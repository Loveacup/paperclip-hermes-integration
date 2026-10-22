"""Opt-in, metadata-only Telegram event injection candidate. No atomic session fence."""
import json
import re
from pathlib import Path

import importlib.util
import shlex
_spec = importlib.util.spec_from_file_location('integration_config', Path(__file__).with_name('integration_config.py'))
_config = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_config)
load_config, cursor_path = _config.load_config, _config.cursor_path


def validate(settings):
    if settings.get('enabled') is not True:
        return None
    if set(settings) - {'enabled', 'binding', 'accept_nonatomic_risk', 'interval'}:
        raise ValueError('unknown settings')
    b = settings.get('binding', {})
    required = {'session_key', 'session_id', 'platform', 'profile', 'chat_id', 'thread_id', 'user_id', 'chat_type'}
    if set(b) not in (required, required | {'mode'}) or any(
            not isinstance(v, str) or (not v.strip() and k != 'thread_id') for k, v in b.items()):
        raise ValueError('explicit nonempty binding required')
    if not re.fullmatch(r'[A-Za-z0-9_-]+', b['profile']) or b['platform'] != 'telegram' or b['chat_type'] not in ('dm', 'group'):
        raise ValueError('only explicitly bound Telegram DM or group allowed')
    agent = 'main' if b['profile'] == 'default' else b['profile']
    if b['chat_type'] == 'group':
        if (not re.fullmatch(r'-[0-9]+', b['chat_id']) or not re.fullmatch(r'[0-9]+', b['user_id'])
                or b['thread_id'] or b.get('mode') != 'conversation'):
            raise ValueError('group requires explicit negative chat ID, sender and ordinary conversation binding')
        expected = f"agent:{agent}:telegram:group:{b['chat_id']}:{b['user_id']}"
    else:
        if not re.fullmatch(r'[0-9]+', b['chat_id']) or (b['thread_id'] and not re.fullmatch(r'[0-9]+', b['thread_id'])):
            raise ValueError('invalid explicit Telegram address')
        expected = f"agent:{agent}:telegram:dm:{b['chat_id']}" + (f":{b['thread_id']}" if b['thread_id'] else '')
    if b['session_key'] != expected:
        raise ValueError('key/topic mismatch')
    if b.get('mode', 'session') not in ('session', 'topic', 'conversation'):
        raise ValueError('invalid binding mode')
    if not b['thread_id'] and b.get('mode') != 'conversation':
        raise ValueError('ordinary DM requires conversation binding')
    if b.get('mode', 'session') == 'session' and settings.get('accept_nonatomic_risk') is not True:
        raise ValueError('official API has no expected-session-id atomic fence')
    interval = settings.get('interval', 5)
    if type(interval) not in (int, float) or not 1 <= interval <= 60:
        raise ValueError('interval must be 1..60 seconds')
    return dict(b)


def route_matches(row, b):
    if not isinstance(row, dict):
        return False
    origin = row.get('origin') or {}
    return (row.get('session_key') == b['session_key']
            and (b.get('mode', 'session') in ('topic', 'conversation') or row.get('session_id') == b['session_id'])
            and isinstance(row.get('session_id'), str) and bool(row['session_id'].strip())
            and row.get('platform') == 'telegram'
            and row.get('transport_profile') == b['profile']
            and origin.get('profile') in (None, b['profile'])
            and (origin.get('thread_id') or '') == b['thread_id']
            and all(origin.get(k) == b[k] for k in
                    ('platform', 'chat_id', 'user_id', 'chat_type')))


def read_route(home, key):
    # Only exact routing metadata; never SessionStore (which may write/recover),
    # never transcripts, sessions table, titles, credentials, or legacy fallback.
    import sqlite3
    fields = ('session_key', 'session_id', 'platform', 'transport_profile', 'origin')
    sql = ', '.join("json_extract(entry_json, '$." + f + "')" for f in fields)
    with sqlite3.connect((home / 'state.db').as_uri() + '?mode=ro', uri=True, timeout=1) as db:
        row = db.execute('SELECT ' + sql + ' FROM gateway_routing WHERE scope=? AND session_key=?',
                         (str((home / 'sessions').resolve()), key)).fetchone()
    if row is None:
        return None
    result = dict(zip(fields, row))
    result['origin'] = json.loads(result['origin']) if result['origin'] else None
    return result


