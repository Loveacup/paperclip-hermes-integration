"""Composition checks across independently implemented native graph and QA CLI."""
import shlex
import subprocess
import sys
import tempfile
import contextlib
import io
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
import unittest
from pathlib import Path
from native_graph import build_graph

ROOT = Path(__file__).resolve().parent
# All UUIDs below are synthetic fixtures, never live identities.
PROJECT = '10000000-0000-4000-8000-000000000001'
ACTORS = {
    'prepare': {'id': '10000000-0000-4000-8000-000000000002', 'adapterType': 'omp_local', 'role': 'pm'},
    'machine': {'id': '10000000-0000-4000-8000-000000000003', 'adapterType': 'process', 'role': 'qa'},
    'closeout': {'id': '10000000-0000-4000-8000-000000000004', 'adapterType': 'omp_local', 'role': 'qa'},
}
ISSUES = {name: '20000000-0000-4000-8000-00000000000'+str(i)
          for i, name in enumerate(('prepare', 'machine', 'closeout'), 1)}


class CompositionTests(unittest.TestCase):
    def test_machine_graph_through_installed_process_factory_and_local_native_finish(self):
        import staged_qa
        from test_staged_qa import SOURCE
        run_id = '30000000-0000-4000-8000-000000000001'
        company = '40000000-0000-4000-8000-000000000001'
        actor = ACTORS['machine']['id']
        issue_id = ISSUES['machine']
        state = {'id': issue_id, 'companyId': company, 'assigneeAgentId': actor, 'status':'in_progress'}
        comments, calls = [], []
        class LocalNative(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                self.handle_request('GET')
            def do_PATCH(self):
                self.handle_request('PATCH')
            def handle_request(self, method):
                self.server.owner.assertEqual(self.headers.get('Authorization'), 'Bearer synthetic-native-fixture')
                self.server.owner.assertEqual(self.headers.get('X-Paperclip-Run-Id'), run_id)
                body = json.loads(self.rfile.read(int(self.headers.get('Content-Length','0')))) if method=='PATCH' else None
                calls.append((method,self.path,body))
                if self.path=='/api/agents/me':
                    value = {'id':actor,'companyId':company,'role':'qa'}
                elif self.path=='/api/heartbeat-runs/'+run_id:
                    value = {'id':run_id,'companyId':company,'agentId':actor,'status':'running','nativeIssueId':issue_id,'contextSnapshot':{'issueId':issue_id,'taskId':issue_id,'taskKey':'wake:synthetic-session'}}
                elif self.path=='/api/issues/'+issue_id:
                    if method=='PATCH':
                        self.server.owner.assertEqual(body['status'],'done')
                        state['status']='done'
                        comments.append({'id':'synthetic-comment','issueId':issue_id,'companyId':company,'authorAgentId':actor,'body':body['comment']})
                    value = dict(state)
                elif self.path=='/api/issues/'+issue_id+'/comments':
                    value = comments
                else:
                    self.send_error(404)
                    return
                data=json.dumps(value).encode()
                self.send_response(200)
                self.send_header('Content-Type','application/json')
                self.send_header('Content-Length',str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            contract=staged_qa.prepare(SOURCE,root/'prepared')
            graph=build_graph(project_id=PROJECT,actors=ACTORS,issue_ids=ISSUES,contract_path=contract,work_root=root)
            config=next(p for p in graph['phases'] if p['phase']=='machine')['body']['assigneeAdapterOverrides']['adapterConfig']
            server=ThreadingHTTPServer(('127.0.0.1',0),LocalNative)
            server.owner=self
            thread=threading.Thread(target=server.serve_forever,daemon=True)
            thread.start()
            self.addCleanup(lambda:(server.shutdown(),server.server_close(),thread.join()))
            base='http://127.0.0.1:'+str(server.server_port)+'/api/'
            from test_support import paperclip_packages
            factory=paperclip_packages()/'server/dist/adapters/process/execute.js'
            js=r'''
import fs from 'node:fs';
const data=JSON.parse(fs.readFileSync(0,'utf8'));
const {execute}=await import(data.factory);
const result=await execute({runId:data.runId,agent:{id:data.actor,companyId:data.company,name:'Synthetic process QA'},config:data.config,authToken:'synthetic-native-fixture',onLog:async()=>{},onMeta:async meta=>{if(meta.env?.PAPERCLIP_API_URL!==data.base)throw Error('Synthetic-only endpoint preflight refused');}});
console.log(JSON.stringify({exitCode:result.exitCode,timedOut:result.timedOut,stderr:result.resultJson?.stderr??null}));
'''
            payload={'factory':factory.as_uri(),'runId':run_id,'actor':actor,'company':company,'config':config,'base':base}
            env={'PATH':os.environ['PATH'],'HOME':str(root),'TMPDIR':str(root),'PAPERCLIP_API_URL':base}
            result=subprocess.run(['node','--input-type=module','-e',js],input=json.dumps(payload),capture_output=True,text=True,env=env,timeout=60)
            self.assertEqual(result.returncode,0,result.stderr)
            executed=json.loads(result.stdout)
            self.assertEqual(executed['exitCode'],0,executed)
            self.assertEqual(state['status'],'done')
            self.assertEqual(len([c for c in calls if c[0]=='PATCH']),1)
            receipt=staged_qa.verify(contract,root/'machine')
            self.assertEqual(receipt['counts']['tests_run'],23)
            self.assertEqual(receipt['verdict'],'PASS')
            self.assertTrue((root/'machine/native-publication/finish.intent.json').is_file())

    def test_real_product_schema_mutant_is_completed_FAIL_not_execution_failure(self):
        import staged_qa
        from test_staged_qa import SOURCE
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            original=Path(staged_qa.prepare(SOURCE,root/'mutant-origin')).parent/'snapshot'
            product=original/'md_link_audit.py'
            text=product.read_text()
            self.assertEqual(text.count("'schema_version': 1"),1)
            product.write_text(text.replace("'schema_version': 1","'schema_version': 999"))
            contract=staged_qa.prepare(original,root/'prepared-mutant')
            args=['machine','--contract',str(contract),'--machine-dir',str(root/'machine-mutant')]
            with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
                code=staged_qa.main(args)
            self.assertEqual(code,0,'a completed adverse verdict is not execution failure')
            result=staged_qa.verify(contract,root/'machine-mutant')
            self.assertEqual(result['verdict'],'FAIL')
            self.assertEqual(result['counts']['tests_run'],23)
            self.assertEqual(result['counts']['errors'],0)
            self.assertGreater(result['counts']['failures'],0)

    def test_graph_uses_real_adapter_identity_not_invented_OMP_role(self):
        actors={k:dict(v) for k,v in ACTORS.items()}
        actors['prepare']['role']='pm'
        actors['closeout']['role']='qa'
        graph=build_graph(project_id=PROJECT,actors=actors,issue_ids=ISSUES,contract_path=ROOT/'synthetic-contract.json',work_root=ROOT/'synthetic-work')
        self.assertEqual(graph['status'],'ready','real Paperclip roles must not be replaced with an engine brand')
        actors['closeout']={'id':ACTORS['closeout']['id'],'role':'OMP','adapterType':'hermes_local'}
        graph=build_graph(project_id=PROJECT,actors=actors,issue_ids=ISSUES,contract_path=ROOT/'synthetic-contract.json',work_root=ROOT/'synthetic-work')
        self.assertEqual(graph['status'],'needs_admission','a brand label cannot turn another adapter into OMP')

    def test_native_finish_refusal_cannot_be_reported_as_process_success(self):
        import staged_qa
        from test_staged_qa import SOURCE
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            contract = staged_qa.prepare(SOURCE, root/'prepared')
            staged_qa.execute(contract, root/'machine')
            with patch('native_finish.finish_current_issue', return_value={'status':'refused','verified':False,'reason':'synthetic_denial'}), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                code = staged_qa.main(['machine','--contract',str(contract),'--machine-dir',str(root/'machine'),'--native-finish'])
            self.assertNotEqual(code, 0, 'native registration refusal must not become successful process execution')

    def test_graph_closeout_command_is_accepted_by_real_qa_cli(self):
        graph = build_graph(project_id=PROJECT, actors=ACTORS, issue_ids=ISSUES,
                            contract_path=ROOT/'synthetic-contract.json', work_root=ROOT/'synthetic-work')
        description = next(p for p in graph['phases'] if p['phase']=='closeout')['body']['description']
        command = description.split('```sh\n', 1)[1].split('\n```', 1)[0]
        result = subprocess.run(shlex.split(command)+['--help'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
