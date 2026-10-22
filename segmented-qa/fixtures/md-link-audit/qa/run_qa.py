#!/usr/bin/env python3
"""All generated inputs, reports, caches and subprocess logs remain below qa/."""
import argparse
import ast
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
from fixtures import CASES, FIELDS, STATUSES, build, inventory, order
import test_blackbox as blackbox

QA = Path(__file__).absolute().parent


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def workspace():
    folder = QA / '.runs'
    folder.mkdir(exist_ok=True)
    if folder.is_symlink():
        raise ValueError('QA runtime directory must not be a symlink')
    return Path(tempfile.mkdtemp(prefix='run-', dir=folder))


def self_check(work):
    checks = []
    for path in sorted(QA.glob('*.py')) + sorted((QA / 'guard').glob('*.py')):
        ast.parse(path.read_text(encoding='utf-8'), filename=str(path))
        checks.append('syntax:' + path.relative_to(QA).as_posix())
    fixture_dir = work / 'fixtures'
    fixture_dir.mkdir()
    for case in CASES:
        root, manifest = build(case, fixture_dir / case)
        assert manifest['input_inventory'] == inventory(root)
        assert manifest['expected'] == sorted(manifest['expected'], key=order)
        for row in manifest['expected']:
            assert set(row) == set(FIELDS)
            assert row['status'] in STATUSES
            if row['line'] is None:
                assert all(row[k] is None for k in ('line', 'column', 'raw', 'target'))
                continue
            source = root / row['source']
            text = source.read_text(encoding='utf-8-sig')
            line = text.splitlines()[row['line'] - 1]
            start = row['column'] - 1
            assert line[start:start + len(row['raw'])] == row['raw'], (case, row, line)
        checks.append('fixture:' + case)
        exported_base = QA / 'fixtures' / case
        if exported_base.exists():
            exported = json.loads((exported_base / 'expected.json').read_text(encoding='utf-8'))
            exported_root = exported_base / 'input'
            assert exported['input_inventory'] == inventory(exported_root), ('exported_inventory', case)
            adjusted = json.loads(json.dumps(manifest['expected'], ensure_ascii=False).replace(
                str(root.parent), str(exported_base)))
            assert exported['expected'] == adjusted, ('exported_expected', case)
            for key in ('files_scanned', 'complete', 'broken'):
                assert exported[key] == manifest[key], ('exported_summary', case, key)
            for row in exported['expected']:
                if row['line'] is not None:
                    text = (exported_root / row['source']).read_text(encoding='utf-8-sig')
                    line = text.splitlines()[row['line'] - 1]
                    start = row['column'] - 1
                    assert line[start:start + len(row['raw'])] == row['raw'], ('exported_position', case, row)
            checks.append('exported_fixture:' + case)
    construction = work / 'harness-construction'
    construction.mkdir()
    previous = blackbox.CONTEXT.copy()
    try:
        blackbox.CONTEXT.update(workspace=construction, mode='v1', cli=QA.parent / 'md_link_audit.py')
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(blackbox.Acceptance)
        for test in suite:
            test.setUp()
            test.doCleanups()
        checks.append('harness:all_case_setup_and_input_cleanup')
    finally:
        blackbox.CONTEXT.clear()
        blackbox.CONTEXT.update(previous)
    # Deliberate exact examples test the report reader, not a fake product.
    table = ('| source | line | column | raw | target | status | reason |\n'
             '| --- | --- | --- | --- | --- | --- | --- |\n'
             '| a&#124;&lt;i&gt;&#96;&#92;.md | 1 | 2 | &#91;x&#93;(missing) | missing | broken | missing_target |\n'
             '| empty.md | null | null | null | null | scan_error | invalid_utf8 |\n')
    rows = blackbox.markdown_rows(table)
    assert rows[0] == dict(zip(FIELDS, ('a|<i>`\\.md', 1, 2, '[x](missing)', 'missing', 'broken', 'missing_target')))
    assert rows[1] == dict(zip(FIELDS, ('empty.md', None, None, None, None, 'scan_error', 'invalid_utf8')))
    assert blackbox.cell_decode(r'a\\b\|c\<d\>\`') == 'a\\b|c<d>`'
    assert blackbox.cell_decode('&lt;br&gt;') == '<br>'
    assert blackbox.cell_decode('one<br>two') == 'one\ntwo'
    checks.append('markdown_reader:entities_escapes_null_roundtrip')
    # The fixture oracle must reject a shifted Unicode source column.
    _, manifest = build('A01', work / 'oracle-mutation')
    row = manifest['expected'][0]
    source = (work / 'oracle-mutation/input' / row['source']).read_text()
    bad_start = row['column']  # intentionally +1
    assert source.splitlines()[row['line'] - 1][bad_start:bad_start + len(row['raw'])] != row['raw']
    checks.append('fixture_oracle:rejects_shifted_column')
    guard_root, _ = build('A10', work / 'guard-probe')
    probe_log = []
    scripts = (
        ('ordinary', "from pathlib import Path; print(Path('input/x').read_text())", False),
        ('dns', "import socket; socket.getaddrinfo('qa.invalid',443)", True),
        ('outside', "open('synthetic-outside/canary.md').read()", True),
        ('symlink_dotdot', "open('input/s/../x').read()", True),
    )
    for name, script, blocked in scripts:
        guard_log = work / f'guard-probe-{name}.jsonl'
        env = os.environ.copy()
        env.update(PYTHONPATH=str(QA / 'guard'), PYTHONDONTWRITEBYTECODE='1', QA_GUARD_LOG=str(guard_log))
        p = subprocess.run([sys.executable, '-B', '-c', script], cwd=guard_root.parent,
                           env=env, capture_output=True, text=True, timeout=15)
        events = [json.loads(v) for v in guard_log.read_text().splitlines()]
        assert events[0]['kind'] == 'ready'
        assert (p.returncode != 0) == blocked, (name, p.stderr)
        assert bool([e for e in events if e['kind'] != 'ready']) == blocked
        probe_log.append({'name': name, 'argv': [sys.executable, '-B', '-c', script],
                          'returncode': p.returncode, 'stdout': p.stdout, 'stderr': p.stderr,
                          'events': events})
        checks.append('guard:' + name)
    save(work / 'guard-probes.json', probe_log)
    # A permission probe is measured, never inferred from chmod's success.
    permission = work / 'permission-probe'
    permission.mkdir()
    denied = permission / 'denied.md'
    denied.write_bytes(b'synthetic only\n')
    locked_dir = permission / 'denied-directory'
    locked_dir.mkdir()
    denied.chmod(0); locked_dir.chmod(0)
    limits = {}
    try:
        try:
            denied.read_bytes()
        except PermissionError:
            limits['file_denial_reproducible'] = True
        else:
            limits['file_denial_reproducible'] = False
        try:
            list(locked_dir.iterdir())
        except PermissionError:
            limits['directory_denial_reproducible'] = True
        else:
            limits['directory_denial_reproducible'] = False
    finally:
        denied.chmod(0o600); locked_dir.chmod(0o700)
    return {'kind': 'preparation_self_check', 'status': 'PASS', 'product_acceptance': 'NOT_RUN',
            'checks': checks, 'check_count': len(checks), 'fixtures': len(CASES),
            'permission_probe': limits,
            'limits': ['No product acceptance executed',
                       'Audit guard covers Python audit events, not hostile/native bypasses',
                       'Markdown summary prose, README limits, optional syntax recognition and deliverable smoke require manual review',
                       'No TOCTOU security guarantee']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=('self-check', 'v1', 'd1'), default='self-check')
    parser.add_argument('--cli', type=Path, default=QA.parent / 'md_link_audit.py')
    parser.add_argument('--case', help='unittest method substring (e.g. A10); omitted runs all')
    parser.add_argument('--export-fixtures', action='store_true', help='Build persistent qa/fixtures once; never overwrite')
    args = parser.parse_args()
    work = workspace()
    print('QA workspace:', work, flush=True)
    if args.export_fixtures:
        destination = QA / 'fixtures'
        destination.mkdir(exist_ok=False)
        for case in CASES:
            build(case, destination / case)
        print('Exported fixtures:', destination)
    if args.mode == 'self-check':
        try:
            evidence = self_check(work)
        except Exception as exc:
            save(work / 'result.json', {'kind': 'preparation_self_check', 'status': 'FAIL',
                                      'product_acceptance': 'NOT_RUN', 'error': repr(exc)})
            raise
        save(work / 'result.json', evidence)
        print(json.dumps(evidence, ensure_ascii=False, indent=2))
        return 0
    cli = args.cli.absolute()
    # Explicitly distinguish unavailable product from a failing acceptance run.
    if not cli.is_file():
        save(work / 'result.json', {'status': 'NOT_RUN', 'mode': args.mode,
                                  'reason': 'product_missing', 'cli': str(cli)})
        print('NOT_RUN: product CLI absent; preparation is not blocked.')
        return 3
    if not cli.is_relative_to(QA.parent) or cli.is_symlink():
        parser.error('--cli must be a non-symlink file in this synthetic project')
    blackbox.CONTEXT.update(workspace=work, mode=args.mode, cli=cli)
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(blackbox.Acceptance)
    if args.case:
        suite = unittest.TestSuite(t for t in suite if args.case in t.id())
    if suite.countTestCases() == 0:
        parser.error('No matching test cases')
    log = io.StringIO()
    result = unittest.TextTestRunner(stream=log, verbosity=2).run(suite)
    text = log.getvalue()
    (work / 'unittest.txt').write_text(text, encoding='utf-8')
    evidence = {'kind': 'product_blackbox_automated_subset', 'mode': args.mode,
                'status': 'PASS' if result.wasSuccessful() else 'FAIL', 'tests_run': result.testsRun,
                'failures': len(result.failures), 'errors': len(result.errors),
                'skips': [{'test': t.id(), 'reason': reason} for t, reason in result.skipped],
                'cli': str(cli), 'cli_sha256': hashlib.sha256(cli.read_bytes()).hexdigest(),
                'manual_acceptance': 'PENDING; see PREPARATION.md'}
    save(work / 'result.json', evidence)
    print(text)
    print(json.dumps(evidence, ensure_ascii=False, indent=2))
    return int(not result.wasSuccessful())


if __name__ == '__main__':
    raise SystemExit(main())
