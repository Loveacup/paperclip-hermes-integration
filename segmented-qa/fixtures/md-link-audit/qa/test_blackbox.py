"""Run via run_qa.py. No product imports; CLI subprocess + generated report only."""
import collections
import html
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import unittest

from fixtures import FIELDS, STATUSES, build, inventory, order

QA = Path(__file__).absolute().parent
PROJECT = QA.parent
CONTEXT = {}


def cell_decode(value):
    value = value.strip()
    if len(value) >= 2 and value.startswith('`') and value.endswith('`'):
        value = value[1:-1]
    # Decode Markdown punctuation escapes before HTML entities. The inverse
    # order would corrupt literal backslashes restored from entities.
    value = re.sub(r'\\([!"#$%&\'()*+,\-./:;<=>?@\[\]\\^_`{|}~])', r'\1', value)
    value = value.replace('<br>', '\n').replace('<br/>', '\n').replace('<br />', '\n')
    return html.unescape(value)


def split_cells(line):
    parts, current, escaped = [], [], False
    for char in line.strip().strip('|'):
        if char == '|' and not escaped:
            parts.append(''.join(current)); current = []
        else:
            current.append(char)
        if char == '\\':
            escaped = not escaped
        else:
            escaped = False
    parts.append(''.join(current))
    return parts


def markdown_rows(text):
    """Read the specified seven-field table, not a particular report template."""
    header = None
    rows = []
    for line in text.splitlines():
        if not line.lstrip().startswith('|'):
            continue
        cells = split_cells(line)
        decoded = [cell_decode(v) for v in cells]
        if set(FIELDS).issubset(decoded):
            header = decoded
            continue
        if header is None or all(re.fullmatch(r':?-{2,}:?', c.strip()) for c in decoded):
            continue
        if len(decoded) != len(header):
            raise AssertionError('Broken Markdown table row: ' + line)
        row = {k: decoded[header.index(k)] for k in FIELDS}
        if row['status'] not in STATUSES:
            continue  # Other summary tables are not link records.
        for key in ('line', 'column'):
            if row[key] in ('', 'null', 'None', '—', '-', 'N/A'):
                row[key] = None
            else:
                row[key] = int(row[key])
        for key in ('raw', 'target'):
            if row['line'] is None or row[key] in ('null', 'None'):
                row[key] = None
        rows.append(row)
    if header is None:
        raise AssertionError('No table with source/line/column/raw/target/status/reason headers; inspect manually if equivalent fields use another layout')
    return rows


