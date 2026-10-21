import importlib.util
import unittest
from pathlib import Path

class HealthTests(unittest.TestCase):
    def load(self):
        p=Path(__file__).with_name('health.py')
        self.assertTrue(p.exists(),'Missing read-only health entrypoint')
        s=importlib.util.spec_from_file_location('bridge_health',p)
        m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
        return m

    def test_live_but_unmanaged_is_not_reported_ready(self):
        m=self.load()
        state={'lastReconciledMs':100000,'ws':'connected','lastError':None,'promptReady':True,'pending':{},'inflight':None}
        result=m.classify(state,pid_alive=True,launchd_matches=False,cursor_initialized=True,now_ms=100100)
        self.assertEqual(result['status'],'degraded')
        self.assertIn('not_managed_by_launchd',result['problems'])

    def test_uncertain_delivery_is_not_retried_or_called_consumed(self):
        m=self.load()
        state={'lastReconciledMs':100000,'ws':'connected','lastError':None,'promptReady':True,'pending':{},'inflight':{'status':'uncertain'}}
        result=m.classify(state,pid_alive=True,launchd_matches=True,cursor_initialized=True,now_ms=100100)
        self.assertEqual(result['status'],'degraded')
        self.assertIn('delivery_requires_review_no_replay',result['problems'])
        self.assertNotIn('consumed',result)
        self.assertEqual(state['inflight']['status'],'uncertain')

    def test_healthy_and_stale_states_are_distinguished(self):
        m=self.load()
        state={'lastReconciledMs':100000,'ws':'connected','lastError':None,'promptReady':True,'pending':{},'inflight':None}
        self.assertEqual(m.classify(state,pid_alive=True,launchd_matches=True,cursor_initialized=True,now_ms=100100)['status'],'ready')
        result=m.classify(state,pid_alive=True,launchd_matches=True,cursor_initialized=True,now_ms=200100)
        self.assertIn('reconcile_stale',result['problems'])

    def test_health_uses_exact_group_cursor_not_old_dm_cursor(self):
        import contextlib, io, json, os, sys, tempfile, time
        from unittest.mock import patch
        root=Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory(dir=root/'.local') as tmp:
            tmp=Path(tmp)
            config=json.loads((root/'integration.example.json').read_text())
            config['bridge']['statePath']=str(tmp/'bridge.json')
            config['plugin']['cursorDir']=str(tmp/'cursors')
            config_path=tmp/'config.json';config_path.write_text(json.dumps(config))
            (tmp/'bridge.json').write_text(json.dumps({'lastReconciledMs':time.time()*1000,'ws':'connected','promptReady':True}))
            (tmp/'bridge.json.lock').write_text(json.dumps({'pid':os.getpid()}))
            (tmp/'cursors').mkdir()
            (tmp/'cursors/delivery-cursor.json').write_text('{"initialized":true}')
            spec=importlib.util.spec_from_file_location('cursor_config',root/'tele-injection-plugin/integration_config.py')
            cursor_module=importlib.util.module_from_spec(spec);spec.loader.exec_module(cursor_module)
            exact=cursor_module.cursor_path(config)
            m=self.load()
            real_run=m.subprocess.run
            def run(args,**kw):
                if args[0]=='/bin/launchctl':
                    from types import SimpleNamespace
                    self.assertIn(config['bridge']['serviceLabel'],args[-1])
                    return SimpleNamespace(returncode=0,stdout='pid = '+str(os.getpid()))
                return real_run(args,**kw)
            for initialized in [False,True]:
                if initialized:exact.write_text('{"initialized":true}')
                output=io.StringIO()
                with patch.object(sys,'argv',['health','--config',str(config_path)]),patch.object(m.subprocess,'run',side_effect=run),contextlib.redirect_stdout(output):
                    status=m.main()
                self.assertEqual(status,0 if initialized else 2)
                result=json.loads(output.getvalue())
                self.assertEqual('telegram_cursor_not_initialized' in result['problems'],not initialized)

if __name__=='__main__': unittest.main()
