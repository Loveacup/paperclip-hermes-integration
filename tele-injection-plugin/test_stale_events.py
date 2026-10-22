import json
import pathlib
import tempfile
import unittest
from types import SimpleNamespace
from test_plugin import load, BINDING, route

IDENTITY = dict(apiBase='http://offline.invalid/api', companyId='company', ceoAgentId='ceo')

def event(revision, status='blocked', kind='issue', id='one'):
    return dict(kind=kind, id=id, status=status, revision=revision)

def snapshot(*rows):
    return dict(identity=IDENTITY, pending={str(i): e for i, e in enumerate(rows)})

class StaleTests(unittest.TestCase):
    def setUp(self):
        self.p = load()
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.cursor = pathlib.Path(self.temp.name)/'cursor.json'
        self.calls = []
        self.ctx = SimpleNamespace(inject_message=lambda content, **kw: self.calls.append(json.loads(content.split('\n')[-1])) or True)
        self.restart()
        self.engine.tick(snapshot())

    def restart(self):
        self.engine = self.p.Engine(self.ctx, BINDING, self.cursor, route)

    def test_restart_baseline_highwater_and_recurrence(self):
        self.engine.tick(snapshot(event(3)))
        self.restart()
        self.assertEqual(self.engine.tick(snapshot(event(1), event(2, 'done'))), 'idle')
        self.engine.tick(snapshot(event(4, 'done')))
        self.engine.tick(snapshot(event(5)))
        self.assertEqual([c['events'][0]['pointer']['revision'] for c in self.calls], [3, 4, 5])
        self.cursor.unlink()
        self.restart()
        self.assertEqual(self.engine.tick(snapshot(event(9))), 'baseline')
        self.restart()
        self.assertEqual(self.engine.tick(snapshot(event(8, 'done'))), 'idle')
        self.assertEqual(len(self.calls), 3)

    def test_source_identity_changes_fail_closed_before_cursor_write(self):
        self.engine.tick(snapshot(event(3)))
        self.restart()
        saved = self.cursor.read_bytes()
        for identity in [dict(IDENTITY, companyId='other'), dict(IDENTITY, apiBase='http://other.invalid/api'), dict(IDENTITY, ceoAgentId='other'), None]:
            with self.assertRaisesRegex(ValueError, 'identity'):
                self.engine.tick(dict(snapshot(event(1)), identity=identity))
            self.assertEqual(self.cursor.read_bytes(), saved)
        self.assertEqual(len(self.calls), 1)

    def test_current_bridge_revision_revokes_historical_actionable_pointer(self):
        s = snapshot()
        s['revisions'] = {'agent:one': 4}
        s['inflight'] = dict(key='old', batch=[event(3, 'error', kind='agent')])
        self.assertEqual(self.engine.tick(s), 'idle')
        self.restart()
        self.assertEqual(self.engine.tick(snapshot(event(3, 'error', kind='agent'))), 'idle')
        self.engine.tick(snapshot(event(5, 'error', kind='agent')))
        self.assertEqual(len(self.calls), 1)

    def test_different_resources_and_unknown_write_ahead(self):
        def unknown(content, **kw):
            saved = json.loads(self.cursor.read_text())
            self.assertEqual(saved['highwater']['issue:one'], 9)
            self.assertTrue(all(r['accepted'] == 'unknown' and r['consumed'] == 'unverified'
                                for r in saved['receipts'].values()))
            self.calls.append(json.loads(content.split('\n')[-1]))
            raise RuntimeError('ambiguous')
        self.ctx.inject_message = unknown
        self.engine.tick(snapshot(event(9)))
        self.restart()
        self.assertEqual(self.engine.tick(snapshot(event(8, 'done'), event(9))), 'idle')
        self.engine.tick(snapshot(event(1, id='other'), event(1, kind='agent')))
        self.assertEqual(len(self.calls), 2)
        self.assertEqual({(e['pointer']['kind'], e['pointer']['id']) for e in self.calls[-1]['events']},
                         {('issue', 'other'), ('agent', 'one')})

    def test_unbound_initialized_cursor_requires_explicit_migration(self):
        for old_revision, new_revision in [(3, 3), (5, 3)]:
            self.cursor.unlink()
            self.restart()
            self.engine.tick(dict(pending={'one': event(old_revision)}))
            self.restart()
            saved = self.cursor.read_bytes()
            memory_before = json.dumps(self.engine.state, sort_keys=True)
            for _ in range(2):
                with self.assertRaisesRegex(ValueError, 'source identity migration'):
                    self.engine.tick(snapshot(event(new_revision)))
                self.assertEqual(self.cursor.read_bytes(), saved)
                self.assertEqual(json.dumps(self.engine.state, sort_keys=True), memory_before)
            self.assertEqual(self.calls, [])

    def test_same_revision_conflict_refuses_both_orders_without_mutation(self):
        saved = self.cursor.read_bytes()
        for rows in [(event(3), event(3, 'done')), (event(3, 'done'), event(3))]:
            with self.assertRaisesRegex(ValueError, 'conflicting revision'):
                self.engine.tick(snapshot(*rows))
            self.assertEqual(self.cursor.read_bytes(), saved)
            self.assertEqual(self.calls, [])
        self.assertEqual(self.engine.tick(snapshot(event(3), event(3))), 'attempted')
        self.assertEqual(len(self.calls[0]['events']), 1)

    def test_mixed_snapshot_only_latest_per_resource(self):
        s = snapshot(event(3))
        s['inflight'] = dict(key='old', batch=[event(1)])
        s['lastDelivery'] = dict(key='older', batch=[event(2, 'done')])
        self.engine.tick(s)
        self.assertEqual([e['pointer']['revision'] for e in self.calls[0]['events']], [3])
