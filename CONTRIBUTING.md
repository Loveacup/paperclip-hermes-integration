# Contributing

Keep changes small and preserve the three-component architecture. Open an issue or
PR describing the problem, affected contract, synthetic reproduction, test command
and actual result. Do not include private operational evidence.

```sh
npm ci
npm test
npm run config:check -- integration.example.json
```

Default tests must run without Hermes/OMP installations, secrets, production state,
or network. New fixtures must be explicitly synthetic. Add regressions at the public
boundary changed (configuration, bridge behavior, routing or adapter execution).
Installed-host tests belong in explicit opt-in commands and must fail clearly when
prerequisites are absent; do not silently skip them and claim complete coverage.

For an SDK or host API update, state the exact versions and validate real exports and
behavior. Preserve baseline/no-replay, uncertainty/no-retry, sender isolation, owner
configuration scope, authenticated read ownership, model override precedence and
actual resolved-model verification. Never accept a task-level arbitrary executable.

Before sharing, inspect the diff for personal paths, real identifiers, `.env`, secrets,
state/cursor/lock files, transcripts and captures. Keep local configuration and test
artifacts under ignored paths. Update README/AI_SETUP only when the documented public
workflow changes; schema and scripts remain the source of truth.

The project code is MIT licensed. Preserve dependencies' original license notices.
