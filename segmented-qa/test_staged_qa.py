import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import staged_qa as qa

SOURCE = Path(__file__).resolve().parent / 'fixtures/md-link-audit'

class StagedTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def test_prepare_freezes_only_source(self):
        contract = qa.prepare(SOURCE, self.root / 'stage')
        doc = json.loads(contract.read_text())
        self.assertEqual(doc['expected_tests'], 23)
        self.assertEqual(doc['manual_acceptance'], 'PENDING')
        self.assertFalse(any('.runs' in p for p in doc['files']))
        for name, digest in doc['files'].items():
            self.assertEqual(hashlib.sha256((SOURCE / name).read_bytes()).hexdigest(), digest)
        with self.assertRaises(qa.QAError):
            qa.prepare(SOURCE, self.root / 'stage')

    def test_real_machine_once_and_readonly_verify(self):
        contract = qa.prepare(SOURCE, self.root / 'stage')
        machine = self.root / 'machine'
        before = {n: (SOURCE / n).read_bytes() for n in json.loads(contract.read_text())['files']}
        import subprocess
        original_run = subprocess.run
        seen = []
        def guarded_run(*args, **kwargs):
            self.assertNotIn('PAPERCLIP_API_KEY', kwargs['env'])
            self.assertNotIn('UNLISTED_PROVIDER_SECRET', kwargs['env'])
            self.assertNotIn('start_new_session', kwargs)
            self.assertNotIn('preexec_fn', kwargs)
            seen.append(1)
            return original_run(*args, **kwargs)
        with patch.dict(os.environ, {'PAPERCLIP_API_KEY': 'synthetic-secret', 'UNLISTED_PROVIDER_SECRET': 'synthetic-secret'}), patch('subprocess.run', side_effect=guarded_run):
            receipt = qa.execute(contract, machine)
        self.assertTrue(seen)
        self.assertEqual(receipt['counts']['tests_run'], 23)
        self.assertEqual(receipt['verdict'], 'PASS')
        with patch.object(qa, '_run_original', side_effect=AssertionError('rerun')):
            self.assertEqual(qa.execute(contract, machine), receipt)
            self.assertEqual(qa.verify(contract, machine), receipt)
        self.assertEqual(before, {n: (SOURCE / n).read_bytes() for n in before})

    def test_closeout_interruption_is_report_only(self):
        contract = qa.prepare(SOURCE, self.root / 'stage')
        machine = self.root / 'machine'
        qa.execute(contract, machine)
        close = self.root / 'close'
        with patch.object(qa, '_run_original', side_effect=AssertionError('rerun')):
            with self.assertRaisesRegex(RuntimeError, 'after report'):
                qa.closeout(contract, machine, close, after_report=lambda: (_ for _ in ()).throw(RuntimeError('after report')))
            first = (close / 'REPORT.md').read_bytes()
            result = qa.closeout(contract, machine, close)
            self.assertEqual(first, (close / 'REPORT.md').read_bytes())
            self.assertEqual(result, qa.closeout(contract, machine, close))
            self.assertEqual(result['manual_acceptance'], 'PENDING')

    def synthetic(self, snapshot, machine, contract, failures=0, skips=0, tests=23):
        """Explicit synthetic executor seam for corruption tests; not product proof."""
        import ast
        import shutil
        shutil.copytree(snapshot, machine / 'runtime')
        work = machine / 'work'
        work.mkdir()
        ids = ['test_blackbox.Acceptance.' + n.name for n in ast.walk(ast.parse((snapshot / 'qa/test_blackbox.py').read_text()))
               if isinstance(n, ast.FunctionDef) and n.name.startswith('test_')]
        obs = dict(tests_run=tests, failures=failures, errors=0, skips=skips,
                   test_ids=ids, exit_code=int(failures > 0))
        data = dict(kind=qa.COVERAGE, mode='d1', status='FAIL' if failures else 'PASS',
                    tests_run=tests, failures=failures, errors=0, skips=[],
                    cli=str(machine / 'runtime/md_link_audit.py'),
                    cli_sha256=contract['files']['md_link_audit.py'], manual_acceptance='PENDING')
        (work / 'result.json').write_bytes(qa.encoded(data))
        (work / 'unittest.txt').write_text('\n'.join(ids) + '\nRan 23 tests in 0.01s\n')
        (work / 'commands.jsonl').write_text('{"synthetic_test_only":true}\n')
        return obs

    def fixture(self, **kwargs):
        contract = qa.prepare(SOURCE, self.root / 'stage')
        machine = self.root / 'machine'
        with patch.object(qa, '_run_original', side_effect=lambda *a: self.synthetic(*a, **kwargs)):
            receipt = qa.execute(contract, machine)
        return contract, machine, receipt

    def test_fail_verdict_is_completed_and_cli_zero(self):
        import contextlib
        import io
        contract, machine, receipt = self.fixture(failures=1)
        self.assertEqual(receipt['verdict'], 'FAIL')
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(qa.main(['machine', '--contract', str(contract), '--machine-dir', str(machine)]), 0)
        self.assertEqual(qa.closeout(contract, machine, self.root / 'close')['verdict'], 'FAIL')

    def test_incomplete_never_reexecutes(self):
        for tests, skips in [(0, 0), (22, 0), (23, 1)]:
            with self.subTest(tests=tests, skips=skips):
                contract = qa.prepare(SOURCE, self.root / ('stage' + str(tests)))
                machine = self.root / ('machine' + str(tests))
                with patch.object(qa, '_run_original', side_effect=lambda *a: self.synthetic(*a, tests=tests, skips=skips)) as run:
                    with self.assertRaises(qa.QAError):
                        qa.execute(contract, machine)
                    with self.assertRaises((qa.QAError, OSError)):
                        qa.execute(contract, machine)
                    self.assertEqual(run.call_count, 1)
                self.assertTrue((machine / 'admission.json').exists())
                self.assertFalse((machine / 'receipt.json').exists())

    def test_infrastructure_exception_preserves_admission(self):
        contract = qa.prepare(SOURCE, self.root / 'stage')
        machine = self.root / 'machine'
        with patch.object(qa, '_run_original', side_effect=RuntimeError('interrupted')) as run:
            with self.assertRaises(RuntimeError):
                qa.execute(contract, machine)
            with self.assertRaises(OSError):
                qa.execute(contract, machine)
            self.assertEqual(run.call_count, 1)
        self.assertFalse((machine / 'receipt.json').exists())

    def test_tampering_refused_without_execution(self):
        contract, machine, receipt = self.fixture()
        targets = [contract, contract.parent / 'snapshot/md_link_audit.py',
                   machine / 'receipt.json', machine / 'work/result.json',
                   machine / 'work/unittest.txt', machine / 'admission.json',
                   machine / 'runtime/qa/guard/sitecustomize.py']
        for target in targets:
            with self.subTest(target=target):
                original = target.read_bytes()
                target.write_bytes(original + b' ')
                with patch.object(qa, '_run_original', side_effect=AssertionError('rerun')):
                    with self.assertRaises((qa.QAError, ValueError)):
                        qa.execute(contract, machine)
                target.write_bytes(original)
        self.assertEqual(qa.verify(contract, machine), receipt)

    def test_missing_partial_and_symlink_receipt(self):
        contract, machine, _ = self.fixture()
        path = machine / 'receipt.json'
        original = path.read_bytes()
        for value in [None, b'{']:
            if value is None:
                path.unlink()
            else:
                path.write_bytes(value)
            with self.assertRaises((qa.QAError, ValueError, OSError)):
                qa.execute(contract, machine)
        path.unlink()
        outside = self.root / 'other.json'
        outside.write_bytes(original)
        path.symlink_to(outside)
        with self.assertRaises(qa.QAError):
            qa.verify(contract, machine)

    def test_output_alias_and_conflict(self):
        contract = qa.prepare(SOURCE, self.root / 'stage')
        alias = self.root / 'alias'
        alias.symlink_to(self.root / 'stage', target_is_directory=True)
        for output in [alias / 'machine', contract.parent, contract.parent / 'child']:
            with self.assertRaises(qa.QAError):
                qa.execute(contract, output)
        output = self.root / 'occupied'
        output.mkdir()
        (output / 'keep').write_text('unchanged')
        with self.assertRaises(OSError):
            qa.execute(contract, output)
        self.assertEqual((output / 'keep').read_text(), 'unchanged')

    def test_native_publication_is_separate_and_opt_in(self):
        import contextlib
        import io
        import types
        import sys
        contract, machine, receipt = self.fixture()
        called = []
        def finish(**kw):
            called.append(kw)
            self.assertTrue(kw['intent_dir'].is_dir())
            (kw['intent_dir'] / 'finish.intent.json').write_text('synthetic-publication')
            return {'status': 'read_back', 'verified': True}
        fake = types.SimpleNamespace(finish_current_issue=finish)
        with patch.dict(sys.modules, {'native_finish': fake}), contextlib.redirect_stdout(io.StringIO()):
            args = ['machine', '--contract', str(contract), '--machine-dir', str(machine)]
            self.assertEqual(qa.main(args), 0)
            self.assertEqual(called, [])
            self.assertEqual(qa.main(args + ['--native-finish']), 0)
        self.assertEqual(called[0]['intent_dir'], machine / 'native-publication')
        self.assertEqual(qa.verify(contract, machine), receipt)
        (machine / 'work/unexpected').write_text('tamper')
        with self.assertRaises(qa.QAError):
            qa.verify(contract, machine)

    def test_one_subprocess_timeout_is_infrastructure_not_completed_fail(self):
        import subprocess
        original_run = subprocess.run
        calls = []
        def timeout_once(*args, **kwargs):
            calls.append(1)
            if len(calls) == 1:
                raise subprocess.TimeoutExpired(args[0], 30)
            return original_run(*args, **kwargs)
        contract = qa.prepare(SOURCE, self.root / 'stage')
        machine = self.root / 'machine'
        with patch('subprocess.run', side_effect=timeout_once):
            with self.assertRaises(qa.QAError):
                qa.execute(contract, machine)
        self.assertFalse((machine / 'receipt.json').exists())

    def test_admission_visible_before_executor_and_reentrant_owner_refused(self):
        contract = qa.prepare(SOURCE, self.root / 'stage')
        machine = self.root / 'machine'
        def executor(*args):
            self.assertEqual(json.loads((machine / 'admission.json').read_text())['execution_count'], 1)
            with self.assertRaises(OSError):
                qa.execute(contract, machine)
            return self.synthetic(*args)
        with patch.object(qa, '_run_original', side_effect=executor) as run:
            qa.execute(contract, machine)
            self.assertEqual(run.call_count, 1)

    def test_report_conflict_is_not_overwritten(self):
        contract, machine, _ = self.fixture()
        close = self.root / 'close'
        close.mkdir()
        report = close / 'REPORT.md'
        report.write_text('preserve')
        with self.assertRaises(qa.QAError):
            qa.closeout(contract, machine, close)
        self.assertEqual(report.read_text(), 'preserve')
        self.assertFalse((close / 'receipt.json').exists())

if __name__ == '__main__':
    unittest.main()
