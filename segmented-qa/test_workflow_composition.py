"""Real workflow/QA composition against a synthetic local control plane, not live scheduling."""
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
import unittest
from typing import Any

import native_workflow as workflow
import staged_qa as qa
import test_native_workflow as support

ROOT = Path(__file__).resolve().parent


class WorkflowCompositionTests(unittest.TestCase):
    def test_generated_commands_execute_real_qa_and_publish_before_finish(self):
        fixture = support.WorkflowTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        plan: dict[str, Any] = fixture.p
        source = Path(plan['source_project'])
        self.assertEqual(source.parent, fixture.root)
        shutil.rmtree(source)  # Only the synthetic source created by this test fixture.
        shutil.copytree(ROOT / 'fixtures/md-link-audit', source,
                        ignore=shutil.ignore_patterns('__pycache__', '.runs'))
        Path(plan['plan_path']).write_text(json.dumps(plan), encoding='utf-8')
        state = {'api': fixture.graph_api()}

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format, *args):
                pass

            def request(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length']))) if self.headers.get('Content-Length') else None
                result = state['api'](self.command, self.path, body, dict(self.headers))
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(result).encode())

            do_GET = request
            do_PATCH = request
            do_PUT = request

        server = HTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            base = 'http://127.0.0.1:' + str(server.server_port) + '/api/'
            state['api'].env['PAPERCLIP_API_URL'] = base
            self.assertTrue(workflow.activate(plan, env=state['api'].env)['verified'])
            graph = workflow.build_plan(plan)
            self.assertEqual(workflow.build_plan(dict(plan, command='/untrusted/command', api_url='https://untrusted.invalid')), graph)
            phases = {item['phase']: item for item in graph['phases']}
            for phase in ('prepare', 'machine', 'closeout'):
                api = support.MemoryAPI(plan, phase)
                api.env['PAPERCLIP_API_URL'] = base
                api.env.pop('PAPERCLIP_TASK_ID')
                state['api'] = api
                env = dict(api.env, PATH=os.environ.get('PATH', os.defpath), TMPDIR=str(fixture.root),
                           PYTHONDONTWRITEBYTECODE='1', PYTHONPATH=str(ROOT))
                cwd = plan['work_root']
                if phase == 'machine':
                    config = phases[phase]['body']['assigneeAdapterOverrides']['adapterConfig']
                    command = [config['command'], *config['args']]
                    env.update(config.get('env', {}))
                    cwd = config.get('cwd', cwd)
                else:
                    command = shlex.split(phases[phase]['body']['description'].splitlines()[-1])
                run = subprocess.run(command, cwd=cwd, env=env, capture_output=True, text=True, timeout=120)
                self.assertEqual(run.returncode, 0, (phase, run.stdout, run.stderr))
                self.assertEqual(api.rows['/api/issues/' + plan['issue_ids'][phase]]['status'], 'done')
                self.assertEqual(sum(call[0] == 'PATCH' for call in api.calls), 1)
                if phase != 'machine':
                    self.assertEqual(sum(call[1].startswith('/api/heartbeat-runs/') for call in api.calls), 2)
                    calls_before = list(api.calls)
                    replay = subprocess.run(command, cwd=cwd, env=env, capture_output=True, text=True, timeout=30)
                    self.assertEqual(replay.returncode, 2, (phase, replay.stdout, replay.stderr))
                    self.assertEqual(api.calls, calls_before)
                if phase == 'closeout':
                    route = '/api/issues/' + plan['issue_ids'][phase] + '/documents/segmented-qa'
                    self.assertEqual(api.rows[route]['body'], (Path(plan['work_root']) / 'closeout/REPORT.md').read_text())
                    doc_read = next(i for i, call in enumerate(api.calls) if call[0] == 'GET' and call[1] == route)
                    finish_write = next(i for i, call in enumerate(api.calls) if call[0] == 'PATCH')
                    self.assertLess(doc_read, finish_write)
            receipt = qa.verify(Path(plan['work_root']) / 'prepared/contract.json', Path(plan['work_root']) / 'machine')
            self.assertEqual(receipt['verdict'], 'PASS')
            self.assertEqual(receipt['counts'], dict(tests_run=23, failures=0, errors=0, skips=0))
            admission = json.loads((Path(plan['work_root']) / 'machine/admission.json').read_text())
            self.assertEqual(admission['execution_count'], 1)
            self.assertEqual(receipt['manual_acceptance'], 'PENDING')
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
            self.assertFalse(thread.is_alive())
