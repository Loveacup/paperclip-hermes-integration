"""Explicit trusted-plan native QA operations. No scheduler, retries, or task parsing."""
import json
import os
from pathlib import Path
import re
from urllib.request import Request, ProxyHandler, build_opener
import staged_qa as qa
import native_finish as nf

PHASES = ('prepare', 'machine', 'closeout')


def finish_expected(*, expected_issue, env, **kwargs):
    # Pin the previously verified identity at the public finisher's own boundary.
    if env.get('PAPERCLIP_TASK_ID',expected_issue)!=expected_issue: raise ValueError('identity')
    pinned=dict(env, PAPERCLIP_TASK_ID=expected_issue)
    return nf.finish_current_issue(env=pinned, **kwargs)


def publish_finish(plan,*,env=None,transport=None):
    env=os.environ if env is None else env; attempted=False
    try:
        root=validate(plan); publication=qa.safe(root/'closeout/native-publication')
        intent=publication/'document.intent.json'
        if intent.exists(): return outcome('needs_reconciliation')
        transport=transport or transport_for(env); call=context(plan,'closeout',env,transport)
        receipt=qa.closeout(root/'prepared/contract.json',root/'machine',root/'closeout')
        report=qa.safe(root/'closeout/REPORT.md').read_bytes()
        if qa.digest(report)!=receipt['report_sha256'] or env['PAPERCLIP_API_KEY'].encode() in report: raise ValueError('report')
        path='/api/issues/'+plan['issue_ids']['closeout']; key='segmented-qa'
        existing=call('GET',path+'/documents')
        if not isinstance(existing,list) or any(not isinstance(d,dict) or d.get('key')==key for d in existing): raise ValueError('existing_document')
        publication.mkdir(parents=True,exist_ok=True)
        qa.exclusive(intent,qa.encoded(dict(state='unknown',issueId=plan['issue_ids']['closeout'],runId=env['PAPERCLIP_RUN_ID'],reportSha256=qa.digest(report))))
        attempted=True
        body=dict(title='Segmented QA automated subset report',format='markdown',body=report.decode('utf-8'),baseRevisionId=None)
        call('PUT',path+'/documents/'+key,body)
        observed=call('GET',path+'/documents/'+key)
        if observed.get('key')!=key or any(observed.get(k)!=body[k] for k in ('title','format','body')): raise ValueError('document_readback')
        qa.exclusive(publication/'document.readback.json',qa.encoded(dict(status='read_back',issueId=plan['issue_ids']['closeout'],runId=env['PAPERCLIP_RUN_ID'],reportSha256=qa.digest(report))))
        return finish_expected(expected_issue=plan['issue_ids']['closeout'],summary='Published verified automated QA report; manual acceptance PENDING',receipt_sha256=qa.digest(qa.safe(root/'closeout/receipt.json').read_bytes()),intent_dir=publication,env=env,transport=transport)
    except Exception: return outcome('needs_reconciliation' if attempted else 'refused')


def build_plan(plan):
    """Pure payload generation; never creates tasks or admits execution."""
    import shlex
    import sys
    from native_graph import build_graph
    root=validate(plan)
    graph=build_graph(project_id=plan['project_id'],actors=plan['actors'],issue_ids=plan['issue_ids'],contract_path=root/'prepared/contract.json',work_root=root,allowed_http_origin=plan.get('allowed_http_origin'))
    if graph['status']!='ready': raise ValueError('actors_not_admitted')
    if not Path(plan['plan_path']).is_absolute(): raise ValueError('plan_path')
    for phase in graph['phases']:
        if phase['phase'] in ('prepare','closeout'):
            command=[sys.executable,'-B',str(Path(__file__).resolve()),'prepare' if phase['phase']=='prepare' else 'publish','--plan',plan['plan_path'],'--execute']
            if plan.get('allowed_http_origin') is not None:
                command=['env',nf.HTTP_ORIGIN_ENV+'='+plan['allowed_http_origin'],*command]
            phase['body']['description']='Use current native run only. Stop on any failure; do not retry or wake agents. Manual acceptance remains PENDING.\n'+shlex.join(command)
    return graph


