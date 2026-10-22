#!/usr/bin/env python3
"""Read-only, deliberately limited local Markdown link auditor (D1)."""
import argparse
from collections import Counter
from dataclasses import asdict, dataclass
import errno
import json
import os
from pathlib import Path
import re
import stat
import sys
from urllib.parse import unquote

STATUSES = ('ok', 'broken', 'unchecked_fragment', 'skipped_external',
            'outside_root', 'skipped_symlink', 'unchecked_unsupported', 'scan_error')
LIMITS = (
    'Local .md files only; UTF-8 with optional BOM. Existence, not anchor validity, is checked. '
    'Supported: single-line inline links/images and full, collapsed, defined shortcut references. '
    'Labels cannot contain nested brackets. Bare destinations cannot contain unescaped whitespace; '
    'angle destinations allow spaces. Titles, multiline links/definitions and unescaped nested '
    'parentheses are unsupported. Fenced and matching-backtick inline code are ignored. '
    'HTML/autolinks, wiki links, indented code blocks and full CommonMark container/nesting '
    'semantics are not supported. No network access. No symlink following. '
    'Safety assumes a static input tree; malicious concurrent replacement (TOCTOU) is not prevented.'
)


@dataclass(frozen=True)
class Result:
    source: str
    line: object
    column: object
    raw: object
    target: object
    status: str
    reason: str


def escaped(text, index):
    start = index
    while start > 0 and text[start - 1] == '\\':
        start -= 1
    return (index - start) % 2 == 1


def markdown_unescape(text):
    return re.sub(r'\\([!"#$%&\'()*+,\-./:;<=>?@\[\]\\^_`{|}~])', r'\1', text)


def mask_code(text):
    chars = list(text)
    def blank(start, end):
        for j in range(start, end):
            if chars[j] not in '\r\n':
                chars[j] = ' '
    fence = None
    offset = 0
    for line in text.splitlines(keepends=True):
        match = re.match(r' {0,3}(`{3,}|~{3,})([^\r\n]*)', line)
        if fence:
            blank(offset, offset + len(line))
            if (match and match[1][0] == fence[0] and len(match[1]) >= fence[1]
                    and not match[2].strip()):
                fence = None
        elif match and not (match[1][0] == '`' and '`' in match[2]):
            fence = (match[1][0], len(match[1]))
            blank(offset, offset + len(line))
        offset += len(line)
    masked = ''.join(chars)
    runs = list(re.finditer(r'`+', masked))
    i = 0
    while i < len(runs):
        opener = runs[i]
        if escaped(masked, opener.start()):
            i += 1
            continue
        end = i + 1
        while end < len(runs) and len(runs[end][0]) != len(opener[0]):
            end += 1
        if end < len(runs):
            blank(opener.start(), runs[end].end())
            i = end + 1
        else:
            i += 1
    return ''.join(chars)


def normalize_label(text):
    return ' '.join(markdown_unescape(text).split()).casefold()


def destination(text):
    """Return original destination without angle delimiters, plus syntax reason."""
    text = text.strip(' \t')
    if '\n' in text or '\r' in text:
        return text, 'multiline_not_supported'
    if text.startswith('<'):
        end = next((i for i in range(1, len(text))
                    if text[i] == '>' and not escaped(text, i)), None)
        if end is None:
            return text, 'invalid_angle_destination'
        target = text[1:end]
        if text[end + 1:].strip():
            return target, 'title_or_trailing_text_not_supported'
        if '<' in target:
            return target, 'invalid_angle_destination'
        return target, None
    for i, char in enumerate(text):
        if char.isspace() and not escaped(text, i):
            return text, 'bare_whitespace_or_title_not_supported'
        if char in '()' and not escaped(text, i):
            return text, 'nested_parentheses_not_supported'
    return text, None


