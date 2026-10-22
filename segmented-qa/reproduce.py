#!/usr/bin/env python3
"""Real frozen QA + process interruption/recovery probe; no native HTTP by default."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inventory(root):
    result = {}
    for path in sorted(root.rglob('*')):
        relative = str(path.relative_to(root))
        if path.is_symlink():
            result[relative] = {'symlink': os.readlink(path)}
        elif path.is_file():
            result[relative] = {'sha256': sha(path)}
    return result


def original_sources(root):
    paths = [root/'md_link_audit.py', root/'qa/run_qa.py',
             root/'qa/test_blackbox.py', root/'qa/fixtures.py']
    paths += sorted((root/'qa/guard').glob('*.py'))
    return {str(path.relative_to(root)): sha(path) for path in paths}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    source = args.project.resolve(strict=True)
    output = args.output.absolute()
    output.mkdir(parents=True, exist_ok=False)
    # Import only after choosing a never-used, explicitly requested output scope.
    import staged_qa
    before = original_sources(source)
    contract = Path(staged_qa.prepare(source, output/'prepared'))
    machine = output/'machine'
    closeout = output/'closeout'
    staged_qa.execute(contract, machine)
    verified = staged_qa.verify(contract, machine)
    stored_receipt = json.loads((machine/'receipt.json').read_text())
    assert stored_receipt['contract_sha256'] == sha(contract), 'receipt must bind the frozen contract'
    machine_before = inventory(machine)
    module_dir = str(Path(__file__).resolve().parent)
    guarded_closeout = r'''
import json, os, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import staged_qa

def forbid_reexecution(event, arguments):
    if event == 'subprocess.Popen' or event in ('socket.connect', 'socket.getaddrinfo'):
        raise RuntimeError('closeout attempted subprocess or network')

sys.addaudithook(forbid_reexecution)
def interrupted(*args, **kwargs):
    os._exit(23)
kwargs = {'after_report': interrupted} if sys.argv[5] == 'interrupt' else {}
result = staged_qa.closeout(Path(sys.argv[2]), Path(sys.argv[3]), Path(sys.argv[4]), **kwargs)
print(json.dumps(result, ensure_ascii=False, sort_keys=True))
'''
    command = [sys.executable, '-B', '-c', guarded_closeout,
               module_dir, str(contract), str(machine), str(closeout)]
    interrupted = subprocess.run(command+['interrupt'], capture_output=True, text=True)
    (output/'interrupted.stdout').write_text(interrupted.stdout)
    (output/'interrupted.stderr').write_text(interrupted.stderr)
    assert interrupted.returncode == 23, 'probe must actually exit after a durable report'
    report = closeout/'REPORT.md'
    assert report.is_file(), 'interrupted process did not leave its report'
    report_before = sha(report)
    resumed = subprocess.run(command+['resume'], capture_output=True, text=True)
    (output/'resumed.stdout').write_text(resumed.stdout)
    (output/'resumed.stderr').write_text(resumed.stderr)
    resumed.check_returncode()
    assert sha(report) == report_before, 'closeout must preserve the exact report bytes'
    assert inventory(machine) == machine_before, 'closeout must not mutate machine evidence'
    assert original_sources(source) == before, 'original project source changed'
    summary = {
        'scope': 'real_local_product_QA_and_process_interruption_only',
        'machine_receipt': verified,
        'interrupted_closeout_exit': interrupted.returncode,
        'resumed_closeout_exit': resumed.returncode,
        'closeout_subprocess_and_network_forbidden': True,
        'same_report_sha256': report_before,
        'machine_inventory_unchanged': True,
        'original_source_unchanged': True,
        'native_graph_submitted': False,
        'real_OMP_consumption_verified': False,
        'live_Paperclip_recovery_verified': False,
    }
    (output/'reproduction.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
