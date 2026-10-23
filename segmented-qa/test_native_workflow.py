import importlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
import uuid
import staged_qa as qa


def uid(): return str(uuid.uuid4())

class MemoryAPI:
    def __init__(self, plan, phase='prepare'):
        self.p = plan
        actor = plan['ceo_id'] if phase == 'coordinator' else plan['actors'][phase]['id']
        issue = plan['coordinator_issue_id'] if phase == 'coordinator' else plan['issue_ids'][phase]
        self.env = dict(PAPERCLIP_AGENT_ID=actor, PAPERCLIP_COMPANY_ID=plan['company_id'], PAPERCLIP_RUN_ID=uid(), PAPERCLIP_TASK_ID=issue, PAPERCLIP_API_KEY='synthetic-token', PAPERCLIP_API_URL='https://synthetic.invalid/api')
        company = plan['company_id']
        self.rows = {'/api/agents/me':dict(id=actor, companyId=company, status='running', role='ceo' if phase=='coordinator' else 'general'), '/api/heartbeat-runs/'+self.env['PAPERCLIP_RUN_ID']:dict(id=self.env['PAPERCLIP_RUN_ID'],companyId=company,agentId=actor,status='running',nativeIssueId=issue,contextSnapshot={'issueId':issue,'taskId':issue})}
        self.rows['/api/issues/'+issue] = dict(id=issue, companyId=company, assigneeAgentId=actor, assigneeUserId=None,status='in_progress',projectId=plan['project_id'])
        self.comments=[]; self.calls=[]
    def __call__(self, method, path, body, headers):
        self.calls.append((method,path,body))
        if method=='PATCH':
            self.rows[path].update({k:v for k,v in body.items() if k!='comment'})
            if 'blockedByIssueIds' in body: self.rows[path]['blockedBy']=[{'id':i} for i in body['blockedByIssueIds']]
            if 'comment' in body: self.comments.append(dict(issueId=path.split('/')[-1],companyId=self.p['company_id'],authorAgentId=self.env['PAPERCLIP_AGENT_ID'],body=body['comment']))
        if method=='PUT': self.rows[path] = dict(key=path.split('/')[-1], **body)
        if path.endswith('/comments'): return self.comments
        if path.endswith('/documents'): return []
        return dict(self.rows[path])
    def writes(self): return [c for c in self.calls if c[0]!='GET']

