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

## Rebuildable Paperclip server patch: upstream notice

The server-patch delivery is a version-bound modification of selected Paperclip
server code, not a relicensing or bundled distribution of the complete server.
The public `@paperclipai/server` and `@paperclipai/shared` packages at
`2026.1005.0` declare MIT. Their tested tarballs omit a root LICENSE file and do not
provide `gitHead`; source integrity is therefore recorded with the exact tarball
integrity and file hashes, not an invented package-to-Git-commit correspondence.

The upstream license text below was retrieved from
[Paperclip commit 4c57da370884c64f4b0034ec7e6d27e4adae2db5](https://github.com/paperclipai/paperclip/blob/4c57da370884c64f4b0034ec7e6d27e4adae2db5/LICENSE),
license blob `a63594a5150d0ae00c3ddc36b61fa8f708c3ca8c`. This preserves the upstream
copyright/permission notice; that commit is a license-source reference, not a
claim that it built the tested npm release.

```text
MIT License

Copyright (c) 2025 Paperclip AI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The patch host-test parser is separately pinned to `acorn` 8.15.0 and retains its
MIT notice in the installed package. Host source archives, npm caches and installed
dependencies are test preparation assets, not repository source or live evidence.
