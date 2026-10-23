import {spawnSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const files=['entry.mjs','host-binding.mjs','index.mjs','skills.mjs','runtime-skills.mjs','output-parser.mjs','omp-baseline.mjs',
  ...['tests','scripts'].flatMap(dir=>readdirSync(path.join(root,dir),{recursive:true}).filter(f=>f.endsWith('.mjs')).map(f=>`${dir}/${f}`))];
for(const file of files){
  const r=spawnSync(process.execPath,['--check',file],{cwd:root,stdio:'inherit'});
  if(r.status!==0) process.exit(r.status??1);
}
console.log(`Syntax checked ${files.length} modules.`);
