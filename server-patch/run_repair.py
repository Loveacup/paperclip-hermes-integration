"""Test generated SDK by default; --server-root adds public-source cancellation contracts.
Only disposable copies are modified. No service, provider, or live database is used.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import apply as patch

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent

def run(args, **kwargs):
    subprocess.run(args, check=True, **kwargs)

def verify(root, bundle):
    for item in json.loads((HERE / bundle / 'source-baseline.json').read_text())['files']:
        if patch.sha(patch.read_safe(patch.target_path(root, item['path']))) != item['sha256']:
            raise ValueError('baseline mismatch: ' + item['path'])

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--server-root', help='Pristine public server dist; read-only')
    args = parser.parse_args()
    env = {k: os.environ[k] for k in ('PATH', 'HOME', 'TMPDIR', 'LANG') if k in os.environ}
    env['PYTHONDONTWRITEBYTECODE'] = '1'
    with tempfile.TemporaryDirectory(prefix='repair-contract-') as tmp:
        work = Path(tmp)
        (work / 'package.json').write_text('{"type":"module"}')
        sdk = ROOT / 'node_modules/@paperclipai/adapter-utils'
        verify(sdk / 'dist', 'sdk')
        copied = work / 'node_modules/@paperclipai/adapter-utils'
        shutil.copytree(sdk, copied)
        for name in ('@paperclipai/shared', 'zod', 'picocolors'):
            target = work / 'node_modules' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.symlink_to(ROOT / 'node_modules' / name, target_is_directory=True)
        run([sys.executable, '-B', str(HERE / 'apply.py'), '--bundle', 'sdk', '--root', str(copied / 'dist'), '--apply'], env=env)
        shutil.copy2(HERE / 'sdk/regression.test.mjs', work)
        run(['node', '--test', '--test-reporter=tap', str(work / 'regression.test.mjs')], env=env)
        if not args.server_root:
            print('Server cancellation tier not requested; run with --server-root (not a passed/skip claim).')
            return
        source = patch.safe_path(args.server_root)
        verify(source, 'cancellation')
        dependencies = HERE / 'host-deps/node_modules'
        for name, version in [('acorn', '8.15.0'), ('@paperclipai/shared', '2026.1005.0'), ('express', '5.1.0')]:
            if json.loads((dependencies / name / 'package.json').read_text())['version'] != version:
                raise ValueError('host dependency mismatch: ' + name)
        baseline = work / 'baseline'
        shutil.copytree(source, baseline)
        # Public modules resolve only the dedicated lockfile installation.
        (baseline / 'node_modules').symlink_to(dependencies, target_is_directory=True)
        tests = work / 'tests'
        shutil.copytree(HERE / 'cancellation/tests', tests)
        candidate = tests / 'candidate'
        shutil.copytree(source, candidate)
        run([sys.executable, '-B', str(HERE / 'apply.py'), '--bundle', 'cancellation', '--root', str(candidate), '--apply'], env=env)
        env.update(BASELINE_ROOT=str(baseline), REVIEW_CANCEL_SOURCE=str(candidate / 'routes/issues.js'), ACORN_PACKAGE=str(dependencies / 'acorn/package.json'))
        names = ['acceptance', 'broker', 'consumer', 'oneshot', 'delivery', 'windows', 'fence', 'startup', 'startup-delivery', 'policy']
        run(['node', '--test', '--test-reporter=tap', *[str(tests / (n + '.test.mjs')) for n in names]], env=env)

if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
