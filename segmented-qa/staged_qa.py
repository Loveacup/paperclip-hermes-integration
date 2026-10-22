#!/usr/bin/env python3
"""One-shot, local segmented QA. Paperclip owns process lifetime.

Transitions: absent -> prepared -> admitted -> receipted -> reported.
An admitted execution without a valid receipt is terminal/uncertain, never retried.
Hashes detect corruption, not an attacker rewriting the entire evidence trust root.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys

COVERAGE = 'product_blackbox_automated_subset'
BASE_FILES = ('md_link_audit.py', 'qa/run_qa.py', 'qa/test_blackbox.py', 'qa/fixtures.py')

class QAError(ValueError):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, ensure_ascii=False, indent=2) + '\n').encode()


def safe(path):
    path = Path(path)
    if '..' in path.parts:
        raise QAError('path traversal/alias refused')
    path = path.absolute()
    for node in (path,) + tuple(path.parents):
        if node.is_symlink():
            raise QAError('symlink path refused')
    if path.is_file() and path.stat().st_nlink != 1:
        raise QAError('hardlink alias refused')
    return path


def exclusive(path, data, reuse=False):
    path = safe(path)
    if path.exists():
        if reuse and path.is_file() and path.read_bytes() == data:
            return
        raise QAError('existing output conflict: ' + str(path))
    try:
        with path.open('xb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        fd = os.open(str(path.parent), os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    except FileExistsError as exc:
        raise QAError('exclusive output already exists') from exc


def fresh(path):
    path = safe(path)
    try:
        path.mkdir(parents=True, exist_ok=False)
    except FileExistsError as exc:
        raise QAError('output directory already exists') from exc
    return path


def prepare(source_project, destination):
    source = safe(source_project)
    destination = safe(destination)
    if source == destination or source in destination.parents or destination in source.parents:
        raise QAError('source/output overlap')
    names = list(BASE_FILES)
    guard = safe(source / 'qa/guard')
    names += [p.relative_to(source).as_posix() for p in sorted(guard.rglob('*.py'))]
    if not any(n.startswith('qa/guard/') for n in names):
        raise QAError('guard source missing')
    contents = {n: safe(source / n).read_bytes() for n in names}
    fresh(destination)
    for name, data in contents.items():
        target = destination / 'snapshot' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        exclusive(target, data)
    contract = dict(schema='segmented-qa/v1', snapshot='snapshot',
                    files={n: digest(b) for n, b in contents.items()}, mode='d1',
                    expected_tests=23, coverage=COVERAGE, manual_acceptance='PENDING')
    exclusive(destination / 'contract.json', encoded(contract))
    return destination / 'contract.json'


def load_contract(path):
    path = safe(path)
    raw = path.read_bytes()
    doc = json.loads(raw)
    required = dict(schema='segmented-qa/v1', snapshot='snapshot', mode='d1',
                    expected_tests=23, coverage=COVERAGE, manual_acceptance='PENDING')
    if any(doc.get(k) != v for k, v in required.items()):
        raise QAError('unsupported contract')
    files = doc.get('files', {})
    if not isinstance(files, dict) or not set(BASE_FILES) <= set(files):
        raise QAError('missing source allowlist')
    for name, expected in files.items():
        if name not in BASE_FILES and not (name.startswith('qa/guard/') and name.endswith('.py')):
            raise QAError('source outside allowlist')
        if Path(name).is_absolute() or '..' in Path(name).parts:
            raise QAError('invalid source path')
        if digest(safe(path.parent / 'snapshot' / name).read_bytes()) != expected:
            raise QAError('frozen source changed')
    actual = {p.relative_to(path.parent / 'snapshot').as_posix()
              for p in (path.parent / 'snapshot').rglob('*') if not p.is_dir()}
    if actual != set(files):
        raise QAError('snapshot inventory changed')
    return doc, digest(raw)


def disjoint(a, b):
    if a == b or a in b.parents or b in a.parents:
        raise QAError('input/output overlap')


def artifact_inventory(root):
    """Never follow fixture symlinks; bind their literal targets instead."""
    result = {}
    for folder, dirs, files in os.walk(root, followlinks=False):
        for name in sorted(dirs + files):
            p = Path(folder) / name
            rel = p.relative_to(root).as_posix()
            if p.is_symlink():
                result[rel] = digest(b'symlink\0' + os.readlink(p).encode())
            elif p.is_file():
                result[rel] = digest(safe(p).read_bytes())
            elif not p.is_dir():
                raise QAError('special artifact refused')
    return dict(sorted(result.items()))


def _run_original(snapshot, machine, contract):
    """Run original main in-process, no supervisor or process-group changes."""
    import contextlib
    import types
    import unittest
    runtime = machine / 'runtime'
    for name in contract['files']:
        p = runtime / name
        p.parent.mkdir(parents=True, exist_ok=True)
        exclusive(p, (snapshot / name).read_bytes())
    work = fresh(machine / 'work')
    saved_modules = {n: sys.modules.get(n) for n in ('fixtures', 'test_blackbox', 'run_qa')}
    old_argv, old_env = sys.argv[:], dict(os.environ)
    observations = {}
    class ObservedRunner(unittest.TextTestRunner):
        def run(self, suite):
            ids = [t.id() for t in suite]
            result = super().run(suite)
            observations.update(tests_run=result.testsRun, failures=len(result.failures),
                                errors=len(result.errors), skips=len(result.skipped), test_ids=ids)
            return result
    try:
        # Allowlist, not a provider-name denylist: unknown credential names also stay out.
        allowed = {'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SYSTEMROOT'}
        os.environ.clear()
        os.environ.update({k: v for k, v in old_env.items() if k in allowed})
        os.environ.update(PYTHONDONTWRITEBYTECODE='1', TMPDIR=str(work), TMP=str(work), TEMP=str(work))
        for name in saved_modules:
            p = runtime / 'qa' / (name + '.py')
            module = types.ModuleType(name)
            module.__file__ = str(p)
            sys.modules[name] = module
            exec(compile(p.read_bytes(), str(p), 'exec'), module.__dict__)
        runner = sys.modules['run_qa']
        runner.workspace = lambda: work
        runner.unittest = types.SimpleNamespace(defaultTestLoader=unittest.defaultTestLoader,
                                                TestSuite=unittest.TestSuite, TextTestRunner=ObservedRunner)
        sys.argv = [str(runtime / 'qa/run_qa.py'), '--mode', 'd1', '--cli', str(runtime / 'md_link_audit.py')]
        with (machine / 'runner.txt').open('x', encoding='utf-8') as log:
            with contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
                observations['exit_code'] = runner.main()
        return observations
    finally:
        sys.argv = old_argv
        os.environ.clear()
        os.environ.update(old_env)
        for name, previous in saved_modules.items():
            if previous is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = previous


def validate_result(machine, contract):
    data = json.loads(safe(machine / 'work/result.json').read_bytes())
    obs = json.loads(safe(machine / 'observation.json').read_bytes())
    log = safe(machine / 'work/unittest.txt').read_text()
    counts = {k: obs.get(k) for k in ('tests_run', 'failures', 'errors', 'skips')}
    if any(type(v) is not int or v < 0 for v in counts.values()):
        raise QAError('invalid observed counts')
    if counts['tests_run'] != 23 or counts['skips'] != 0 or counts['errors'] != 0:
        # Assertion failures are product FAIL; unexpected harness exceptions (including
        # subprocess timeouts) cannot certify a complete, known-effect execution.
        raise QAError('incomplete suite: partial, skipped or infrastructure errors')
    if counts['failures'] > counts['tests_run']:
        raise QAError('impossible failure count')
    ids = obs.get('test_ids', [])
    if len(ids) != 23 or len(set(ids)) != 23 or any(not x.startswith('test_blackbox.Acceptance.test_') for x in ids):
        raise QAError('incomplete suite identities')
    if 'Ran 23 tests in ' not in log or any(x.split('.')[-1] not in log for x in ids):
        raise QAError('unittest evidence incomplete')
    for key in ('tests_run', 'failures', 'errors'):
        if type(data.get(key)) is not int or data[key] != counts[key]:
            raise QAError('result/observation counts mismatch')
    verdict = 'FAIL' if counts['failures'] or counts['errors'] else 'PASS'
    if (data.get('status') != verdict or data.get('skips') != [] or
        data.get('mode') != 'd1' or data.get('kind') != COVERAGE or
        data.get('cli_sha256') != contract['files']['md_link_audit.py'] or
        data.get('cli') != str(machine / 'runtime/md_link_audit.py') or
        obs.get('exit_code') != int(verdict == 'FAIL') or
        not str(data.get('manual_acceptance', '')).startswith('PENDING')):
        raise QAError('result semantics mismatch')
    if not (machine / 'work/commands.jsonl').is_file():
        raise QAError('missing subprocess evidence')
    for name, expected in contract['files'].items():
        if digest(safe(machine / 'runtime' / name).read_bytes()) != expected:
            raise QAError('executed source changed')
    return verdict, counts


def bound_artifacts(machine):
    entries = artifact_inventory(machine)
    for key in ('admission.json', 'receipt.json', 'receipt.sha256'):
        entries.pop(key, None)
    # Dedicated publication metadata is outside the sealed QA evidence namespace.
    return {k: v for k, v in entries.items() if not k.startswith('native-publication/')}


def verify(contract_path, machine_dir):
    contract_path, machine = safe(contract_path), safe(machine_dir)
    disjoint(contract_path.parent, machine)
    contract, contract_hash = load_contract(contract_path)
    admission = json.loads(safe(machine / 'admission.json').read_bytes())
    expected_admission = dict(schema='segmented-qa-admission/v1', contract_sha256=contract_hash,
                              machine_dir=str(machine), execution_count=1)
    if admission != expected_admission or safe(machine / 'admission.json').read_bytes() != encoded(expected_admission):
        raise QAError('admission binding mismatch')
    raw = safe(machine / 'receipt.json').read_bytes()
    if safe(machine / 'receipt.sha256').read_text() != digest(raw) + '\n':
        raise QAError('receipt digest mismatch')
    receipt = json.loads(raw)
    verdict, counts = validate_result(machine, contract)
    expected = dict(schema='segmented-qa-receipt/v1', contract_sha256=contract_hash,
                    admission_sha256=digest(encoded(admission)), coverage=COVERAGE,
                    manual_acceptance='PENDING', verdict=verdict, counts=counts,
                    artifacts=bound_artifacts(machine))
    if receipt != expected:
        raise QAError('receipt/artifact binding mismatch')
    return receipt


def execute(contract_path, machine_dir):
    contract_path, machine = safe(contract_path), safe(machine_dir)
    disjoint(contract_path.parent, machine)
    contract, contract_hash = load_contract(contract_path)
    if machine.exists():
        # Any existing partial execution fails closed; no speculative recovery.
        return verify(contract_path, machine)
    fresh(machine)
    admission = dict(schema='segmented-qa-admission/v1', contract_sha256=contract_hash,
                     machine_dir=str(machine), execution_count=1)
    exclusive(machine / 'admission.json', encoded(admission))
    obs = _run_original(contract_path.parent / 'snapshot', machine, contract)
    exclusive(machine / 'observation.json', encoded(obs))
    if load_contract(contract_path)[1] != contract_hash:
        raise QAError('contract changed during execution')
    verdict, counts = validate_result(machine, contract)
    receipt = dict(schema='segmented-qa-receipt/v1', contract_sha256=contract_hash,
                   admission_sha256=digest(encoded(admission)), coverage=COVERAGE,
                   manual_acceptance='PENDING', verdict=verdict, counts=counts,
                   artifacts=bound_artifacts(machine))
    exclusive(machine / 'receipt.json', encoded(receipt))
    exclusive(machine / 'receipt.sha256', (digest(encoded(receipt)) + '\n').encode())
    return verify(contract_path, machine)


def closeout(contract_path, machine_dir, closeout_dir, after_report=None):
    receipt = verify(contract_path, machine_dir)
    close = safe(closeout_dir)
    disjoint(close, safe(contract_path).parent)
    disjoint(close, safe(machine_dir))
    machine_digest = digest(safe(Path(machine_dir) / 'receipt.json').read_bytes())
    text = ('# Segmented QA report\n\n'
            'Coverage: ' + COVERAGE + '\n'
            'Machine verdict: ' + receipt['verdict'] + '\n'
            'Counts: ' + json.dumps(receipt['counts'], sort_keys=True) + '\n'
            'Manual acceptance: PENDING\n'
            'Machine receipt SHA256: ' + machine_digest + '\n'
            'This automated subset is not full product or live orchestration acceptance.\n').encode()
    result = dict(schema='segmented-qa-closeout/v1', machine_receipt_sha256=machine_digest,
                  report_sha256=digest(text), verdict=receipt['verdict'], coverage=COVERAGE,
                  manual_acceptance='PENDING')
    if not close.exists():
        fresh(close)
    elif not close.is_dir() or any(p.name not in {'REPORT.md', 'receipt.json', 'native-publication'} for p in close.iterdir()):
        raise QAError('closeout output conflict')
    # Validate existing receipt before writing any missing output.
    if (close / 'receipt.json').exists():
        if safe(close / 'receipt.json').read_bytes() != encoded(result) or not (close / 'REPORT.md').exists():
            raise QAError('closeout receipt conflict')
    exclusive(close / 'REPORT.md', text, reuse=True)
    if after_report is not None:
        after_report()
    exclusive(close / 'receipt.json', encoded(result), reuse=True)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest='operation', required=True)
    prep = subs.add_parser('prepare')
    prep.add_argument('--source-project', required=True)
    prep.add_argument('--destination', required=True)
    for name in ('machine', 'verify', 'closeout'):
        p = subs.add_parser(name)
        p.add_argument('--contract', required=True)
        p.add_argument('--machine-dir', required=True)
        if name == 'closeout':
            p.add_argument('--closeout-dir', required=True)
        if name != 'verify':
            p.add_argument('--native-finish', action='store_true')
    args = parser.parse_args(argv)
    try:
        if args.operation == 'prepare':
            print(prepare(args.source_project, args.destination))
            return 0
        if args.operation == 'machine':
            result = execute(args.contract, args.machine_dir)
            stage = Path(args.machine_dir)
        elif args.operation == 'closeout':
            result = closeout(args.contract, args.machine_dir, args.closeout_dir)
            stage = Path(args.closeout_dir)
        else:
            result = verify(args.contract, args.machine_dir)
            stage = Path(args.machine_dir)
        if getattr(args, 'native_finish', False):
            from native_finish import finish_current_issue
            publication = safe(stage / 'native-publication')
            if not publication.exists():
                fresh(publication)
            if not publication.is_dir():
                raise QAError('native publication output conflict')
            registered = finish_current_issue(summary='Automated QA ' + result['verdict'] + '; manual acceptance PENDING',
                                             receipt_sha256=digest(safe(stage / 'receipt.json').read_bytes()),
                                             intent_dir=publication)
            if not isinstance(registered, dict) or registered.get('verified') is not True or registered.get('status') != 'read_back':
                raise QAError('native registration not verified; no automatic retry')
        print(json.dumps(result, sort_keys=True))
        return 0
    except Exception as exc:
        # No exception payload/log/env dump: provider secrets must not enter evidence.
        print('QA refused: ' + type(exc).__name__, file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
