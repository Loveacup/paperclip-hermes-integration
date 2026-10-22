"""Synthetic acceptance inputs; every path is contained in the caller's QA workspace."""
from pathlib import Path
import hashlib
import json
import os
import stat

STATUSES = ('ok', 'broken', 'unchecked_fragment', 'skipped_external',
            'outside_root', 'skipped_symlink', 'unchecked_unsupported', 'scan_error')
FIELDS = ('source', 'line', 'column', 'raw', 'target', 'status', 'reason')


def inventory(root):
    """lstat only for links; never hash their referents. Include empty directories."""
    result = []
    def walk(folder):
        for item in sorted(folder.iterdir(), key=lambda p: p.name):
            info = item.lstat()
            row = {'path': item.relative_to(root).as_posix()}
            if stat.S_ISLNK(info.st_mode):
                row.update(type='symlink', target=os.readlink(item))
            elif stat.S_ISDIR(info.st_mode):
                row.update(type='directory')
            elif stat.S_ISREG(info.st_mode):
                row.update(type='file', sha256=hashlib.sha256(item.read_bytes()).hexdigest())
            else:
                row.update(type='other')
            result.append(row)
            if row['type'] == 'directory':
                walk(item)
    walk(root)
    return result


def order(row):
    return (row['source'], row['line'] or 0, row['column'] or 0,
            row['status'], row['raw'] or '')


