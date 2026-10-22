"""Synthetic UUID fixtures, real installed schema validation; no live API."""
import importlib
import json
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).parent
from test_support import paperclip_packages
PHASES = ('prepare', 'machine', 'closeout')
# Explicitly SYNTHETIC, not created task or actor identities.
ISSUES = {p: f'10000000-0000-4000-8000-{n:012d}' for n,p in enumerate(PHASES, 1)}
ACTORS = {p: {'id': f'20000000-0000-4000-8000-{n:012d}', 'adapterType': 'process' if p=='machine' else 'omp_local', 'role': 'pm' if p=='prepare' else 'qa'} for n,p in enumerate(PHASES, 1)}
PROJECT = '30000000-0000-4000-8000-000000000001'

class GraphTests(unittest.TestCase):
    def graph(self, actors=None):
        return importlib.import_module('native_graph').build_graph(project_id=PROJECT, actors=ACTORS if actors is None else actors, issue_ids=ISSUES, contract_path=str(ROOT/'synthetic/contract.json'), work_root=str(ROOT/'synthetic'))
    def test_graph_is_three_native_bodies_not_a_scheduler(self):
        graph = self.graph()
        self.assertEqual(graph['status'], 'ready')
        phases = graph['phases']
        self.assertEqual([p['phase'] for p in phases], list(PHASES))
        self.assertEqual([p['type'] for p in phases], ['OMP','process','OMP'])
        self.assertEqual([p['body']['blockedByIssueIds'] for p in phases], [[],[ISSUES['prepare']],[ISSUES['machine']]])
        for p in phases:
            self.assertNotIn('parentId', p['body'])
            self.assertNotIn('id', p['body'])
        config = phases[1]['body']['assigneeAdapterOverrides']['adapterConfig']
        self.assertIn('--native-finish', config['args'])
        self.assertIn('machine', config['args'])
        self.assertNotIn('assigneeAdapterOverrides', phases[2]['body'])
        import shlex
        description = phases[2]['body']['description']
        command = description.split('```sh\n', 1)[1].split('\n```', 1)[0]
        argv = shlex.split(command)
        self.assertEqual(Path(argv[1]).name, 'staged_qa.py')
        self.assertEqual(argv[2:4], ['closeout', '--contract'])
        self.assertIn('--native-finish', phases[2]['body']['description'])
        self.assertIn('do not rerun', phases[2]['body']['description'])
    def test_real_installed_shared_schema_accepts_without_stripping_fields(self):
        script = '''import {createIssueSchema} from './shared/dist/validators/issue.js';
import fs from 'node:fs';
const bodies=JSON.parse(fs.readFileSync(0,'utf8'));
for(const b of bodies){const parsed=createIssueSchema.parse(b); for(const k of Object.keys(b)){if(JSON.stringify(parsed[k])!==JSON.stringify(b[k])) throw Error('stripped or changed '+k);}}
console.log('validated '+bodies.length+' createIssue bodies');'''
        run = subprocess.run(['node','--input-type=module','-e',script], input=json.dumps([p['body'] for p in self.graph()['phases']]), text=True, capture_output=True, cwd=paperclip_packages(), timeout=30)
        self.assertEqual(run.returncode,0,run.stderr)
        self.assertIn('validated 3',run.stdout)

    def test_missing_or_wrong_role_is_admission_gap_not_adapter_override(self):
        import copy
        for phase in PHASES:
            actors = copy.deepcopy(ACTORS)
            del actors[phase]
            result = self.graph(actors)
            self.assertEqual(result['status'], 'needs_admission')
            self.assertEqual(result['phases'], [])
        actors = copy.deepcopy(ACTORS)
        actors['machine']['adapterType'] = 'hermes_local'
        self.assertEqual(self.graph(actors)['status'], 'needs_admission')
        actors = copy.deepcopy(ACTORS)
        actors['closeout']['adapterType'] = 'process'
        self.assertEqual(self.graph(actors)['status'], 'needs_admission')

    def test_installed_process_execute_consumes_config_shape_without_model(self):
        config = self.graph()['phases'][1]['body']['assigneeAdapterOverrides']['adapterConfig']
        # Actual native execute with harmless replacement argv, never writer A code.
        config = {**config, 'cwd': str(ROOT), 'args': ['-c', 'print("synthetic-process-contract-ok")']}
        script = '''import {execute} from './server/dist/adapters/process/execute.js';
import fs from 'node:fs';
const config=JSON.parse(fs.readFileSync(0,'utf8')); let meta;
const result=await execute({runId:'40000000-0000-4000-8000-000000000001',agent:{id:'20000000-0000-4000-8000-000000000002',companyId:'30000000-0000-4000-8000-000000000001',name:'synthetic'},config,onLog:async()=>{},onMeta:async m=>{meta=m;}});
if(result.exitCode!==0 || !result.resultJson.stdout.includes('synthetic-process-contract-ok') || meta.adapterType!=='process') throw Error('process contract failed');
console.log('actual process execute passed');'''
        import os
        safe_env = {k:v for k,v in os.environ.items() if k in ('PATH','HOME','TMPDIR','LANG')}
        run = subprocess.run(['node','--input-type=module','-e',script], input=json.dumps(config), text=True, capture_output=True, cwd=paperclip_packages(), timeout=30, env=safe_env)
        self.assertEqual(run.returncode,0,run.stderr)
        self.assertIn('actual process execute passed',run.stdout)

if __name__ == '__main__':
    unittest.main()
