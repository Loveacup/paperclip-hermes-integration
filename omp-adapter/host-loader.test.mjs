import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServerAdapter} from './index.mjs';
const cwd=import.meta.dirname;
const make=()=>createServerAdapter({command:process.execPath});
test('external module factory contract, config schema and environment probe are offline',async()=>{
  const {validateAdapterModule}=await import(pathToFileURL(path.join(process.env.PAPERCLIP_SERVER_ROOT,'dist/adapters/plugin-loader.js')));
  const mod=validateAdapterModule({createServerAdapter},'@local/paperclip-adapter-omp-native-json');
  assert.equal(mod.type,'omp_native_json_local');
  assert.equal(typeof mod.execute,'function');
  assert.equal(typeof mod.testEnvironment,'function');
  assert.equal(mod.getConfigSchema().fields.some(f=>f.key==='model'),true);
  const result=await make().testEnvironment({config:{cwd},companyId:'company',adapterType:mod.type});
  assert.equal(result.status,'pass');
  const bad=await make().testEnvironment({config:{cwd,model:'bad model'},companyId:'company',adapterType:mod.type});
  assert.equal(bad.status,'fail');
});
