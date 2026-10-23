import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {resolvePackageEntryPoint,validateAdapterModule} from './fixtures/host-validator.mjs';
import {syntheticHost} from './fixtures/synthetic-host.mjs';
const root=path.resolve(import.meta.dirname,'..');
const fixtures=path.join(import.meta.dirname,'fixtures/shared');
const command='/synthetic-installation/bin/omp';
function fixture() {
  const repo=fs.mkdtempSync(path.join(process.env.TMPDIR,'host-installation-'));
  const pkg=path.join(repo,'omp-local-adapter');fs.mkdirSync(pkg);
  for(const file of fs.readdirSync(root).filter(f=>f.endsWith('.mjs')||f==='package.json')) fs.copyFileSync(path.join(root,file),path.join(pkg,file));
  fs.mkdirSync(path.join(repo,'scripts'));
  fs.copyFileSync(path.join(fixtures,'config.mjs'),path.join(repo,'scripts/config.mjs'));
  fs.copyFileSync(path.join(fixtures,'config.schema.json'),path.join(repo,'config.schema.json'));
  const config=JSON.parse(fs.readFileSync(path.join(fixtures,'integration.example.json')));config.omp.command=command;
  config.host.paperclipServerRoot=syntheticHost(path.join(repo,'host'));
  const configFile=path.join(repo,'synthetic.json');fs.writeFileSync(configFile,JSON.stringify(config));
  return {repo,pkg,config,configFile};
}
async function isolated(fn) {
  const f=fixture();const old=process.env.PAPERCLIP_INTEGRATION_CONFIG;
  try {process.env.PAPERCLIP_INTEGRATION_CONFIG=f.configFile;await fn(f);}
  finally {if(old===undefined)delete process.env.PAPERCLIP_INTEGRATION_CONFIG;else process.env.PAPERCLIP_INTEGRATION_CONFIG=old;fs.rmSync(f.repo,{recursive:true,force:true});}
}
const load=f=>import(pathToFileURL(path.resolve(f.pkg,resolvePackageEntryPoint(f.pkg))).href);
test('host real resolver + no-argument validator loads installed package',()=>isolated(async f=>{
  const mod=await load(f);
  const adapter=validateAdapterModule(mod,'omp-local-adapter');
  assert.equal(adapter.type,'omp_local');assert.equal(typeof adapter.execute,'function');
  const result=await adapter.testEnvironment({config:{cwd:f.repo}});
  assert.equal(result.checks.find(c=>c.code==='omp_command_missing').message,`${command} is not executable.`);
}));
test('installed command cannot be overridden by factory args, changed env or task context',()=>isolated(async f=>{
  const mod=await load(f);
  process.env.PAPERCLIP_INTEGRATION_CONFIG='/synthetic-attacker/config.json';
  const adapter=mod.createServerAdapter({ompCommand:'/synthetic-attacker/bin/omp',loadConfig(){throw Error('must not run');}});
  const result=await adapter.testEnvironment({config:{cwd:f.repo,env:{OMP_COMMAND:'/synthetic-attacker/bin/omp',PAPERCLIP_INTEGRATION_CONFIG:'/synthetic-attacker/config.json'}},context:{ompCommand:'/synthetic-attacker/bin/omp'}});
  assert.equal(result.checks.find(c=>c.code==='omp_command_missing').message,`${command} is not executable.`);
  for(const key of ['command','ompCommand','prefixArgs']) {
    const r=await adapter.execute({config:{cwd:f.repo,[key]:'/synthetic-attacker/bin/omp'}});
    assert.equal(r.errorCode,'omp_config_invalid');
  }
}));
test('host load fails closed without a valid installation host (no local SDK fallback)',()=>isolated(async f=>{
  f.config.host.paperclipServerRoot='/synthetic/missing-host';fs.writeFileSync(f.configFile,JSON.stringify(f.config));
  await assert.rejects(load(f),{message:'installation_host_binding_invalid'});
}));
test('host load fails closed without trusted config path',()=>isolated(async f=>{
  delete process.env.PAPERCLIP_INTEGRATION_CONFIG;
  await assert.rejects(async()=>validateAdapterModule(await load(f),'omp-local-adapter'),/installation_config_invalid/);
}));
test('host load fails closed with invalid/missing/NUL installation command',async()=>{
  for(const value of [undefined,'relative-omp','/synthetic/omp\u0000']) await isolated(async f=>{
    f.config.omp.command=value;fs.writeFileSync(f.configFile,JSON.stringify(f.config));
    await assert.rejects(async()=>validateAdapterModule(await load(f),'omp-local-adapter'),/installation_config_invalid/);
  });
});
