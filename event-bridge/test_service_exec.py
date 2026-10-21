import fcntl
import hashlib
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
SHIM = HERE / 'service_exec.py'
BRIDGE = HERE / 'bridge.mjs'
import shutil
NODE = shutil.which('node')

class ServiceOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR'), prefix='bridge-service-test-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.state = self.root / 'state.json'
        self.state.write_text(json.dumps({'inflight': {'status': 'uncertain', 'key': 'offline-do-not-replay'}}))
        self.original_state = self.state.read_bytes()
        self.fixture = self.root / 'owned-node.mjs'
        self.fixture.write_text("import {acquireLock} from " + json.dumps(BRIDGE.as_uri()) + ";\n"
            "const release=acquireLock(process.argv[2]+'.lock');\n"
            "process.once('SIGTERM',()=>{release();process.exit(0);});\n"
            "console.log(JSON.stringify({ready:true,pid:process.pid}));\n"
            "setInterval(()=>{},1000);\n")
        self.children = []
        self.addCleanup(self.stop_children)

    def command(self):
        return [sys.executable, '-B', str(SHIM), '--state', str(self.state), '--', NODE, str(self.fixture), str(self.state)]

    def start(self):
        p = subprocess.Popen(self.command(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.children.append(p)
        readable, _, _ = select.select([p.stdout], [], [], 5)
        self.assertTrue(readable, 'Service ownership entrypoint did not become ready')
        line = p.stdout.readline()
        if not line:
            self.fail('Missing production service entrypoint or failed exec: ' + p.stderr.read())
        event = json.loads(line)
        self.assertTrue(event['ready'])
        self.assertEqual(event['pid'], p.pid, 'Ownership shim must exec, not become another supervisor')
        return p

    def stop_children(self):
        for p in self.children:
            if p.poll() is None:
                p.terminate()
                try:
                    p.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    p.kill()
                    p.wait(timeout=5)
            p.stdout.close()
            p.stderr.close()

    def test_single_owner_kernel_lock_survives_exec(self):
        p = self.start()
        with open(str(self.state)+'.owner.lock', 'r+b') as fd:
            with self.assertRaises(BlockingIOError):
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        other = subprocess.run(self.command(), capture_output=True, text=True, timeout=5)
        self.assertNotEqual(other.returncode, 0)
        self.assertIn('owner_busy', other.stderr)
        p.terminate()
        self.assertEqual(p.wait(timeout=5), 0)
        self.assertFalse(Path(str(self.state)+'.lock').exists())
        self.assertEqual(self.state.read_bytes(), self.original_state)
        with open(str(self.state)+'.owner.lock', 'r+b') as fd:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_crash_restart_preserves_uncertain_state(self):
        first = self.start()
        first.kill()
        first.wait(timeout=5)
        self.assertTrue(Path(str(self.state)+'.lock').exists())
        restarted = self.start()
        lease = json.loads(Path(str(self.state)+'.lock').read_text())
        self.assertEqual(lease['pid'], restarted.pid)
        self.assertEqual(self.state.read_bytes(), self.original_state)

    def test_live_legacy_owner_is_never_evicted(self):
        lease = Path(str(self.state)+'.lock')
        original = json.dumps({'pid':os.getpid(),'startedAt':'offline-live-owner'})
        lease.write_text(original)
        result = subprocess.run(self.command(), capture_output=True, text=True, timeout=5)
        self.assertNotEqual(result.returncode,0)
        self.assertIn('legacy_owner_alive',result.stderr)
        self.assertEqual(lease.read_text(),original)
        self.assertEqual(self.state.read_bytes(),self.original_state)

    def test_corrupt_or_symlink_pid_lease_is_not_removed(self):
        lease = Path(str(self.state)+'.lock')
        lease.write_text('not-json')
        result = subprocess.run(self.command(), capture_output=True, text=True, timeout=5)
        self.assertNotEqual(result.returncode,0)
        self.assertIn('pid_lease_invalid',result.stderr)
        self.assertEqual(lease.read_text(),'not-json')
        lease.unlink()
        target=self.root/'retained.txt'
        target.write_text('preserve')
        lease.symlink_to(target)
        result = subprocess.run(self.command(), capture_output=True, text=True, timeout=5)
        self.assertNotEqual(result.returncode,0)
        self.assertTrue(lease.is_symlink())
        self.assertEqual(target.read_text(),'preserve')

    def test_invalid_config_refuses_before_touching_owner_or_pid_lease(self):
        config=json.loads((HERE.parent/'integration.example.json').read_text())
        config['bridge']['statePath']=str(self.root/'different.json')
        config_path=self.root/'bad-config.json';config_path.write_text(json.dumps(config))
        lease=Path(str(self.state)+'.lock');lease.write_text('{"pid":99999999}')
        result=subprocess.run([sys.executable,'-B',str(SHIM),'--state',str(self.state),'--config',str(config_path),'--',NODE,str(self.fixture)],capture_output=True,text=True,timeout=10)
        self.assertNotEqual(result.returncode,0)
        self.assertIn('config_state_mismatch',result.stderr)
        self.assertEqual(lease.read_text(),'{"pid":99999999}')
        self.assertFalse(Path(str(self.state)+'.owner.lock').exists())

    def test_config_argv_survives_environment_cleanup_and_only_auth_ref_is_forwarded(self):
        config=json.loads((HERE.parent/'integration.example.json').read_text())
        config['bridge']['statePath']=str(self.state)
        config_path=self.root/'config.json';config_path.write_text(json.dumps(config))
        probe=self.root/'probe.mjs'
        probe.write_text("console.log(JSON.stringify({config:process.argv[2],auth:process.env.PAPERCLIP_BRIDGE_READ_IDENTITY==='synthetic-only',other:process.env.UNRELATED_TOKEN??null,ambient:process.env.PAPERCLIP_INTEGRATION_CONFIG??null}));")
        env={**os.environ,'PAPERCLIP_BRIDGE_READ_IDENTITY':'synthetic-only','UNRELATED_TOKEN':'synthetic-other','PAPERCLIP_INTEGRATION_CONFIG':'discard-me'}
        result=subprocess.run([sys.executable,'-B',str(SHIM),'--state',str(self.state),'--config',str(config_path),'--',NODE,str(probe),str(config_path)],env=env,capture_output=True,text=True,timeout=10)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(json.loads(result.stdout),{'config':str(config_path),'auth':True,'other':None,'ambient':None})
        self.assertEqual(self.state.read_bytes(),self.original_state)

if __name__ == '__main__':
    unittest.main()