class Acceptance(unittest.TestCase):
    maxDiff = None

    def setUp(self):
        self.case = self.id().split('.')[-1].split('_')[1]
        self.base = CONTEXT['workspace'] / self.id().split('.')[-1]
        self.root, self.manifest = build(self.case, self.base)
        self.before = inventory(self.root)
        self.outside_before = inventory(self.base / 'synthetic-outside')
        self.addCleanup(self.check_unchanged)
        self.counter = 0

    def check_unchanged(self):
        self.assertEqual(self.before, inventory(self.root), 'Input tree mutated')
        self.assertEqual(self.outside_before, inventory(self.base / 'synthetic-outside'), 'Synthetic outside canary mutated')

    def invoke(self, *extra, root=None, output=None, mode=None):
        self.counter += 1
        output = Path(output) if output is not None else self.base / f'report-{self.counter}'
        mode = mode or CONTEXT['mode']
        args = [sys.executable, '-B', str(CONTEXT['cli']), str(root or self.root), '--report-dir', str(output)]
        if mode == 'd1':
            args += ['--format', 'json']
        args += list(extra)
        temp = self.base / 'tmp'
        temp.mkdir(exist_ok=True)
        guard_log = self.base / f'guard-{self.counter}.jsonl'
        env = os.environ.copy()
        env.update(PYTHONDONTWRITEBYTECODE='1', TMPDIR=str(temp), TMP=str(temp), TEMP=str(temp),
                   PYTHONPATH=str(QA / 'guard'), QA_GUARD_LOG=str(guard_log),
                   QA_GUARD_ROOT=str(self.root), QA_GUARD_OUTSIDE=str(self.base / 'synthetic-outside'),
                   QA_GUARD_LINKS=json.dumps([r['path'] for r in self.before if r['type'] == 'symlink']))
        completed = subprocess.run(args, cwd=self.base, env=env, capture_output=True,
                                   text=True, encoding='utf-8', errors='replace', timeout=30)
        record = {'test': self.id(), 'argv': args, 'returncode': completed.returncode,
                  'stdout': completed.stdout, 'stderr': completed.stderr,
                  'output': str(output), 'guard_log': str(guard_log)}
        with (CONTEXT['workspace'] / 'commands.jsonl').open('a', encoding='utf-8') as f:
            f.write(json.dumps(record, ensure_ascii=False) + '\n')
        self.assertTrue(guard_log.exists(), 'Python audit guard did not initialize; no safety evidence')
        events = [json.loads(line) for line in guard_log.read_text(encoding='utf-8').splitlines()]
        self.assertEqual([e for e in events if e['kind'] != 'ready'], [], 'Forbidden network/outside/symlink access attempted')
        return completed, output

    def expected_code(self, manifest):
        if not manifest['complete']:
            return 2 if CONTEXT['mode'] == 'd1' else None
        return int(manifest['broken'] > 0) if CONTEXT['mode'] == 'd1' else 0

    def report(self, completed, output, manifest=None):
        manifest = manifest or self.manifest
        code = self.expected_code(manifest)
        if code is None:
            self.assertNotEqual(completed.returncode, 0, completed.stderr)
        else:
            self.assertEqual(completed.returncode, code, completed.stderr)
        if not manifest['complete']:
            self.assertTrue(completed.stderr.strip(), 'Scan failure needs stderr diagnostic')
        if CONTEXT['mode'] == 'd1':
            doc = json.loads((output / 'report.json').read_text(encoding='utf-8'))
            self.assertEqual(doc['schema_version'], 1)
            self.assertIs(doc['complete'], manifest['complete'])
            self.assertEqual(doc['files_scanned'], manifest['files_scanned'])
            rows = doc['results']
            self.assertEqual(set(doc['counts']), set(STATUSES))
            counts = collections.Counter(r['status'] for r in rows)
            self.assertEqual(doc['counts'], {k: counts[k] for k in STATUSES})
            for count in doc['counts'].values():
                self.assertIs(type(count), int)
                self.assertGreaterEqual(count, 0)
            self.assertEqual(bool(doc['errors']), not manifest['complete'])
            for error in doc['errors']:
                self.assertTrue({'source', 'reason', 'message'} <= set(error))
                self.assertTrue(error['message'])
            text = None
        else:
            text = (output / 'report.md').read_text(encoding='utf-8')
            rows = markdown_rows(text)
            # Summary typography is unspecified. Semantic summary checks are
            # recorded for manual review instead of guessing a template.
        self.assertEqual(len(rows), len(manifest['expected']))
        self.assertEqual(rows, sorted(rows, key=order), 'Report ordering')
        for actual, expected in zip(rows, manifest['expected']):
            self.assertTrue(set(FIELDS) <= set(actual))
            for key in FIELDS:
                # Stable reason spelling is specified only for these cases;
                # unsupported syntax's target extraction is not prescribed.
                if expected[key] is None and key == 'reason':
                    self.assertRegex(actual[key], r'^[a-z][a-z0-9_]*$')
                elif expected['status'] == 'unchecked_unsupported' and key == 'target' and expected[key] is None:
                    pass
                else:
                    self.assertEqual(actual[key], expected[key], (expected, actual, key))
        self.assertEqual(sum(r['status'] == 'broken' for r in rows), manifest['broken'])
        return rows, text

    def normal(self):
        p, out = self.invoke()
        return self.report(p, out)

    def invalid(self, *extra, root=None, output=None):
        p, out = self.invoke(*extra, root=root, output=output)
        if CONTEXT['mode'] == 'd1':
            self.assertEqual(p.returncode, 2, p.stderr)
        else:
            self.assertNotEqual(p.returncode, 0, p.stderr)
        self.assertTrue(p.stderr.strip(), 'Failure needs stderr diagnostic')
        return p, out

    def test_A01_existing_and_cross_directory(self): self.normal()
    def test_A02_encoding_and_single_decode(self): self.normal()
    def test_A03_repeated_missing_and_empty(self): self.normal()
    def test_A04_reference_normalization(self): self.normal()
    def test_A05_undefined_and_plain_text(self): self.normal()
    def test_A06_code_mask_and_definition_mask(self): self.normal()
    def test_A07_external_no_network(self): self.normal()
    def test_A08_fragment_precedence(self): self.normal()
    def test_A09_escape_no_outside_reads(self): self.normal()

    def test_A10_symlink_components_and_root(self):
        self.normal()
        alias = self.base / 'root-alias'
        alias.symlink_to('input', target_is_directory=True)
        self.invalid(root=alias)
        self.invalid(root=alias / 'real')

    def test_A11_scan_error_not_missing(self): self.normal()
    def test_A12_empty_and_invalid_roots(self):
        self.normal()
        self.invalid(root=self.base / 'missing-root')
        self.invalid(root=self.base / 'expected.json')

    def test_A13_output_boundaries_and_exclusive_create(self):
        for output in (self.root, self.root / 'new-report', self.root / 'missing' / '..' / 'alias', self.base):
            self.invalid(output=output)
            self.assertEqual(self.before, inventory(self.root))
        alias = self.base / 'output-alias'
        alias.symlink_to('input', target_is_directory=True)
        self.invalid(output=alias / 'reports')
        self.invalid(output=alias / '..' / 'otherwise-safe')
        self.assertFalse((self.base / 'otherwise-safe').exists(), 'Rejected symlink alias created output')
        external_alias = self.base / 'external-output-alias'
        external_alias.symlink_to('synthetic-outside', target_is_directory=True)
        self.invalid(output=external_alias / 'reports')
        output = self.base / 'existing-output'
        output.mkdir()
        filename = 'report.json' if CONTEXT['mode'] == 'd1' else 'report.md'
        sentinel = output / filename
        sentinel.write_bytes(b'EXISTING REPORT MUST SURVIVE\x00\n')
        before = inventory(output)
        self.invalid(output=output)
        self.assertEqual(inventory(output), before)
        linked_output = self.base / 'linked-report'
        linked_output.mkdir()
        (linked_output / filename).symlink_to('../input/source.md')
        linked_before = inventory(linked_output)
        self.invalid(output=linked_output)
        self.assertEqual(inventory(linked_output), linked_before)
        safe = self.base / 'existing-safe'
        safe.mkdir()
        p, out = self.invoke(output=safe)
        self.report(p, out)
        # Report write failure reproducible without relying on uid/mode bits.
        self.invalid(output=self.base / 'expected.json' / 'child')

    def test_A14_markdown_roundtrip_and_escaping(self):
        _, text = self.normal()
        if text is None:
            # D1's JSON does not replace Markdown's escaping obligation.
            p, out = self.invoke(mode='v1')
            self.assertEqual(p.returncode, 1)  # D1 Markdown also uses exit 1.
            text = (out / 'report.md').read_text(encoding='utf-8')
            self.assertEqual(markdown_rows(text)[0]['raw'], self.manifest['expected'][0]['raw'])
        self.assertNotIn('<b>', text)
        self.assertNotIn('<i>', text)
        for line in text.splitlines():
            if 'missing.md' in line and line.lstrip().startswith('|'):
                raw_cells = split_cells(line)
                self.assertFalse(any(re.search(r'(?<!\\)\[[^\n]*\]\(', c) for c in raw_cells), 'Active Markdown link in report')

    def test_A15_byte_stability_and_source_positions(self):
        p1, out1 = self.invoke(); self.report(p1, out1)
        p2, out2 = self.invoke(); self.report(p2, out2)
        filename = 'report.json' if CONTEXT['mode'] == 'd1' else 'report.md'
        self.assertEqual((out1 / filename).read_bytes(), (out2 / filename).read_bytes())

    def test_A16_inventory_and_suffix(self): self.normal()
    def test_A17_recognized_unsupported(self): self.normal()

    def test_A17_multiline_observation(self):
        root = self.base / 'optional-input'
        before = inventory(root)
        p, out = self.invoke(root=root)
        self.assertEqual(p.returncode, 0, p.stderr)
        if CONTEXT['mode'] == 'd1':
            doc = json.loads((out / 'report.json').read_text(encoding='utf-8'))
            self.assertIs(doc['complete'], True)
            self.assertEqual(doc['counts']['broken'], 0)
            rows = doc['results']
        else:
            rows = markdown_rows((out / 'report.md').read_text(encoding='utf-8'))
        # Ignored malformed input or recognized unsupported input are allowed;
        # fabricated missing files from a partially parsed construct are not.
        self.assertTrue(all(r['status'] == 'unchecked_unsupported' for r in rows))
        self.assertEqual(inventory(root), before)

    def test_A18_v1_baseline_and_real_cli(self):
        self.normal()
        if CONTEXT['mode'] == 'v1':
            self.invalid('--format', 'json')
        else:
            p, out = self.invoke(mode='v1')
            self.assertEqual(p.returncode, 0, p.stderr)
            self.assertTrue((out / 'report.md').is_file())

    def test_D01_controlled_json_contract(self):
        if CONTEXT['mode'] != 'd1': self.skipTest('D1 reserved; not a v1 defect')
        self.normal()

    def test_D02_exit_priority_and_call_errors(self):
        if CONTEXT['mode'] != 'd1': self.skipTest('D1 reserved; not a v1 defect')
        for name in ('D02-clean', 'D02-skipped', 'D02-error'):
            root, manifest = build(name, self.base / name)
            p, out = self.invoke(root=root)
            self.report(p, out, manifest)
            self.assertEqual(inventory(root), manifest['input_inventory'])
        self.invalid('--not-a-real-option')
        self.invalid(output=self.base / 'expected.json' / 'child')

    def test_A11_permission_probe(self):
        self.permission_probe(directory=False)

    def test_A11_directory_permission_probe(self):
        self.permission_probe(directory=True)

    def permission_probe(self, directory):
        # chmod success is not evidence that this identity is denied access.
        target = self.root / ('denied-directory' if directory else 'denied.md')
        if directory:
            target.mkdir()
            (target / 'hidden.md').write_text('[hidden]()\n', encoding='utf-8')
        else:
            target.write_text('[self]()\n', encoding='utf-8')
        before = inventory(self.root)
        target.chmod(0)
        try:
            try:
                list(target.iterdir()) if directory else target.read_bytes()
            except PermissionError:
                p, out = self.invoke()
                if CONTEXT['mode'] == 'd1':
                    self.assertEqual(p.returncode, 2, p.stderr)
                    doc = json.loads((out / 'report.json').read_text(encoding='utf-8'))
                    self.assertIs(doc['complete'], False)
                    self.assertTrue(doc['errors'])
                    rows = doc['results']
                else:
                    self.assertNotEqual(p.returncode, 0, p.stderr)
                    rows = markdown_rows((out / 'report.md').read_text(encoding='utf-8'))
                diagnostic = [r for r in rows if r['source'] == target.name]
                self.assertTrue(diagnostic, 'Permission error must have a source diagnostic')
                for row in diagnostic:
                    self.assertEqual(row['status'], 'scan_error')
                    for key in ('line', 'column', 'raw', 'target'):
                        self.assertIsNone(row[key])
            else:
                self.skipTest('chmod(000) access still succeeds; permission denial NOT VERIFIED')
        finally:
            target.chmod(0o700 if directory else 0o600)
            try:
                self.assertEqual(inventory(self.root), before)
            finally:
                if directory:
                    (target / 'hidden.md').unlink()
                    target.rmdir()
                else:
                    target.unlink()
