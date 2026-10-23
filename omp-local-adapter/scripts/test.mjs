import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, readdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root = path.resolve(import.meta.dirname,'..');
// Explicit source baseline: all 16 source test files, including both omitted deadline files.
export const suites = [
  'index','skills','runtime-skills','output-adapt','omp-baseline','p0c-rev','p0c-rev2',
  'index-baseline','baseline-env','cap-boundary','replay-guard','async-admission',
  'model-select','model-select-f2','deadline-window','deadline-jobs','installation','host-installation','host-binding','large-terminal-boundary',
].map(name => `tests/${name}.test.mjs`);
const discovered = readdirSync(path.join(root,'tests')).filter(n=>n.endsWith('.test.mjs')).map(n=>`tests/${n}`).sort();
if (JSON.stringify([...suites].sort()) !== JSON.stringify(discovered)) throw Error('test_manifest_incomplete');
const base = path.join(root,'.evidence','tmp'); mkdirSync(base,{recursive:true});
const temp = mkdtempSync(path.join(base,'suite-'));
const home = path.join(temp,'home'); mkdirSync(home);
const env = {PATH:process.env.PATH??'',HOME:home,TMPDIR:temp,TEMP:temp,TMP:temp,
  PAPERCLIP_RUN_SCRATCH_DIR:temp,LANG:'C.UTF-8',NO_COLOR:'1',NODE_ENV:'production'};
const guard = pathToFileURL(path.join(root,'tests','offline-guard.mjs')).href;
const hostTier=process.argv[2]==='--host';
if(hostTier) {
  if(!process.argv[3]||!path.isAbsolute(process.argv[3]))throw Error('absolute_host_package_root_required');
  env.OMP_TEST_HOST_ROOT=process.argv[3];
}
const selected=hostTier?['tests/host-tier/registry.test.mjs']:suites;
// Guard imports run inside each isolated test worker, not as a runtime loader.
const wrappers=selected.map((suite,i)=>{
  const file=path.join(temp,`suite-${i}.test.mjs`);
  writeFileSync(file,`await import(${JSON.stringify(guard)});\nawait import(${JSON.stringify(pathToFileURL(path.join(root,suite)).href)});\n`);
  return file;
});
try {
  const result=spawnSync(process.execPath,['--test','--test-reporter=tap',...wrappers],
    {cwd:root,env,stdio:'inherit',timeout:180000});
  if(result.error) console.error(result.error.code??'test_runner_error');
  process.exitCode=result.status??1;
} finally {rmSync(temp,{recursive:true,force:true});}
