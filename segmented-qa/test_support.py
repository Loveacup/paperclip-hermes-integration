"""Explicit host dependencies; no author-machine lookup or silent skipping."""
import os
from pathlib import Path
import shutil


def paperclip_packages():
    value = os.environ.get('SEGMENTED_QA_PAPERCLIP_PACKAGES')
    if not value:
        raise RuntimeError('Host tier requires --paperclip-packages or SEGMENTED_QA_PAPERCLIP_PACKAGES')
    root = Path(value)
    if not root.is_absolute():
        raise RuntimeError('Paperclip packages path must be absolute')
    for relative in ('shared/dist/validators/issue.js', 'server/dist/adapters/process/execute.js'):
        if not (root / relative).is_file():
            raise RuntimeError('Host dependency missing: ' + relative)
    if shutil.which('node') is None:
        raise RuntimeError('Host tier requires Node.js on PATH')
    return root.resolve(strict=True)