def extract_links(text):
    """Yield (offset, raw, target, syntax_reason); None target means undefined ref."""
    masked = mask_code(text)
    chars = list(masked)
    definitions = {}
    offset = 0
    for line in masked.splitlines(keepends=True):
        match = re.fullmatch(r' {0,3}\[([^\[\]\r\n]+)\]:[ \t]*(.*?)[\r\n]*', line)
        if match:
            # Slice the original, not code-masked text, for exact destination bytes.
            original = text[offset + match.start(2):offset + match.end(2)]
            key = normalize_label(match[1])
            parsed = destination(original)
            if not original.strip():
                parsed = (original, 'multiline_or_empty_definition_not_supported')
            definitions.setdefault(key, parsed)
            for j in range(offset, offset + len(line)):
                if chars[j] not in '\r\n':
                    chars[j] = ' '
        offset += len(line)
    masked = ''.join(chars)
    i = 0
    while i < len(masked):
        start = i
        if masked[i] == '!' and i + 1 < len(masked) and masked[i + 1] == '[':
            label_start = i + 1
        elif masked[i] == '[':
            label_start = i
        else:
            i += 1
            continue
        if escaped(masked, start):
            i += 1
            continue
        if masked[label_start:label_start + 2] == '[[':
            end = masked.find(']]', label_start + 2)
            newline = masked.find('\n', label_start)
            if end >= 0 and (newline < 0 or end < newline):
                i = end + 2
                continue
        close = label_start + 1
        nested = False
        depth = 1
        while close < len(masked):
            if not escaped(masked, close):
                if masked[close] == '[':
                    depth += 1
                    nested = True
                elif masked[close] == ']':
                    depth -= 1
                    if depth == 0:
                        break
            close += 1
        if close == len(masked):
            i += 1
            continue
        label = text[label_start + 1:close]
        after = close + 1
        target = reason = None
        end = after
        recognized = False
        if after < len(masked) and masked[after] == '(':
            depth = 1
            pos = after + 1
            angle = False
            while pos < len(masked):
                c = masked[pos]
                if not escaped(masked, pos):
                    if c == '<' and pos == after + 1:
                        angle = True
                    elif c == '>' and angle:
                        angle = False
                    elif not angle and c == '(':
                        depth += 1
                    elif not angle and c == ')':
                        depth -= 1
                        if depth == 0:
                            break
                pos += 1
            if depth == 0:
                target, reason = destination(text[after + 1:pos])
                end, recognized = pos + 1, True
        elif after < len(masked) and masked[after] == '[':
            pos = after + 1
            while pos < len(masked) and (masked[pos] != ']' or escaped(masked, pos)):
                pos += 1
            if pos < len(masked):
                key = normalize_label(text[after + 1:pos] or label)
                target, reason = definitions.get(key, (None, 'undefined_reference'))
                end, recognized = pos + 1, True
        elif normalize_label(label) in definitions:
            target, reason = definitions[normalize_label(label)]
            recognized = True
        if recognized:
            raw = text[start:end]
            if nested:
                reason = 'nested_label_not_supported'
            elif '\n' in raw or '\r' in raw:
                reason = 'multiline_not_supported'
            yield start, raw, target, reason
            i = end
        else:
            i = after


def checked_absolute(value, allow_missing=False):
    """Inspect unnormalized components first: s/../x must not hide a symlink."""
    raw = value if os.path.isabs(value) else os.path.join(os.getcwd(), value)
    current = Path('/')
    for part in raw.split('/'):
        if part in ('', '.'):
            continue
        if part == '..':
            current = current.parent
            continue
        current = current / part
        try:
            mode = current.lstat().st_mode
        except FileNotFoundError:
            if not allow_missing:
                raise ValueError(f'path does not exist: {current}')
            continue
        if stat.S_ISLNK(mode):
            raise ValueError(f'symlink path component is prohibited: {current}')
        if not stat.S_ISDIR(mode):
            raise ValueError(f'not a directory: {current}')
    return current


