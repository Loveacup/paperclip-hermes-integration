"""Explicit installed Hermes contract; never part of npm test."""
import os, sys, pathlib, importlib.util, unittest
from types import SimpleNamespace
from test_plugin import BINDING
HOST = pathlib.Path(os.environ["HERMES_SOURCE"]).resolve()
sys.path.insert(0,str(HOST))
class InstalledContracts(unittest.TestCase):
    def test_actual_official_injector_called_once_accepted_not_consumed(self):
        # Execute installed official routing helper, only its final host callback is fake.
        source = HOST / 'hermes_cli/plugins_injection.py'
        spec = importlib.util.spec_from_file_location('official_injection', source)
        official = importlib.util.module_from_spec(spec); spec.loader.exec_module(official)
        calls = []
        manager = SimpleNamespace(_cli_ref=None, has_tui_message_injector=False,
                                  has_gateway_message_injector=True,
                                  inject_gateway_message=lambda **kw: calls.append(kw) or True)
        ctx = SimpleNamespace(_manager=manager, plugin_id='tele-injection-plugin',
                              _gateway_injection_allowed=lambda: True)
        self.assertTrue(official.inject_plugin_message(ctx, 'event', 'user',
                        session_key=BINDING['session_key'], origin=None))
        self.assertEqual(len(calls), 1)
        self.assertNotIn('session_id', calls[0])  # known missing atomic fence

    def test_official_busy_fifo_retains_injected_event_metadata(self):
        # Compile only the installed FIFO method: no gateway boot/config/session IO.
        import ast
        from typing import Any
        source = HOST / 'gateway/run_busy.py'
        tree = ast.parse(source.read_text())
        method = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == '_enqueue_fifo')
        namespace = {'Any': Any, 'MessageEvent': SimpleNamespace}
        exec(compile(ast.Module(body=[method], type_ignores=[]), str(source), 'exec'), namespace)
        adapter = SimpleNamespace(_pending_messages={})
        queued = SimpleNamespace(conversation=SimpleNamespace(queued_events=[]))
        host = SimpleNamespace(_session_state=lambda key: queued)
        meta = dict(gateway_session_key=BINDING['session_key'], gateway_session_id=BINDING['session_id'],
                    gateway_session_strict=True, hermes_plugin_injection=True)
        first = SimpleNamespace(metadata=meta)
        second = SimpleNamespace(metadata=dict(meta))
        enqueue = namespace['_enqueue_fifo']
        enqueue(host, BINDING['session_key'], first, adapter)
        enqueue(host, BINDING['session_key'], second, adapter)
        self.assertIs(adapter._pending_messages[BINDING['session_key']], first)
        self.assertIs(queued.conversation.queued_events[0], second)
        self.assertTrue(second._gateway_accepted)
        self.assertEqual(second.metadata, meta)
        self.assertFalse(hasattr(second, 'consumed'))

if __name__ == "__main__": unittest.main()
