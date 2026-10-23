import fs from 'node:fs';
import path from 'node:path';
// Self-contained offline host shape: resolves the candidate's installed SDK.
// Not evidence about the real host. Host tier never uses this substitute.
export function syntheticHost(root) {
  fs.mkdirSync(path.join(root,'dist/adapters'),{recursive:true});
  fs.mkdirSync(path.join(root,'dist/services'),{recursive:true});
  fs.writeFileSync(path.join(root,'dist/adapters/index.js'),'export { runningProcesses } from "./utils.js";');
  fs.writeFileSync(path.join(root,'dist/services/heartbeat.js'),'import { getServerAdapter, runningProcesses } from "../adapters/index.js";');
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'@paperclipai/server',version:'2026.1005.0',type:'module',dependencies:{'@paperclipai/adapter-utils':'2026.1005.0'}}));
  fs.writeFileSync(path.join(root,'dist/adapters/utils.js'),'import * as serverUtils from "@paperclipai/adapter-utils/server-utils";\nexport const runningProcesses = serverUtils.runningProcesses;\nconst _runChildProcess = serverUtils.runChildProcess;\nexport const runChildProcess = _runChildProcess;\n');
  return root;
}
