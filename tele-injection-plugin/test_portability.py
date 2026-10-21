"""Portability boundaries exercised with synthetic config, no host installation."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from test_plugin import load
from fixture_config import registration
from test_group_route import B

class PortabilityTests(unittest.TestCase):
    def test_duplicate_destination_writer_refuses_until_unload(self):
        with registration(load(),B) as (p,ctx,c,unload):
            first=p.register(ctx)
            with self.assertRaises(BlockingIOError):p.register(ctx)
            unload.pop()()
            second=p.register(ctx)
            unload.pop()()
            self.assertFalse(first.is_alive())
            self.assertFalse(second.is_alive())

    def test_shared_schema_loader_resolves_config_without_host(self):
        p=load()
        c=p.load_config(Path(__file__).resolve().parents[1]/'integration.example.json')
        self.assertFalse(c['plugin']['enabled'])
        self.assertTrue(Path(c['plugin']['ownerHome']).is_absolute())

    def test_cursor_exact_group_sender_and_new_identity(self):
        p=load()
        c=p.load_config(Path(__file__).resolve().parents[1]/'integration.example.json')
        group=p.cursor_path(c)
        c['plugin']['binding']['session_id']='new'
        self.assertEqual(group,p.cursor_path(c))
        c['plugin']['binding']['user_id']='2000000000'
        self.assertNotEqual(group,p.cursor_path(c))
        c['plugin']['binding'].update(chat_type='dm',chat_id='1000000000')
        self.assertNotEqual(group,p.cursor_path(c))

    def test_registration_rejects_cli_and_cross_owner(self):
        for change in ['cli','owner']:
            with registration(load(),B) as (p,ctx,c,unload):
                if change=='cli':ctx._manager._cli_ref=object()
                else:
                    original=ctx.get_config
                    ctx.get_config=lambda k,d=None:c['configPath'] if k=='config_path' else d
                    ctx._manager.home_path=str(Path(c['plugin']['ownerHome']).parent/'other')
                with self.assertRaisesRegex(ValueError,'requires target-profile'):
                    p.register(ctx)
                self.assertEqual(unload,[])

    def test_register_uses_configured_state_route_cursor_and_instructions(self):
        with registration(load(),B) as (p,ctx,c,unload):
            captured=[]
            class Engine:
                def __init__(self,*args,**kwargs):captured.append((args,kwargs))
            with patch.object(p,'Engine',Engine):
                thread=p.register(ctx);unload.pop()()
            args,kw=captured[0]
            self.assertEqual(args[2],p.cursor_path(c))
            self.assertEqual(kw['instructions_path'],c['plugin']['instructionsPath'])
            self.assertIn(c['configPath'],kw['read_command'])
            with patch.object(p,'read_route',return_value=None) as reader:
                args[3]()
            self.assertEqual(reader.call_args.args,(Path(c['plugin']['routingHome']),B['session_key']))

if __name__=='__main__':unittest.main()
