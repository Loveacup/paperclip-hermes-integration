import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {createServerAdapter} from '../index.mjs';

test('installation authority: missing or malformed command fails closed at factory without echoing values', () => {
  for (const ompCommand of [undefined, null, '', 'omp', '--help', 7, [], {}, '/synthetic\0SECRET']) {
    assert.throws(() => createServerAdapter({ompCommand}), {message: 'invalid_installation_command'});
  }
});

test('trusted installation command binds run, metadata, baseline and environment check; task cannot replace it', async (t) => {
  const root = mkdtempSync(path.join(process.env.TMPDIR, 'installation-'));
  t.after(() => rmSync(root, {recursive:true, force:true}));
  const source = path.join(root, 'skill'); mkdirSync(source);
  writeFileSync(path.join(source, 'SKILL.md'), '---\nname: alpha\ndescription: Synthetic.\n---\nBody.\n');
  const command = path.join(root, 'trusted-bin', 'omp');
  const calls = [], metas = [], baseline = [], access = [];
  const adapter = createServerAdapter({
    ompCommand: command,
    listOmpModels: async () => [],
    accessExecutable: async (p) => access.push(p),
    runOmpBaselineCommand: async (cmd) => {baseline.push(cmd); return {exitCode:0, stdout:JSON.stringify({key:'skills.customDirectories',type:'array',value:[]})};},
    runChildProcess: async (_id, cmd, args, opts) => {
      calls.push({cmd,args,opts});
      await opts.onSpawn({pid:123});
      const stdout = JSON.stringify({type:'agent_end',messages:[{role:'assistant',stopReason:'stop',content:[{type:'text',text:'ok'}]}]})+'\n';
      await opts.onLog('stdout',stdout);
      return {exitCode:0,signal:null,timedOut:false,stdout,stderr:''};
    },
  });
  const ctx = {
    runId:'portable-run', agent:{id:'portable-agent',companyId:'portable-company',name:'synthetic'},
    config:{cwd:root,env:{PAPERCLIP_RUN_SCRATCH_DIR:root},paperclipSkillSync:{desiredSkills:['e/alpha']},
      paperclipRuntimeSkills:[{key:'e/alpha',runtimeName:'alpha',source,versionId:'v1',currentVersionId:'v1',sourceStatus:'available'}]},
    context:{taskId:'issue-portable',paperclipWake:{issue:{id:'issue-portable',title:'Synthetic task'}},paperclipScratch:{type:'heartbeat_run',dir:root}},
    onLog:async()=>{},onMeta:async(m)=>metas.push(m),
  };
  const result = await adapter.execute(ctx);
  assert.equal(result.resultJson.runOutcome,'succeeded');
  assert.equal(calls[0].cmd,command);
  assert.equal(metas[0].command,command);
  assert.deepEqual(baseline,[command]);
  assert.equal(calls[0].opts.env.TMPDIR,root);
  assert.equal(calls[0].opts.timeoutSec,915);
  assert.equal((await adapter.testEnvironment(ctx)).status,'pass');
  assert.deepEqual(access,[command]);
  for (const key of ['command','ompCommand','prefixArgs']) {
    const rejected = await adapter.execute({...ctx,config:{...ctx.config,[key]:command}});
    assert.equal(rejected.errorCode,'omp_config_invalid');
    assert.deepEqual(rejected.executionRecovery,{kind:'bootstrap',providerWorkStarted:false});
  }
  assert.equal(calls.length,1);
});

test('discovery uses each installation command and does not share cache across installations', async (t) => {
  const calls = [];
  const realSpawn = childProcess.spawn;
  childProcess.spawn = (command,args) => {
    calls.push({command,args});
    const child = new EventEmitter();
    child.exitCode=null; child.stdout=new EventEmitter(); child.stdout.destroy=()=>{};
    child.unref=()=>{}; child.kill=()=>{};
    setImmediate(()=>{child.stdout.emit('data',Buffer.from('synthetic/model  Model\n'));child.exitCode=0;child.emit('close',0);});
    return child;
  };
  syncBuiltinESMExports();
  t.after(()=>{childProcess.spawn=realSpawn;syncBuiltinESMExports();});
  const a=path.resolve('synthetic-install-a','omp'), b=path.resolve('synthetic-install-b','omp');
  const adapter=createServerAdapter({ompCommand:a});
  assert.deepEqual(await adapter.listModels(),[{id:'synthetic/model',label:'synthetic/model'}]);
  await adapter.listModels();
  await createServerAdapter({ompCommand:b}).listModels();
  assert.deepEqual(calls,[{command:a,args:['models']},{command:b,args:['models']}]);
});
