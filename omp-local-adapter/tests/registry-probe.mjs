import assert from 'node:assert/strict';
export async function registryProbe(sdk, host, cwd, expectVisible=true) {
  const id=`omp-binding-${process.pid}-${crypto.randomUUID()}`;
  let owned, metadata, readyResolve;
  const ready=new Promise(r=>readyResolve=r);
  const pending=sdk.runChildProcess(id,process.execPath,['-e','console.log("READY");setTimeout(()=>process.exit(0),4000)'],{
    cwd,env:{},timeoutSec:6,graceSec:1,
    onSpawn:async m=>{metadata=m;},onLog:async(_s,text)=>{if(text.includes('READY'))readyResolve();},
  });
  let timer;
  const report={id};
  try {
    await Promise.race([ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('ready_timeout')),2500);})]);
    owned=sdk.runningProcesses.get(id);
    assert.equal(owned.child.pid,metadata.pid);
    Object.assign(report,{pid:metadata.pid,hostVisible:host.runningProcesses.has(id)});
    // Exact heartbeat stop eligibility gate, not a call to its DB-backed service.
    const tracked=host.runningProcesses.get(id);
    if(tracked){assert.equal(tracked.child,owned.child);host.signalRunningProcess(tracked,'SIGTERM');}
    assert.equal(report.hostVisible,expectVisible,'host registry must own dispatched child');
    if(expectVisible){const result=await pending;assert.equal(result.signal,'SIGTERM');assert.equal(result.timedOut,false);report.signal=result.signal;}
    return report;
  } finally {
    clearTimeout(timer);
    owned??=sdk.runningProcesses.get(id);
    if(owned&&owned.child.exitCode===null&&owned.child.signalCode===null)owned.child.kill('SIGTERM');
    await pending;
    assert.equal(sdk.runningProcesses.has(id),false);
    assert.equal(host.runningProcesses.has(id),false);
    report.mapsCleared=true;
  }
}
