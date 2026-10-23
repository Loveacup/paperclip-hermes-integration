import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,chmodSync,readdirSync,rmSync} from 'node:fs';
import path from 'node:path';
import {createServerAdapter} from './adapter-fixture.mjs';
const root=mkdtempSync(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR,'cleanup-cancel-review-'));
process.on('exit',()=>{chmodSync(root,0o700); rmSync(root,{recursive:true,force:true});});
test('P0C-REV2 R6a: pre-dispatch cancellation cleanup failure is reported, not silently discarded (D1d)',async()=>{
 const scratch=path.join(root,'scratch'); mkdirSync(scratch); const source=path.join(root,'source'); mkdirSync(source);
 writeFileSync(path.join(source,'SKILL.md'),'---\nname: alpha\ndescription: Synthetic review skill.\n---\nBody.\n');
 const ac=new AbortController(); let calls=0; let getterCalls=0;
 // A synchronous injected baseline getter fires while buildOverlay structured-clones the
 // baseline, after copied skills exist but before prepareRuntimeSkills returns. This injects
 // an actual AbortSignal cancellation and a deterministic filesystem cleanup failure without
 // changing product code or starting a process. Accessors are test-only dependency injection.
 const skills={}; Object.defineProperty(skills,'customDirectories',{enumerable:true,get(){getterCalls++;chmodSync(scratch,0o500);ac.abort();return [];}});
 const baseline={trusted:true,config:{skills}};
 const ctx={runId:'review-cleanup',agent:{id:'review-agent',companyId:'review-company',name:'review',adapterType:'omp_local',adapterConfig:{}},runtime:{sessionId:null,sessionParams:null},
 config:{cwd:root,timeoutSec:60,graceSec:5,env:{PAPERCLIP_RUN_SCRATCH_DIR:scratch},paperclipSkillSync:{desiredSkills:['review/alpha']},paperclipRuntimeSkills:[{key:'review/alpha',runtimeName:'alpha',source,versionId:'v1',currentVersionId:'v1',sourceStatus:'available'}]},
 context:{taskId:'review-issue',issueId:'review-issue',wakeReason:'issue_assigned',paperclipWake:{reason:'issue_assigned',issue:{id:'review-issue',identifier:'REV-2',title:'Review fixture',status:'in_progress'}},paperclipScratch:{type:'heartbeat_run',dir:scratch}},signal:ac.signal,onLog:async()=>{},onMeta:async()=>{},onSpawn:async()=>{}};
 try{
  const result=await createServerAdapter({runChildProcess:async()=>{calls++;throw new Error('must not dispatch');},readOmpSkillBaseline:async()=>baseline}).execute(ctx);
  const warning=result.resultJson?.runtimeSkills?.cleanupWarning;
  const leftovers=readdirSync(scratch);
  console.log(JSON.stringify({aborted:ac.signal.aborted,getterCalls,calls,errorCode:result.errorCode,cleanupWarning:warning??null,leftovers:leftovers.length,resultKeys:Object.keys(result.resultJson??{})}));
  assert.equal(calls,0);assert.equal(result.errorCode,'omp_cancelled_before_spawn');assert.equal(getterCalls,1);
  assert.equal(typeof warning,'string','cleanup failure must remain visible in resultJson');
 }finally{chmodSync(scratch,0o700);rmSync(scratch,{recursive:true,force:true});}
});

// ---- R6b: reviewed coordinator-frozen cleanup contract ----
// Trigger: the injected baseline accessor fires inside buildOverlay (structuredClone), i.e. after the exclusive
// staging dir was created and the skill was copied. It removes write permission from that staging dir only, so
// the subsequent overlay writeFile fails (real staging failure) and rm cannot unlink the staged child (real cleanup
// failure). Synthetic run scratch only; runner/baseline are injected; no product change, no forged result.
test('P0C-REV2 R6b: staging failure plus cleanup failure keeps omp_skills_staging_failed and reports cleanupWarning (D1d/F6)',async()=>{
 const base=mkdtempSync(path.join(root,'r6b-'));
 const scratch=path.join(base,'scratch'); mkdirSync(scratch); const source=path.join(base,'source'); mkdirSync(source);
 writeFileSync(path.join(source,'SKILL.md'),'---\nname: alpha\ndescription: Synthetic R6b skill.\n---\nBody.\n');
 let runnerCalls=0; let onMetaCalls=0; let getterCalls=0; const locked=[];
 const skills={}; Object.defineProperty(skills,'customDirectories',{enumerable:true,get(){getterCalls++;for(const n of readdirSync(scratch)){const d=path.join(scratch,n);chmodSync(d,0o500);locked.push(d);}return [];}});
 const baseline={trusted:true,config:{skills}};
 const ac=new AbortController();
 const ctx={runId:'r6b-cleanup',agent:{id:'r6b-agent',companyId:'r6b-company',name:'r6b',adapterType:'omp_local',adapterConfig:{}},runtime:{sessionId:null,sessionParams:null},
 config:{cwd:base,timeoutSec:60,graceSec:5,env:{PAPERCLIP_RUN_SCRATCH_DIR:scratch},paperclipSkillSync:{desiredSkills:['r6b/alpha']},paperclipRuntimeSkills:[{key:'r6b/alpha',runtimeName:'alpha',source,versionId:'v1',currentVersionId:'v1',sourceStatus:'available'}]},
 context:{taskId:'r6b-issue',issueId:'r6b-issue',wakeReason:'issue_assigned',paperclipWake:{reason:'issue_assigned',issue:{id:'r6b-issue',identifier:'R6B-1',title:'R6b fixture',status:'in_progress'}},paperclipScratch:{type:'heartbeat_run',dir:scratch}},signal:ac.signal,onLog:async()=>{},onMeta:async()=>{onMetaCalls++;},onSpawn:async()=>{}};
 try{
  const result=await createServerAdapter({runChildProcess:async()=>{runnerCalls++;throw new Error('must not dispatch');},readOmpSkillBaseline:async()=>baseline}).execute(ctx);
  const warning=result.resultJson?.runtimeSkills?.cleanupWarning;
  const leftovers=readdirSync(scratch);
  console.log(JSON.stringify({getterCalls,lockedStagingDirs:locked.length,runnerCalls,onMetaCalls,errorCode:result.errorCode,errorMessage:result.errorMessage??null,cleanupWarning:warning??null,leftovers:leftovers.length,resultKeys:Object.keys(result.resultJson??{})}));
  assert.equal(getterCalls,1,'staging must reach the post-copy overlay step');
  assert.equal(locked.length,1,'exactly one exclusive staging dir must exist when staging fails');
  assert.equal(leftovers.length,1,'cleanup must really have failed (staging dir left behind)');
  assert.equal(result.errorCode,'omp_skills_staging_failed','cleanup failure must not replace the original errorCode');
  assert.equal(runnerCalls,0);assert.equal(onMetaCalls,0);
  assert.ok(!/"spawnBound"\s*:\s*true/.test(JSON.stringify(result)),'evidence must not claim spawnBound=true');
  assert.equal(typeof warning,'string','cleanup failure must remain visible in resultJson.runtimeSkills.cleanupWarning');
  assert.ok(warning.trim().length>0,'cleanupWarning must be non-empty');
 }finally{for(const d of locked) chmodSync(d,0o700); rmSync(base,{recursive:true,force:true});}
});
