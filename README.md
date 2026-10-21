<div align="center">

<img src="assets/hero.svg" alt="Paperclip coordinates tasks, Hermes hosts the conversation, and OMP executes native worker runs." width="100%">

# Paperclip × Hermes

**Your task control plane. Your agent conversation. Connected.**

[![MIT License](https://img.shields.io/badge/license-MIT-d4b47b?style=flat-square)](LICENSE)
[![Node.js 24.11.0+](https://img.shields.io/badge/Node.js-24.11.0%2B-6eb593?style=flat-square)](package.json)
[![Python 3.9+](https://img.shields.io/badge/Python-3.9%2B-84aef0?style=flat-square)](#quick-start)
[![Offline checks on macOS and Linux](https://img.shields.io/badge/checks-macOS%20%2B%20Linux-a59bef?style=flat-square)](https://github.com/Loveacup/paperclip-hermes-integration/actions/workflows/offline.yml)

**English** · [简体中文](README.zh-CN.md)

[Quick start](#quick-start) · [Set up with AI](#ai-setup) · [Configuration](#configuration) · [How it works](#architecture) · [Documentation](#documentation)

</div>

---

Connect **Paperclip** task changes to a precisely bound **Hermes** conversation, while keeping **OMP** workers on their native execution path. A thin integration—not another scheduler, task database, or bot that bypasses your agent.

> [!NOTE]
> **Start locally. Activate deliberately.** Quick start installs dependencies and runs synthetic offline checks. It does not deploy services, invoke a real model, or send messages. The repository is currently private; cloning requires access.

## ✨ What you get

| Component | Role | Why it matters |
|:--|:--|:--|
| **Event bridge** | Reconcile metadata and wake the native CEO heartbeat | Task changes return to the existing management workflow. |
| **Hermes plugin** | Inject event pointers into an explicitly bound conversation | Keep the conversation destination and group sender isolation intact. |
| **OMP adapter** | Execute native JSON runs and verify resolved model identity | Use task-level model overrides without replacing the worker runtime. |
| **Shared configuration** | One nonsecret JSON file, validated against a schema | Change paths and targets without editing product source. |

First startup establishes a baseline, not a historical replay. Uncertain deliveries remain available for review instead of being blindly retried.

<a id="quick-start"></a>
## 🚀 Quick start

**Requirements:** Node.js **24.11.0+**, npm, Python **3.9+**, and macOS or Linux.

```sh
git clone https://github.com/Loveacup/paperclip-hermes-integration.git
cd paperclip-hermes-integration
npm ci
npm test
npm run config:check -- integration.example.json
```

**Success looks like:** installation exits successfully, all tests pass with no skips, and the last command reports `Configuration valid`.

The default suite uses synthetic fixtures. It needs neither the author's installed Hermes/OMP nor production credentials or private captures. For a real installation, continue with the configuration guide below.

<a id="ai-setup"></a>
## 🤖 Let your AI configure it

**Preparing an installation, changing paths or destinations, or diagnosing configuration? Read [AI_SETUP.md](docs/AI_SETUP.md) first.** It gives your assistant an ordered runbook with parameter sources, checks, activation boundaries, and completion criteria.

Copy this into a trusted local coding assistant:

```text
Help me configure this repository. First read docs/AI_SETUP.md,
config.schema.json, integration.example.json, and the relevant implementation.
Inspect the environment and existing installation within the scope I authorize.
Start with local preparation and validation. Derive the field checklist from
schema; verify real identities, paths, and exact conversation routing rather
than substituting the synthetic example. Ask when a required fact is missing.
Reference secrets by environment-variable name; do not ask me to paste them
or expose their values. Preserve existing configuration and runtime state.
Before activation, obtain my approval for the specific host changes and tests.
Report actual commands, results, and unverified boundaries. Offline success
is not proof of live event consumption or user-visible delivery.
```

Prefer configuring it yourself? [Deployment guide →](docs/DEPLOYMENT.md)

<a id="configuration"></a>
## ⚙️ One configuration, explicit ownership

Create a local file, edit it for your environment, then validate and preview:

```sh
cp integration.example.json integration.local.json
npm run config:check -- integration.local.json
npm run setup -- integration.local.json
```

| Configure | Source of truth |
|:--|:--|
| API endpoint, company, and CEO identity | Your verified Paperclip installation |
| Hermes home, destination, sender, and session key | Exact metadata from the intended Hermes route |
| State/cursor paths and OMP executable | Your installation-level choices, with the existing owner accounted for |
| Credentials | An existing protected process environment; JSON stores only the `authEnv` variable name |

The [example](integration.example.json) is **synthetic**, with injection disabled. The [schema](config.schema.json) defines the actual fields; relative paths resolve from the JSON file's directory. Local configuration and runtime data stay out of Git.

<details>
<summary><strong>Preview is not deployment—what does <code>--apply</code> do?</strong></summary>

```sh
npm run setup -- integration.local.json --apply
sh -n .local/deploy.sh
```

This only writes and syntax-checks a reviewable `.local/deploy.sh`. It does **not** execute the deployment. The generated script refuses an existing plugin destination, including directory and dangling symlinks, before host changes.

Hermes stores a `config_path` pointer. Paperclip's installation environment supplies `PAPERCLIP_INTEGRATION_CONFIG`. Actual plugin activation, adapter registration, and service startup are separate steps in [DEPLOYMENT.md](docs/DEPLOYMENT.md).

When changing API/company/CEO, review state ownership first. The bridge rejects mismatched or identity-less persisted state rather than reusing old pending work for a new target.

</details>

<a id="architecture"></a>
## 🧭 How it works

```text
Paperclip task state ──► Metadata bridge ──► Native CEO heartbeat
                              │
                              └──────────► Bound Hermes conversation

Paperclip scheduling ──► OMP adapter ─────► Native OMP worker
```

**Paperclip owns tasks, permissions, and run lifecycle. Hermes owns the selected conversation. OMP executes worker runs.** This repository connects those boundaries without replacing them.

<details>
<summary><strong>Repository map</strong></summary>

```text
event-bridge/           Metadata reconciliation, authenticated reads, ownership, health
tele-injection-plugin/ Owner-scoped configuration, exact routing, persistent cursors
omp-adapter/           Native JSON worker adapter and synthetic protocol fixtures
scripts/               Configuration validation, test tiers, deployment preview
docs/                  English and Chinese setup, deployment, compatibility guides
assets/                Original documentation artwork
```

</details>

## 🧪 Verification without overclaiming

| Layer | What it checks | Entry point |
|:--|:--|:--|
| **Offline** | Reconciliation, routing, configuration, process lifecycle, and synthetic protocol behavior | `npm test` |
| **Host contracts** | Your explicitly configured Hermes/Paperclip installation and OMP probe | Commands below |
| **Live acceptance** | Authorized installation, actual event consumption, and visible delivery | Operator-run acceptance; not proven by offline tests |

<details>
<summary><strong>Optional host checks and compatibility</strong></summary>

```sh
npm run test:host -- integration.local.json
npm run test:server -- integration.local.json
npm run test:installed-omp -- integration.local.json
```

Missing or incompatible hosts fail explicitly instead of silently skipping. The last command really starts OMP, using an isolated HOME and a synthetic offline provider—not a remote model.

- **SDK boundary:** Paperclip SDK/Hermes adapter are pinned to `2026.1005.0`; the internal `buildPrompt` export is checked explicitly.
- **Hermes boundary:** target-installation injection, lifecycle, and routing contracts must be verified. No universal version support is claimed.
- **OMP boundary:** the executable is installation-level configuration; task inputs cannot replace it. Requested and resolved models are handled distinctly.
- **Platform boundary:** POSIX ownership locks; the launchd health probe is macOS-only. See actual per-commit [CI results](https://github.com/Loveacup/paperclip-hermes-integration/actions).

</details>

> [!IMPORTANT]
> **`accepted` is not consumed. Healthy is not delivered.** The standalone package has not been certified through a live deployment and Telegram end-to-end loop. Tool permissions are not an OS sandbox; session injection has no atomic session-id fence. See [compatibility and rollback](docs/COMPATIBILITY.md) before activation.

<a id="documentation"></a>
## 📚 Go deeper

| I want to… | English | 简体中文 |
|:--|:--|:--|
| Have an AI discover and validate configuration | [AI setup](docs/AI_SETUP.md) | [AI 配置指南](docs/AI_SETUP.zh-CN.md) |
| Install the plugin, register the adapter, and operate the bridge | [Deployment](docs/DEPLOYMENT.md) | [配置与部署](docs/DEPLOYMENT.zh-CN.md) |
| Understand support boundaries and roll back safely | [Compatibility](docs/COMPATIBILITY.md) | [兼容性与回滚](docs/COMPATIBILITY.zh-CN.md) |

## 🤝 Contributing

Small, focused changes with reproducible tests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), run the quick-start checks, and keep both language editions aligned when changing instructions.

Keep private configuration, real IDs, credentials, cursors, conversations, and operational output out of commits. Describe contract changes when updating SDK or host interfaces.

## 📄 License & acknowledgements

This project's code is **[MIT licensed](LICENSE)**. Paperclip, Hermes, OMP, and other dependencies retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).

Built around [Paperclip](https://github.com/paperclipai/paperclip), [Hermes Agent](https://github.com/NousResearch/hermes-agent), and [oh-my-pi](https://github.com/can1357/oh-my-pi). This is a community integration, not an official product of those projects.
