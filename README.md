# PRUMO

**English** · [Português (Brasil)](README.pt-BR.md)

PRUMO combines the [graph-foreman](https://github.com/JrSantiaggo/graph-foreman) engine with PO First: approved plans, dependency-aware tasks, independent review, validation evidence and a local dashboard. The same workflow supports software, data, automation, migrations and other domains.

The plan defines the expected outcome; the engine enforces transitions and records evidence. Your AI harness performs the work and dispatches its agents.

## Install

Requires **Node.js 22 or newer** and the chosen harness. The installer does not install Claude Code, Kiro or Codex, or expand their execution permissions.

```sh
bunx @henri-ralmeida/prumo@latest install --claude
bunx @henri-ralmeida/prumo@latest install --kiro
bunx @henri-ralmeida/prumo@latest install --codex
```

Replace `bunx` with `npx` if preferred. Bun is optional; the executable runs under Node.js. Installed files are persistent copies, independent of the package manager cache.

```sh
npx @henri-ralmeida/prumo@latest install --claude --lang en --dry-run
npx @henri-ralmeida/prumo@latest install --claude --lang en
npx @henri-ralmeida/prumo@latest doctor --claude --lang en
```

`--dry-run` only previews changes. A real installation prints affected files before applying them and reports its backup. Repeat the command to update; identical files and instruction blocks are not duplicated. Repeatable `--project <path>` includes additional projects when looking for existing installations and data. It does not scan your entire disk.

| Harness | Invocation | PO First activation |
|---|---|---|
| Claude Code | `/prumo` | Installs and selects an output style |
| Kiro | `/prumo` | Always-included steering and explicit resources in discovered JSON agents |
| Codex | `$prumo` / skill picker | Managed block in the effective global instructions file |

PO First also applies outside PRUMO. It prioritizes outcomes, rules, scope, decisions and evidence without requiring other personal skills. Claude's coding instructions stay enabled in the output style.

Open a new session after installation. `doctor` distinguishes installed files, completed configuration and pending activation conditions. Local overrides, explicitly disabled skills and Markdown agents needing an inheritance check are reported; installation does not override harness policies. Filesystem inspection is not proof of model behavior.

## Installing over graph-foreman

No manual migration, stopped agents or stopped dashboard is required in advance. The installer checks standard locations, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, supplied projects and ancestors of the current directory.

- Installs PRUMO under the same skills root and preserves compatibility with old script paths.
- Keeps data in its original location, including project-local `.specs/graph` and the old central store. Installation never runs engine commands or changes contracts, states, attempts, evidence or history.
- Takes complete backups of affected installations and configuration before writing. Live plan data is outside this transaction and is never rolled back with the installation.
- Applies independent groups separately. Invalid configuration, linked paths or busy files block only their affected group. The installer does not kill processes to release files.
- Verifies written bytes and rolls back a failed group. Concurrent configuration edits are detected.

The backup includes a restore command:

```sh
npx @henri-ralmeida/prumo@1.0.1 restore "<backup-directory>"
```

Restore refuses to overwrite files edited since installation. Plans keep their current state: reverting an installation must not erase ongoing work. Maintain your own business-data backups; the installer does not take a consistent snapshot of every live plan.

An open dashboard can load the updated interface on its next request. Its process keeps already-loaded code until restarted; the installer never restarts it silently.

## Run an approved plan

Present and approve the plan in your AI harness. Invoke `/prumo <plan-or-run>` or `$prumo` in Codex. The engine records dispatches; the harness creates agents. If independent executors and reviewers are unavailable, the workflow must report that limitation.

For new work, select a central workspace. On macOS/Linux:

```sh
export PRUMO_HOME="$HOME/.local/share/prumo"
export PRUMO_ROOT="$PRUMO_HOME/my-workspace"
mkdir -p "$PRUMO_ROOT"
```

On PowerShell:

```powershell
$env:PRUMO_HOME = Join-Path $HOME '.local/share/prumo'
$env:PRUMO_ROOT = Join-Path $env:PRUMO_HOME 'my-workspace'
New-Item -ItemType Directory -Force -Path $env:PRUMO_ROOT | Out-Null
```

For existing plans, preserve their original workspace. `GRAPH_ROOT` and `GRAPH_FOREMAN_HOME` remain supported; explicitly set `PRUMO_*` variables take precedence. Without an explicit setting, an existing legacy central store is reused. Otherwise new installations use `~/.local/share/prumo`.

Scripts are under `scripts/` beside the installed skill. Resolve paths from that skill, not from the project directory. See the [engine reference](references/runtime.md) for commands, contracts and states.

## What approval means

A functional change needs an executable step marked `kind: "functional"`. Lint, build, type checks and prose alone are insufficient. The engine executes approved commands and records output, exit code, working directory and timeout; the reviewer judges whether that evidence establishes the requested behavior.

Documentation and other tasks without runtime impact can use `validationMode: "inspection"`, with `inspectionReason` and evidence. This exception must not disguise functional work. A label in a plan does not prove test quality.

An approved contract update does not require inventing a failure or another attempt. `refresh-contract` preserves work and state, including blocks, while invalidating old receipts. Unblocking and resuming are separate decisions; installation does neither.

## Languages and compatibility

Use `--lang en|pt-BR`, `PRUMO_LANG`, environment detection or the persistent dashboard language selector. Interface, messages and documentation support English and Brazilian Portuguese. Internal instructions remain English and direct agents to answer in the user's language. Identifiers, contracts, commands and process output are not translated.

Installer and engine checks for Windows, macOS and Linux with Node.js 22 and 24 are defined in [CI](.github/workflows/ci.yml). Each harness remains subject to its vendor's platform support. The [verification matrix](references/verification.md) separates automated checks from real client sessions.

## Publishing updates

Pushing to `main` runs CI; it does not publish an npm package or update a GitHub release. Each published update needs a new version in `package.json`, matching release checks and changelog, passing CI, and a corresponding Git tag and GitHub release. Publish the tested archive to npm as `@henri-ralmeida/prumo`; the `latest` npm tag selects the version installed by the commands above.

## Develop and license

```sh
npm test
npm run check
npm pack
```

After changing translations, run `node scripts/build-dashboard.mjs --write`. The dashboard embeds its catalog so already-running legacy servers need no new asset routes.

PRUMO is a fork of graph-foreman by **JrSantiaggo**, preserving its history and [MIT license](LICENSE). PRUMO and PO First additions are described in the [changelog](CHANGELOG.md).
