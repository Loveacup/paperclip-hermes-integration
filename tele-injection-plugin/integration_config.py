"""Load nonsecret installation JSON through the shared schema validator."""
import json
import subprocess
from pathlib import Path

def load_config(file):
    if not file:
        raise ValueError('integration config path required')
    validator = Path(__file__).resolve().parents[1] / 'scripts/config.mjs'
    result = subprocess.run(['node', str(validator), str(file), '--json'], capture_output=True, text=True, timeout=10)
    if result.returncode:
        raise ValueError('invalid integration config; run npm run config:check')
    return json.loads(result.stdout)

def cursor_path(config):
    import hashlib
    b = dict(config['plugin']['binding'])
    if b.get('mode') in ('topic', 'conversation'):
        b.pop('session_id', None)
    elif b.get('mode') == 'session':
        b.pop('mode')
    digest = hashlib.sha256(json.dumps(b, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return Path(config['plugin']['cursorDir']) / ('delivery-cursor-' + digest + '.json')
