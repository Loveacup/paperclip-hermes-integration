import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import Ajv from 'ajv';
const schema=JSON.parse(fs.readFileSync(new URL('../config.schema.json',import.meta.url),'utf8'));
const validate=new Ajv({allErrors:true}).compile(schema);
export function loadConfig(file=process.env.PAPERCLIP_INTEGRATION_CONFIG) {
  if(!file) throw Error('integration_config_path_required');
  const root=path.dirname(path.resolve(file));
  const c=JSON.parse(fs.readFileSync(file,'utf8'));
  if(!validate(c)) throw Error('invalid_integration_config: '+validate.errors.map(e=>e.instancePath+' '+e.keyword).join('; '));
  const url=new URL(c.apiUrl);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash) throw Error('invalid_api_url');
  const b=c.plugin.binding, agent=b.profile==='default'?'main':b.profile;
  const expected=`agent:${agent}:telegram:${b.chat_type}:${b.chat_id}`+(b.chat_type==='group'?`:${b.user_id}`:b.thread_id?`:${b.thread_id}`:'');
  if(b.session_key!==expected||b.chat_type==='group'&&(!b.chat_id.startsWith('-')||b.thread_id||b.mode!=='conversation')||b.chat_type==='dm'&&b.chat_id.startsWith('-')||!b.thread_id&&b.mode!=='conversation'||b.mode==='session'&&!c.plugin.accept_nonatomic_risk) throw Error('invalid_binding');
  for(const [obj,keys] of [[c.bridge,['statePath','hermesAdapterRoot']],[c.plugin,['ownerHome','routingHome','cursorDir','instructionsPath']],[c.host,['hermesSource','paperclipServerRoot']]]) for(const k of keys)obj[k]=path.resolve(root,obj[k]);
  c.configPath=path.resolve(file);
  return c;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  try {const c=loadConfig(process.argv[2]);console.log(process.argv.includes('--json')?JSON.stringify(c):'Configuration valid (no network, no credential lookup, no deployment).');}
  catch(e){console.error(e.message);process.exitCode=1;}
}