def activate(plan,*,env=None,transport=None):
    env=os.environ if env is None else env; attempted=False
    try:
        root=validate(plan); directory=qa.safe(root/'activation')
        if directory.exists() and any(directory.glob('*.intent.json')): return outcome('needs_reconciliation')
        graph=build_plan(plan)
        transport=transport or transport_for(env); call=context(plan,'coordinator',env,transport)
        project=call('GET','/api/projects/'+plan['project_id'])
        if project.get('id')!=plan['project_id'] or project.get('companyId')!=plan['company_id'] or project.get('archivedAt'): raise ValueError('project')
        def fresh(phase):
            row=call('GET','/api/issues/'+phase['issue_id'])
            if row.get('assigneeAdapterOverrides') is not None: raise ValueError('existing_overrides')
            if any(row.get(k)!=v for k,v in [('id',phase['issue_id']),('companyId',plan['company_id']),('projectId',plan['project_id']),('status','backlog')]) or any(row.get(k) for k in ('assigneeAgentId','assigneeUserId','executionRunId','checkoutRunId','startedAt','completedAt','cancelledAt','archivedAt')): raise ValueError('not_fresh_backlog')
        for phase in graph['phases']:
            actor=call('GET','/api/agents/'+phase['actor']['id'])
            if any(actor.get(k)!=v for k,v in [('id',phase['actor']['id']),('companyId',plan['company_id']),('adapterType',phase['actor']['adapterType'])]) or actor.get('status') not in ('active','idle','running'): raise ValueError('actor')
            fresh(phase)
        directory.mkdir(parents=True,exist_ok=True)
        qa.exclusive(directory/'activation.intent.json',qa.encoded(dict(state='unknown',runId=env['PAPERCLIP_RUN_ID'],planSha256=qa.digest(qa.encoded(plan)))))
        attempted=True; records=[]
        for phase in reversed(graph['phases']):
            fresh(phase)
            path='/api/issues/'+phase['issue_id']; body=phase['body']
            qa.exclusive(directory/(phase['phase']+'.intent.json'),qa.encoded(dict(state='unknown',issueId=phase['issue_id'],bodySha256=qa.digest(qa.encoded(body)))))
            call('PATCH',path,body); row=call('GET',path)
            if row.get('id')!=phase['issue_id'] or row.get('companyId')!=plan['company_id'] or row.get('assigneeUserId'): raise ValueError('scope_readback')
            if row.get('assigneeAdapterOverrides')!=body.get('assigneeAdapterOverrides'): raise ValueError('override_readback')
            for k,v in body.items():
                if k=='blockedByIssueIds':
                    dependencies=row.get('blockedBy')
                    if not isinstance(dependencies,list) or [d['id'] for d in dependencies]!=v: raise ValueError('dependency_readback')
                elif row.get(k)!=v: raise ValueError('patch_readback')
            records.append(dict(phase=phase['phase'],issueId=phase['issue_id'],status='read_back'))
        raw=qa.encoded(dict(assignments=records,manualHeartbeatInvokes=0,businessAcceptance='unverified'))
        qa.exclusive(directory/'dispatch.readback.json',raw)
        result=finish_expected(expected_issue=plan['coordinator_issue_id'],summary='Native dispatch verified; no manual wake; QA business acceptance unverified, manual acceptance PENDING',receipt_sha256=qa.digest(raw),intent_dir=directory,env=env,transport=transport)
        return {**result,'businessAcceptance':'unverified','manualHeartbeatInvokes':0}
    except Exception: return outcome('needs_reconciliation' if attempted else 'refused')


def validate(plan):
    if plan['schema'] != 'native-qa-workflow/v1': raise ValueError('schema')
    ids = [plan[k] for k in ('company_id','ceo_id','coordinator_issue_id','project_id')]
    ids += [plan['issue_ids'][p] for p in PHASES] + [plan['actors'][p]['id'] for p in PHASES]
    if not all(isinstance(i,str) and nf.UUID.fullmatch(i) for i in ids): raise ValueError('ids')
    if len(set([plan['coordinator_issue_id'],*plan['issue_ids'].values()])) != 4: raise ValueError('issue_alias')
    for k in ('source_project','work_root'):
        if not Path(plan[k]).is_absolute(): raise ValueError('absolute_paths_required')
        qa.safe(plan[k])
    qa.disjoint(qa.safe(plan['source_project']),qa.safe(plan['work_root']))
    return qa.safe(plan['work_root'])


def transport_for(env):
    base=nf._base_url(env['PAPERCLIP_API_URL'],env.get(nf.HTTP_ORIGIN_ENV))
    opener=build_opener(ProxyHandler({}),nf._NoRedirect())
    def request(method,path,body,headers):
        if method not in ('GET','PATCH','PUT') or not re.fullmatch(r'/api/(?:agents/(?:me|[0-9a-fA-F-]+)|projects/[0-9a-fA-F-]+|heartbeat-runs/[0-9a-fA-F-]+|issues/[0-9a-fA-F-]+(?:/comments|/documents(?:/[A-Za-z0-9_-]+)?)?)',path): raise ValueError('route')
        req=Request(base+path,data=None if body is None else json.dumps(body).encode(),headers={**headers,'Content-Type':'application/json'},method=method)
        with opener.open(req,timeout=10) as r: return json.load(r)
    return request


