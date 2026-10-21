import importlib.util
import pathlib
import unittest

ROOT = pathlib.Path(__file__).parent

def load():
    spec = importlib.util.spec_from_file_location('candidate', ROOT / '__init__.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

class ConfigTests(unittest.TestCase):
    def test_default_off_and_explicit_nonempty_binding(self):
        self.assertTrue((ROOT / '__init__.py').exists(), 'missing plugin implementation')
        p = load()
        self.assertIsNone(p.validate({}))
        with self.assertRaises(ValueError):
            p.validate({'enabled': True, 'binding': {}})

import copy
import tempfile
from types import SimpleNamespace

BINDING = dict(session_key='agent:main:telegram:dm:123:45', session_id='session-old',
               platform='telegram', profile='default', chat_id='123', thread_id='45',
               user_id='123', chat_type='dm')

def route():
    return dict(session_key=BINDING['session_key'], session_id='session-old',
                platform='telegram', transport_profile='default',
                origin={k: BINDING[k] for k in ('platform', 'chat_id', 'thread_id', 'user_id', 'chat_type')})

class DeliveryTests(unittest.TestCase):
    def setUp(self):
        self.p = load()
        self.temp = tempfile.TemporaryDirectory(dir=ROOT)
        self.addCleanup(self.temp.cleanup)
        self.cursor = pathlib.Path(self.temp.name) / 'cursor.json'
        self.calls = []
        self.r = route()
        self.ctx = SimpleNamespace(inject_message=self.inject)
        self.engine = self.p.Engine(self.ctx, BINDING, self.cursor, lambda: self.r)
        self.event = dict(kind='issue', id='issue-1', status='blocked', blockedBy=[])
        self.engine.tick({})  # baseline, never replay

    def inject(self, content, *, session_key):
        self.calls.append((content, session_key))
        return True  # official accepted/queued, NOT consumed

    def test_pending_then_inflight_dedup_terminal_supplement(self):
        self.engine.tick({'pending': {'issue:issue-1': self.event}})
        inflight = dict(key='batch-1', batch=[self.event], runId='ceo-1')
        self.engine.tick({'inflight': inflight})
        self.assertEqual(len(self.calls), 1)
        self.engine.tick({'lastDelivery': dict(inflight, runStatus='succeeded')})
        self.engine.tick({'lastDelivery': dict(inflight, runStatus='succeeded')})
        self.assertEqual(len(self.calls), 2)
        self.assertIn('issue-1', self.calls[0][0])
        self.assertIn('batch-1', self.calls[1][0])
        receipts = list(self.engine.state['receipts'].values())
        self.assertTrue(all(r['accepted'] is True and r['consumed'] == 'unverified' for r in receipts))

    def test_wrong_topic_session_profile_missing_pause(self):
        variants = [None, dict(route(), session_id=''), dict(route(), session_id='session-new'),
                    dict(route(), transport_profile='other')]
        wrong = route(); wrong['origin']['thread_id'] = '99'; variants.append(wrong)
        wrong = route(); wrong['origin']['platform'] = 'discord'; variants.append(wrong)
        for r in variants:
            self.r = r
            self.engine.tick({'pending': {'issue:issue-1': self.event}})
        self.assertEqual(self.calls, [])
        self.assertEqual(self.engine.state['receipts'], {})

    def test_new_after_acceptance_no_more_injection(self):
        self.engine.tick({'pending': {'x': self.event}})
        self.r['session_id'] = 'new-session'
        self.event['status'] = 'done'
        self.engine.tick({'pending': {'x': self.event}})
        self.assertEqual(len(self.calls), 1)

    def test_unknown_durable_receipt_no_blind_retry(self):
        def raises(*args, **kwargs):
            self.calls.append('attempt'); raise RuntimeError('ambiguous')
        self.ctx.inject_message = raises
        self.engine.tick({'pending': {'x': self.event}})
        second = self.p.Engine(self.ctx, self.engine.binding, self.engine.cursor, lambda: self.r)
        second.tick({'pending': {'x': self.event}})
        self.assertEqual(self.calls, ['attempt'])
        self.assertEqual(next(iter(second.state['receipts'].values()))['accepted'], 'unknown')

    def test_initial_baseline_no_replay(self):
        fresh = self.p.Engine(self.ctx, BINDING, pathlib.Path(self.temp.name) / 'fresh.json', lambda: self.r)
        fresh.tick({'pending': {'x': self.event}})
        fresh.tick({'inflight': dict(key='old', batch=[self.event])})
        self.assertEqual(self.calls, [])

    def test_busy_is_one_official_call_not_completion(self):
        self.engine.tick({'pending': {'x': self.event}})
        self.engine.tick({'pending': {'x': self.event}})
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(next(iter(self.engine.state['receipts'].values()))['consumed'], 'unverified')

    def test_real_detector_recurrence_and_legacy_cursor_no_replay(self):
        import subprocess
        import json
        script = '''
import * as B from './event-bridge/bridge.mjs';
const s=B.initialState(), row={kind:'issue',id:'issue-1',status:'blocked',blockedBy:[]};
B.observe(s,[row]); s.pending.x={...row};
const snapshots=[structuredClone(s)];
for(const status of ['done','blocked']) {
 B.observe(s,[{...row,status}]); snapshots.push(structuredClone(s));
 await B.deliver(s,false,async()=>({id:'ceo-test'}),()=>{});
 snapshots.push(structuredClone(s));
 B.settle(s,{id:'ceo-test',status:'succeeded'});
}
console.log(JSON.stringify(snapshots));
'''
        result = subprocess.run(['node', '--input-type=module', '-e', script],
                                cwd=ROOT.parent, capture_output=True, text=True, check=True)
        snapshots = json.loads(result.stdout)
        # Already-seen legacy pointer remains legacy during upgrade: no revision retrofit.
        self.engine.tick(snapshots[0])
        self.assertEqual(len(self.calls), 1)
        self.engine = self.p.Engine(self.ctx, self.engine.binding, self.engine.cursor, lambda: self.r)
        self.assertEqual(self.engine.tick(snapshots[0]), 'idle')
        for snapshot in snapshots[1:]:
            self.engine.tick(snapshot)
        events = [e for content, _ in self.calls
                  for e in json.loads(content.split('\n')[-1])['events'] if e['type'] == 'event']
        self.assertEqual([e['pointer']['status'] for e in events], ['blocked', 'done', 'blocked'])
        self.assertEqual([e['pointer'].get('revision') for e in events], [None, 1, 2])

    def test_registration_default_off(self):
        ctx = SimpleNamespace(get_config=lambda key, default=None: default)
        self.assertIsNone(self.p.register(ctx))

class HostContractTests(unittest.TestCase):
    def test_manifest_default_off_no_invented_permission(self):
        import json
        manifest = json.loads((ROOT / 'plugin.yaml').read_text())  # JSON is YAML subset
        self.assertEqual(manifest['kind'], 'standalone')
        self.assertEqual(manifest['config_schema']['config_path']['default'], '')
        self.assertNotIn('permissions', manifest)
        self.assertEqual(manifest['capabilities'], [])

    def test_exact_routing_metadata_readonly(self):
        import json
        from unittest.mock import patch, MagicMock
        p = load()
        home = ROOT / 'nonexistent-fixture-home'
        r = route()
        db = MagicMock()
        db.execute.return_value.fetchone.return_value = tuple(
            json.dumps(r[k]) if k == 'origin' else r[k]
            for k in ('session_key', 'session_id', 'platform', 'transport_profile', 'origin'))
        with patch('sqlite3.connect') as connect:
            connect.return_value.__enter__.return_value = db
            self.assertTrue(p.route_matches(p.read_route(home, BINDING['session_key']), BINDING))
            self.assertIn('?mode=ro', connect.call_args.args[0])
            self.assertEqual(db.execute.call_args.args[1],
                             (str((home / 'sessions').resolve()), BINDING['session_key']))
            db.execute.return_value.fetchone.return_value = None
            self.assertIsNone(p.read_route(home, 'missing'))



    def test_registered_thread_unloads_without_gateway_or_io(self):
        from fixture_config import registration
        with registration(load(), BINDING, risk=True) as (p, ctx, config, unload):
            thread = p.register(ctx)
            self.assertTrue(thread.is_alive())
            self.assertEqual(len(unload), 1)
            unload.pop()()
            self.assertFalse(thread.is_alive())
            self.assertFalse(p.cursor_path(config).exists())

    def test_binding_rejects_empty_id_wrong_key_and_risk_default(self):
        p = load()
        for binding, ack in [(dict(BINDING, session_id=''), True),
                             (dict(BINDING, thread_id='99'), True), (BINDING, False)]:
            with self.assertRaises(ValueError):
                p.validate(dict(enabled=True, binding=binding, accept_nonatomic_risk=ack))

class TopicTests(DeliveryTests):
    def setUp(self):
        super().setUp()
        self.binding = dict(BINDING, mode='topic')
        self.engine = self.p.Engine(self.ctx, self.binding,
                                    pathlib.Path(self.temp.name) / 'topic.json', lambda: self.r)
        self.engine.tick({})

    # Inherit shared tests, but replace the two session-only expectations.
    def test_new_after_acceptance_no_more_injection(self):
        self.assertEqual(self.p.validate(dict(enabled=True, binding=self.binding)), self.binding)
        self.engine.tick({'pending': {'x': self.event}})
        self.r['session_id'] = 'new-session'
        restarted = self.p.Engine(self.ctx, dict(self.binding, session_id='new-session'), self.engine.cursor, lambda: self.r)
        self.assertEqual(restarted.tick({'inflight': dict(key='old', batch=[self.event])}), 'idle')
        self.event = dict(self.event, status='done')
        self.assertEqual(restarted.tick({'pending': {'x': self.event}}), 'attempted')
        self.assertEqual(len(self.calls), 2)
        self.assertNotIn('expected_session_id', self.calls[-1][0])
        self.assertNotIn('session-old', self.calls[-1][0])

    def test_wrong_topic_session_profile_missing_pause(self):
        variants = [None, dict(route(), session_id=''), dict(route(), session_id='  '),
                    dict(route(), transport_profile='other'), dict(route(), session_key='other')]
        for field in ('thread_id', 'profile', 'chat_id', 'user_id', 'platform'):
            wrong = route(); wrong['origin'][field] = 'other'; variants.append(wrong)
        for r in variants:
            self.r = r
            self.assertEqual(self.engine.tick({'pending': {'x': self.event}}), 'paused_route')
        self.assertEqual(self.calls, [])

    def test_recurring_state_revisions_and_terminal(self):
        for revision, status in [(1, 'blocked'), (2, 'done'), (3, 'blocked')]:
            event = dict(self.event, revision=revision, status=status)
            self.engine.tick({'pending': {'x': event}})
            self.engine.tick({'inflight': dict(key=str(revision), batch=[event])})
        self.assertEqual(len(self.calls), 3)
        terminal = {'lastDelivery': dict(key='3', runId='r', runStatus='succeeded', batch=[event])}
        self.engine.tick(terminal); self.engine.tick(terminal)
        self.assertEqual(len(self.calls), 4)

if __name__ == '__main__':
    unittest.main()
