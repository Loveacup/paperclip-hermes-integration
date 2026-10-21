import sys

import copy
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from test_plugin import load, ROOT

B=dict(mode='conversation',profile='default',platform='telegram',chat_type='group',
       chat_id='-1000000000000',user_id='1000000000',thread_id='',
       session_key='agent:main:telegram:group:-1000000000000:1000000000',session_id='group-old')
def route():
    return dict(session_key=B['session_key'],session_id=B['session_id'],platform='telegram',
                transport_profile='default',origin={k:(None if k=='thread_id' else B[k])
                for k in ['platform','chat_id','user_id','thread_id','chat_type']})

class GroupRouteTests(unittest.TestCase):
    def test_exact_sender_scoped_group_accepts_new_events_without_replaying_history(self):
        p=load(); self.assertEqual(p.validate(dict(enabled=True,binding=B)),B)
        for wrong in [dict(B,chat_id='1000000000000'),dict(B,user_id='99'),dict(B,thread_id='12')]:
            with self.assertRaises(ValueError):p.validate(dict(enabled=True,binding=wrong))
        calls=[];r=route()
        with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
            e=p.Engine(SimpleNamespace(inject_message=lambda text,**kw:calls.append((text,kw)) or True),B,Path(tmp)/'group.json',lambda:r)
            old=dict(kind='issue',id='old',status='done',revision=1)
            self.assertEqual(e.tick(dict(pending={'old':old})),'baseline')
            self.assertEqual(calls,[])
            e.tick(dict(pending={'new':dict(kind='issue',id='new',status='done',revision=1)}))
            self.assertEqual(calls[0][1]['session_key'],B['session_key'])
            self.assertIn('docs/CEO-AGENTS.md',calls[0][0])
            self.assertNotIn('"id": "old"',calls[0][0])
            wrong=copy.deepcopy(r);wrong['origin']['user_id']='99';self.assertFalse(p.route_matches(wrong,B))
            wrong=copy.deepcopy(r);wrong['origin']['chat_type']='dm';self.assertFalse(p.route_matches(wrong,B))
            r['session_id']='group-new';self.assertTrue(p.route_matches(r,B))

    def test_group_cursor_is_separate_from_preserved_dm_cursor_and_stable_after_new(self):
        from fixture_config import registration
        with registration(load(), B) as (p, ctx, config, unload):
            legacy=Path(config['plugin']['cursorDir'])/'delivery-cursor.json'
            legacy.parent.mkdir(parents=True)
            legacy.write_text('{"old_dm_must_remain":true}')
            first=p.cursor_path(config)
            t=p.register(ctx);unload.pop()();self.assertFalse(t.is_alive())
            config['plugin']['binding']=dict(B,session_id='group-new')
            second=p.cursor_path(config)
            t=p.register(ctx);unload.pop()();self.assertFalse(t.is_alive())
            self.assertNotEqual(first,legacy);self.assertEqual(first,second)
            self.assertEqual(legacy.read_text(),'{"old_dm_must_remain":true}')

if __name__=='__main__':unittest.main()
