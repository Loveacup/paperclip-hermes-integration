"""Read-only local bridge health; readiness is not a delivery/consumption receipt."""
import json
import os
from pathlib import Path
import re
import subprocess
import time


def classify(state, *, pid_alive, launchd_matches, cursor_initialized, now_ms):
    problems=[]
    age_ms=max(0,now_ms-state.get('lastReconciledMs',0))
    if not pid_alive: problems.append('detector_not_alive')
    if not launchd_matches: problems.append('not_managed_by_launchd')
    if age_ms>90000: problems.append('reconcile_stale')
    if state.get('ws')!='connected': problems.append('websocket_not_connected')
    if state.get('lastError'): problems.append('detector_error')
    if not state.get('promptReady'): problems.append('ceo_prompt_not_ready')
    if not cursor_initialized: problems.append('telegram_cursor_not_initialized')
    delivery=(state.get('inflight') or {}).get('status')
    if delivery in ['uncertain','skipped_needs_review']:
        problems.append('delivery_requires_review_no_replay')
    return {'status':'degraded' if problems else 'ready','problems':problems,'reconcileAgeSec':round(age_ms/1000,2),'pendingCount':len(state.get('pending',{})),'inflightStatus':delivery,'readOnly':True,'receiptScope':'health only; not proof of consumption or user receipt'}


def main():
    import argparse
    import importlib.util
    parser=argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    args=parser.parse_args()
    source=Path(__file__).resolve().parents[1]/'tele-injection-plugin/integration_config.py'
    spec=importlib.util.spec_from_file_location('health_config',source)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    config=module.load_config(args.config)
    state_path=Path(config['bridge']['statePath'])
    state=json.loads(state_path.read_text())
    lease_path=Path(str(state_path)+'.lock')
    lease=json.loads(lease_path.read_text()) if lease_path.exists() else {}
    pid=lease.get('pid')
    try:
        if type(pid) is not int or pid<1: raise ProcessLookupError()
        os.kill(pid,0)
        alive=True
    except (ProcessLookupError,PermissionError): alive=False
    result=subprocess.run(['/bin/launchctl','print',f"gui/{os.getuid()}/{config['bridge']['serviceLabel']}"],capture_output=True,text=True,timeout=5)
    match=re.search(r'^\s*pid = (\d+)\s*$',result.stdout,re.M)
    managed=result.returncode==0 and match is not None and int(match[1])==pid
    cursor_path=module.cursor_path(config)
    cursor=json.loads(cursor_path.read_text()) if cursor_path.exists() else {}
    output=classify(state,pid_alive=alive,launchd_matches=managed,cursor_initialized=cursor.get('initialized') is True,now_ms=time.time()*1000)
    output.update({'pid':pid,'launchdRegistered':result.returncode==0})
    print(json.dumps(output,ensure_ascii=False))
    return 0 if output['status']=='ready' else 2


if __name__=='__main__':
    try:
        raise SystemExit(main())
    except (OSError,ValueError,KeyError,TypeError,subprocess.SubprocessError):
        print(json.dumps({'status':'unknown','readOnly':True,'error':'local_health_unavailable'}))
        raise SystemExit(2)
