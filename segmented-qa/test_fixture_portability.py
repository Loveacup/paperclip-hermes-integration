"""Fixture semantics must not change with the operator's temporary-directory spelling."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent / 'fixtures/md-link-audit'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FixturePortabilityTests(unittest.TestCase):
    def test_absolute_outside_fixture_is_valid_markdown_in_space_path(self):
        fixtures = load('portability_fixture', ROOT / 'qa/fixtures.py')
        product = load('portability_product', ROOT / 'md_link_audit.py')
        with tempfile.TemporaryDirectory(prefix='qa fixture with spaces ', dir=os.environ['TMPDIR']) as directory:
            root, manifest = fixtures.build('A09', Path(directory) / 'case')
            expected = next(row for row in manifest['expected'] if row['raw'].startswith('[absolute]'))
            source = root / expected['source']
            matches = [item for item in product.extract_links(source.read_text()) if item[1] == expected['raw']]
            self.assertEqual(len(matches), 1)
            _, _, target, syntax = matches[0]
            self.assertIsNone(syntax, 'fixture must reach the outside-root guard, not invalid-syntax handling')
            self.assertEqual(target, expected['target'])
            self.assertEqual(product.classify(root, source, target), ('outside_root', 'absolute_path_disallowed'))
            self.assertEqual(expected['status'], 'outside_root')

    def test_product_still_rejects_bare_whitespace_destination(self):
        product = load('portability_product_control', ROOT / 'md_link_audit.py')
        value = '/synthetic directory/outside/canary.md'
        self.assertEqual(product.destination(value), (value, 'bare_whitespace_or_title_not_supported'))
