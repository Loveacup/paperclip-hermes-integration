"""Subprocess-only audit observer. Blocks network and synthetic forbidden reads.
Not an OS sandbox; never claim resistance to hostile code or native extensions.
"""
import json
import os
import sys

_fd = os.open(os.environ['QA_GUARD_LOG'], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
_scope = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def emit(kind, **details):
    os.write(_fd, (json.dumps({'kind': kind, **details}, ensure_ascii=False) + '\n').encode('utf-8'))


def observe(event, args):
    if event in ('socket.connect', 'socket.connect_ex', 'socket.getaddrinfo',
                 'socket.gethostbyname', 'socket.gethostbyaddr', 'socket.sendto', 'socket.bind'):
        emit('network_attempt', event=event)
        raise PermissionError('QA guard forbids network: ' + event)
    if event not in ('open', 'os.scandir', 'os.listdir') or not args:
        return
    name = args[0]
    if not isinstance(name, (str, bytes, os.PathLike)):
        return
    name = os.fsdecode(name)
    # Preserve s/../x while checking each actual component; abspath would erase s.
    path = name if os.path.isabs(name) else os.getcwd() + '/' + name
    if not path.startswith(_scope + '/'):
        return
    cursor = '/'
    for part in path.split('/'):
        if not part or part == '.':
            continue
        cursor = os.path.join(cursor, part)
        if part == 'synthetic-outside' or os.path.islink(cursor):
            emit('forbidden_access', event=event, path=name)
            raise PermissionError('QA guard forbids synthetic outside/symlink access')


sys.addaudithook(observe)
emit('ready', python=sys.version.split()[0])
