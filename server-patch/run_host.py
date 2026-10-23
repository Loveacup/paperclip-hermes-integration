"""Optional real-public-source AST/VM regression tier; never edits --root."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import apply as patch

HERE = Path(__file__).resolve().parent

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, help='Explicit pristine public server dist (read only)')
    args = parser.parse_args()
    root = patch.safe_path(args.root)
    # Gate all real public sources before any fixture writes.
    baseline = json.loads((HERE/'source-baseline.json').read_text())
    sources = {}
    for item in baseline['files']:
        data = patch.read_safe(patch.target_path(root, item['path']))
        if patch.sha(data) != item['sha256']:
            raise ValueError('baseline hash mismatch: ' + item['path'])
        sources[item['path']] = data
    acorn = HERE/'host-deps/node_modules/acorn/package.json'
    if not acorn.is_file() or json.loads(acorn.read_text()).get('version') != '8.15.0':
        raise ValueError('Install fixed host-deps/acorn 8.15.0 explicitly; no fallback')
    env = dict(os.environ)
    env.pop('NODE_PATH', None)
    env.pop('NODE_OPTIONS', None)
    with tempfile.TemporaryDirectory(prefix='host-fixture-', dir=HERE) as temporary:
        candidate = Path(temporary)/'dist'
        for name, data in sources.items():
            target = candidate/name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        subprocess.run([sys.executable, '-B', str(HERE/'apply.py'), '--root', str(candidate), '--apply'], check=True)
        for item in json.loads((HERE/'manifest.json').read_text()):
            if patch.sha((candidate/item['path']).read_bytes()) != item['candidateSha256']:
                raise ValueError('candidate fixture verification failed')
        env['BASELINE_ROOT'] = str(root)
        env['CANDIDATE_ROOT'] = str(candidate)
        tests = sorted(str(p) for p in (HERE/'host').glob('*.test.cjs'))
        result = subprocess.run(['node', '--test', '--test-reporter=tap', *tests], env=env, cwd=HERE)
        return result.returncode

if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
