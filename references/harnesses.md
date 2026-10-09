# Harness integration guide

Prumo installs the same `prumo` skill and the PO First instructions in each selected harness. The harness remains responsible for authentication, permissions, native planning, model selection and agent creation. Prumo does not install a harness, create an API key, replace a default model or create native agents.

Use the native planning surface first. Review and approve the plan, then load the Prumo skill so the approved work becomes a Prumo run. Native plan approval and a Prumo run are separate stages: the first authors the approved intent, and the second records discussion, planning, execution, review and evidence.

## Install a target

The installer accepts one explicit target or all detected targets:

```sh
prumo install --antigravity
prumo install --opencode
prumo install --grok
prumo install --copilot
prumo install --all
```

The commands integrate with an existing local installation. They do not download Antigravity, OpenCode or Grok Build, and they do not configure credentials or provider endpoints. See the [installation section](../README.md#install) for detection, dry runs, backups and conflict handling.

## GitHub Copilot: CLI and VS Code

Run `prumo install --copilot` from the project root or add `--project <path>`.
Personal skills use `~/.copilot/skills/prumo`; existing project installations in
`.github/skills/prumo` are also updated. `COPILOT_HOME` supports a custom CLI root while
retaining the default personal skill location for VS Code.

PO First is appended as a managed block to the CLI configuration's `copilot-instructions.md`
and the selected projects' `.github/copilot-instructions.md`. Project instructions also serve
the VS Code Local agent. Existing instructions, models and permissions are preserved.
Run `prumo install --copilot --project <path>` for a new project to receive those rules.

Use `/plan` in the CLI or the Plan agent in VS Code. After approval, leave planning mode
and invoke `/prumo`. Installation does not create agents or configure authentication.
Check discovery with `copilot skill list` in the CLI or `/skills` in VS Code.

Official sources: [skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills),
[CLI and instructions](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference),
[VS Code](https://code.visualstudio.com/docs/agent-customization/agent-skills).

## Antigravity

Antigravity has different global skill roots for the 2.0/IDE surface and the CLI. Prumo keeps both available and also supports the shared workspace skill root:

| Scope | Prumo destination |
|---|---|
| Antigravity 2.0 or IDE | `~/.gemini/config/skills/prumo/SKILL.md` |
| Antigravity CLI (`agy`) | `~/.gemini/antigravity-cli/skills/prumo/SKILL.md` |
| Workspace | `.agents/skills/prumo/SKILL.md` |
| Global PO First | `~/.gemini/AGENTS.md` |

Use `/plan` in the prompt surface. With the CLI, `agy --mode=plan` starts in planning mode. After approval, invoke `/prumo <plan-or-run>`. Pick the reasoning model from the model selector under the prompt; availability depends on the account or organization plan and can change.

Official references: [skills and locations](https://antigravity.google/docs/skills/), [plan command](https://antigravity.google/docs/plan/), [execution modes](https://www.antigravity.google/docs/cli/modes/), and [models](https://antigravity.google/docs/models?app=antigravity).

## OpenCode

OpenCode discovers skills from project and global roots. The default global integration is under `~/.config/opencode`; `OPENCODE_CONFIG_DIR` can provide an additional configured root.

| Scope | Prumo destination |
|---|---|
| Global skill | `~/.config/opencode/skills/prumo/SKILL.md` |
| Workspace skill | `.opencode/skills/prumo/SKILL.md` |
| Global PO First | `~/.config/opencode/AGENTS.md` |

Select the built-in `Plan` agent before asking for the approved plan: use `/agents` or `Shift+Tab` in V2, and `Tab` in V1. After approval, leave Plan and mention `@prumo` in a V2 prompt. V1 registers discovered skills as slash commands, so use `/prumo`. The `skill` tool is an internal agent call, not a command to type into the prompt. Choose a model with `/models`, or configure a full `provider/model-id` only when that choice is deliberate. The catalog and provider availability are not fixed by Prumo.

Installation uses OpenCode's canonical directories. The documentation also mentions `.agents/skills` compatibility, but this discovery was not observed in the isolated OpenCode 1.4.10 diagnostic; do not depend on that path for this integration.

OpenCode's `AGENTS.md` rules provide project instructions, while `SKILL.md` files provide reusable task behavior. Their precedence and permission settings remain controlled by OpenCode.

Official references: [skills](https://opencode.ai/v2/docs/skills), [TUI V2](https://opencode.ai/v2/docs/cli/tui/), [skills V1](https://opencode.ai/docs/skills/), [V1 slash registration](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/command/index.ts), [rules](https://opencode.ai/docs/rules/), [agents and Plan](https://opencode.ai/docs/agents/), [models and `/models`](https://opencode.ai/docs/models/), and [providers](https://opencode.ai/docs/providers/).

## Grok Build

Grok Build uses project `.grok/skills` and a user skill root. When `GROK_HOME` is set, Prumo uses that directory as the user root; otherwise it uses `~/.grok`.

| Scope | Prumo destination |
|---|---|
| Global skill | `$GROK_HOME/skills/prumo/SKILL.md` or `~/.grok/skills/prumo/SKILL.md` |
| Workspace skill | `.grok/skills/prumo/SKILL.md` |
| Global PO First | `$GROK_HOME/AGENTS.md` or `~/.grok/AGENTS.md` |

Enter `/plan` or cycle to Plan with `Shift+Tab`; review and approve the plan before editing. After approval, invoke `/prumo <plan-or-run>`. Run `grok models` to inspect available models, use `/model <name>` in the TUI or pass `-m <name>` for a headless run. `grok inspect` shows the configuration, rules and skills discovered for the current directory.

Grok reads the `AGENTS.md` family while walking from the current directory to the repository root, and it also discovers skills from `.grok/skills`, the user root and enabled plugins. Project rules, permissions and plugin configuration remain under Grok's own precedence rules.

Official references: [Grok Build overview](https://docs.x.ai/build/overview), [skills, plugins and marketplaces](https://docs.x.ai/build/features/skills-plugins-marketplaces), [project rules](https://docs.x.ai/build/features/project-rules), [Plan Mode](https://docs.x.ai/build/features/plan-mode), and [CLI/model selection](https://docs.x.ai/build/cli/reference).

## Shared operating rule

For all three harnesses, select the model and enter the native planning surface before invoking Prumo. Keep the approved plan as the source of scope. The dashboard then shows the resulting Prumo run and its independent review evidence; it does not execute the harness or change its model choice.

## Hermes Agent

Instale com `prumo install --hermes --project <pasta-do-projeto>`. A skill fica no perfil selecionado por `HERMES_HOME`; o padrão é `~/.hermes/skills/prumo` em Linux/macOS e `%LOCALAPPDATA%/hermes/skills/prumo` no Windows. O PO First é acrescentado às instruções prioritárias do projeto, preservando conteúdo pessoal e `SOUL.md`.

Use `/plan`, aprove o plano e invoque `/prumo`. Habilite terminal e delegação. Cada subagente deve receber o contrato e os caminhos do run; após uma interrupção, consulte o estado persistido antes de disparar outra tentativa. A instalação não altera modelos, autenticação, permissões nem a confiança de skills do projeto. Se usar uma skill de projeto, confirme a confiança com `hermes skills trust` por sua decisão.

Fontes oficiais: [skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills/), [contexto do projeto](https://hermes-agent.nousresearch.com/docs/user-guide/features/context-files/) e [delegação](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation/).

## OpenClaw

Instale com `prumo install --openclaw --project <workspace-do-agente>`. A skill compartilhada fica em `<OPENCLAW_STATE_DIR>/skills/prumo`, com padrão `~/.openclaw/skills/prumo`; `OPENCLAW_PROFILE` seleciona o diretório do perfil. O PO First é acrescentado ao `AGENTS.md` do workspace, preservando configurações, personalidade e credenciais.

Sem `--project`, o instalador respeita `OPENCLAW_WORKSPACE_DIR` ou os workspaces declarados em `openclaw.json` no formato JSON. Para configurações JSON5, informe o workspace explicitamente com `--project`. Peça um plano, aprove e invoque `/prumo`; o Prumo não acrescenta um comando nativo de planejamento. Os agentes precisam de execução de comandos e delegação. Em sandbox ou host remoto, Node, o pacote e os arquivos persistidos precisam estar disponíveis no ambiente onde os comandos rodam; o navegador local não acessa automaticamente o localhost de outro computador.

Fontes oficiais: [skills](https://docs.openclaw.ai/tools/skills), [workspace](https://docs.openclaw.ai/concepts/agent-workspace) e [subagentes](https://docs.openclaw.ai/tools/subagents).