def context(plan,phase,env,transport):
    validate(plan)
    agent=plan['ceo_id'] if phase=='coordinator' else plan['actors'][phase]['id']
    issue=plan['coordinator_issue_id'] if phase=='coordinator' else plan['issue_ids'][phase]
    company=plan['company_id']; run=env['PAPERCLIP_RUN_ID']; token=env['PAPERCLIP_API_KEY']
    nf._base_url(env['PAPERCLIP_API_URL'],env.get(nf.HTTP_ORIGIN_ENV))
    if not nf.UUID.fullmatch(run) or not token or any(c.isspace() for c in token): raise ValueError('runtime')
    if any(env.get('PAPERCLIP_'+k)!=v for k,v in [('AGENT_ID',agent),('COMPANY_ID',company)]) or env.get('PAPERCLIP_TASK_ID',issue)!=issue: raise ValueError('identity')
    headers={'Authorization':'Bearer '+token,'X-Paperclip-Run-Id':run}
    def call(method,path,body=None): return transport(method,path,body,headers)
    me=call('GET','/api/agents/me'); runtime=call('GET','/api/heartbeat-runs/'+run)
    if me.get('id')!=agent or me.get('companyId')!=company or any(runtime.get(k)!=v for k,v in [('id',run),('companyId',company),('agentId',agent),('status','running')]): raise ValueError('runtime_binding')
    if phase=='coordinator' and (me.get('role')!='ceo' or me.get('keyScope') or me.get('status') not in ('active','idle','running')): raise ValueError('ceo_required')
    ctx=runtime.get('contextSnapshot') or {}
    if not isinstance(ctx,dict): raise ValueError('context')
    bindings=[runtime[k] for k in ('nativeIssueId',) if runtime.get(k) is not None]+[ctx[k] for k in ('issueId','taskId') if ctx.get(k) is not None]
    if not bindings or any(v!=issue for v in bindings): raise ValueError('issue_binding')
    row=call('GET','/api/issues/'+issue)
    if any(row.get(k)!=v for k,v in [('id',issue),('companyId',company),('assigneeAgentId',agent),('projectId',plan['project_id'])]) or row.get('assigneeUserId') or row.get('status') not in ('todo','in_progress','in_review'): raise ValueError('ownership')
    return call


def outcome(status): return dict(status=status,verified=status=='read_back',businessAcceptance='unverified')


def prepare_finish(plan,*,env=None,transport=None):
    env=os.environ if env is None else env
    try:
        root=validate(plan); intent=qa.safe(root/'prepare-publication')
        if (intent/'finish.intent.json').exists() or (intent/'prepare.intent.json').exists(): return outcome('needs_reconciliation')
        transport=transport or transport_for(env); context(plan,'prepare',env,transport)
        contract=root/'prepared/contract.json'
        if not contract.exists(): qa.prepare(plan['source_project'],root/'prepared')
        _,digest=qa.load_contract(contract)
        intent.mkdir(parents=True,exist_ok=True)
        qa.exclusive(intent/'prepare.intent.json',qa.encoded(dict(state='unknown',issueId=plan['issue_ids']['prepare'],runId=env['PAPERCLIP_RUN_ID'])))
        return finish_expected(expected_issue=plan['issue_ids']['prepare'],summary='QA contract frozen; machine not executed; manual acceptance PENDING',receipt_sha256=digest,intent_dir=intent,env=env,transport=transport)
    except Exception: return outcome('refused')


def main(argv=None):
    import argparse
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation',choices=('plan','prepare','publish','activate'))
    parser.add_argument('--plan',required=True)
    parser.add_argument('--execute',action='store_true')
    args=parser.parse_args(argv)
    try:
        if args.operation!='plan' and not args.execute: raise ValueError('explicit_execution_required')
        path=qa.safe(args.plan)
        plan=json.loads(path.read_bytes())
        if str(path)!=plan['plan_path']: raise ValueError('plan_path_binding')
        if args.operation=='plan': result=build_plan(plan)
        else: result={'prepare':prepare_finish,'publish':publish_finish,'activate':activate}[args.operation](plan)
        print(json.dumps(result,sort_keys=True))
        return 0 if args.operation=='plan' or result.get('verified') is True else 2
    except Exception:
        print('{"status":"refused","verified":false}')
        return 2


if __name__=='__main__': raise SystemExit(main())
