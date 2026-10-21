"""One exec-only ownership gate for launchd; not another scheduler/supervisor."""
import argparse
import fcntl
import os
from pathlib import Path
import sys
import json
import stat


def recover_dead_pid_lease(state):
    lease = Path(str(state)+'.lock')
    try:
        before = lease.lstat()
    except FileNotFoundError:
        return
    if not stat.S_ISREG(before.st_mode) or before.st_size > 4096:
        raise RuntimeError('pid_lease_invalid')
    raw = lease.read_bytes()
    try:
        pid = json.loads(raw)['pid']
        if type(pid) is not int or pid < 1:
            raise ValueError()
    except (ValueError, KeyError, TypeError):
        raise RuntimeError('pid_lease_invalid') from None
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        after = lease.lstat()
        if (before.st_dev,before.st_ino,before.st_mtime_ns) != (after.st_dev,after.st_ino,after.st_mtime_ns) or lease.read_bytes() != raw:
            raise RuntimeError('pid_lease_changed')
        lease.unlink()
    else:
        # Never kill or evict a live PID, including a reused PID; fail closed.
        raise RuntimeError('legacy_owner_alive')


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--state', required=True)
    parser.add_argument('--config', help='Nonsecret installation JSON; only its authEnv is forwarded')
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    state = Path(args.state)
    if not state.is_absolute() or not command or not Path(command[0]).is_absolute():
        raise RuntimeError('invalid_service_paths')
    env = {k: os.environ[k] for k in ('HOME','USER','LOGNAME','PATH','LANG','LC_ALL','TMPDIR') if k in os.environ}
    env['NODE_ENV'] = 'production'
    if args.config:
        import importlib.util
        spec = importlib.util.spec_from_file_location('service_config', Path(__file__).resolve().parents[1]/'tele-injection-plugin/integration_config.py')
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        config = module.load_config(args.config)
        if Path(config['bridge']['statePath']).resolve() != state.resolve():
            raise RuntimeError('config_state_mismatch')
        key = config['authEnv']
        if key not in os.environ:
            raise RuntimeError('missing_auth_environment')
        env[key] = os.environ[key]
    # flock has no stale-owner problem after SIGKILL. Keep the inode permanently;
    # unlinking an owner.lock would let two different inodes grant two owners.
    fd = os.open(str(state)+'.owner.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise RuntimeError('owner_busy') from None
    recover_dead_pid_lease(state)
    os.set_inheritable(fd, True)
    # Same PID and process group; service manager owns restarts. Config travels in argv.
    os.execve(command[0], command, env)


if __name__ == '__main__':
    try:
        main()
    except RuntimeError as exc:
        sys.stderr.write(str(exc)+'\n')
        raise SystemExit(1)
    except Exception:
        sys.stderr.write('service_entry_failed\n')
        raise SystemExit(1)
