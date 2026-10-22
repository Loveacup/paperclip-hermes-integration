"""Offline synthetic native-runtime fixtures; never contact Paperclip."""
import importlib
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).parent
# Synthetic UUID fixtures only.
IDS = [f'00000000-0000-4000-8000-{i:012d}' for i in range(1, 7)]
A, C, R, I, OTHER, P = IDS
ENV = dict(PAPERCLIP_API_URL='http://127.0.0.1:9', PAPERCLIP_API_KEY='synthetic-secret-never-log', PAPERCLIP_AGENT_ID=A, PAPERCLIP_COMPANY_ID=C, PAPERCLIP_RUN_ID=R)

class Fake:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.calls = []
        self.me = dict(id=A, companyId=C)
        self.run = dict(id=R, companyId=C, agentId=A, status='running', contextSnapshot={'issueId': I})
        self.issue = dict(id=I, companyId=C, assigneeAgentId=A, status='in_progress')
        self.comments = []
        self.error = None
        self.mismatch = False
    def __call__(self, method, path, body, headers):
        self.calls.append((method, path))
        assert headers['X-Paperclip-Run-Id'] == R
        if method == 'PATCH':
            intent = json.loads((self.directory / 'finish.intent.json').read_text())
            assert intent['state'] == 'unknown'
            assert intent['issue_id'] == I
            if self.error:
                raise self.error
            self.issue['status'] = 'done'
            self.comments = [dict(issueId=I, companyId=C, authorAgentId=A, body=body['comment'])]
            if self.mismatch:
                self.comments[0]['body'] += ' altered'
            return {'accepted': True}
        return {'/api/agents/me': self.me, f'/api/heartbeat-runs/{R}': self.run,
                f'/api/issues/{I}': self.issue, f'/api/issues/{I}/comments': self.comments}[path]

class FinishTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.fake = Fake(self.temp.name)
    def finish(self, **kwargs):
        module = importlib.import_module('native_finish')
        return module.finish_current_issue(summary='QA completed; verdict FAIL', receipt_sha256='a'*64,
            intent_dir=self.temp.name, env=ENV, transport=self.fake, **kwargs)
    def test_success_requires_readback_and_intent_before_single_write(self):
        result = self.finish()
        self.assertEqual(result['status'], 'read_back')
        self.assertTrue(result['verified'])
        self.assertEqual([m for m,p in self.fake.calls].count('PATCH'), 1)
        self.assertEqual(self.fake.calls[-2:], [('GET', f'/api/issues/{I}'), ('GET', f'/api/issues/{I}/comments')])
        self.assertNotIn(ENV['PAPERCLIP_API_KEY'], (Path(self.temp.name)/'finish.intent.json').read_text())

    def test_wrong_identity_or_terminal_run_refuses_without_write(self):
        mutations = [('me', 'id', OTHER), ('me', 'companyId', OTHER),
            ('run', 'id', OTHER), ('run', 'companyId', OTHER), ('run', 'agentId', OTHER),
            ('run', 'status', 'succeeded'), ('run', 'contextSnapshot', {'issueId': I, 'taskId': OTHER}),
            ('run', 'contextSnapshot', {}), ('issue', 'id', OTHER),
            ('issue', 'companyId', OTHER), ('issue', 'assigneeAgentId', OTHER), ('issue', 'status', 'done')]
        for obj, key, value in mutations:
            with self.subTest(obj=obj, key=key):
                self.fake = Fake(self.temp.name)
                getattr(self.fake, obj)[key] = value
                result = self.finish()
                self.assertEqual(result['status'], 'refused')
                self.assertFalse(any(m == 'PATCH' for m,p in self.fake.calls))
                self.assertFalse((Path(self.temp.name)/'finish.intent.json').exists())

    def test_supported_api_suffixes_preserve_exact_transport_paths(self):
        import native_finish
        for suffix in ('', '/', '/api', '/api/'):
            with self.subTest(suffix=suffix), tempfile.TemporaryDirectory() as directory:
                fake=Fake(directory)
                env={**ENV,'PAPERCLIP_API_URL':'http://127.0.0.1:9'+suffix}
                result=native_finish.finish_current_issue(summary='safe',receipt_sha256='a'*64,intent_dir=directory,env=env,transport=fake)
                self.assertTrue(result['verified'],result)
                self.assertEqual(native_finish._base_url(env['PAPERCLIP_API_URL']),'http://127.0.0.1:9')
                self.assertEqual(fake.calls[0],('GET','/api/agents/me'))
        for suffix in ('/api/x','//api','/api//','/%61pi','/api?x=1','/api#x'):
            with self.subTest(suffix=suffix),self.assertRaises(ValueError):
                native_finish._base_url('http://127.0.0.1:9'+suffix)

    def test_native_issue_conflicts_and_task_key_only_never_write(self):
        cases=[
            {'nativeIssueId':OTHER,'contextSnapshot':{'issueId':I,'taskId':I,'taskKey':I}},
            {'nativeIssueId':I,'contextSnapshot':{'issueId':OTHER}},
            {'nativeIssueId':'malformed','contextSnapshot':{'issueId':I}},
            {'nativeIssueId':'','contextSnapshot':{'issueId':I}},
            {'contextSnapshot':{'taskKey':I}},
            {'contextSnapshot':{'taskKey':'wake:synthetic-session'}},
        ]
        import native_finish
        for changes in cases:
            with self.subTest(changes=changes),tempfile.TemporaryDirectory() as directory:
                fake=Fake(directory)
                fake.run.update(changes)
                result=native_finish.finish_current_issue(summary='safe',receipt_sha256='a'*64,intent_dir=directory,env=ENV,transport=fake)
                self.assertEqual(result['status'],'refused',result)
                self.assertFalse(result['verified'])
                self.assertFalse(any(m=='PATCH' for m,p in fake.calls))
                self.assertFalse((Path(directory)/'finish.intent.json').exists())

    def test_native_issue_identity_accepts_session_task_key_without_using_it(self):
        cases=[
            {'nativeIssueId':I,'contextSnapshot':{}},
            {'nativeIssueId':I,'contextSnapshot':{'issueId':I,'taskId':I,'taskKey':'wake:synthetic-session'}},
            {'contextSnapshot':{'issueId':I,'taskKey':OTHER}},
        ]
        import native_finish
        for changes in cases:
            with self.subTest(changes=changes),tempfile.TemporaryDirectory() as directory:
                fake=Fake(directory)
                fake.run.update(changes)
                result=native_finish.finish_current_issue(summary='safe',receipt_sha256='a'*64,intent_dir=directory,env=ENV,transport=fake)
                self.assertTrue(result['verified'],result)
                self.assertEqual(sum(m=='PATCH' for m,p in fake.calls),1)

    def test_duplicate_intent_never_retries(self):
        self.finish()
        calls = len(self.fake.calls)
        result = self.finish()
        self.assertEqual(result['status'], 'needs_reconciliation')
        self.assertEqual(len(self.fake.calls), calls)

    def test_write_failures_keep_unknown_and_redact_token(self):
        from urllib.error import HTTPError
        errors = [TimeoutError(ENV['PAPERCLIP_API_KEY'])] + [HTTPError('http://fake', code, ENV['PAPERCLIP_API_KEY'], {}, None) for code in (403,409,500)]
        for error in errors:
            with self.subTest(error_type=type(error).__name__):
                with tempfile.TemporaryDirectory() as directory:
                    self.fake = Fake(directory)
                    self.fake.error = error
                    result = importlib.import_module('native_finish').finish_current_issue(summary='safe', receipt_sha256='a'*64, intent_dir=directory, env=ENV, transport=self.fake)
                    self.assertIn(result['status'], ('refused', 'needs_reconciliation'))
                    self.assertFalse(result['verified'])
                    self.assertEqual(sum(m=='PATCH' for m,p in self.fake.calls), 1)
                    text = (Path(directory)/'finish.intent.json').read_text()
                    self.assertEqual(json.loads(text)['state'], 'unknown')
                    self.assertNotIn(ENV['PAPERCLIP_API_KEY'], text+json.dumps(result))

    def test_changed_comment_is_not_verified(self):
        self.fake.mismatch = True
        self.assertFalse(self.finish()['verified'])

    def test_secret_in_summary_refused(self):
        result = importlib.import_module('native_finish').finish_current_issue(summary=ENV['PAPERCLIP_API_KEY'], receipt_sha256='a'*64, intent_dir=self.temp.name, env=ENV, transport=self.fake)
        self.assertEqual(result['status'], 'refused')
        self.assertEqual(self.fake.calls, [])

    def test_default_transport_local_http_and_redirect_denial(self):
        from http.server import HTTPServer, BaseHTTPRequestHandler
        import threading
        from unittest.mock import patch
        import native_finish
        fake = self.fake
        observed = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                observed.append(self.path)
                if self.server.redirect:
                    self.send_response(302)
                    self.send_header('Location', '/redirect-target')
                    self.end_headers()
                    return
                value = fake('GET', self.path, None, dict(self.headers))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps(value).encode())
            def do_PATCH(self):
                value = fake('PATCH', self.path, json.loads(self.rfile.read(int(self.headers['Content-Length']))), dict(self.headers))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps(value).encode())
        server = HTTPServer(('127.0.0.1', 0), Handler)
        server.redirect = False
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            env = {**ENV, 'PAPERCLIP_API_URL': 'http://127.0.0.1:'+str(server.server_port)}
            result = native_finish.finish_current_issue(summary='safe', receipt_sha256='b'*64, intent_dir=self.temp.name, env=env)
            self.assertTrue(result['verified'])
            server.redirect = True
            with self.assertRaises(Exception):
                native_finish._transport(env['PAPERCLIP_API_URL'])('GET', '/api/agents/me', None, {})
            self.assertNotIn('/redirect-target', observed)
        finally:
            server.shutdown()
            thread.join()
            server.server_close()
        for value in ['http://external.example', 'https://u:p@example.com', 'https://example.com/path', 'https://example.com?x=1', 'https://example.com/#x']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                native_finish._transport(value)
        class Opener:
            def open(self, req, timeout):
                self.timeout = timeout
                raise TimeoutError('synthetic')
        opener = Opener()
        with patch.object(native_finish, 'build_opener', return_value=opener):
            with self.assertRaises(TimeoutError):
                native_finish._transport('http://127.0.0.1:9')('GET','/api/agents/me',None,{})
        self.assertEqual(opener.timeout, 10)

if __name__ == '__main__':
    unittest.main()