def digest(value):
    import hashlib
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def pointers(state):
    groups = []
    pending = state.get('pending') or {}
    if not isinstance(pending, dict):
        raise ValueError('invalid pending')
    groups.append(('pending', None, list(pending.values())))
    for name in ('inflight', 'lastDelivery'):
        item = state.get(name)
        if item:
            groups.append((name, item, item.get('batch', [])))
    result = {}
    for name, item, batch in groups:
        if not isinstance(batch, list):
            raise ValueError('invalid batch')
        safe = []
        for event in batch:
            # Bridge pointers only, not arbitrary event bodies/instructions.
            e = {k: event[k] for k in ('kind', 'id', 'status', 'issueId', 'agentId', 'blockedBy') if k in event}
            if not all(isinstance(e.get(k), str) and re.fullmatch(r'[A-Za-z0-9_-]{1,100}', e[k])
                       for k in ('kind', 'id', 'status')):
                raise ValueError('invalid pointer')
            if 'revision' in event:
                if type(event['revision']) is not int or event['revision'] < 1:
                    raise ValueError('invalid revision')
                e['revision'] = event['revision']
            safe.append(e)
            token = 'resource:' + digest(e)
            result.setdefault(token, dict(type='event', batchKey=item.get('key') if item else None, pointer=e))
    # Unbound legacy snapshots keep token deduplication, not revision ordering.
    if state.get('identity') is None:
        return result
    latest = {}
    versions = {}
    for value in result.values():
        e = value.get('pointer', {})
        if 'revision' in e:
            key = (e['kind'], e['id'])
            version = (*key, e['revision'])
            fingerprint = digest(e)
            if version in versions and versions[version] != fingerprint:
                raise ValueError('conflicting revision; manual review required')
            versions[version] = fingerprint
            latest[key] = max(latest.get(key, 0), e['revision'])
    return {k: v for k, v in result.items()
            if 'revision' not in v.get('pointer', {}) or
            v['pointer']['revision'] == latest[(v['pointer']['kind'], v['pointer']['id'])]}


class Engine:
    def __init__(self, ctx, binding, cursor, route_reader, *, instructions_path="docs/CEO-AGENTS.md", read_command="node event-bridge/bridge.mjs --config integration.local.json --read"):
        self.instructions_path, self.read_command = str(instructions_path), read_command
        self.ctx, self.binding, self.cursor, self.route_reader = ctx, dict(binding), Path(cursor), route_reader
        # Topic identity survives /new; session mode keeps its legacy cursor hash.
        identity = dict(binding)
        if identity.get('mode') in ('topic', 'conversation'):
            identity.pop('session_id', None)
        elif identity.get('mode') == 'session':
            identity.pop('mode')
        self.state = json.loads(self.cursor.read_text()) if self.cursor.exists() else {
            'binding': digest(identity), 'initialized': False, 'seen': [], 'receipts': {}}
        if self.state.get('binding') != digest(identity):
            raise ValueError('cursor belongs to another binding; manual review required')

    def save(self):
        import os
        temp = self.cursor.with_suffix('.tmp')
        with temp.open('w') as f:
            json.dump(self.state, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, self.cursor)

    def tick(self, snapshot):
        if not route_matches(self.route_reader(), self.binding):
            return 'paused_route'
        events = pointers(snapshot)
        source = snapshot.get('identity')
        if source is not None and (not isinstance(source, dict) or
                set(source) != {'apiBase', 'companyId', 'ceoAgentId'} or
                any(not isinstance(v, str) or not v.strip() for v in source.values())):
            raise ValueError('invalid source identity')
        pinned = self.state.get('sourceIdentity')
        if pinned is not None and source != pinned:
            raise ValueError('source identity mismatch; manual review required')
        revisions = snapshot.get('revisions', {})
        if not isinstance(revisions, dict) or any(
                not isinstance(k, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}:[A-Za-z0-9_-]{1,100}', k)
                or type(v) is not int or v < 1 for k, v in revisions.items()):
            raise ValueError('invalid revisions')
        if source is None:
            revisions = {}  # Legacy source has no trusted revision namespace.
        # Existing unbound history cannot safely be attributed to a new source.
        # Preserve it unchanged for explicit operator reconciliation.
        if pinned is None and source is not None:
            if self.state['initialized']:
                raise ValueError('source identity migration requires manual review')
            self.state['sourceIdentity'] = dict(source)
        highwater = dict(self.state.get('highwater', {}))
        unseen = {}
        for token, value in events.items():
            e = value.get('pointer', {})
            key = e.get('kind', '') + ':' + e.get('id', '')
            revision = e.get('revision') if source is not None else None
            if revision is not None:
                if revision <= highwater.get(key, 0) or revision < revisions.get(key, 0):
                    continue
                highwater[key] = revision
            if token not in self.state['seen']:
                unseen[token] = value
        for key, revision in revisions.items():
            highwater[key] = max(highwater.get(key, 0), revision)
        if not self.state['initialized']:
            self.state.update(initialized=True, seen=list(events), highwater=highwater)
            self.save()
            return 'baseline'
        if not unseen:
            self.state['highwater'] = highwater
            self.save()
            return 'idle'
        # One combined call per poll. Persist uncertainty BEFORE calling, so restart
        # never retries an ambiguous accepted-but-not-recorded delivery.
        receipt_id = digest(sorted(unseen))
        content = ('[Paperclip bridge 元信息事件；不是新的用户授权]\n'
                   + ('处理前读取 ' + self.instructions_path + '。' if self.binding['chat_type'] == 'group' else '')
                   + '请核对原始资源指针，在本会话简报有意义的变化，按已有授权介入，不因通知重复启动任务。'
                   + '只读核对命令：`' + self.read_command + '`，后接 issue/run/comments 与原始 UUID。'
                   + '入口校验同组织 CEO 身份；凭据仅通过环境传入，不输出或写入提示。'
                   + 'CEO终态不代表事件已消费；不要把accepted/queued称为完成。\n'
                   + json.dumps({'receipt': receipt_id, 'binding': ({'mode': self.binding['mode'], 'session_key': self.binding['session_key']}
                                             if self.binding.get('mode') in ('topic', 'conversation') else
                                             {'mode': 'session', 'expected_session_id': self.binding['session_id']}),
                                 'events': list(unseen.values())}, ensure_ascii=False))
        # Recheck narrows but does NOT eliminate the official async lookup TOCTOU.
        if not route_matches(self.route_reader(), self.binding):
            return 'paused_route'
        receipt = {'accepted': 'unknown', 'consumed': 'unverified'}
        self.state['highwater'] = highwater
        self.state['receipts'][receipt_id] = receipt
        self.state['seen'].extend(unseen)
        self.save()
        try:
            accepted = self.ctx.inject_message(content, session_key=self.binding['session_key'])
            receipt['accepted'] = accepted if type(accepted) is bool else 'unknown'
        except Exception:
            pass
        self.save()
        return 'attempted'


