#!/usr/bin/env node
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {loadConfig} from './config.mjs';
import {main} from '../ceo-control/ceo.mjs';

function apiBase(value){
  const u=new URL(value);
  if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw Error('invalid_api_base');
  u.pathname=u.pathname.replace(/\/+$/,'').replace(/\/api$/,'')+'/api';
  return u.href;
}

// Deployment-owned JSON selects the target. Task/CLI arguments cannot replace it.
export async function run(args,env=process.env,fetcher=fetch){
  const [file,...command]=args;
  if(!file||file.startsWith('--'))throw Error('integration_config_path_required');
  if(command.some(x=>['--company-id','--agent-id','--config','--env-file'].includes(x)))throw Error('integration_identity_override');
  const c=loadConfig(file);
  const nativeFields=['PAPERCLIP_API_KEY','PAPERCLIP_AGENT_ID','PAPERCLIP_COMPANY_ID','PAPERCLIP_RUN_ID'];
  const native=nativeFields.some(k=>!!env[k]);
  if(native&&nativeFields.some(k=>!env[k]))throw Error('incomplete_native_context');
  if(native&&(!env.PAPERCLIP_API_URL||apiBase(env.PAPERCLIP_API_URL)!==apiBase(c.apiUrl)))throw Error('native_api_mismatch');
  const targetEnv=native?env:{...env,PAPERCLIP_BRIDGE_READ_IDENTITY:env[c.authEnv],PAPERCLIP_BRIDGE_READ_API_URL:c.apiUrl};
  return main(['--company-id',c.companyId,'--agent-id',c.ceoAgentId,...command],targetEnv,fetcher);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{console.log(JSON.stringify(await run(process.argv.slice(2)),null,2));}
  catch(e){console.error(JSON.stringify({status:'refused',error:e?.safe?e.message:'integration_ceo_failed_check_configuration_or_target'}));process.exitCode=1;}
}
