import fs from 'node:fs';
import path from 'node:path';
import {loadConfig} from './config.mjs';
const args=process.argv.slice(2), apply=args.includes('--apply');
const file=args.find(a=>!a.startsWith('--'));
if(args.some(a=>a.startsWith('--')&&a!=='--apply'))throw Error('unknown_setup_option');
const c=loadConfig(file), root=path.resolve(import.meta.dirname,'..');
const q=s=>"'"+String(s).replaceAll("'","'\\''")+"'";
const stateDir=path.dirname(c.bridge.statePath);
const commands=[
 '#!/bin/sh', 'set -eu',
 '# GENERATED REVIEW ARTIFACT. Does not start a bridge, gateway or model.',
 '# Run only after choosing exactly one bridge and one destination plugin owner.',
 `export HERMES_HOME=${q(c.plugin.ownerHome)}`,
 `export PAPERCLIP_INTEGRATION_CONFIG=${q(c.configPath)}`,
 '# Refuse the exact target before creating directories or configuring the host.',
 'plugin_target="$HERMES_HOME/plugins/tele-injection-plugin"',
 'if [ -e "$plugin_target" ] || [ -L "$plugin_target" ]; then',
 '  echo "plugin_target_exists: inspect existing plugin before deployment" >&2',
 '  exit 1',
 'fi',
 `mkdir -p ${q(stateDir)} ${q(c.plugin.cursorDir)} "$HERMES_HOME/plugins"`,
 `ln -s ${q(path.join(root,'tele-injection-plugin'))} "$HERMES_HOME/plugins/tele-injection-plugin"`,
 `hermes config set plugins.entries.tele-injection-plugin.settings.config_path ${q(c.configPath)}`,
 'hermes plugins enable tele-injection-plugin',
 '# Restart the selected messaging gateway manually, not a CLI session.',
 '# Pass PAPERCLIP_INTEGRATION_CONFIG to the Paperclip server environment too.',
 '# Bridge service argv (credentials must already be supplied by your service manager):',
 `# python3 ${q(path.join(root,'event-bridge/service_exec.py'))} --state ${q(c.bridge.statePath)} --config ${q(c.configPath)} -- ${q(process.execPath)} ${q(path.join(root,'event-bridge/bridge.mjs'))} --config ${q(c.configPath)} --run`,
 '# No scheduler/service definition is installed by this project.'
].join('\n')+'\n';
if(apply){const dir=path.join(root,'.local');fs.mkdirSync(dir,{recursive:true});const out=path.join(dir,'deploy.sh');fs.writeFileSync(out,commands,{mode:0o600});console.log('Wrote .local/deploy.sh for manual review. No deployment executed.');}
else console.log(commands+'\nPreview only. --apply writes .local/deploy.sh; it never executes it.');
