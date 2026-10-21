import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {loadConfig} from './config.mjs';
import {spawnSync} from 'node:child_process';

test('generated setup refuses every existing exact plugin target before any host changes',()=>{
 for(const kind of ['directory','symlink','dangling','file']) {
  const dir=fs.mkdtempSync(path.join(root,'.local/setup-test-'));
  try {
   const c=loadConfig(example), home=path.join(dir,'home'), bin=path.join(dir,'bin');
   c.plugin.ownerHome=home;c.plugin.cursorDir=path.join(dir,'cursors');c.bridge.statePath=path.join(dir,'state/state.json');
   delete c.configPath;
   const file=path.join(dir,'config.json');fs.writeFileSync(file,JSON.stringify(c));
   fs.mkdirSync(path.join(home,'plugins'),{recursive:true});fs.mkdirSync(bin);
   const calls=path.join(dir,'calls');
   fs.writeFileSync(path.join(bin,'hermes'),'#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALLS"\n',{mode:0o700});
   const target=path.join(home,'plugins/tele-injection-plugin'), destination=path.join(dir,'destination');
   if(kind==='directory') fs.mkdirSync(target);
   else if(kind==='file') fs.writeFileSync(target,'existing');
   else {if(kind==='symlink')fs.mkdirSync(destination);fs.symlinkSync(destination,target);}
   const env={PATH:bin+path.delimiter+process.env.PATH,HOME:home,CALLS:calls};
   const generated=spawnSync(process.execPath,[path.join(root,'scripts/setup.mjs'),file],{env,encoding:'utf8'});
   assert.equal(generated.status,0,generated.stderr);
   const script=path.join(dir,'deploy.sh');fs.writeFileSync(script,generated.stdout.split('\nPreview only.')[0]);
   const result=spawnSync('/bin/sh',[script],{env,encoding:'utf8'});
   assert.notEqual(result.status,0,kind+' must fail');
   assert.match(result.stderr,/plugin_target_exists/);
   assert.equal(fs.existsSync(calls),false,'no hermes config/enable');
   assert.equal(fs.existsSync(path.dirname(c.bridge.statePath)),false,'no state mkdir');
   assert.equal(fs.existsSync(c.plugin.cursorDir),false,'no cursor mkdir');
   for(const folder of [target,destination]) if(fs.existsSync(folder)&&fs.statSync(folder).isDirectory())assert.deepEqual(fs.readdirSync(folder),[],'no nested link');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
 }
});
import {loadBuildPrompt} from '../event-bridge/prompt-contract.mjs';
const root=path.resolve(import.meta.dirname,'..');
const example=path.join(root,'integration.example.json');
test('example validates with synthetic IDs and disabled injection',()=>{
  const c=loadConfig(example);assert.equal(c.plugin.enabled,false);assert.ok(path.isAbsolute(c.bridge.statePath));
});
test('unknown secret/config keys, malformed binding and command are rejected',()=>{
 const dir=fs.mkdtempSync(path.join(root,'.local/config-test-')); const file=path.join(dir,'input.json');
 try {for(const mutate of [c=>c.apiKey='never-store-secrets',c=>c.plugin.binding.user_id='other',c=>c.omp.command='relative',c=>c.plugin.binding.session_key='wrong',c=>c.apiUrl='http://user:secret@localhost',c=>c.plugin.binding.chat_id='123']){
 const c=JSON.parse(fs.readFileSync(example));mutate(c);fs.writeFileSync(file,JSON.stringify(c));assert.throws(()=>loadConfig(file));}}
 finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('incompatible internal adapter version fails closed before module import',async()=>{
 const dir=fs.mkdtempSync(path.join(root,'.local/prompt-test-'));
 try{fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name:'@paperclipai/hermes-paperclip-adapter',version:'0.0.0'}));await assert.rejects(loadBuildPrompt(dir),/incompatible/);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
