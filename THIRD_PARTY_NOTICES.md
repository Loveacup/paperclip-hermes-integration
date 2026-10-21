# Third-party sources and license boundaries

This repository's integration source and synthetic tests are MIT licensed (see LICENSE).
It is a standalone packaging of the contributors' metadata bridge, Telegram injection
plugin and OMP adapter; it does not vendor Paperclip, Hermes or OMP implementations.

Runtime dependencies are resolved from npm with integrity hashes in package-lock.json:

- `@paperclipai/adapter-utils` and `@paperclipai/hermes-paperclip-adapter`, pinned to
  `2026.1005.0`: [Paperclip](https://github.com/paperclipai/paperclip), MIT.
- `ws` 8.22.0: [websockets/ws](https://github.com/websockets/ws), MIT.
- `ajv` 8.20.0: [ajv-validator/ajv](https://github.com/ajv-validator/ajv), MIT.
- Transitive packages retain their own licenses and notices in their distributions.
  The repository MIT license does not replace or relicense any dependency.

External installations are **not included**:

- [Hermes Agent](https://github.com/NousResearch/hermes-agent): official plugin/context
  APIs and routing metadata schema are compatibility boundaries. Host contract tests
  read your explicitly configured installation, not bundled third-party source.
- [oh-my-pi](https://github.com/can1357/oh-my-pi): native JSON CLI protocol. The optional
  `offline-provider.ts` imports its `@oh-my-pi/pi-ai` API. Its installed version and
  license remain independently managed by the operator.

`omp-adapter/fixtures/*.jsonl`, fake executables, IDs and sample payloads are
**synthetic fixtures**, not captures from a real model, private conversation, or
production acceptance run. The offline provider is a synthetic deterministic test
extension. No private captures or capture writer are shipped.

The bridge deliberately uses `dist/server/execute.js`'s `buildPrompt` export at the
pinned Paperclip version. This is an internal compatibility dependency, not a claim
that `@paperclipai/hermes-paperclip-adapter/server` publicly exports that function.
