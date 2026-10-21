"""Regent ordinary-DM routing regression; no network or live gateway."""
import copy
import tempfile
import unittest
import sys

from pathlib import Path
from types import SimpleNamespace
from test_plugin import load, ROOT

B = dict(mode='conversation', profile='regent', platform='telegram', chat_type='dm',
         session_key='agent:regent:telegram:dm:123', session_id='old',
         chat_id='123', user_id='123', thread_id='')


def route():
    return dict(session_key=B['session_key'], session_id='old', platform='telegram',
                transport_profile='regent', origin=dict(platform='telegram',
                chat_type='dm', chat_id='123', user_id='123', thread_id=None))


class RegentConversationTests(unittest.TestCase):
    def test_telegram_pointer_carries_authenticated_read_entrypoint_not_credentials(self):
        p = load(); calls = []
        ctx = SimpleNamespace(inject_message=lambda text, **kw: calls.append(text) or True)
        with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
            engine=p.Engine(ctx,B,Path(tmp)/'cursor.json',route)
            engine.tick({})
            engine.tick(dict(pending={'x':dict(kind='issue',id='00000000-0000-4000-8000-000000000003',status='done')}))
        self.assertIn('bridge.mjs --config',calls[0])
        self.assertIn('--read',calls[0])
        self.assertNotIn('Bearer ',calls[0])
        self.assertNotIn('PAPERCLIP_API_KEY=',calls[0])

    def test_registration_reads_owner_config_not_ambient_profile(self):
        from fixture_config import registration
        with registration(load(), B) as (p, ctx, config, unload):
            thread = p.register(ctx)
            self.assertIsNotNone(thread)
            self.assertTrue(thread.is_alive())
            from hermes_constants import get_hermes_home
            self.assertEqual(get_hermes_home(), 'ambient-synthetic')
            unload.pop()()
            self.assertFalse(thread.is_alive())

    def test_regent_plain_dm_validated_and_new_events_injected_without_replay(self):
        p = load()
        self.assertEqual(p.validate(dict(enabled=True, binding=B)), B)
        calls = []
        ctx = SimpleNamespace(inject_message=lambda text, **kw: calls.append((text, kw)) or True)
        r = route()
        with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
            cursor = Path(tmp)/'regent.json'
            engine = p.Engine(ctx, B, cursor, lambda: r)
            old = dict(kind='issue', id='old', status='done', revision=1)
            snapshot = dict(pending=dict(old=old))
            self.assertEqual(engine.tick(snapshot), 'baseline')
            self.assertEqual(calls, [])
            snapshot['pending']['new'] = dict(kind='issue', id='new', status='done', revision=1)
            self.assertEqual(engine.tick(snapshot), 'attempted')
            self.assertEqual(calls[0][1], dict(session_key=B['session_key']))
            self.assertNotIn('"id": "old"', calls[0][0])
            r['session_id'] = 'new'
            restarted = p.Engine(ctx, dict(B, session_id='new'), cursor, lambda: r)
            self.assertEqual(restarted.tick(snapshot), 'idle')
            for field,value in [('transport_profile','default'), ('session_key','agent:main:telegram:dm:123')]:
                wrong = dict(r, **{field:value})
                self.assertFalse(p.route_matches(wrong, B))
            wrong = copy.deepcopy(r); wrong['origin']['thread_id'] = '45'
            self.assertFalse(p.route_matches(wrong, B))
            self.assertTrue(p.route_matches(r, B))



if __name__ == '__main__':
    unittest.main()
