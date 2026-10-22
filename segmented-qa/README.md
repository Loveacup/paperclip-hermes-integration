# Segmented QA (portable reference component)

Frozen local QA, separated from optional Paperclip native publication. The core
`staged_qa.py` and `reproduce.py` remain unchanged from the reviewed candidate.
Native helpers add a narrowly scoped, explicit HTTP-origin opt-in. Tests, this
runner, documentation and bundled fixtures provide portable packaging. No SDK is vendored.

## Test tiers

From this directory, using Python 3.9+ on a POSIX host:

```sh
python3 -B run_tests.py
python3 -B run_tests.py --paperclip-packages /absolute/node_modules/@paperclipai
```

* **Offline (default):** 33 stdlib-only tests; no Node.js, installed Paperclip,
  author-specific paths, production credentials or Internet required. This includes
  non-SDK graph/composition cases and synthetic loopback HTTP transport checks.
* **Host (explicit):** all 36 tests, including exactly three additional cases:
  real shared `createIssueSchema` validation, real native process execution with
  harmless argv, and the complete machine graph through the real process factory
  to a synthetic loopback native endpoint. Requires Node.js on `PATH` and installed
  `shared/dist/validators/issue.js` and `server/dist/adapters/process/execute.js`
  (including their transitive dependencies). Missing dependencies fail, never skip.
  Individual host tests also accept the explicit environment variable
  `SEGMENTED_QA_PAPERCLIP_PACKAGES`; the runner uses the CLI flag to select the tier.

The runner records logs/counts/exit status under gitignored `.evidence/`. It clears
ambient `PAPERCLIP_*` values before tests. Tests own their temporary directories,
respect `TMPDIR`, and clean them up; no pre-existing evidence subdirectories are
needed. A skipped test makes the runner fail. The included product's 23 black-box
checks run inside relevant component tests (not 23 extra top-level tests). Product
permission probes require an identity actually denied by `chmod(000)`; a privileged
host may fail the no-skip contract rather than silently claim coverage.

## Three stages and actual CLI

Choose a new output scope (the example's `.evidence/example` must not already
contain these outputs). Commands below do not publish to Paperclip:

```sh
mkdir -p .evidence/example
python3 -B staged_qa.py prepare --source-project fixtures/md-link-audit --destination .evidence/example/prepared
python3 -B staged_qa.py machine --contract .evidence/example/prepared/contract.json --machine-dir .evidence/example/machine
python3 -B staged_qa.py verify --contract .evidence/example/prepared/contract.json --machine-dir .evidence/example/machine
python3 -B staged_qa.py closeout --contract .evidence/example/prepared/contract.json --machine-dir .evidence/example/machine --closeout-dir .evidence/example/closeout
```

1. **Prepare (OMP / admitted owner):** freeze only allowlisted source and produce a
   hashed contract. No model invocation is implemented by this component.
2. **Machine (process):** admit a unique execution owner, execute the frozen QA once,
   and bind its evidence to a receipt. `verify` is read-only. A completed FAIL verdict
   is not an infrastructure failure; inspect the receipt rather than exit 0 alone.
3. **Closeout (OMP / admitted owner):** verify existing evidence and produce the report
   without rerunning QA. Manual acceptance remains `PENDING`.

For an actual process interruption/recovery probe with a fresh output directory:

```sh
python3 -B reproduce.py --project fixtures/md-link-audit --output .evidence/reproduction
```

`native_graph.build_graph(...)` is a Python API, not a deployment CLI: supply
`project_id`, admitted `actors`, explicit `issue_ids`, `contract_path` and `work_root`.
It returns three native issue bodies with dependency edges, not a scheduler. Missing
or unsuitable actors produce an admission gap. It does **not** create tasks, configure
agents, choose models, deploy services or schedule runs automatically. Each native
task has one assigned owner; machine evidence has one admitted executor. Do not
introduce a second owner or clear admission records to force a rerun.

Only explicit `machine --native-finish` or `closeout --native-finish` requests native
publication using the current task's runtime environment. Native identity/run/task
checks precede a single status/comment write and exact readback. An unknown write
outcome is **not retried**: retain its intent and reconcile manually. Local passing
tests do not guarantee live authentication, authorization, OMP consumption, installed
SDK version compatibility, remote recovery or production readiness.

### Explicit plaintext HTTP approval

HTTPS and loopback HTTP remain the defaults; remote HTTP is refused unless an
administrator explicitly approves one verified origin. Plaintext HTTP exposes
runtime credentials and task contents to interception and modification. Prefer
HTTPS; approval is not a claim that a private network is secure.

`finish_current_issue` reads `SEGMENTED_QA_ALLOWED_HTTP_ORIGIN` only from its supplied
`env` (or the process environment when `env` is omitted). The value must be a pure
`http://host[:port]` origin, for example `http://example.invalid:8123`: no trailing
slash, path, query, fragment, userinfo, whitespace, backslash, wildcard or boolean.
It must match the API base origin exactly, including host spelling and explicit
port; the base alone may retain its supported `/`, `/api` or `/api/` suffix.
An invalid or mismatched opt-in fails closed even with an injected transport.
Redirects remain refused, proxies disabled, and durable intents prevent replay.
Neither the origin nor runtime credentials are added to results or intent records.

Pass `allowed_http_origin='http://example.invalid:8123'` explicitly to
`native_graph.build_graph(...)` only after approval. With the default `None`, graph
output is unchanged. An explicit value is validated before graph construction;
only this non-secret key is added to the machine task's `adapterConfig.env`.
The closeout task's helper command gets an `env SEGMENTED_QA_ALLOWED_HTTP_ORIGIN=...`
prefix, scoped to that invocation. Existing OMP agents/roles/configs are untouched;
no OMP environment merge is assumed. Prepare does not automatically execute this
helper: its owner must receive explicit freeze commands and native-completion
instructions separately. This option does not authorize another task's completion.

## Fixture and portability scope

`fixtures/md-link-audit/` contains exactly five allowlisted original source files:
`md_link_audit.py`, `qa/run_qa.py`, `qa/test_blackbox.py`, `qa/fixtures.py`, and
`qa/guard/sitecustomize.py`. No historical runs, reports, credentials or private
planning/evidence were copied. Source scanning found no personal information needing
redaction; all five files are unchanged. UUIDs in tests are synthetic fixtures, not
live company, actor, project, run or issue identities. Example `.invalid` addresses
are synthetic, not instance URLs.

This is a POSIX filesystem/process reference, exercised on macOS with local
loopback sockets and ordinary permission enforcement. It is not an OS sandbox and
is not a claim of hostile-code isolation, Windows support or cross-version SDK
compatibility. Public files contain no author-machine absolute paths; generated
local evidence can contain runtime paths and must remain untracked.