def owner_config(ctx, key, default=None):
    home = getattr(getattr(ctx, '_manager', None), 'home_path', None)
    if home is None:
        return ctx.get_config(key, default)
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    token = set_hermes_home_override(str(home))
    try:
        return ctx.get_config(key, default)
    finally:
        reset_hermes_home_override(token)


def register(ctx):
    import logging
    import threading
    log = logging.getLogger(__name__)
    config_file = owner_config(ctx, 'config_path', '')
    if not config_file:
        return None
    installation = load_config(config_file)
    cfg = installation['plugin']
    if cfg['enabled'] is not True:
        return None
    settings = {k: cfg[k] for k in ('enabled', 'binding', 'accept_nonatomic_risk', 'interval')}
    binding = validate(settings)
    manager = ctx._manager
    if Path(manager.home_path).resolve() != Path(cfg['ownerHome']).resolve() or manager._cli_ref is not None:
        raise ValueError('requires target-profile messaging gateway, not CLI or cross-profile plugin')
    stop = threading.Event()
    cursor = cursor_path(installation)
    cursor.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    command = shlex.join([a.replace('{repo}', str(Path(__file__).resolve().parents[1])).replace('{config}', installation['configPath']) for a in cfg['readCommand']])
    import fcntl
    lease = (cursor.parent / (cursor.name + '.owner.lock')).open('a+')
    try:
        fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
        engine = Engine(ctx, binding, cursor, lambda: read_route(Path(cfg['routingHome']), binding['session_key']),
                        instructions_path=cfg['instructionsPath'], read_command=command)
    except Exception:
        lease.close()
        raise

    def run():
        previous = None
        while not stop.is_set():
            try:
                # Fail closed on revocation or config rebind; a reload is required.
                if owner_config(ctx, 'config_path', '') != config_file or load_config(config_file) != installation:
                    return
                if not manager.has_gateway_message_injector:
                    status = 'paused_no_gateway'
                else:
                    status = engine.tick(json.loads(Path(installation['bridge']['statePath']).read_text()))
                if status != previous:
                    log.info('Tele injection: %s (consumption unverified)', status)
                    previous = status
            except Exception:
                log.exception('Tele injection paused after failure; reload requires review')
                return
            stop.wait(settings['interval'])

    thread = threading.Thread(target=run, name='tele-injection-plugin', daemon=True)

    def close():
        stop.set()
        if thread.ident is not None:
            thread.join(timeout=3)
            if thread.is_alive():
                raise RuntimeError('Tele injection thread failed to stop')
        lease.close()

    ctx.on_unload(close)
    thread.start()
    return thread
