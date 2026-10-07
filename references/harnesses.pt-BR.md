# Guia de integração dos harnesses

O Prumo instala a mesma skill `prumo` e as instruções do PO First em cada harness selecionado. O harness continua responsável por autenticação, permissões, planejamento nativo, escolha do modelo e criação dos agentes. O Prumo não instala um harness, cria uma chave de API, troca o modelo padrão nem cria agentes nativos.

Use primeiro a superfície nativa de planejamento. Revise e aprove o plano; depois carregue a skill do Prumo para transformar o trabalho aprovado em uma run do Prumo. A aprovação do plano nativo e uma run do Prumo são etapas separadas: a primeira registra a intenção aprovada, e a segunda registra discussão, planejamento, execução, revisão e evidências.

## Instalar um destino

O instalador aceita um destino explícito ou todos os destinos detectados:

```sh
prumo install --antigravity
prumo install --opencode
prumo install --grok
prumo install --all
```

Os comandos integram uma instalação local existente. Eles não baixam Antigravity, OpenCode ou Grok Build e não configuram credenciais ou endpoints de provedores. Consulte a [seção de instalação](../README.pt-BR.md#instalação) para detecção, prévia, backups e conflitos.

## Antigravity

O Antigravity usa raízes globais de skills diferentes para a superfície 2.0/IDE e para a CLI. O Prumo mantém as duas disponíveis e também aceita a raiz de skill compartilhada do workspace:

| Escopo | Destino do Prumo |
|---|---|
| Antigravity 2.0 ou IDE | `~/.gemini/config/skills/prumo/SKILL.md` |
| CLI do Antigravity (`agy`) | `~/.gemini/antigravity-cli/skills/prumo/SKILL.md` |
| Workspace | `.agents/skills/prumo/SKILL.md` |
| PO First global | `~/.gemini/AGENTS.md` |

Use `/plan` no prompt. Na CLI, `agy --mode=plan` inicia diretamente no modo de planejamento. Depois da aprovação, invoque `/prumo <plano-ou-run>`. Escolha o modelo de raciocínio no seletor sob o prompt; a disponibilidade depende do plano da conta ou organização e pode mudar.

Referências oficiais: [skills e locais](https://antigravity.google/docs/skills/), [comando plan](https://antigravity.google/docs/plan/), [modos de execução](https://www.antigravity.google/docs/cli/modes/) e [modelos](https://antigravity.google/docs/models).

## OpenCode

O OpenCode descobre skills em raízes de projeto e globais. A integração global padrão fica em `~/.config/opencode`; `OPENCODE_CONFIG_DIR` pode fornecer uma raiz adicional configurada.

| Escopo | Destino do Prumo |
|---|---|
| Skill global | `~/.config/opencode/skills/prumo/SKILL.md` |
| Skill do workspace | `.opencode/skills/prumo/SKILL.md` |
| PO First global | `~/.config/opencode/AGENTS.md` |

Selecione o agente primário integrado `Plan` com `Tab` antes de pedir o plano aprovado. Carregue o Prumo pela ferramenta nativa de skills do OpenCode, por exemplo `skill({ name: "prumo" })`. Escolha um modelo com `/models`, ou configure um `provider/model-id` completo somente quando essa escolha for deliberada. O catálogo e a disponibilidade dos provedores não são fixados pelo Prumo.

A instalação usa os diretórios canônicos do OpenCode. A documentação também menciona `.agents/skills` como compatibilidade, mas essa descoberta não apareceu no diagnóstico isolado do OpenCode 1.4.10; não dependa desse caminho para a integração.

No OpenCode, as regras em `AGENTS.md` fornecem instruções do projeto, enquanto arquivos `SKILL.md` fornecem comportamento reutilizável para tarefas. A precedência e as permissões continuam sob controle do OpenCode.

Referências oficiais: [skills](https://opencode.ai/docs/skills/), [rules](https://opencode.ai/docs/rules/), [agentes e Plan](https://opencode.ai/docs/agents/), [modelos e `/models`](https://opencode.ai/docs/models/) e [provedores](https://opencode.ai/docs/providers/).

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
