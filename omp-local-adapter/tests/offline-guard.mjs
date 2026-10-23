// Offline process tripwire. Only synthetic Node children may reach the OS.
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
for (const method of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork', 'exec', 'execSync']) {
  const original = childProcess[method];
  childProcess[method] = function(command, ...args) {
    if (command !== process.execPath || !['spawn','spawnSync','execFile','execFileSync'].includes(method)) {
      throw Object.assign(new Error('offline_process_guard_refused'), {code:'OFFLINE_PROCESS_GUARD'});
    }
    return Reflect.apply(original, this, [command, ...args]);
  };
}
syncBuiltinESMExports();