class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']); self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name).resolve()
        self.p=dict(schema='native-qa-workflow/v1',company_id=uid(),ceo_id=uid(),coordinator_issue_id=uid(),project_id=uid(),issue_ids={p:uid() for p in ('prepare','machine','closeout')},actors={p:dict(id=uid(),adapterType='process' if p=='machine' else 'omp_local') for p in ('prepare','machine','closeout')},source_project=str(self.root/'source'),work_root=str(self.root/'work'))
        self.p['plan_path']=str(self.root/'plan.json')
        source=self.root/'source'
        for name in (*qa.BASE_FILES,'qa/guard/check.py'):
            target=source/name; target.parent.mkdir(parents=True,exist_ok=True); target.write_text('# synthetic fixture\n')
        self.api=MemoryAPI(self.p)
    def workflow(self):
        spec=importlib.util.find_spec('native_workflow')
        self.assertIsNotNone(spec,'native workflow implementation missing')
        return importlib.import_module('native_workflow')
    def test_importlib_util_is_explicit(self):
        import ast
        tree=ast.parse(Path(__file__).read_text())
        self.assertTrue(any(isinstance(node,ast.Import) and any(a.name=='importlib.util' for a in node.names) for node in tree.body))

    def test_prepare_freezes_then_finishes_only_bound_issue(self):
        w=self.workflow()
        result=w.prepare_finish(self.p,env=self.api.env,transport=self.api)
        self.assertTrue(result['verified'])
        qa.load_contract(self.root/'work/prepared/contract.json')
        self.assertEqual([c[0] for c in self.api.writes()],['PATCH'])
        self.assertFalse((self.root/'work/machine').exists())
        self.assertEqual(w.prepare_finish(self.p,env=self.api.env,transport=self.api)['status'],'needs_reconciliation')
        self.assertEqual(len(self.api.writes()),1)

    def evidence(self):
        import shutil
        contract=qa.prepare(self.p['source_project'],self.root/'work/prepared')
        doc,ch=qa.load_contract(contract)
        machine=self.root/'work/machine'; machine.mkdir()
        shutil.copytree(contract.parent/'snapshot',machine/'runtime')
        work=machine/'work'; work.mkdir()
        ids=['test_blackbox.Acceptance.test_'+str(i) for i in range(23)]
        counts=dict(tests_run=23,failures=0,errors=0,skips=0)
        (machine/'observation.json').write_bytes(qa.encoded(dict(**counts,test_ids=ids,exit_code=0)))
        (work/'unittest.txt').write_text('\n'.join(ids)+'\nRan 23 tests in synthetic fixture\n')
        (work/'commands.jsonl').write_text('{"synthetic":true}\n')
        (work/'result.json').write_bytes(qa.encoded(dict(kind=qa.COVERAGE,mode='d1',status='PASS',tests_run=23,failures=0,errors=0,skips=[],cli=str(machine/'runtime/md_link_audit.py'),cli_sha256=doc['files']['md_link_audit.py'],manual_acceptance='PENDING')))
        admission=dict(schema='segmented-qa-admission/v1',contract_sha256=ch,machine_dir=str(machine),execution_count=1)
        (machine/'admission.json').write_bytes(qa.encoded(admission))
        receipt=dict(schema='segmented-qa-receipt/v1',contract_sha256=ch,admission_sha256=qa.digest(qa.encoded(admission)),coverage=qa.COVERAGE,manual_acceptance='PENDING',verdict='PASS',counts=counts,artifacts=qa.bound_artifacts(machine))
        (machine/'receipt.json').write_bytes(qa.encoded(receipt)); (machine/'receipt.sha256').write_text(qa.digest(qa.encoded(receipt))+'\n')
        qa.verify(contract,machine)

    def test_report_exact_readback_before_finish(self):
        w=self.workflow(); self.assertTrue(hasattr(w,'publish_finish'),'report operation missing')
        self.evidence(); api=MemoryAPI(self.p,'closeout')
        result=w.publish_finish(self.p,env=api.env,transport=api)
        self.assertTrue(result['verified'],result)
        self.assertEqual([c[0] for c in api.writes()],['PUT','PATCH'])
        doc=api.rows['/api/issues/'+self.p['issue_ids']['closeout']+'/documents/segmented-qa']
        self.assertEqual(doc['body'],(self.root/'work/closeout/REPORT.md').read_text())
        self.assertEqual(w.publish_finish(self.p,env=api.env,transport=api)['status'],'needs_reconciliation')
        self.assertEqual(len(api.writes()),2)

    def graph_api(self):
        api=MemoryAPI(self.p,'coordinator'); company=self.p['company_id']
        api.rows['/api/projects/'+self.p['project_id']]=dict(id=self.p['project_id'],companyId=company)
        for phase in ('prepare','machine','closeout'):
            actor=self.p['actors'][phase]
            api.rows['/api/agents/'+actor['id']]=dict(**actor,companyId=company,status='idle')
            issue=self.p['issue_ids'][phase]
            api.rows['/api/issues/'+issue]=dict(id=issue,companyId=company,projectId=self.p['project_id'],status='backlog',assigneeAgentId=None,assigneeUserId=None)
        return api

    def test_activate_reverse_order_then_coordinator_finish(self):
        w=self.workflow(); self.assertTrue(hasattr(w,'activate'),'activation missing')
        api=self.graph_api()
        result=w.activate(self.p,env=api.env,transport=api)
        self.assertTrue(result['verified'],result)
        self.assertEqual(result['businessAcceptance'],'unverified')
        self.assertEqual([c[1] for c in api.writes()],['/api/issues/'+self.p['issue_ids'][p] for p in ('closeout','machine','prepare')]+['/api/issues/'+self.p['coordinator_issue_id']])
        self.assertEqual(w.activate(self.p,env=api.env,transport=api)['status'],'needs_reconciliation')
        self.assertEqual(len(api.writes()),4)

    def test_cli_requires_explicit_execution(self):
        w=self.workflow(); self.assertTrue(hasattr(w,'main'),'CLI missing')
        path=self.root/'plan.json'; path.write_text(json.dumps(self.p))
        self.assertEqual(w.main(['prepare','--plan',str(path)]),2)
        self.assertFalse((self.root/'work').exists())
        import contextlib, io
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(w.main(['plan','--plan',str(path)]),0)
        self.assertFalse((self.root/'work').exists())

    def test_binding_conflict_and_taskkey_only_refuse(self):
        w=self.workflow()
        runtime=self.api.rows['/api/heartbeat-runs/'+self.api.env['PAPERCLIP_RUN_ID']]
        for ctx,native in [({'issueId':uid()},self.p['issue_ids']['prepare']), ({},None)]:
            runtime.update(contextSnapshot=ctx,nativeIssueId=native,taskKey=self.p['issue_ids']['prepare'])
            self.assertEqual(w.prepare_finish(self.p,env=self.api.env,transport=self.api)['status'],'refused')
        self.assertEqual(self.api.writes(),[])

    def test_report_mismatch_prevents_closeout(self):
        w=self.workflow(); self.evidence(); api=MemoryAPI(self.p,'closeout')
        def corrupted(method,path,body,headers):
            row=api(method,path,body,headers)
            if method=='GET' and path.endswith('/documents/segmented-qa'): row['body']='corrupted'
            return row
        self.assertEqual(w.publish_finish(self.p,env=api.env,transport=corrupted)['status'],'needs_reconciliation')
        self.assertEqual([c[0] for c in api.writes()],['PUT'])
        self.assertEqual(w.publish_finish(self.p,env=api.env,transport=corrupted)['status'],'needs_reconciliation')
        self.assertEqual(len(api.writes()),1)

    def test_tampered_report_refuses_without_network_write(self):
        w=self.workflow(); self.evidence(); api=MemoryAPI(self.p,'closeout')
        qa.closeout(self.root/'work/prepared/contract.json',self.root/'work/machine',self.root/'work/closeout')
        (self.root/'work/closeout/REPORT.md').write_text('forged')
        self.assertEqual(w.publish_finish(self.p,env=api.env,transport=api)['status'],'refused')
        self.assertEqual(api.writes(),[])

    def test_activation_checks_all_backlog_before_write(self):
        w=self.workflow(); api=self.graph_api()
        api.rows['/api/issues/'+self.p['issue_ids']['prepare']]['assigneeUserId']='synthetic-user'
        self.assertEqual(w.activate(self.p,env=api.env,transport=api)['status'],'refused')
        self.assertEqual(api.writes(),[])

    def fixture(self):
        f=WorkflowTests(); f.setUp(); self.addCleanup(f.doCleanups); return f

    def test_existing_overrides_rejected_across_entire_graph(self):
        for phase in ('prepare','machine','closeout'):
            for override in ({'adapterConfig':{'command':'untrusted','env':{'PAPERCLIP_API_URL':'https://untrusted.invalid'}}}, {}, False, ''):
                with self.subTest(phase=phase,override=override):
                    f=self.fixture(); api=f.graph_api(); target='/api/issues/'+f.p['issue_ids'][phase]
                    api.rows[target]['assigneeAdapterOverrides']=override
                    self.assertEqual(f.workflow().activate(f.p,env=api.env,transport=api)['status'],'refused')
                    self.assertEqual(api.writes(),[])
                    self.assertEqual(api.rows[target]['assigneeAdapterOverrides'],override)

    def test_finish_binding_drift_never_patches_other_issue_or_retries(self):
        for phase in ('prepare','closeout','coordinator'):
            with self.subTest(phase=phase):
                f=self.fixture(); w=f.workflow()
                if phase=='closeout': f.evidence()
                api=f.graph_api() if phase=='coordinator' else MemoryAPI(f.p,phase)
                api.env.pop('PAPERCLIP_TASK_ID'); original=dict(api.env); global_env=dict(os.environ)
                expected=f.p['coordinator_issue_id'] if phase=='coordinator' else f.p['issue_ids'][phase]
                other=uid(); target='/api/issues/'+other
                api.rows[target]=dict(api.rows['/api/issues/'+expected],id=other)
                runtime=api.rows['/api/heartbeat-runs/'+api.env['PAPERCLIP_RUN_ID']]; reads=0
                def switched(method,path,body,headers):
                    nonlocal reads
                    if method=='GET' and path.startswith('/api/heartbeat-runs/'):
                        reads+=1
                        if reads==2: runtime.update(nativeIssueId=other,contextSnapshot={'issueId':other,'taskId':other})
                    return api(method,path,body,headers)
                operation={'prepare':w.prepare_finish,'closeout':w.publish_finish,'coordinator':w.activate}[phase]
                result=operation(f.p,env=api.env,transport=switched)
                self.assertFalse(result['verified'])
                self.assertFalse(any(m=='PATCH' and (p==target or b.get('status')=='done') for m,p,b in api.writes()))
                self.assertTrue(list((f.root/'work').rglob('*.intent.json')))
                before=list(api.calls)
                self.assertEqual(operation(f.p,env=api.env,transport=switched)['status'],'needs_reconciliation')
                self.assertEqual(api.calls,before)
                self.assertEqual(api.env,original); self.assertEqual(dict(os.environ),global_env)

    def test_finish_missing_task_id_success_and_conflicting_id_refusal(self):
        for phase in ('prepare','closeout','coordinator'):
            for conflict in (False,True):
                with self.subTest(phase=phase,conflict=conflict):
                    f=self.fixture(); w=f.workflow()
                    if phase=='closeout': f.evidence()
                    api=f.graph_api() if phase=='coordinator' else MemoryAPI(f.p,phase)
                    if conflict: api.env['PAPERCLIP_TASK_ID']=uid()
                    else: api.env.pop('PAPERCLIP_TASK_ID')
                    original=dict(api.env)
                    result={'prepare':w.prepare_finish,'closeout':w.publish_finish,'coordinator':w.activate}[phase](f.p,env=api.env,transport=api)
                    self.assertEqual(result['verified'],not conflict)
                    if conflict: self.assertEqual(api.writes(),[])
                    self.assertEqual(api.env,original)

    def test_override_race_rechecked_before_patch(self):
        f=self.fixture(); api=f.graph_api(); target='/api/issues/'+f.p['issue_ids']['closeout']; reads=0
        def injected(method,path,body,headers):
            nonlocal reads
            if method=='GET' and path==target:
                reads+=1
                if reads==2: api.rows[path]['assigneeAdapterOverrides']={'adapterConfig':{'command':'untrusted'}}
            return api(method,path,body,headers)
        w=f.workflow()
        self.assertEqual(w.activate(f.p,env=api.env,transport=injected)['status'],'needs_reconciliation')
        self.assertEqual(api.writes(),[])
        self.assertEqual(w.activate(f.p,env=api.env,transport=injected)['status'],'needs_reconciliation')
        self.assertEqual(api.writes(),[])

    def test_full_override_readback_including_absence(self):
        for phase in ('prepare','machine','closeout'):
            with self.subTest(phase=phase):
                f=self.fixture(); api=f.graph_api(); target='/api/issues/'+f.p['issue_ids'][phase]
                def injected(method,path,body,headers):
                    result=api(method,path,body,headers)
                    if method=='PATCH' and path==target: api.rows[path]['assigneeAdapterOverrides']={'adapterConfig':{'command':'untrusted'}}
                    return result
                w=f.workflow()
                self.assertEqual(w.activate(f.p,env=api.env,transport=injected)['status'],'needs_reconciliation')
                before=list(api.writes())
                self.assertFalse(any(b.get('status')=='done' for m,p,b in before))
                self.assertEqual(w.activate(f.p,env=api.env,transport=injected)['status'],'needs_reconciliation')
                self.assertEqual(api.writes(),before)

    def test_machine_preserves_exact_approved_override(self):
        api=self.graph_api(); w=self.workflow()
        expected=next(p['body']['assigneeAdapterOverrides'] for p in w.build_plan(self.p)['phases'] if p['phase']=='machine')
        self.assertTrue(w.activate(self.p,env=api.env,transport=api)['verified'])
        self.assertEqual(api.rows['/api/issues/'+self.p['issue_ids']['machine']]['assigneeAdapterOverrides'],expected)

    def test_activation_timeout_never_replays(self):
        w=self.workflow(); api=self.graph_api()
        def lost(method,path,body,headers):
            result=api(method,path,body,headers)
            if method=='PATCH': raise TimeoutError('synthetic')
            return result
        self.assertEqual(w.activate(self.p,env=api.env,transport=lost)['status'],'needs_reconciliation')
        self.assertEqual(w.activate(self.p,env=api.env,transport=lost)['status'],'needs_reconciliation')
        self.assertEqual(len(api.writes()),1)

    def test_remote_plaintext_remains_optin(self):
        w=self.workflow(); self.api.env['PAPERCLIP_API_URL']='http://synthetic.invalid/api'
        self.assertEqual(w.prepare_finish(self.p,env=self.api.env,transport=self.api)['status'],'refused')
        self.assertEqual(self.api.calls,[])

    def test_plaintext_origin_is_carried_to_all_phase_commands(self):
        w=self.workflow(); self.p['allowed_http_origin']='http://synthetic.invalid:4567'
        graph=w.build_plan(self.p)
        for phase in graph['phases']:
            if phase['phase']=='machine':
                self.assertEqual(phase['body']['assigneeAdapterOverrides']['adapterConfig']['env']['SEGMENTED_QA_ALLOWED_HTTP_ORIGIN'],self.p['allowed_http_origin'])
            else:
                self.assertIn('SEGMENTED_QA_ALLOWED_HTTP_ORIGIN=http://synthetic.invalid:4567',phase['body']['description'])

    def test_real_loopback_transport_api_suffix(self):
        from http.server import BaseHTTPRequestHandler, HTTPServer
        import threading
        w=self.workflow(); api=self.api
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def handle_request(self):
                body=json.loads(self.rfile.read(int(self.headers['Content-Length']))) if self.headers.get('Content-Length') else None
                result=api(self.command,self.path,body,dict(self.headers))
                self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers(); self.wfile.write(json.dumps(result).encode())
            do_GET=handle_request
            do_PATCH=handle_request
        server=HTTPServer(('127.0.0.1',0),Handler); thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
        try:
            api.env['PAPERCLIP_API_URL']='http://127.0.0.1:'+str(server.server_port)+'/api/'
            self.assertTrue(w.prepare_finish(self.p,env=api.env)['verified'])
        finally:
            server.shutdown(); server.server_close(); thread.join()
        self.assertEqual(len(api.writes()),1)

    def test_ceo_and_actor_status_allowlist(self):
        for target in ('ceo','actor'):
            for status in ('active','idle','running','paused','terminated','pending_approval','error',None,'unknown'):
                with self.subTest(target=target,status=status):
                    f=self.fixture(); api=f.graph_api()
                    row=api.rows['/api/agents/me' if target=='ceo' else '/api/agents/'+f.p['actors']['machine']['id']]
                    if status is None: row.pop('status',None)
                    else: row['status']=status
                    result=f.workflow().activate(f.p,env=api.env,transport=api)
                    allowed=status in ('active','idle','running')
                    self.assertEqual(result['verified'],allowed)
                    if not allowed:
                        self.assertEqual(result['status'],'refused')
                        self.assertEqual(api.writes(),[])

    def test_actor_company_project_and_ceo_admission_guards(self):
        w=self.workflow()
        for kind in ('actor-company','actor-paused','adapter','project','ceo','run'):
            with self.subTest(kind=kind):
                api=self.graph_api()
                if kind=='actor-company': api.rows['/api/agents/'+self.p['actors']['machine']['id']]['companyId']=uid()
                if kind=='actor-paused': api.rows['/api/agents/'+self.p['actors']['machine']['id']]['status']='paused'
                if kind=='adapter': api.rows['/api/agents/'+self.p['actors']['machine']['id']]['adapterType']='omp_local'
                if kind=='project': api.rows['/api/issues/'+self.p['issue_ids']['closeout']]['projectId']=uid()
                if kind=='ceo': api.rows['/api/agents/me']['role']='engineer'
                if kind=='run': api.rows['/api/heartbeat-runs/'+api.env['PAPERCLIP_RUN_ID']]['status']='succeeded'
                self.assertEqual(w.activate(self.p,env=api.env,transport=api)['status'],'refused')
                self.assertEqual(api.writes(),[])

    def test_corrupt_machine_receipt_refuses_publication(self):
        w=self.workflow(); self.evidence(); api=MemoryAPI(self.p,'closeout')
        (self.root/'work/machine/receipt.json').write_text('{}')
        self.assertEqual(w.publish_finish(self.p,env=api.env,transport=api)['status'],'refused')
        self.assertEqual(api.writes(),[])

if __name__=='__main__': unittest.main()
