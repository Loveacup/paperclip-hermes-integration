// Installation-only binding. Never resolve the runner relative to this package.
import {readFileSync, realpathSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {findPackageJSON} from 'node:module';
const VERSION='2026.1005.0';
const readJson=p=>JSON.parse(readFileSync(p,'utf8'));
function canonical(url) {
  const u=new URL(url);
  if(u.protocol!=='file:'||u.search||u.hash)throw Error();
  return pathToFileURL(realpathSync(fileURLToPath(u))).href;
}
export async function bindHostSdk(hostRoot) {
  try {
    // Only ordinary unbundled Node ESM is supported. No loader/preload/custom
    // conditions or symlink-preserving mode: they invalidate resolver equivalence.
    if(process.env.NODE_OPTIONS?.trim()||process.execArgv.some(a=>/^--(?:preserve-symlinks(?:-main)?|(?:experimental-)?loader|import|require|conditions|experimental-default-type|experimental-specifier-resolution)(?:=|$)/.test(a)||/^-[rC]/.test(a)))throw Error();
    if(path.basename(fileURLToPath(import.meta.url))!=='host-binding.mjs'||canonical(import.meta.url)!==import.meta.url)throw Error();
    if(typeof hostRoot!=='string'||!path.isAbsolute(hostRoot))throw Error();
    const root=realpathSync(hostRoot);
    const pkg=readJson(path.join(root,'package.json'));
    if(pkg.name!=='@paperclipai/server'||pkg.version!==VERSION||pkg.type!=='module'||pkg.dependencies?.['@paperclipai/adapter-utils']!==VERSION)throw Error();
    const adapterIndex=readFileSync(path.join(root,'dist/adapters/index.js'),'utf8');
    const heartbeat=readFileSync(path.join(root,'dist/services/heartbeat.js'),'utf8');
    if(!adapterIndex.includes('export { runningProcesses } from "./utils.js";')||!heartbeat.includes('import { getServerAdapter, runningProcesses } from "../adapters/index.js";'))throw Error();
    const anchor=canonical(pathToFileURL(path.join(root,'dist/adapters/utils.js')));
    // Reject bundled/rewritten host adapters instead of assuming their private
    // registry is the ordinary SDK module cache entry.
    const source=readFileSync(fileURLToPath(anchor),'utf8');
    if(!source.includes('import * as serverUtils from "@paperclipai/adapter-utils/server-utils";')||!source.includes('export const runningProcesses = serverUtils.runningProcesses;')||!source.includes('const _runChildProcess = serverUtils.runChildProcess;'))throw Error();
    // A real Node ESM resolver with the host importer as parent. require.resolve
    // would select CJS conditions and is deliberately not used here.
    const probe=spawnSync(process.execPath,['--experimental-import-meta-resolve','--input-type=module','-e',
      'process.stdout.write(import.meta.resolve("@paperclipai/adapter-utils/server-utils",process.argv[1]))',anchor],
      {env:{},encoding:'utf8',timeout:5000,maxBuffer:16384});
    if(probe.status!==0||probe.error)throw Error();
    const resolved=probe.stdout;
    const url=canonical(resolved);
    if(url!==resolved)throw Error();
    const sdkPkg=readJson(findPackageJSON('@paperclipai/adapter-utils/server-utils',anchor));
    if(sdkPkg.name!=='@paperclipai/adapter-utils'||sdkPkg.version!==VERSION||sdkPkg.type!=='module')throw Error();
    const sdk=await import(url);
    // Observe the actual host consumer, not just a second import of our URL.
    // In production this is the already-loaded utils module; cold host-tier
    // verification initializes its logger only (NODE_ENV=production in tests).
    const host=await import(anchor);
    if(host.runningProcesses!==sdk.runningProcesses||typeof host.runChildProcess!=='function')throw Error();
    if(!(sdk.runningProcesses instanceof Map)||typeof sdk.runChildProcess!=='function'||typeof sdk.signalRunningProcess!=='function')throw Error();
    // Both canonical import and resolver URL must return the same actual objects,
    // not merely matching versions or source hashes.
    const again=await import(resolved);
    if(again.runningProcesses!==sdk.runningProcesses||again.runChildProcess!==sdk.runChildProcess)throw Error();
    return Object.freeze({runChildProcess:sdk.runChildProcess,runningProcesses:sdk.runningProcesses,signalRunningProcess:sdk.signalRunningProcess,url});
  } catch {throw new Error('installation_host_binding_invalid');}
}
