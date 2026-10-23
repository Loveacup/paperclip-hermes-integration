"""Offline safety tests. Fixtures are synthetic, not upstream host validation."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent

class SafetyTests(unittest.TestCase):
    def test_sdk_fixture_does_not_follow_ambient_temp_alias(self):
        import os
        with tempfile.TemporaryDirectory(dir=HERE) as temporary:
            directory = Path(temporary)
            real = directory / 'real'; real.mkdir()
            alias = directory / 'alias'; alias.symlink_to(real, target_is_directory=True)
            env = {k: os.environ[k] for k in ('PATH', 'HOME', 'LANG') if k in os.environ}
            env.update(TMPDIR=str(alias), TEMP=str(alias), TMP=str(alias))
            result = subprocess.run(['python3', '-B', str(HERE / 'run_repair.py')],
                                    env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn('# pass 8', result.stdout)
            self.assertEqual(list(real.iterdir()), [])

    def fixture(self):
        import hashlib
        self.tmp = tempfile.TemporaryDirectory(dir=HERE)
        self.addCleanup(self.tmp.cleanup)
        home = Path(self.tmp.name)
        package = home/'package'; package.mkdir()
        (package/'apply.py').write_bytes((HERE/'apply.py').read_bytes())
        root = home/'dist'; root.mkdir()
        sha = lambda b: hashlib.sha256(b).hexdigest()
        edits = [{'path': f'target{i}.js', 'baselineSha256': sha(b'old\n'), 'candidateSha256': sha(b'new\n'), 'edits': [{'old': 'old', 'new': 'new'}]} for i in range(3)]
        files = [{'path': x['path'], 'kind': 'target', 'sha256': x['baselineSha256']} for x in edits]
        files.append({'path': 'dep.js', 'kind': 'read-dependency', 'sha256': sha(b'dep\n')})
        (package/'manifest.json').write_text(json.dumps(edits))
        (package/'source-baseline.json').write_text(json.dumps({'schemaVersion':1, 'files':files}))
        for x in edits: (root/x['path']).write_bytes(b'old\n')
        (root/'dep.js').write_bytes(b'dep\n')
        return package, root

    def run_apply(self, package, root, *args):
        return subprocess.run(['python3', str(package/'apply.py'), '--root', str(root), *args], capture_output=True, text=True)

    def test_dependency_drift_refuses_all_writes(self):
        package, root = self.fixture()
        (root/'dep.js').write_bytes(b'foreign\n')
        result = self.run_apply(package, root, '--apply')
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn('hash mismatch', result.stderr)
        for i in range(3): self.assertEqual((root/f'target{i}.js').read_bytes(), b'old\n')

    def test_symlink_root_is_rejected(self):
        package, root = self.fixture()
        alias = root.parent/'alias'; alias.symlink_to(root, target_is_directory=True)
        result = self.run_apply(package, alias, '--apply')
        self.assertNotEqual(result.returncode, 0)
        for i in range(3): self.assertEqual((root/f'target{i}.js').read_bytes(), b'old\n')

    def test_symlink_dependency_is_rejected(self):
        package, root = self.fixture()
        dep = root/'dep.js'; dep.rename(root.parent/'real-dep.js'); dep.symlink_to(root.parent/'real-dep.js')
        result = self.run_apply(package, root, '--apply')
        self.assertNotEqual(result.returncode, 0)
        for i in range(3): self.assertEqual((root/f'target{i}.js').read_bytes(), b'old\n')

    def test_dependency_rechecked_immediately_before_write(self):
        from unittest.mock import patch
        package, root = self.fixture()
        spec = importlib.util.spec_from_file_location('portable_apply', package/'apply.py')
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        def interfere(*args, **kwargs):
            if args and args[0] == 'CHECK OK': (root/'dep.js').write_bytes(b'drift\n')
        with patch('sys.argv', ['apply.py', '--root', str(root), '--apply']), patch('builtins.print', side_effect=interfere):
            with self.assertRaisesRegex(ValueError, 'concurrent'):
                module.main()
        for i in range(3): self.assertEqual((root/f'target{i}.js').read_bytes(), b'old\n')

    def test_hardlink_target_rejected(self):
        import os
        package, root = self.fixture()
        os.link(root/'target0.js', root.parent/'outside.js')
        result = self.run_apply(package, root, '--apply')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((root.parent/'outside.js').read_bytes(), b'old\n')

    def test_concurrent_dependency_change_stops_partial_apply_without_rollback(self):
        from unittest.mock import patch
        package, root = self.fixture()
        spec = importlib.util.spec_from_file_location('portable_apply', package/'apply.py')
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        def interfere(*args, **kwargs):
            if args and args[0] == 'APPLIED': (root/'dep.js').write_bytes(b'drift\n')
        with patch('sys.argv', ['apply.py', '--root', str(root), '--apply']), patch('builtins.print', side_effect=interfere):
            with self.assertRaisesRegex(ValueError, 'concurrent'):
                module.main()
        self.assertEqual((root/'target0.js').read_bytes(), b'new\n')
        self.assertEqual((root/'target1.js').read_bytes(), b'old\n')
        self.assertEqual((root/'target2.js').read_bytes(), b'old\n')

    def test_default_and_preview_are_read_only_regression(self):
        package, root = self.fixture()
        for args in [(), ('--preview',)]:
            result = self.run_apply(package, root, *args)
            self.assertEqual(result.returncode, 0, result.stderr)
            for i in range(3): self.assertEqual((root/f'target{i}.js').read_bytes(), b'old\n')
        self.assertIn('--- ', result.stdout)

    def test_explicit_apply_exact_candidate_and_second_apply_refused_regression(self):
        package, root = self.fixture()
        result = self.run_apply(package, root, '--apply')
        self.assertEqual(result.returncode, 0, result.stderr)
        for i in range(3): self.assertEqual((root/f'target{i}.js').read_bytes(), b'new\n')
        self.assertNotEqual(self.run_apply(package, root, '--apply').returncode, 0)
        for i in range(3): self.assertEqual((root/f'target{i}.js').read_bytes(), b'new\n')
        self.assertEqual((root/'dep.js').read_bytes(), b'dep\n')

    def test_each_target_drift_zero_writes_regression(self):
        for index in range(3):
            package, root = self.fixture()
            (root/f'target{index}.js').write_bytes(b'foreign\n')
            before = {f.name:f.read_bytes() for f in root.iterdir()}
            self.assertNotEqual(self.run_apply(package, root, '--apply').returncode, 0)
            self.assertEqual({f.name:f.read_bytes() for f in root.iterdir()}, before)

    def test_ambiguous_and_candidate_hash_mismatch_zero_writes_regression(self):
        for edit in [{'old':'missing', 'new':'new'}, {'old':'old', 'new':'unexpected'}]:
            package, root = self.fixture()
            manifest = json.loads((package/'manifest.json').read_text())
            manifest[-1]['edits'] = [edit]
            (package/'manifest.json').write_text(json.dumps(manifest))
            self.assertNotEqual(self.run_apply(package, root, '--apply').returncode, 0)
            for i in range(3): self.assertEqual((root/f'target{i}.js').read_bytes(), b'old\n')

    def test_parent_traversal_and_absolute_manifest_paths_rejected(self):
        for relative in ['../outside.js', '/outside.js']:
            package, root = self.fixture()
            manifest = json.loads((package/'manifest.json').read_text()); manifest[0]['path'] = relative
            (package/'manifest.json').write_text(json.dumps(manifest))
            self.assertNotEqual(self.run_apply(package, root, '--apply').returncode, 0)
            for i in range(3): self.assertEqual((root/f'target{i}.js').read_bytes(), b'old\n')

    def test_nested_symlink_rejected(self):
        package, root = self.fixture()
        (root/'nested').symlink_to(root, target_is_directory=True)
        baseline = json.loads((package/'source-baseline.json').read_text())
        baseline['files'][-1]['path'] = 'nested/dep.js'
        (package/'source-baseline.json').write_text(json.dumps(baseline))
        self.assertNotEqual(self.run_apply(package, root, '--apply').returncode, 0)
        for i in range(3): self.assertEqual((root/f'target{i}.js').read_bytes(), b'old\n')

    def test_real_manifest_edits_on_synthetic_seams_not_host_sources(self):
        import hashlib
        package, root = self.fixture()
        manifest = json.loads((HERE/'manifest.json').read_text())
        files = []
        sha = lambda data: hashlib.sha256(data).hexdigest()
        for item in manifest:
            text = '\n// SYNTHETIC SEAM\n'.join(e['old'] for e in item['edits'])
            before = text.encode()
            for e in item['edits']:
                self.assertEqual(text.count(e['old']), 1)
                text = text.replace(e['old'], e['new'], 1)
            item['baselineSha256'] = sha(before); item['candidateSha256'] = sha(text.encode())
            target = root/item['path']; target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(before)
            files.append({'path':item['path'], 'kind':'target', 'sha256':sha(before)})
        (package/'manifest.json').write_text(json.dumps(manifest))
        (package/'source-baseline.json').write_text(json.dumps({'files':files}))
        result = self.run_apply(package, root, '--apply')
        self.assertEqual(result.returncode, 0, result.stderr)
        for item in manifest:
            self.assertEqual(sha((root/item['path']).read_bytes()), item['candidateSha256'])

    def test_public_manifest_consistency(self):
        manifest = json.loads((HERE/'manifest.json').read_text())
        baseline = json.loads((HERE/'source-baseline.json').read_text())
        targets = {x['path']:x['sha256'] for x in baseline['files'] if x['kind']=='target'}
        self.assertEqual({x['path']:x['baselineSha256'] for x in manifest}, targets)
        self.assertEqual(len(targets), 3)
        self.assertEqual(len(baseline['files']), 6)
        self.assertEqual([p['version'] for p in baseline['packages']], ['2026.1005.0']*2)

    def test_host_runner_requires_explicit_root(self):
        result = subprocess.run(['python3', str(HERE/'run_host.py')], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn('--root', result.stderr)

    def test_root_is_required(self):
        result = subprocess.run(['python3', str(HERE/'apply.py')], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn('--root', result.stderr)
        self.assertNotIn('/Users/', result.stderr)

if __name__ == '__main__':
    unittest.main(verbosity=2)
