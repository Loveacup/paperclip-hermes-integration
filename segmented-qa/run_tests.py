#!/usr/bin/env python3
"""Run offline tests by default; explicit Paperclip packages enables all tests."""
import argparse
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
MODULES = ('test_staged_qa', 'test_native_finish', 'test_native_graph', 'test_composition', 'test_native_workflow', 'test_workflow_composition', 'test_fixture_portability')
HOST_CASES = frozenset({
    'test_native_graph.GraphTests.test_real_installed_shared_schema_accepts_without_stripping_fields',
    'test_native_graph.GraphTests.test_installed_process_execute_consumes_config_shape_without_model',
    'test_composition.CompositionTests.test_machine_graph_through_installed_process_factory_and_local_native_finish',
})


def flatten(suite):
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            yield from flatten(item)
        else:
            yield item


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--paperclip-packages', type=Path,
                        help='absolute node_modules/@paperclipai path; enables host + offline suite')
    args = parser.parse_args()
    sys.dont_write_bytecode = True
    os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
    # Never allow ambient live runtime credentials/endpoints into the host adapter.
    for key in list(os.environ):
        if key.startswith('PAPERCLIP_'):
            del os.environ[key]
    evidence = ROOT / '.evidence'
    evidence.mkdir(exist_ok=True)
    tier = 'host' if args.paperclip_packages is not None else 'offline'
    if args.paperclip_packages is not None:
        os.environ['SEGMENTED_QA_PAPERCLIP_PACKAGES'] = str(args.paperclip_packages)
        from test_support import paperclip_packages
        try:
            paperclip_packages()
        except (RuntimeError, OSError) as exc:
            print('Host tier refused: ' + str(exc), file=sys.stderr)
            return 2
    tests = list(flatten(unittest.defaultTestLoader.loadTestsFromNames(MODULES)))
    found = {test.id() for test in tests} & HOST_CASES
    if found != HOST_CASES:
        raise RuntimeError('Host case inventory changed')
    selected = [test for test in tests if tier == 'host' or test.id() not in HOST_CASES]
    # A test-owned parent keeps subprocess HOME/TMPDIR inside a disposable scope.
    # TemporaryDirectory honors the caller's TMPDIR; no hardcoded system temp path.
    log = io.StringIO()
    with tempfile.TemporaryDirectory(prefix='segmented-qa-') as directory:
        # Canonicalize this test-owned scope: macOS's default /var is an alias.
        # Product outputs still reject symlinks; never weaken that guard.
        directory = str(Path(directory).resolve(strict=True))
        os.environ.update(TMPDIR=directory, TMP=directory, TEMP=directory)
        tempfile.tempdir = directory
        try:
            result = unittest.TextTestRunner(stream=log, verbosity=2).run(unittest.TestSuite(selected))
        finally:
            tempfile.tempdir = None
    text = log.getvalue()
    print(text, end='')
    code = 0 if result.wasSuccessful() and not result.skipped and result.testsRun == len(selected) else 1
    summary = dict(tier=tier, tests_run=result.testsRun, failures=len(result.failures),
                   errors=len(result.errors), skips=len(result.skipped), exit_code=code,
                   selected_test_ids=[test.id() for test in selected])
    (evidence / (tier + '.log')).write_text(text, encoding='utf-8')
    (evidence / (tier + '.json')).write_text(json.dumps(summary, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({k: v for k, v in summary.items() if k != 'selected_test_ids'}, sort_keys=True))
    return code


if __name__ == '__main__':
    raise SystemExit(main())