def build(case, base):
    base = Path(base)
    base.mkdir(parents=True, exist_ok=False)
    root = base / 'input'
    root.mkdir()
    outside = base / 'synthetic-outside'
    outside.mkdir()
    (outside / 'canary.md').write_text('SYNTHETIC CANARY ONLY\n', encoding='utf-8')
    expected = []
    def put(name, value=b''):
        p = root / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(value.encode('utf-8') if isinstance(value, str) else value)
    def row(source, line, column, raw, target, status, reason=None):
        reasons = {'ok': 'target_exists', 'broken': 'missing_target',
                   'unchecked_fragment': 'fragment_not_checked'}
        expected.append(dict(zip(FIELDS, (source, line, column, raw, target,
                                         status, reason or reasons.get(status)))))
    def links(items, source='source.md', prefix=''):
        lines = []
        for raw, target, status, *reason in items:
            line = prefix + raw
            lines.append(line)
            row(source, len(lines), len(prefix) + 1, raw, target, status,
                reason[0] if reason else None)
        put(source, '\n'.join(lines) + '\n')
    if case == 'A01':
        put('target.md'); put('image.png', b'not a real image; existence only')
        (root / 'folder').mkdir()
        links([('[one](../target.md)', '../target.md', 'ok'),
               ('![image](../image.png)', '../image.png', 'ok'),
               ('[dir](../folder)', '../folder', 'ok'),
               ('[self](./source.md)', './source.md', 'ok')], 'sub/source.md', '中文 ')
    elif case == 'A02':
        for name in ('a b.md', '中文.md', 'name#part.md', '+.md', '%20.md', 'a(b).md'):
            put(name)
        links([('[space](<a b.md>)', 'a b.md', 'ok'),
               ('[encoded](a%20b.md)', 'a%20b.md', 'ok'),
               ('[中文](%E4%B8%AD%E6%96%87.md)', '%E4%B8%AD%E6%96%87.md', 'ok'),
               ('[中文](中文.md)', '中文.md', 'ok'),
               ('[hash](name%23part.md)', 'name%23part.md', 'ok'),
               ('[plus](+.md)', '+.md', 'ok'),
               ('[once](%2520.md)', '%2520.md', 'ok'),
               (r'[escaped](a\(b\).md)', r'a\(b\).md', 'ok')])
    elif case == 'A03':
        links([('[a](absent.md)', 'absent.md', 'broken'),
               ('[b](absent.md)', 'absent.md', 'broken'),
               ('[empty]()', '', 'ok')])
    elif case == 'A04':
        put('target.txt')
        put('source.md', '[text][  MiXeD   ID ]\n[MiXeD ID][]\n[ mixed id ]\n![pic][MIXED ID]\n![mixed id][]\n![mixed id]\n[STRASSE]\n\n   [mixed id]: target.txt\n[mixed id]: absent.txt\n[Straße]: target.txt\n')
        for n, raw in enumerate(('[text][  MiXeD   ID ]', '[MiXeD ID][]', '[ mixed id ]',
                                 '![pic][MIXED ID]', '![mixed id][]', '![mixed id]', '[STRASSE]'), 1):
            row('source.md', n, 1, raw, 'target.txt', 'ok')
    elif case == 'A05':
        links([('[text][unknown]', None, 'broken', 'undefined_reference'),
               ('[unknown][]', None, 'broken', 'undefined_reference')])
        with (root / 'source.md').open('a', encoding='utf-8') as f:
            f.write('[说明]\n')
    elif case == 'A06':
        put('target.txt')
        text = ('```md\n[fake](no-fence)\n[masked]: absent.txt\n````\n'
                '   ~~~\n[fake](no-tilde)\n   ~~~~\n'
                '`[fake](no-inline)` [real](target.txt)\n'
                '``[fake](no-cross)\n[masked]: absent.txt``\n'
                '[masked]\n[masked]: target.txt\n'
                '[real][masked]\n`````\n[fake](no-eof)\n```\n[fake](still-masked)\n')
        put('source.md', text)
        row('source.md', 8, 21, '[real](target.txt)', 'target.txt', 'ok')
        row('source.md', 11, 1, '[masked]', 'target.txt', 'ok')
        row('source.md', 13, 1, '[real][masked]', 'target.txt', 'ok')
    elif case == 'A07':
        links([(f'[external]({t})', t, 'skipped_external') for t in
               ('http://qa.invalid/a', 'https://qa.invalid/b', 'mailto:qa@example.invalid',
                'data:text/plain,synthetic', 'file:///SYNTHETIC-DO-NOT-OPEN', '//qa.invalid/a')])
    elif case == 'A08':
        put('target.md')
        links([('[exists](target.md#title)', 'target.md#title', 'unchecked_fragment'),
               ('[self](#title)', '#title', 'unchecked_fragment'),
               ('[missing](absent.md#title)', 'absent.md#title', 'broken')])
    elif case == 'A09':
        links([('[escape](../synthetic-outside/canary.md)', '../synthetic-outside/canary.md', 'outside_root'),
               ('[encoded](%2e%2e%2Fsynthetic-outside%2Fcanary.md)', '%2e%2e%2Fsynthetic-outside%2Fcanary.md', 'outside_root'),
               ('[absolute](' + str(outside / 'canary.md') + ')', str(outside / 'canary.md'), 'outside_root', 'absolute_path_disallowed'),
               ('[fragment](../synthetic-outside/canary.md#title)', '../synthetic-outside/canary.md#title', 'outside_root'),
               ('[reentry](../input/source.md)', '../input/source.md', 'outside_root')])
    elif case == 'A10':
        put('x', 'x'); put('real/inside.txt', 'synthetic')
        for name, target in (('s', 'real'), ('inlink', 'x'), ('outlink', '../synthetic-outside'),
                             ('dangling', 'missing'), ('loop', 'loop')):
            (root / name).symlink_to(target)
            row(name, None, None, None, None, 'skipped_symlink')
        links([(f'[link]({t})', t, 'skipped_symlink') for t in
               ('s/../x', 'inlink', 'outlink/canary.md', 'dangling', 'loop', 's/inside.txt')])
    elif case == 'A11':
        put('bad.md', b'\xff\xfeINVALID UTF-8\n')
        put('good.md', '[good]()\n')
        row('bad.md', None, None, None, None, 'scan_error')
        row('good.md', 1, 1, '[good]()', '', 'ok')
    elif case in ('A12', 'A13'):
        if case == 'A13':
            put('source.md', '[self]()\n')
            row('source.md', 1, 1, '[self]()', '', 'ok')
    elif case == 'A14':
        name = '源|<i>`\\.md'
        raw = r'[<b>|`\\](missing.md)'
        put(name, raw + '\n')
        row(name, 1, 1, raw, 'missing.md', 'broken')
    elif case == 'A15':
        # Deliberately reverse creation order; both Unicode and CRLF positions matter.
        put('中.md', '前缀 [z](missing-z)\r\n[x]()\r\n')
        put('z.md', '[z](missing-z)\n')
        put('B.md', '\ufeff[a]()\n')
        put('a.md', '[first](missing-a) [second]()\n')
        row('中.md', 1, 4, '[z](missing-z)', 'missing-z', 'broken')
        row('中.md', 2, 1, '[x]()', '', 'ok')
        row('z.md', 1, 1, '[z](missing-z)', 'missing-z', 'broken')
        # BOM is an encoding marker, not part of the first source column.
        row('B.md', 1, 1, '[a]()', '', 'ok')
        row('a.md', 1, 1, '[first](missing-a)', 'missing-a', 'broken')
        row('a.md', 1, 20, '[second]()', '', 'ok')
    elif case == 'A16':
        put('source.md', '[self]()\n'); put('ignored.MD', '[not scanned](absent)\n')
        put('ignored.txt', 'synthetic bytes\n'); (root / 'empty').mkdir()
        (root / 'symlink').symlink_to('../synthetic-outside/canary.md')
        row('source.md', 1, 1, '[self]()', '', 'ok')
        row('symlink', None, None, None, None, 'skipped_symlink')
    elif case == 'A17':
        put('exists.txt')
        links([('[query](exists.txt?version=1)', 'exists.txt?version=1', 'unchecked_unsupported'),
               ('[badpct](bad%Q0)', 'bad%Q0', 'unchecked_unsupported'),
               ('[utf8](bad%FF)', 'bad%FF', 'unchecked_unsupported'),
               ('[nul](bad%00)', 'bad%00', 'unchecked_unsupported'),
               ('[title](exists.txt "title")', None, 'unchecked_unsupported'),
               ('[nested](a(b)c)', None, 'unchecked_unsupported')])
        # Separate optional-recognition input: no arbitrary-invalid-Markdown promise.
        optional = base / 'optional-input'
        optional.mkdir()
        (optional / 'exists.txt').write_bytes(b'')
        (optional / 'multiline.md').write_text('[multi](\nexists.txt)\n[id]:\n exists.txt\n[label [nested]](exists.txt)\n', encoding='utf-8')
    elif case in ('A18', 'D02-clean'):
        links([('[self]()', '', 'ok')])
    elif case in ('D01', 'D02', 'D02-skipped', 'D02-error'):
        put('target.txt')
        items = [('[external](https://qa.invalid)', 'https://qa.invalid', 'skipped_external'),
                 ('[escape](../synthetic-outside/canary.md)', '../synthetic-outside/canary.md', 'outside_root'),
                 ('[fragment](target.txt#title)', 'target.txt#title', 'unchecked_fragment')]
        if case != 'D02-skipped':
            items.append(('[real](one-missing)', 'one-missing', 'broken'))
        links(items)
        with (root / 'source.md').open('a', encoding='utf-8') as f:
            f.write('```\n[fake](code-missing)\n```\n`[fake](inline-missing)`\n')
        if case == 'D02-error':
            put('bad.md', b'\xff')
            row('bad.md', None, None, None, None, 'scan_error')
    else:
        raise ValueError(case)
    expected.sort(key=order)
    manifest = {'case': case, 'expected': expected,
                'files_scanned': sum(1 for p in inventory(root)
                                     if p['type'] == 'file' and p['path'].endswith('.md')
                                     and p['path'] != 'bad.md'),
                'complete': case not in ('A11', 'D02-error'),
                'broken': sum(r['status'] == 'broken' for r in expected),
                'input_inventory': inventory(root)}
    (base / 'expected.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return root, manifest


CASES = tuple(f'A{i:02}' for i in range(1, 19)) + ('D01', 'D02-clean', 'D02-skipped', 'D02-error')
