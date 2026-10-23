// Installation entry: repo/omp-local-adapter beside repo/scripts/config.mjs.
// The server's administrator environment selects the shared trusted config ONCE,
// at module load. Task context/env and factory arguments are never consulted.
import {loadConfig} from '../scripts/config.mjs';
import {createServerAdapter as createCoreAdapter} from './index.mjs';
import {bindHostSdk} from './host-binding.mjs';
let installationCommand, installationHostRoot;
try {
  const config = loadConfig();
  installationCommand = config.omp.command;
  installationHostRoot = config.host.paperclipServerRoot;
  // Validate through the same core contract, without running OMP or probing it.
  createCoreAdapter({ompCommand:installationCommand});
} catch {
  // Do not publish config paths, values or parsing errors.
  throw new Error('installation_config_invalid');
}
const host = await bindHostSdk(installationHostRoot);
export function createServerAdapter() {
  return createCoreAdapter({ompCommand:installationCommand,runChildProcess:host.runChildProcess});
}
