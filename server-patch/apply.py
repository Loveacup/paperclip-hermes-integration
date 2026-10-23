"""Explicit --root dist required. Default is check only; --preview is read-only."""
from pathlib import Path
from contextlib import contextmanager
import argparse
import difflib
import hashlib
import json
import os
import stat
import sys

HERE = Path(__file__).resolve().parent

def sha(data):
    return hashlib.sha256(data).hexdigest()

def safe_path(path):
    path = Path(path)
    if '..' in path.parts:
        raise ValueError('unsafe parent traversal')
    path = path.absolute()
    for part in [*reversed(path.parents), path]:
        if part.is_symlink():
            raise ValueError('unsafe symlink: ' + str(part))
    return path

def target_path(root, relative):
    rel = Path(relative)
    if rel.is_absolute() or not rel.parts or '..' in rel.parts:
        raise ValueError('unsafe relative path')
    path = safe_path(root / rel)
    if root not in path.parents:
        raise ValueError('unsafe target path')
    return path

@contextmanager
def open_safe(path, writable=False):
    """No symlink-following at any component; no truncation on open."""
    path = safe_path(path)
    directory = os.open(path.anchor, os.O_RDONLY | os.O_DIRECTORY)
    file_fd = None
    try:
        for component in path.parts[1:-1]:
            next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = next_fd
        file_fd = os.open(path.name, (os.O_RDWR if writable else os.O_RDONLY) | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        info = os.fstat(file_fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError('unsafe non-regular or hardlinked file: ' + str(path))
        with os.fdopen(file_fd, 'r+b' if writable else 'rb') as stream:
            file_fd = None
            yield stream
    finally:
        if file_fd is not None:
            os.close(file_fd)
        os.close(directory)

def read_safe(path):
    with open_safe(path) as stream:
        return stream.read()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True)
    parser.add_argument('--bundle', choices=['lifecycle', 'cancellation', 'sdk'], default='lifecycle')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--preview', action='store_true')
    args = parser.parse_args()
    root = safe_path(args.root)
    bundle = HERE if args.bundle == 'lifecycle' else HERE / args.bundle
    manifest = json.loads((bundle / 'manifest.json').read_text())
    baseline = json.loads((bundle / 'source-baseline.json').read_text())
    pending, snapshots = [], {}
    for item in baseline['files']:
        path = target_path(root, item['path'])
        data = read_safe(path)
        if sha(data) != item['sha256']:
            raise ValueError('baseline hash mismatch: ' + str(path))
        if path in snapshots:
            raise ValueError('duplicate baseline path')
        snapshots[path] = data
    for item in manifest:
        path = target_path(root, item['path'])
        original = snapshots.get(path)
        if original is None or sha(original) != item['baselineSha256']:
            raise ValueError('baseline hash mismatch or missing source entry: ' + str(path))
        if any(path == previous[0] for previous in pending):
            raise ValueError('duplicate target path')
        text = original.decode('utf-8')
        for edit in item['edits']:
            if not edit['old'] or text.count(edit['old']) != 1:
                raise ValueError('ambiguous edit: ' + str(path))
            text = text.replace(edit['old'], edit['new'], 1)
        updated = text.encode('utf-8')
        if sha(updated) != item['candidateSha256']:
            raise ValueError('candidate hash mismatch: ' + str(path))
        pending.append((path, original, updated))
    for path, old, new in pending:
        print('CHECK OK', path, sha(old), '->', sha(new))
        if args.preview:
            print(''.join(difflib.unified_diff(old.decode().splitlines(True), new.decode().splitlines(True), fromfile=str(path), tofile=str(path) + ' (candidate)')))
    if not args.apply:
        return
    expected = dict(snapshots)
    for path, old, new in pending:
        # Recheck ALL targets and read dependencies before first and each next write.
        if any(read_safe(p) != data for p, data in expected.items()):
            raise ValueError('concurrent source change; stop and inspect possible partial application; no rollback/retry')
        with open_safe(path, writable=True) as stream:
            if stream.read() != old:
                raise ValueError('concurrent target change during apply; inspect partial application')
            stream.seek(0)
            stream.write(new)
            stream.truncate()
            stream.flush()
            os.fsync(stream.fileno())
            stream.seek(0)
            if stream.read() != new:
                raise ValueError('write verification failed; inspect partial application: ' + str(path))
        expected[path] = new
        if read_safe(path) != new:
            raise ValueError('write path verification failed; inspect partial application: ' + str(path))
        print('APPLIED', path)

if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError) as error:
        print(str(error) + '; stopped without automatic rollback/retry', file=sys.stderr)
        sys.exit(1)
