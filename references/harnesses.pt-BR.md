# Guia de integração dos harnesses

O Prumo instala a mesma skill `prumo` e as instruções do PO First em cada harness selecionado. O harness continua responsável por autenticação, permissões, planejamento nativo, escolha do modelo e criação dos agentes. O Prumo não instala um harness, cria uma chave de API, troca o modelo padrão nem cria agentes nativos.

Use primeiro a superfície nativa de planejamento. Revise e aprove o plano; depois carregue a skill do Prumo para transformar o trabalho aprovado em uma run do Prumo. A aprovação do plano nativo e uma run do Prumo são etapas separadas: a primeira registra a intenção aprovada, e a segunda registra discussão, planejamento, execução, revisão e evidências.

## Instalar um destino

O instalador aceita um destino explícito ou todos os destinos detectados:

```sh
prumo install --antigravity
prumo install --opencode
prumo install --grok
prumo install --copilot
prumo install --all
```

Os comandos integram uma instalação local existente. Eles não baixam Antigravity, OpenCode ou Grok Build e não configuram credenciais ou endpoints de provedores. Consulte a [seção de instalação](../README.pt-BR.md#instalação) para detecção, prévia, backups e conflitos.

## GitHub Copilot: CLI e VS Code

Use `prumo install --copilot` na raiz do projeto ou acrescente `--project <pasta>`.
A skill pessoal fica em `~/.copilot/skills/prumo`; instalações de projeto existentes em
`.github/skills/prumo` também são atualizadas. `COPILOT_HOME` permite uma raiz personalizada
do CLI sem retirar a skill pessoal padrão do VS Code.

O PO First é acrescentado como bloco gerenciado a `copilot-instructions.md` da configuração
do CLI e a `.github/copilot-instructions.md` dos projetos selecionados. Isso atende também
o agente Local do VS Code, preservando as instruções pessoais, modelos e permissões.
Um projeto novo precisa de `prumo install --copilot --project <pasta>` para receber essas regras.

Planeje com `/plan` no CLI ou com o agente Plan no VS Code. Depois da aprovação, saia do modo
de planejamento e invoque `/prumo`. O instalador não cria agentes nem configura autenticação.
Confira a descoberta com `copilot skill list` no CLI ou `/skills` no VS Code.

Fontes oficiais: [skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills),
[CLI e instruções](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference),
[VS Code](https://code.visualstudio.com/docs/agent-customization/agent-skills).

## Antigravity

O Antigravity usa raízes globais de skills diferentes para a superfície 2.0/IDE e para a CLI. O Prumo mantém as duas disponíveis e também aceita a raiz de skill compartilhada do workspace:

| Escopo | Destino do Prumo |
|---|---|
| Antigravity 2.0 ou IDE | `~/.gemini/config/skills/prumo/SKILL.md` |
| CLI do Antigravity (`agy`) | `~/.gemini/antigravity-cli/skills/prumo/SKILL.md` |
| Workspace | `.agents/skills/prumo/SKILL.md` |
| PO First global | `~/.gemini/AGENTS.md` |

Use `/plan` no prompt. Na CLI, `agy --mode=plan` inicia diretamente no modo de planejamento. Depois da aprovação, invoque `/prumo <plano-ou-run>`. Escolha o modelo de raciocínio no seletor sob o prompt; a disponibilidade depende do plano da conta ou organização e pode mudar.

Referências oficiais: [skills e locais](https://antigravity.google/docs/skills/), [comando plan](https://antigravity.google/docs/plan/), [modos de execução](https://www.antigravity.google/docs/cli/modes/) e [modelos](https://antigravity.google/docs/models?app=antigravity).

## OpenCode

O OpenCode descobre skills em raízes de projeto e globais. A integração global padrão fica em `~/.config/opencode`; `OPENCODE_CONFIG_DIR` pode fornecer uma raiz adicional configurada.

| Escopo | Destino do Prumo |
|---|---|
| Skill global | `~/.config/opencode/skills/prumo/SKILL.md` |
| Skill do workspace | `.opencode/skills/prumo/SKILL.md` |
| PO First global | `~/.config/opencode/AGENTS.md` |

Selecione o agente integrado `Plan` antes de pedir o plano aprovado: use `/agents` ou `Shift+Tab` na V2, e `Tab` na V1. Depois da aprovação, saia de Plan e mencione `@prumo` no prompt da V2. A V1 registra as skills descobertas como comandos de barra; nela, use `/prumo`. A ferramenta `skill` é uma chamada interna do agente, não um comando para digitar no prompt. Escolha um modelo com `/models`, ou configure um `provider/model-id` completo somente quando essa escolha for deliberada. O catálogo e a disponibilidade dos provedores não são fixados pelo Prumo.

A instalação usa os diretórios canônicos do OpenCode. A documentação também menciona `.agents/skills` como compatibilidade, mas essa descoberta não apareceu no diagnóstico isolado do OpenCode 1.4.10; não dependa desse caminho para a integração.

No OpenCode, as regras em `AGENTS.md` fornecem instruções do projeto, enquanto arquivos `SKILL.md` fornecem comportamento reutilizável para tarefas. A precedência e as permissões continuam sob controle do OpenCode.

Referências oficiais: [skills](https://opencode.ai/v2/docs/skills), [TUI V2](https://opencode.ai/v2/docs/cli/tui/), [skills V1](https://opencode.ai/docs/skills/), [registro de comandos V1](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/command/index.ts), [rules](https://opencode.ai/docs/rules/), [agentes e Plan](https://opencode.ai/docs/agents/), [modelos e `/models`](https://opencode.ai/docs/models/) e [provedores](https://opencode.ai/docs/providers/).

## Grok Build

O Grok Build usa `.grok/skills` no projeto e uma raiz de skills do usuário. Quando `GROK_HOME` está definido, o Prumo usa esse diretório como raiz do usuário; caso contrário, usa `~/.grok`.

| Escopo | Destino do Prumo |
|---|---|
| Skill global | `$GROK_HOME/skills/prumo/SKILL.md` ou `~/.grok/skills/prumo/SKILL.md` |
| Skill do workspace | `.grok/skills/prumo/SKILL.md` |
| PO First global | `$GROK_HOME/AGENTS.md` ou `~/.grok/AGENTS.md` |

Digite `/plan` ou use `Shift+Tab` para entrar no Plan; revise e aprove o plano antes de editar. Depois da aprovação, invoque `/prumo <plano-ou-run>`. Execute `grok models` para consultar os modelos disponíveis, use `/model <nome>` na TUI ou passe `-m <nome>` em uma execução headless. `grok inspect` mostra a configuração, as regras e as skills descobertas para a pasta atual.

O Grok lê a família `AGENTS.md` enquanto sobe da pasta atual até a raiz do repositório e também descobre skills em `.grok/skills`, na raiz do usuário e nos plugins habilitados. Regras de projeto, permissões e configuração de plugins continuam seguindo a precedência própria do Grok.

Referências oficiais: [visão geral do Grok Build](https://docs.x.ai/build/overview), [skills, plugins e marketplaces](https://docs.x.ai/build/features/skills-plugins-marketplaces), [regras de projeto](https://docs.x.ai/build/features/project-rules), [Plan Mode](https://docs.x.ai/build/features/plan-mode) e [CLI/seleção de modelo](https://docs.x.ai/build/cli/reference).

## Regra operacional compartilhada

Nos três harnesses, escolha o modelo e entre na superfície nativa de planejamento antes de invocar o Prumo. Mantenha o plano aprovado como fonte do escopo. O dashboard mostra a run resultante e as evidências da revisão independente; ele não executa o harness nem muda a escolha de modelo.

## Hermes Agent

Instale com `prumo install --hermes --project <pasta-do-projeto>`. A skill fica no perfil selecionado por `HERMES_HOME`; o padrão é `~/.hermes/skills/prumo` em Linux/macOS e `%LOCALAPPDATA%/hermes/skills/prumo` no Windows. O PO First é acrescentado às instruções prioritárias do projeto, preservando conteúdo pessoal e `SOUL.md`.

Use `/plan`, aprove o plano e invoque `/prumo`. Habilite terminal e delegação. Cada subagente deve receber o contrato e os caminhos do run; após uma interrupção, consulte o estado persistido antes de disparar outra tentativa. A instalação não altera modelos, autenticação, permissões nem a confiança de skills do projeto. Se usar uma skill de projeto, confirme a confiança com `hermes skills trust` por sua decisão.

Fontes oficiais: [skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills/), [contexto do projeto](https://hermes-agent.nousresearch.com/docs/user-guide/features/context-files/) e [delegação](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation/).

## OpenClaw

Instale com `prumo install --openclaw --project <workspace-do-agente>`. A skill compartilhada fica em `<OPENCLAW_STATE_DIR>/skills/prumo`, com padrão `~/.openclaw/skills/prumo`; `OPENCLAW_PROFILE` seleciona o diretório do perfil. O PO First é acrescentado ao `AGENTS.md` do workspace, preservando configurações, personalidade e credenciais.

Sem `--project`, o instalador respeita `OPENCLAW_WORKSPACE_DIR` ou os workspaces declarados em `openclaw.json` no formato JSON. Para configurações JSON5, informe o workspace explicitamente com `--project`. Peça um plano, aprove e invoque `/prumo`; o Prumo não acrescenta um comando nativo de planejamento. Os agentes precisam de execução de comandos e delegação. Em sandbox ou host remoto, Node, o pacote e os arquivos persistidos precisam estar disponíveis no ambiente onde os comandos rodam; o navegador local não acessa automaticamente o localhost de outro computador.

Fontes oficiais: [skills](https://docs.openclaw.ai/tools/skills), [workspace](https://docs.openclaw.ai/concepts/agent-workspace) e [subagentes](https://docs.openclaw.ai/tools/subagents).