def classify(root, source, original):
    target = markdown_unescape(original)
    if re.match(r'^[A-Za-z][A-Za-z0-9+.-]*:', target) or target.startswith('//'):
        return 'skipped_external', 'explicit_uri_or_network_path'
    path, _, fragment = target.partition('#')
    if '?' in path:
        return 'unchecked_unsupported', 'local_query_not_supported'
    if re.search(r'%(?![0-9A-Fa-f]{2})', path):
        return 'unchecked_unsupported', 'invalid_percent_encoding'
    try:
        path = unquote(path, encoding='utf-8', errors='strict')
    except UnicodeError:
        return 'unchecked_unsupported', 'invalid_utf8_target'
    if '\x00' in path:
        return 'unchecked_unsupported', 'nul_target'
    if path.startswith('/'):
        return 'outside_root', 'absolute_path_disallowed'
    parts = list(Path(source).parent.parts)
    # Lexical escape is rejected before any filesystem access.
    depth = len(parts)
    for part in path.split('/'):
        if part == '..':
            depth -= 1
            if depth < 0:
                return 'outside_root', 'relative_path_escapes_root'
        elif part not in ('', '.'):
            depth += 1
    if not path:
        parts = list(Path(source).parts)
        path_parts = []
    else:
        path_parts = path.split('/')
    current = root.joinpath(*parts)
    for part in path_parts:
        if part in ('', '.'):
            continue
        if part == '..':
            current = current.parent
            continue
        current = current / part
        try:
            mode = current.lstat().st_mode
        except OSError as exc:
            if exc.errno in (errno.ENOENT, errno.ENOTDIR):
                return 'broken', 'missing_target'
            return 'scan_error', 'target_stat_error'
        if stat.S_ISLNK(mode):
            return 'skipped_symlink', 'symlink_target_component'
    # Empty paths and paths ending in .. may not have performed a final lstat.
    try:
        mode = current.lstat().st_mode
    except OSError as exc:
        if exc.errno in (errno.ENOENT, errno.ENOTDIR):
            return 'broken', 'missing_target'
        return 'scan_error', 'target_stat_error'
    if stat.S_ISLNK(mode):
        return 'skipped_symlink', 'symlink_target_component'
    if fragment:
        return 'unchecked_fragment', 'fragment_not_checked'
    return 'ok', 'target_exists'


def scan(root):
    results = []
    files_scanned = 0
    def diagnostic(source, status, reason):
        results.append(Result(source, None, None, None, None, status, reason))
    def visit(directory):
        nonlocal files_scanned
        source = directory.relative_to(root).as_posix()
        try:
            with os.scandir(directory) as iterator:
                entries = sorted(iterator, key=lambda e: e.name)
        except OSError:
            diagnostic(source, 'scan_error', 'directory_enumeration_error')
            return
        for entry in entries:
            relative = Path(entry.path).relative_to(root).as_posix()
            try:
                mode = entry.stat(follow_symlinks=False).st_mode
            except OSError:
                diagnostic(relative, 'scan_error', 'entry_stat_error')
                continue
            if stat.S_ISLNK(mode):
                diagnostic(relative, 'skipped_symlink', 'symlink_input_entry')
            elif stat.S_ISDIR(mode):
                visit(Path(entry.path))
            elif stat.S_ISREG(mode) and entry.name.endswith('.md'):
                try:
                    with open(entry.path, encoding='utf-8-sig', newline='') as stream:
                        text = stream.read()
                except UnicodeError:
                    diagnostic(relative, 'scan_error', 'source_utf8_decode_error')
                    continue
                except OSError:
                    diagnostic(relative, 'scan_error', 'source_read_error')
                    continue
                files_scanned += 1
                for offset, raw, target, syntax in extract_links(text):
                    if syntax == 'undefined_reference':
                        status, reason = 'broken', syntax
                    elif syntax:
                        status, reason = 'unchecked_unsupported', syntax
                    else:
                        status, reason = classify(root, relative, target)
                    line = text.count('\n', 0, offset) + 1
                    column = offset - text.rfind('\n', 0, offset)
                    results.append(Result(relative, line, column, raw, target, status, reason))
    visit(root)
    results.sort(key=lambda r: (r.source, r.line or 0, r.column or 0, r.status, r.raw or ''))
    return files_scanned, results


