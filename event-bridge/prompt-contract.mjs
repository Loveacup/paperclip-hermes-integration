import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
export async function loadBuildPrompt(root) {
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  if(manifest.name!=='@paperclipai/hermes-paperclip-adapter'||manifest.version!=='2026.1005.0') throw Error('incompatible_hermes_adapter_version');
  // Deliberately INTERNAL: public ./server does not export buildPrompt.
  const module=await import(pathToFileURL(path.join(root,'dist/server/execute.js')).href);
  if(typeof module.buildPrompt!=='function') throw Error('incompatible_hermes_buildPrompt_export');
  return module.buildPrompt;
}
