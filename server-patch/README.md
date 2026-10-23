# Portable CEO server patch

Three exact edits against public `@paperclipai/server@2026.1005.0` dist sources. No complete server is vendored. `manifest.json` and `candidate.patch` are byte-for-byte copies of the reviewed patch inputs; the manifest is authoritative for application. This wrapper has been tested in isolation, **not deployed or verified online**.

## Default offline tier

Additional fixed-baseline bundles are selected with `--bundle cancellation` (ten
server targets) or `--bundle sdk` (shared SDK UTF-8 decoder). The default remains
the original lifecycle bundle. See [repair mapping and complete commands](../docs/REPAIR-RELEASE.md).
They reuse this same fail-closed generator. Apply lifecycle before cancellation
when assembling both, because lifecycle reads pristine heartbeat as a dependency.
`python3 -B run_repair.py` tests the generated SDK in a disposable copy;
`--server-root /operator/work/server/package/dist` adds real generated cancellation
contracts. Neither command modifies an installed service.

Requires Python 3.9+ on POSIX/macOS (stdlib only). From this directory:

```sh
python3 -B test_offline.py
```

The tests create and remove temporary directories **inside this package**. They use synthetic source fixtures, including a seam composed of the real manifest's old strings with fixture-specific hashes. That seam is not a real server baseline and does not establish runtime authorization correctness. Existing behavior tests are labeled regression coverage, not retroactive TDD RED. Local development RED/GREEN records are not shipped with this product package; the committed tests are the reproducible verification entrypoints.

## Obtain the public baseline explicitly

Use an empty, operator-selected work directory; do not point any command at an installed service. `source-baseline.json` records public npm URLs, pinned versions, SHA-512 npm integrity values, SHA-256 tarball hashes and all six dist-file SHA-256 values. Download each URL to its own `.tgz`, verify **both** the tarball SHA-256 and the npm SHA-512 integrity, then extract into separate `server` and `shared` directories. Example integrity check (replace the filename/name placeholders deliberately):

```sh
python3 - /operator/work/server.tgz @paperclipai/server <<'PY'
import base64, hashlib, json, pathlib, sys
m = json.loads(pathlib.Path('source-baseline.json').read_text())
p = next(p for p in m['packages'] if p['name'] == sys.argv[2])
data = pathlib.Path(sys.argv[1]).read_bytes()
assert hashlib.sha256(data).hexdigest() == p['sha256']
assert 'sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode() == p['integrity']
print('tarball integrity verified')
PY
```

Repeat for shared. Inspect archive members and reject absolute/traversal/symlink members before extraction; do not unpack unverified input. No additional prerequisite patch is needed for the six verified files. Shared provenance is pinned for reproducibility, but this patch only reads server dist files and does not load shared or build an application. The public baseline manifest is a narrow source lock, not a full application dependency lock.

## Explicit check, preview and apply

```sh
python3 -B apply.py --root /operator/work/server/package/dist
python3 -B apply.py --root /operator/work/server/package/dist --preview
# Only on an explicitly chosen disposable/offline copy:
python3 -B apply.py --root /operator/work/copy/dist --apply
```

`--root` is mandatory. There is no implicit author path, node_modules lookup or environment fallback. Without `--apply`, the command only checks (and optionally prints a diff); `--apply --preview` previews and then applies, so omit `--apply` for read-only use.

Before the first write, **every target and read-only source dependency** must match its recorded hash, every exact old string must occur once, and every transformed target must match its candidate hash. Missing/foreign/already-patched files fail closed, with no writes during preflight. Absolute or parent-traversing manifest paths, symlink components (including root and its ancestors), hardlinked files and non-regular files are rejected. Do not canonicalize a caller's symlink to bypass this guard.

The wrapper rechecks all targets and dependencies immediately before the first write and before each subsequent write, opens path components with `O_NOFOLLOW`, never truncates before checking, and verifies output bytes after each write. Dependencies are never written. **This is not an atomic multi-file transaction, lock manager or hostile-concurrency sandbox.** Use an offline copy with exclusive access; concurrently modifying directory entries or file contents can still race a check. An I/O failure or change after one write can leave a partial application. Stop, inspect all six hashes and decide manually; there is no automatic rollback, retry, baseline acceptance, backup restore or production/service restart. A second apply is rejected rather than treated as success.

## Optional public-source host tier

Requires Node with `node:test`, npm and the public pristine server dist above. Install only the dedicated pinned parser dependency:

```sh
npm --prefix host-deps ci --ignore-scripts --no-audit --no-fund --cache ./npm-cache
python3 -B run_host.py --root /operator/work/server/package/dist
```

The independent `host-deps/package-lock.json` pins public `acorn@8.15.0`. No root-project dependency wiring or author node_modules is used. `NODE_PATH` and `NODE_OPTIONS` are removed for the test subprocess. Missing local acorn or sources are errors, never a fallback. Install caches, node_modules and test-created temporary directories are not distributable patch sources.

The runner hashes all six pristine sources **before** creating a fixture, copies only those six into a temporary directory here, applies only to the fixture, verifies the three resulting candidate hashes, and runs the six preserved CJS test files. It does not modify the supplied public root. Tests extract real public functions via acorn and execute them with VM/persistence fixtures, not a running HTTP server or live DB. They preserve all **41** original test cases: same-company active CEO, real target-scoped configure grants and denials, pending-hire protection, true cancellation attribution, recovery suppression and genuine native-stop receipts. This is stronger than synthetic seams but is not a production integration/deployment claim.

## Provenance and licensing

`manifest.json` and `candidate.patch` preserve the reviewed edits; `source-baseline.json` carries pinned public package URLs, integrity values and source hashes, not private deployment JSON or credentials. Packaging logs, local RED/GREEN records and historical acceptance reports are intentionally excluded. Reproduce the offline and optional public-source host tiers above rather than relying on an author's local evidence files.

The public server and shared `package.json` both declare **MIT**, repository `https://github.com/paperclipai/paperclip` (directories `server` and `packages/shared`). Neither public tarball contains a package-root LICENSE; shared includes a separate `dist/cliplab/LICENSE` for a vendored component not used by this patch. No full upstream server or shared sources are redistributed here. The exact upstream copyright and MIT permission notice are preserved in the repository's [third-party notices](../THIRD_PARTY_NOTICES.md). Acorn retains its MIT notice in its separately installed npm distribution. The license-source commit is not claimed to be the npm build commit.
