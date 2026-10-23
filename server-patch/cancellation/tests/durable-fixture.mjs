import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as url from 'node:url';
export const root=url.fileURLToPath(new URL('.',import.meta.url));
export const identity={runnerInstanceId:'runner',environmentLeaseId:'lease',runId:'run',normalizedSessionId:'native-session',turnId:'turn',itemId:'item'};
const source=fs.readFileSync(new URL('./candidate/vendor/paperclip-runner/control-plane/durable-prp-control-plane.js',import.meta.url),'utf8');
// Complete native authority + native file store. Only private-name visibility,
// import plumbing and network/process leaves differ. No authority behavior mock.
const deps={...fs,...crypto,...path,constants:fs.constants,fileURLToPath:url.fileURLToPath,spawn(){throw Error('FORBIDDEN spawn');},createServer(){throw Error('FORBIDDEN network');},NativeSessionProtocolIntegrityError:class extends Error{},ACPX_CREDENTIAL_BINDING_ENV:'fixture',ACPX_CREDENTIAL_NAMES:[],githubCredentialEnvironment(){throw Error('unused');},validatePrpEvent(){throw Error('unused');},digestPaperclipSemanticContent(){throw Error('unused');}};
export function loadCore(overrides={}) {
 const d={...deps,...overrides}; delete d.default;
 const code=source.slice(0,source.indexOf('const runnerPlatformEnvironmentKeys')).replace(/^import .*;\n/gm,'').replaceAll('import.meta.url',JSON.stringify(new URL('./candidate/vendor/paperclip-runner/control-plane/durable-prp-control-plane.js',import.meta.url).href)).replaceAll('export ','').replace(/#([A-Za-z]\w*)/g,'_$1');
 return Function(...Object.keys(d),code+'\nreturn DurablePrpControlPlane;')(...Object.values(d));
}
export function makeCore(directory,Core=loadCore()) {return new Core({stateDirectory:directory,identity,expectedRunnerVersion:'test',expectedRunnerDigest:'sha256:'+'0'.repeat(64)});}
export function directory(){return fs.mkdtempSync(path.join(root,'state-'));}
export function connection(core, send=()=>{}) {
 const c={secureChannel:{},lease:{leaseId:'lease-connection',protocolVersion:2,expiresAt:'2099-01-01',expiresAtUnixMs:4070908800000,revocationEpoch:0},connectionId:'connection',terminalLifecycleCommandId:null,replayOnly:false,activationReceipt:null,warmTransitionVersion:0,sendJson:send,close(){this.closed=true;}};
 core._connections.add(c);return c;
}
export const once={mode:'targeted_stop_once'};
export function wires(frames){return frames.flatMap(f=>f.kind==='command'?[f.payload]:f.kind==='welcome'?f.payload.pendingCommands:[]);}
export function result(core,c,command,status='completed'){core._commandResult(c,{payload:{commandId:command.commandId,commandType:command.type,controllerSeq:command.controllerSeq,status,result:{}}});}
