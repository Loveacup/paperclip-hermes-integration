import {spawnSync} from 'node:child_process';
import {loadConfig} from './config.mjs';
const kind=process.argv[2], config=loadConfig(process.argv[3]);
const env={...process.env,PAPERCLIP_INTEGRATION_CONFIG:config.configPath,HERMES_SOURCE:config.host.hermesSource,PAPERCLIP_SERVER_ROOT:config.host.paperclipServerRoot,OMP_COMMAND:config.omp.command,NODE_ENV:'production',PYTHONDONTWRITEBYTECODE:'1'};
const commands={hermes:['python3',['-B','tele-injection-plugin/host_contract.py']],server:[process.execPath,['--test','omp-adapter/enrichment.test.mjs','omp-adapter/host-loader.test.mjs']],omp:[process.execPath,['--test','omp-adapter/installed-native.test.mjs']]};
if(!commands[kind])throw Error('unknown_host_probe');
const [cmd,args]=commands[kind];const r=spawnSync(cmd,args,{env,stdio:'inherit'});if(r.error)console.error(r.error.message);process.exitCode=r.status??1;
