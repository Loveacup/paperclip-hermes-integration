import {spawnSync} from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
// Allowlist the environment: offline tests never inherit application credentials.
const root=path.resolve(import.meta.dirname,'..');
fs.mkdirSync(path.join(root,'.local'),{recursive:true});
const env=Object.fromEntries(['PATH','HOME','TMPDIR','LANG','LC_ALL'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
Object.assign(env,{NODE_ENV:'production',PYTHONDONTWRITEBYTECODE:'1',PAPERCLIP_INTEGRATION_CONFIG:path.join(root,'integration.example.json')});
const runs=[
  [process.execPath,['--test','event-bridge/bridge.test.mjs','event-bridge/read.test.mjs','omp-adapter/adapter.test.mjs','omp-adapter/native-contract.test.mjs','scripts/config.test.mjs']],
  ['python3',['-B','-m','unittest','discover','-s','event-bridge','-p','test_*.py']],
  ['python3',['-B','-m','unittest','discover','-s','tele-injection-plugin','-p','test_*.py']]
];
let failed=false;
for(const [command,args] of runs){const r=spawnSync(command,args,{cwd:root,env,stdio:'inherit'});if(r.error)console.error(r.error.message);if(r.status!==0)failed=true;}
process.exitCode=failed?1:0;
