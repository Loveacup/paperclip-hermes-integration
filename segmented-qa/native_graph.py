"""Pure three-phase payload builder; outer native owner creates tasks in order."""
from pathlib import Path
import shlex
import sys


def build_graph(*, project_id, actors, issue_ids, contract_path, work_root, allowed_http_origin=None):
    from native_finish import UUID, HTTP_ORIGIN_ENV, _allowed_http_origin
    allowed_http_origin = _allowed_http_origin(allowed_http_origin)
    phases_required = ('prepare', 'machine', 'closeout')
    gaps = []
    for phase in phases_required:
        actor = actors.get(phase, {})
        adapter = actor.get('adapterType')
        if not isinstance(actor.get('id'), str) or not UUID.fullmatch(actor['id']):
            gaps.append(phase+': real actor id required')
        if phase == 'machine':
            if adapter != 'process':
                gaps.append('machine: dedicated process actor required; override cannot change adapterType')
        elif adapter not in ('omp_local', 'omp_native_json_local'):
            gaps.append(phase+': registered OMP adapter required; role labels do not select an engine')
    if actors.get('machine', {}).get('id') in [actors.get(p, {}).get('id') for p in ('prepare', 'closeout')]:
        gaps.append('machine: actor must be dedicated')
    if gaps:
        return {'status': 'needs_admission', 'phases': [], 'admission_gaps': gaps, 'creates_issues': False}
    if not isinstance(project_id, str) or not UUID.fullmatch(project_id):
        raise ValueError('project_id must be supplied UUID')
    ids = [issue_ids.get(p) for p in phases_required]
    if not all(isinstance(v, str) and UUID.fullmatch(v) for v in ids) or len(set(ids)) != 3:
        raise ValueError('three distinct supplied issue UUIDs required')
    if not Path(work_root).is_absolute() or not Path(contract_path).is_absolute():
        raise ValueError('absolute work and contract paths required')
    root = Path(work_root)
    script = str(Path(__file__).parent/'staged_qa.py')
    common = ['--contract', str(contract_path), '--machine-dir', str(root/'machine')]
    machine = {'command': sys.executable, 'args': [script, 'machine', *common, '--native-finish'],
               'cwd': str(root), 'timeoutSec': 600, 'graceSec': 15}
    helper = [sys.executable, script, 'closeout', *common, '--closeout-dir', str(root/'closeout'), '--native-finish']
    if allowed_http_origin is not None:
        machine['env'] = {HTTP_ORIGIN_ENV: allowed_http_origin}
        helper = ['env', HTTP_ORIGIN_ENV+'='+allowed_http_origin, *helper]
    descriptions = {
        'prepare': 'OMP: freeze the source snapshot and explicit QA contract at '+str(contract_path)+'. No machine run here.',
        'machine': 'Dedicated process actor: run frozen machine QA once, preserve receipts, then finish only this issue. Completed QA verdict FAIL is not infrastructure failure.',
        'closeout': 'OMP owns the judgement and closeout. Call the read-only evidence helper (do not rerun tests):\n```sh\n'+shlex.join(helper)+'\n```\nHelper verifies frozen evidence and registers only this current issue; unknown writes require reconciliation.'}
    phases = []
    for name, previous in [('prepare', None), ('machine', 'prepare'), ('closeout', 'machine')]:
        body = {'projectId': project_id, 'title': 'Segmented QA: '+name, 'description': descriptions[name],
                'status': 'todo', 'priority': 'medium', 'assigneeAgentId': actors[name]['id'],
                'blockedByIssueIds': [] if previous is None else [issue_ids[previous]]}
        if name == 'machine':
            body['assigneeAdapterOverrides'] = {'adapterConfig': machine, 'useProjectWorkspace': False}
        phases.append({'phase': name, 'type': 'process' if name == 'machine' else 'OMP',
                       'issue_id': issue_ids[name], 'actor': dict(actors[name]), 'body': body})
    return {'status': 'ready', 'phases': phases, 'admission_gaps': [], 'creates_issues': False}