def cell(value):
    if value is None:
        return 'null'
    # Entity-encode Markdown syntax as well as HTML; HTML-unescape restores exact text.
    special = '&<>\\`|[]!\r\n'
    return ''.join(f'&#{ord(c)};' if c in special else c for c in str(value))


def render(files_scanned, results):
    counts = Counter(r.status for r in results)
    lines = ['# Markdown link audit — D1', '', '## Scope and limitations', '', LIMITS, '',
             f'Complete: {"false" if counts["scan_error"] else "true"}',
             f'Files scanned: {files_scanned}', f'Broken total: {counts["broken"]}', '',
             '## Counts', '', '| status | count |', '| --- | ---: |']
    lines.extend(f'| {status} | {counts[status]} |' for status in STATUSES)
    lines.extend(['', '## Results', '',
                  '| source | line | column | raw | target | status | reason |',
                  '| --- | ---: | ---: | --- | --- | --- | --- |'])
    for result in results:
        lines.append('| ' + ' | '.join(cell(getattr(result, field)) for field in
                     ('source', 'line', 'column', 'raw', 'target', 'status', 'reason')) + ' |')
    lines.extend(['', '## Scan errors', ''])
    errors = [r for r in results if r.status == 'scan_error']
    lines.extend(f'- {cell(r.source)}: {r.reason}' for r in errors)
    if not errors:
        lines.append('None.')
    return '\n'.join(lines) + '\n'


def render_json(files_scanned, results):
    counts = Counter(r.status for r in results)
    messages = {
        'directory_enumeration_error': 'Could not enumerate input directory.',
        'entry_stat_error': 'Could not inspect input entry.',
        'source_utf8_decode_error': 'Source is not valid UTF-8.',
        'source_read_error': 'Could not read source file.',
        'target_stat_error': 'Could not inspect local target.',
    }
    document = {
        'schema_version': 1,
        'complete': not counts['scan_error'],
        'files_scanned': files_scanned,
        'counts': {status: counts[status] for status in STATUSES},
        'results': [asdict(result) for result in results],
        'errors': [{'source': result.source, 'reason': result.reason,
                    'message': messages[result.reason]}
                   for result in results if result.status == 'scan_error'],
    }
    return json.dumps(document, ensure_ascii=False, indent=2) + '\n'


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('ROOT', help='existing local directory without symlink components')
    parser.add_argument('--report-dir', required=True,
                        help='separate non-overlapping directory; exclusively creates report.md or report.json')
    parser.add_argument('--format', choices=('markdown', 'json'), default='markdown',
                        help='report format (default: markdown)')
    args = parser.parse_args(argv)
    try:
        root = checked_absolute(args.ROOT)
        output = checked_absolute(args.report_dir, allow_missing=True)
        if root == output or root in output.parents or output in root.parents:
            raise ValueError('report directory must not overlap ROOT (inside, equal or ancestor)')
        report = output / ('report.json' if args.format == 'json' else 'report.md')
        if os.path.lexists(report):
            raise ValueError(f'{report.name} already exists; refusing to overwrite')
        files_scanned, results = scan(root)
        output.mkdir(parents=True, exist_ok=True)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0)
        fd = os.open(report, flags, 0o644)
        with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as stream:
            renderer = render_json if args.format == 'json' else render
            stream.write(renderer(files_scanned, results))
        errors = sum(r.status == 'scan_error' for r in results)
        if errors:
            print(f'scan incomplete: {errors} scan_error result(s); see {report}', file=sys.stderr)
            return 2
        broken = sum(r.status == 'broken' for r in results)
        print(f'report: {report}; files={files_scanned}; broken={broken}')
        return 1 if broken else 0
    except (OSError, ValueError, RecursionError) as exc:
        print(f'error: {exc}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
