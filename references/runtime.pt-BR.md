# Referência do motor Prumo

**Um mestre de obras para o seu grafo de tarefas**: executa um plano aprovado como um DAG — disparando
planejadores e executores em paralelo, recusando concluir qualquer tarefa que um revisor novo não tenha
inspecionado e acompanhando a obra inteira num dashboard ao vivo.

Este arquivo documenta o MECANISMO (schemas, comandos, estados, dashboard). O fluxo de cada etapa está
em [SKILL.md](../SKILL.md) e nas referências de etapa ao lado deste arquivo. [English](runtime.md) · [Instalação](../README.pt-BR.md)

## Conteúdo

- [Integração com o DSH](#integração-com-o-dsh)
- [O que ele faz](#o-que-ele-faz) · [O que é preciso antes de executar](#o-que-é-preciso-antes-de-executar) · [O que deixa um projeto pronto para o grafo](#o-que-deixa-um-projeto-pronto-para-o-grafo)
- [Resultados independentes de domínio](#resultados-independentes-de-domínio) · [Mecanismo versus disciplina](#mecanismo-versus-disciplina) · [Peças](#peças)
- [Formato do plano](#formato-do-plano)
  - [Contrato da tarefa](#contrato-da-tarefa) — campos, validação estruturada, cache, prazos, códigos de saída, `refresh-contract`, `sync-plan`, `show-contract`
  - [Reprovação com alteração aprovada do contrato](#reprovação-com-alteração-aprovada-do-contrato)
  - [Pausa e retomada](#pausa-e-retomada)
  - [Artefato de plano da tarefa](#artefato-de-plano-da-tarefa) — JSON de descoberta, JSON do plano da tarefa, perguntas abertas, digests
  - [Inicialização do dashboard](#inicialização-do-dashboard) · [Estados efetivos](#estados-efetivos)
- [Conduzindo uma execução](#conduzindo-uma-execução) — autorização, passo a passo dos comandos, [referência de comandos](#referência-de-comandos), regras impostas
- [Acompanhamento](#acompanhamento) — [layout](#layout), [navegação](#navegação), [resultados](#resultados)

Instale a CLI global, a skill, o PO First e o serviço de dashboard do usuário; consulte o [guia de instalação](../README.pt-BR.md).

```bash
npm install -g @henri-ralmeida/prumo
```

O `postinstall` global do npm configura os ambientes suportados detectados e inicia o dashboard com sua visão de estado somente leitura.
Uma instalação npm local é inerte. Use `prumo install --all` quando os scripts do npm estavam desabilitados ou para reparar um novo ambiente.
`prumo update` atualiza a CLI, a skill, os dois READMEs, as referências, os scripts e a configuração PO First em
todas as instalações registradas do Claude Code, Kiro, Codex, DSH, Antigravity, OpenCode e Grok Build. Ele compara o conteúdo gerenciado, retoma ativação
pendente e nunca rebaixa uma CLI global mais nova que o `latest` do npm. Um marcador danificado só é recuperado
para seu ambiente/caminho exato registrado e somente a partir de um backup Prumo conferido byte a byte.
Instalação e atualização reiniciam o dashboard quando ele está habilitado, para que sirva a versão instalada, e
preservam a desativação explícita. Elas nunca reiniciam agentes. O dashboard global lê a execução e oferece somente
o controle explícito de cota de agentes confirmado pelo usuário; apenas uma chamada explícita do orquestrador a
`sync-plan` reconcilia um plano aprovado.

### Integração com o DSH

O DSH precisa estar instalado e detectado antes de `prumo install --dsh`; o Prumo nunca instala o pacote externo `@deepseek-ai/dsh`. Um `DSH_HOME` não vazio prevalece; caso contrário, usa-se `~/.dsh`. Os destinos gerenciados são `<DSH_HOME>/skills/prumo` e o bloco PO First no `<DSH_HOME>/AGENTS.md` global. A instalação explícita retorna código diferente de zero sem gravar quando o DSH está ausente; `--all` e `postinstall` atuam apenas nos ambientes detectados, enquanto update pode reparar uma instalação Prumo exata detectada ou registrada.

`prumo install --dsh` integra-se apenas a uma instalação externa do DSH já detectada, e `prumo doctor --dsh` diagnostica essa integração. Ele nunca instala `@deepseek-ai/dsh`; a instalação explícita falha sem gravar quando o DSH está ausente. A versão upstream validada para este adaptador foi `0.1.6-alpha.2`, ainda alpha/prévia para desenvolvedores. O DSH já fornece skills, instruções, subagentes e workflows nos perfis aplicáveis, por isso o Prumo não cria nem edita configuração, perfis, plugins, subagentes, workflows ou credenciais do Cordis. As checagens estruturais de instalação, de doctor e de `dsh --profile headless --dump-config` não comprovam uma conversa real com um modelo.

### Outros harnesses

Use `prumo install --antigravity`, `prumo install --opencode` ou `prumo install --grok` após instalar o harness correspondente. `prumo doctor` aceita a mesma opção. A instalação automática age apenas nos harnesses detectados. O Prumo instala sua skill e acrescenta um bloco PO First gerenciado sem substituir instruções pessoais nem escolher um modelo.

| Harness | Skill Prumo global | Regras PO First globais |
| --- | --- | --- |
| Antigravity IDE / 2.0 | `~/.gemini/config/skills/prumo` | `~/.gemini/AGENTS.md` |
| Antigravity CLI | `~/.gemini/antigravity-cli/skills/prumo` | `~/.gemini/AGENTS.md` |
| OpenCode | `~/.config/opencode/skills/prumo` | `~/.config/opencode/AGENTS.md` |
| Grok Build | `~/.grok/skills/prumo` | `~/.grok/AGENTS.md` |

A instalação do Antigravity atende aos dois diretórios globais de skills. O OpenCode respeita `XDG_CONFIG_HOME` e também recebe a skill em `OPENCODE_CONFIG_DIR/skills` quando configurado; PO First permanece no local das regras globais. O Grok respeita `GROK_HOME`. Skills existentes no projeto só são atualizadas para seu próprio harness registrado; Codex e Antigravity nunca sobrescrevem a instalação gerenciada um do outro em `.agents/skills/prumo`.

Escolha o modo nativo de planejamento quando disponível e carregue a skill Prumo explicitamente. Um modo somente leitura pode impedir a gravação do artefato do plano: obtenha permissão para aquele artefato ou devolva-o ao orquestrador, sem conceder gravação ampla nem iniciar execução. Os gates de discussão, planejamento, execução e revisão independente do Prumo continuam valendo, qualquer que seja o modelo ou modo nativo.

Referências oficiais: [skills do Antigravity](https://antigravity.google/docs/skills/), [regras do Antigravity](https://antigravity.google/docs/rules/), [skills do OpenCode](https://opencode.ai/docs/skills/), [regras do OpenCode](https://opencode.ai/docs/rules/), [skills do Grok](https://docs.x.ai/build/features/skills-plugins-marketplaces), [regras do Grok](https://docs.x.ai/build/features/project-rules).

## O que ele faz

- **Pesquisa antes da execução** — cada alvo ativo da fase recebe um trabalhador somente leitura que
  registra fontes e decisões e escreve seu plano de execução imutável e vinculado separadamente.
- **Uma cota compartilhada de agentes** — discussão, planejamento, execução e revisão usam a mesma
  cota `maxAgents` por execução (padrão 3). A revisão é uma passagem na vaga já ocupada pela tarefa;
  reduzir a cota mantém o trabalho atual vivo e adia somente trabalho novo até a ocupação ficar abaixo do limite.
- **Autor ≠ verificador, imposto** — toda tarefa é validada por um agente revisor NOVO que
  nunca viu o código sendo escrito. `done` recusa uma validação autodeclarada; `review`
  recusa o próprio autor da tarefa. A evidência é registrada por veredito.
- **Planos à prova de colisão** — `init` recusa ciclos de dependência (nomeando o laço) e duas
  tarefas paralelas que declaram caminhos `touches` sobrepostos, antes de qualquer agente começar.
- **Dashboard ao vivo** — um servidor de dashboard em `:4949` desenha a visão de estado somente leitura como raias por fase com
  arestas de dependência animadas, estado por tarefa, novas tentativas e um log de eventos. Encerrá-lo nunca afeta uma execução.
- **Zero dependências de runtime** — Node.js 22+. O estado é JSON simples +
  NDJSON somente de acréscimo num workspace central do Prumo, fora dos repositórios dos projetos.
- **Tokens são gastos apenas por agentes** — o motor e o dashboard são processos Node simples
  que não chamam modelos. Planejadores, executores e revisores (subagentes) são o custo; o
  orquestrador acrescenta uma pequena sobrecarga constante; acompanhar o dashboard não custa nada.

## O que é preciso antes de executar

O escopo global precisa estar aprovado antes da pesquisa das fases e da execução das tarefas:

1. **Um plano aprovado** no formato do motor
   (`$PRUMO_ROOT/.specs/graph/plans/<name>.plan.json` — tarefas,
   dependências, contratos de validação; formato abaixo). De onde ele vem é decisão sua: a lista de tarefas
   de um workflow de spec traduzida mecanicamente, qualquer skill de planejamento que você já use ou
   escrito à mão — um plano não exige nenhuma outra ferramenta. Sem ele, a skill para
   e avisa.
2. **Node.js 22+** (sem dependências de projeto para instalar).
3. **Um agente capaz de disparar subagentes** (por exemplo, Claude Code) para atuar como orquestrador,
   planejadores dedicados, executores e revisores independentes.

Depois de instalar, preencha a seção **"Project overrides"** de [SKILL.md](../SKILL.md) (ou o arquivo de
regras de agente do seu projeto): a etapa de validação por tarefa, a política de commits, a origem do
plano aprovado. O motor nunca muda entre projetos; o que muda é essa seção.

## O que deixa um projeto pronto para o grafo

O motor roda em qualquer lugar; a QUALIDADE do que N executores em paralelo produzem depende do
repositório, porque os executores são agentes novos por desenho — a memória de sessão compartilhada que um agente solo
acumula não existe aqui. **O repositório é a única memória compartilhada dos executores.**

1. **Uma etapa executável** (obrigatória): um comando que responde passou/falhou. Sem ela,
   `validation` é opinião e a etapa do revisor não tem o que impor.
2. **Convenções escritas, impostas quando possível**: um arquivo de regras de agente mais um lint que
   FALHA em violações. Cinco executores sem regras produzem cinco estilos — e o
   revisor confere o contrato da tarefa, não gosto. Texto dentro de cada tarefa funciona, mas não
   escala; uma regra escrita uma vez no repositório alcança todos os executores de graça.
3. **Skills de scaffolding** (criar-um-módulo, criar-um-componente): a diferença entre
   executores convergindo para o padrão da casa e cada um improvisando o seu.

## Resultados independentes de domínio

Categorias de tarefa não selecionam o comportamento do motor. Trabalho com dados, RPA, software e migrações usam o
mesmo ciclo de vida e contrato explícito. Uma checagem funcional verifica o efeito pretendido: ela pode
ler configuração migrada, conciliar dados, inspecionar o resultado de uma automação ou testar o comportamento
da aplicação. Ela não precisa compilar código nem usar um framework de testes. Exemplo: migre registros locais uma vez
e deixe o revisor comparar valores de origem/destino e verificar o consumidor do destino;
não execute a migração de novo apenas para obter evidência de verificação.

A inspeção continua adequada para documentos e outras entregas sem mudança de comportamento
executável. As checagens executáveis usam hoje comandos de shell, então uma checagem apenas por GUI ou por conector
precisa de um método de verificação executável aprovado; o motor não certifica essas ferramentas por conta própria.
Independência de domínio não garante toda integração de ferramenta, ambiente ou método de verificação.

## Mecanismo versus disciplina

O motor é deliberadamente burro: ele guarda o grafo, os estados, as tentativas e o histórico.
Toda decisão — qual agente executa o quê, quando tentar de novo, quando escalar — pertence ao
orquestrador que segue [SKILL.md](../SKILL.md). O restante deste arquivo documenta o MECANISMO;
a skill é a DISCIPLINA. Um não substitui o outro.

## Peças

| Arquivo          | Papel                                                                                                                                                                                                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine.mjs`     | CLI + máquina de estados. O ÚNICO que grava o estado.                                                                                                                                                                                                                                                                                             |
| `serve.mjs`      | Servidor HTTP do dashboard; sua visão de estado é somente leitura e o controle explícito de cota delega ao motor. Encerrá-lo nunca afeta uma execução.                                                                                                                                                                                             |
| `dashboard.html` | Visão ao vivo: DAG disposto em raias por fase (alternável para camadas por profundidade de dependência), arestas de dependência animadas, destaque da linhagem ao passar o mouse, detalhes da tarefa num popover ao lado do nó (passar o mouse por mais tempo espia, clicar fixa; painel lateral = estado da execução + logs apenas), subestado trabalhando/validado por tarefa em execução, pulsação do orquestrador, destaques de eventos, novas tentativas, log de eventos. Além de uma aba **resultados** (`r`) que deriva quanto a execução custou — veja abaixo. |

O estado novo fica em `~/.local/share/prumo/<workspace>/.specs/graph/<run>/`, fora dos repositórios
dos projetos. A instalação migra para lá os dados centrais duráveis do graph-foreman: estado do grafo,
backups salvos do grafo e arquivos de plano ou handoff no topo. Diretórios gerados de execução,
cópias de dependências e saídas de build só são removidos depois de conferir o destino durável.
`PRUMO_HOME` substitui essa base; `GRAPH_FOREMAN_HOME` apenas localiza dados legados para descoberta e migração.
Referências de raiz desatualizadas acompanham um workspace central migrado quando o grafo antigo não existe mais e o novo grafo existe. Defina `PRUMO_ROOT`
(ou o legado `GRAPH_ROOT`) como um workspace existente antes de executar comandos. O armazenamento
`.specs/graph` local de projeto já existente continua utilizável no local; armazenamento novo local de projeto
não é criado. Quando o cwd está dentro de um workspace existente, a raiz pode ser omitida.
Cada execução contém `state.json` (fonte de verdade) e `events.ndjson` (histórico somente de acréscimo);
os planos ficam em `.specs/graph/plans/` do workspace. Node.js 22+, zero dependências de runtime.
`CURRENT` seleciona a execução padrão; passe `--run <name>` em toda chamada quando houver várias execuções. Nomes de execução
aceitam letras, números, ponto, hífen e sublinhado, sem ponto inicial ou separadores de caminho. Escritas usam um
arquivo temporário, uma renomeação e uma trava por execução. A validação libera a trava enquanto seus comandos executam e,
antes de registrar o resultado, confere de novo tentativa, contrato, revisor e estado.

## Formato do plano

```json
{
  "name": "my-feature",
  "scopePolicy": "explicit",
  "maxAgents": 3,
  "phases": [{ "id": "F1", "title": "Server side" }],
  "tasks": [
    {
      "id": "T1",
      "phase": "F1",
      "title": "What this task delivers",
      "label": "Card sync",
      "summary": "Approved card details reach the customer account without a second manual step.",
      "validationSummary": "The account shows the approved card status.",
      "manualEstimate": "4h30",
      "deps": ["T0"],
      "validation": [{ "kind": "functional", "run": "pnpm test:changed", "expect": "the task-specific behavior cases pass" }],
      "writeScope": "files",
      "touches": ["supabase/functions/scenes/"],
      "sharedResources": [{ "id": "service:scenes", "access": "write" }],
      "unavailable": ["database", "manual-inspection"],
      "tags": ["migration"]
    }
  ]
}
```

## Escopo explícito de arquivos e recursos compartilhados

Toda nova tradução de um plano aprovado, de qualquer harness, define `scopePolicy: "explicit"` no plano.
Cada tarefa declara `writeScope: "files"|"read-only"|"unknown"`. `files` exige `touches` não vazio,
baseado na investigação do projeto real, incluindo novos caminhos justificados; nunca invente escopo
para passar na validação. `read-only` proíbe gravar arquivos do projeto e usa `touches`/`writes` do task-plan
vazios ou ausentes; isso não significa que recursos externos sejam somente leitura. `unknown` é aceito na inicialização
e permanece visível no dashboard, mas a execução aguarda uma alteração aprovada do contrato de escopo
por `sync-plan`. Não converta automaticamente escopo ausente ou desconhecido para `read-only` nem edite `state.json`.

Declare `sharedResources: [{ "id": "<id estável do recurso>", "access": "read"|"write" }]` na tarefa.
A mesma tabela, serviço ou ambiente usa o mesmo id estável entre tarefas. Qualquer gravação num id
compartilhado exige encadeamento de dependências; leituras simultâneas são permitidas. Investigue os
efeitos externos além dos arquivos: caminhos diferentes não comprovam independência. Uma exceção aprovada
`--allow-overlap` pode aceitar um grafo com conflitos, mas o motor serializa arquivos/recursos conflitantes;
isso não autoriza gravações paralelas. `writes` do task-plan fica dentro de `touches` para `files` e vazio para `read-only`.

Planos sem a política preservam o comportamento legado. A adoção é uma alteração explícita de contrato por
`sync-plan`, com a renovação aplicável de aprovação/planejamento; preserve o histórico e as escolhas explícitas
dos gates existentes. Discussão → planejamento → execução → revisão independente continua sendo o fluxo,
incluindo as escolhas existentes do usuário de pular discussão ou planejamento. Verificações de escopo
nunca dispensam validações de produção nem a independência da revisão.

A verificação real de escopo em `validate`/`done` compara arquivos visíveis pelo Git à linha de base de `start`; arquivos ignorados e efeitos externos exigem observação independente. Sem Git/linha de base, `validate --ok --scope-evidence "<evidência e limitações>"` exige o revisor independente atual, registra a limitação e não libera gravações observadas sem autorização. Veja [review.md](review.md) para os limites da evidência.

A tentativa registra os escopos de arquivos disjuntos dos executores contemporâneos; um novo executor também acrescenta seu escopo às tentativas anteriores ainda ativas. O Git observa caminhos alterados globalmente, não a autoria. Alterações fora desta tarefa só podem ser desconsideradas se couberem nesses outros escopos registrados e o revisor independente atual fornecer atribuição explícita por `--scope-evidence`. O recibo de escopo registra `excludedPaths` e a limitação de autoria. Alterações observadas fora de todos os escopos autorizados registrados sempre bloqueiam, mesmo com evidência do revisor. `done` exige a mesma impressão da entrega e a identidade do revisor do recibo aprovado; alterações após a validação exigem nova verificação. Arquivos ignorados não são auditados automaticamente: o recibo de escopo sempre expõe essa limitação e o revisor independente precisa conferi-los separadamente, sem obrigatoriedade de `--scope-evidence` somente por haver caminhos ignorados. Git/linha de base indisponíveis, submódulos e ambientes sem Git exigem `--scope-evidence` explícita, assim como a atribuição a outro executor; efeitos em recursos externos precisam de observações próprias. A impressão inclui conservadoramente todas as mudanças visíveis pelo Git: qualquer alteração após validar, inclusive de outro executor, exige nova validação para que a evidência de atribuição não fique obsoleta.

### Contrato da tarefa

Todos os campos que um workflow de planejamento global precisa emitir. A inicialização exige `id`, `title`
e um contrato de validação válido; o planejamento da fase refina a execução de cada tarefa sem enfraquecer essa etapa.

| Campo           | Tipo                          | Padrão    | Significado                                                                                   |
| --------------- | ----------------------------- | --------- | --------------------------------------------------------------------------------------------- |
| `id`            | string                        | obrigatório | ID único da tarefa (`T1`, `T2`…) — referenciado por `deps`                                  |
| `title`         | string                        | obrigatório | O que esta tarefa entrega, em uma linha                                                     |
| `label`         | string                        | —         | Rótulo de negócio opcional: 1–3 palavras, no máximo 24 caracteres; apenas exibição            |
| `summary`       | string                        | —         | Obrigatório para tarefas novas adicionadas por `sync-plan`: 1–2 frases com o resultado esperado e por que ele importa; opcional em tarefas antigas armazenadas; apenas exibição |
| `validationSummary` | string                     | —         | Frase de aceite opcional para visões concisas da tarefa; não substitui `validation`         |
| `manualEstimate` | number \| string            | —         | Estimativa opcional para fazer a tarefa à mão: minutos inteiros (`45`) ou `4h`, `4h30`, `90m`, `45min`, `PT4H30M`; guardada em minutos inteiros; apenas metadado |
| `phase`         | string                        | —         | ID de uma entrada de `phases[]`; agrupa a tarefa no status e nas raias do dashboard           |
| `deps`          | string[]                      | `[]`      | IDs de tarefas que precisam estar `done`/`skipped` antes — o modelo INTEIRO de agendamento    |
| `validation`    | string \| {run, expect, kind, cacheable?, cachePaths?, cwd?, env?, shell?, expectedExitCodes?, timeoutMs?}[]    | `""`      | O que precisa ser VERDADE antes de done. Texto, ou passos estruturados (veja abaixo) |
| `validationMode` | "functional" \| "inspection" | "functional" | Checagens comportamentais exigidas, a menos que seja uma inspeção justificada sem runtime. |
| `inspectionReason` | string | — | Obrigatório para inspeção; explique por que o comportamento em runtime não é afetado. |
| `writeScope` | "files" \| "read-only" \| "unknown" | — | Obrigatório em planos explícitos; posse de arquivos, nenhuma gravação de arquivos ou escopo de execução pendente. |
| `sharedResources` | {id, access: "read" \| "write"}[] | `[]` | Ids estáveis de recursos e acesso; qualquer gravação exige ordenação. |
| `touches`       | string[]                      | `[]`      | Prefixos de caminho que a tarefa grava; `init` recusa tarefas paralelas com caminhos sobrepostos |
| `unavailable`   | resource[]                    | —         | Recursos que esta tarefa não pode usar: `database`, `network`, `credential`, `external-service`, `production-data`, `manual-inspection`; alterá-lo exige planejamento novo; entradas repetidas são gravadas uma vez |
| `tags`          | string[]                      | `[]`      | Rótulos livres (`migration`, `docs`…) — apenas informativos                                   |
| `requireReview` | boolean                       | herdado   | Substituição por tarefa do `requireReview` do plano (por exemplo, `false` para uma tarefa mecânica de docs) |
| `maxAttempts`   | number                        | `3`       | Limite de tentativas por tarefa antes de `retry` exigir escalonamento (`--force` substitui)   |

`unavailable` faz parte do contrato da tarefa, assim como `touches`: mudar o que a tarefa não pode usar muda o que
a validação consegue provar, então o `sync-plan` trata a alteração como mudança de contrato e a tarefa precisa de planejamento atual.
Recursos repetidos são normalizados para uma única entrada, então listar um recurso duas vezes não aparece como divergência.

`label`, `summary`, `validationSummary` e `manualEstimate` são metadados. Alterar apenas esses campos via
`sync-plan` atualiza a apresentação (`metadataUpdated` no evento de sincronização) sem mudar o contrato nem
invalidar o planejamento. `manualEstimate` é uma estimativa humana para a visão de ganhos, nunca uma medição; o
estado a guarda em minutos inteiros, e valores inválidos (zero, negativos, frações ou ilegíveis) são recusados.

Campos no nível do plano: `name` (obrigatório), `description`, `phases[]` (`{id, title}`),
`maxAgents` (inteiro positivo, padrão 3), `requireReview` (true) e `scopePolicy` (opcional; `"explicit"`).
Os campos antigos `maxParallel` e `maxExecutors` podem permanecer como metadados de compatibilidade
em estados migrados; eles não controlam o agendamento. `agentLimitHistory` registra o padrão adotado
pela migração e as mudanças posteriores, com ator e horário.

Textos de exibição precisam estar preenchidos quando informados. Antes de acrescentar uma tarefa por
`sync-plan`, o orquestrador deve preencher seu `summary` com base no escopo aprovado; a sincronização
recusa tarefas novas sem ele e preserva o estado existente. Tarefas antigas sem resumo continuam
compatíveis. Uma atualização apenas de texto via `sync-plan`
não muda o contrato da tarefa nem invalida o planejamento. O dashboard preserva o `title` completo
nos detalhes da tarefa e nos tooltips; mostra `label` onde um nome compacto de tarefa é útil e nunca
gera nem corta um rótulo substituto.

`init` e `sync-plan` avisam quando um prefixo de `touches` não existe no cwd da validação ou no `cwd`
declarado por um passo; o aviso não bloqueia o plano, pois um novo arquivo ou pasta pode ser intencional. Um cwd inacessível
é informado como checagem não realizada.

Mantenha propósito e contexto em `description` ou nos documentos aprovados referenciados. Mantenha os critérios de
aceite atuais e consistentes em `validation[].expect` e as checagens que os comprovam em
`validation[].run`. Critérios substituídos pertencem ao histórico/backups, não a um passo `echo` ativo.
Um comportamento esperado escrito ao lado de um build não transforma compilação em prova comportamental.
Um passo funcional é apenas o mínimo estrutural: o revisor precisa conferir a cobertura de cada
critério funcional vigente. Prepare pré-requisitos antes das checagens dependentes, confirme a execução real dos
testes relevantes contra a entrega atual e preserve artefatos anteriores ao gravar evidências.
Prefira verificação somente leitura dos artefatos entregues quando suficiente; validação não é permissão
para repetir efeitos operacionais nem sobrescrever a entrega.

**Validação estruturada.** Quando o contrato É executável, prefira passos a texto — o
revisor então executa exatamente o que está escrito, em vez de interpretar:

```json
"validation": [
  { "kind": "functional", "run": "pnpm test:changed", "expect": "green, includes the 3 new service cases" },
  { "kind": "static", "run": "pnpm lint && pnpm typecheck", "expect": "clean" }
]
```

O `validationMode` padrão é `functional`: ao menos um passo precisa declarar
`kind: "functional"`. Passos sem tipo contam como `static`, então contratos legados apenas de lint/build/typecheck
não conseguem aprovar uma tarefa funcional. `validate --ok` executa os comandos e guarda
o diretório de trabalho, stdout, stderr, código de saída e qualquer erro de execução. O opcional
`--summary "<veredito do revisor em uma frase>"` guarda um texto conciso ao lado da `--evidence` completa;
quando informado, precisa estar preenchido. Todo passo precisa
retornar um código dentro de seus expectedExitCodes (padrão [0]), sem erro de execução nem sinal. `expect` descreve o comportamento que o revisor precisa conferir; ele não é
interpretado como asserção pelo motor. As checagens precisam afirmar o comportamento real ou o estado resultante
relevante para a tarefa, em vez de apenas repetir o relato de um executor.

Antes de `validate --ok`, inspecione a saída das checagens aprovadas. `show-check <task> --check N --attempt K`
imprime o stdout e o stderr completos armazenados, o diretório de trabalho, o código de saída e o status de reutilização. Uma revisão
nova deve executar e inspecionar cada checagem aprovada antes de registrar seu veredito. `validate` então as executa
de novo e mostra uma prévia de até 15 linhas das checagens funcionais e das que falharam; `--tail 0` suprime a prévia.
Linhas de resumo marcadas identificam apenas texto de saída e não determinam sucesso. Para um novo plano de
inspeção apenas em texto, ou um plano de inspeção com checagens executáveis, percorra cada critério conhecido com
`review-progress` antes de `validate --ok`. Estado de inspeção legado sem denominador mantém o progresso
desconhecido. `review-progress` registra o relato do revisor nomeado; não é prova de que a inspeção
ocorreu nem de que o trabalho passou.

Para documentação ou outra tarefa sem mudança de comportamento em runtime, declare
`validationMode: "inspection"` e um `inspectionReason` não vazio explicando a exceção.
Essa tarefa pode usar validação em texto mais evidência concreta de revisão, ou comandos estáticos.
Não use essa exceção para funcionalidade não testada, ambientes ausentes ou testes que falham.
`requireReview: false` muda quem pode verificar, nunca o que precisa ser verificado.

A validação executável exige um `--cwd <project>` absoluto; um passo pode, em vez disso, declarar seu
próprio `cwd` absoluto para checagens em vários repositórios. Os comandos usam cmd.exe no Windows e /bin/sh
em Unix. O opcional `shell` seleciona um executável de shell instalado; o comando precisa usar a sintaxe
desse shell. Use `env` para variáveis de ambiente portáveis, não prefixos Unix NAME=value
sob cmd.exe. Os valores precisam ser strings; não coloque segredos em planos nem em evidências.
Os passos executam em ordem e param na primeira falha. Um passo `static` pode declarar `cacheable: true`;
durante outra validação na mesma tentativa e no mesmo estado da tarefa, o Prumo reutiliza seu resultado aprovado
somente quando o contrato e o snapshot de Git HEAD/árvore de trabalho não mudaram. Passos funcionais sempre
executam. Sem marcador cacheable explícito, todo passo executa de novo. Um passo estático cacheable também pode
declarar `cachePaths` relativos não vazios. Num retry corretivo com o mesmo contrato e estado da tarefa,
o próximo revisor reutiliza esse passo aprovado quando o conteúdo atual sob esses caminhos corresponde ao seu
recibo e então retoma no primeiro passo que falhou ou mudou. Checagens funcionais e estáticas sem escopo
sempre recomeçam numa nova tentativa.

Cada passo tem prazo padrão de 10 minutos. `timeoutMs` aceita de 0 a 2147483647 milissegundos;
0 desabilita o prazo explicitamente. Escolha um limite adequado antes de uma checagem longa aprovada.
O motor imprime o prazo selecionado antes de executar e o registra junto com o shell.
`expectedExitCodes` aceita um array não vazio de inteiros de 0 a 255, padrão [0]. Para um aviso de negócio
documentado que legitimamente retorna 3, declare [0, 3]; o recibo ainda registra 3.
Não acrescente códigos de falha só para deixar verde um teste que falhou. O texto de `expect` nunca configura códigos.

Exemplo para um script de verificação específico de projeto já existente:

```json
{ "kind": "functional", "run": "node verify.cjs", "env": { "APP_ENV": "Development" },
  "expectedExitCodes": [0, 3], "timeoutMs": 1800000,
  "expect": "assertions pass; exit 3 means only the documented data-quality warning" }
```
Um erro de execução, timeout ou saída acima do limite de buffer de 4 MiB impede a aprovação.
O recibo registra comando, expectativa, categoria, diretório, shell, prazo, códigos esperados, saída, erro,
sinal e código de saída real; saída e evidências mantêm seu idioma original.
Em timeout/estouro de saída, o motor encerra a árvore de comandos no Windows ou o grupo de processos
em Unix. Isso não interrompe comandos iniciados separadamente por um agente executor.
Os comandos têm as permissões de quem chama: inspecione-os e execute apenas checagens aprovadas e seguras.

`--evidence` é obrigatório. Uma revalidação malsucedida ou interrompida invalida a
aprovação anterior. Os testes executam fora da trava curta de estado; os resultados são descartados se a tarefa,
o revisor, a tentativa ou o contrato mudaram durante a execução. `done` exige recibos da tentativa
e do contrato atuais, incluindo um revisor independente quando exigido. Nem `--force`
nem um antigo `--ok` isolado contornam essa etapa. Recibos não autenticam a identidade dos agentes,
não verificam a categoria declarada da checagem nem detectam edições posteriores no código-fonte: o revisor precisa inspecionar
a cobertura, rejeitar execuções com zero testes e revalidar após qualquer mudança de código.

O histórico concluído existente não muda. Planos antigos continuam legíveis, mas a próxima aprovação
deles precisa trazer passos funcionais tipados ou uma exceção de inspeção justificada. Atualize o plano
aprovado pelo workflow existente; não reclassifique tarefas silenciosamente para fazê-las passar.
`skip <task> --reason <text>` exige uma decisão explícita não vazia e é terminal: não pode
reescrever uma tarefa já done/skipped. Se a entrega ou a revisão estiver ativa, o skip encerra essa tentativa
com `result: skipped` e sem recibo de validação inventado.

Para uma mudança aprovada de validação numa execução existente, use
`node $ENGINE refresh-contract <task> --plan <approved-plan.json> --run <run>`.
Apenas validation, validationMode e inspectionReason são atualizados. Estado, agente, revisor,
tentativas, motivo de bloqueio e evidência histórica permanecem intactos. Recibos anteriores ficam desatualizados,
inclusive se um refresh posterior restaurar o texto antigo. A autorização de execução da tarefa é revogada e
preservada no histórico de autorizações sempre que esse contrato muda; aceite uma nova autorização antes de
iniciar ou retomar a execução. Uma validação nova é exigida antes de done.
Tarefas done/skipped não podem ser atualizadas. O comando não dispara trabalho nem desbloqueia tarefas.
Não use fail/retry somente para migrar contrato, não refaça uma correção entregue nem amplie uma janela de
dados porque a skill mudou. O revisor pode verificar o trabalho entregue na mesma tentativa.
No `init`, os identificadores `T*` são `T1`, `T2`, ... sem lacunas ou sufixos.
No `sync-plan`, uma tarefa acrescentada usa a próxima letra da tarefa original: `T9a`, `T9b`, ... `T9z`.
Os números e identificadores já registrados são preservados. A ampliação deve ter um caminho de
dependência até sua tarefa original, em um único sentido. Para uma correção que destrava `T9`,
adicione `T9a` às dependências de `T9`; a correção não pode depender de `T9` ao mesmo tempo.
Se `T9` já está concluída, seu contrato permanece imutável e o complemento `T9a` depende de `T9`.
Identificadores numéricos novos, letras fora de ordem e vínculos ausentes são recusados antes de gravar estado.

`sync-plan` atualiza contratos ativos preservando seu ciclo de vida e mantém contratos concluídos como
histórico imutável. Ele imprime mudanças de campos por tarefa com tamanho limitado, resume contratos de validação sem seu
conteúdo e registra diagnósticos de dependência/motivo de bloqueio em eventos estruturados. Sua linha final é
`run "<run>" synced: +A, updated U, metadata M, preserved P, total T` (em pt-BR:
`execução "<run>" sincronizada: +A, atualizadas U, metadados M, preservadas P, total T`): `metadata M` conta tarefas que tiveram ao menos
um campo de metadados aplicado, como `label`, `summary`, `validationSummary` ou `manualEstimate` (uma tarefa que
também mudou campos do contrato aparece em `updated` também); mudanças de metadados são aplicadas sem invalidar
o planejamento nem a autorização de execução. A sincronização registra a
definição aprovada; não é prova de que o trabalho ativo a atende.

A sincronização também avisa quando invalida uma rodada aberta de discussão/planejamento ou um skip atual; ela
continua aplicando o plano aprovado. `begin-phase-discussion` encerra uma rodada aberta desatualizada da fase como
`superseded`, registra a causa e a imprime, incluindo os campos do contrato que o `sync-plan` alterou. Edite o
plano e rode `sync-plan` antes de `begin-*-discussion`. `status` e `ready` comparam a fonte aprovada aos contratos
persistidos das tarefas e informam os IDs das tarefas e os campos alterados, cada um seguido de "run sync-plan" (em pt-BR, "rode sync-plan"). Uma tarefa nova no
plano aprovado aparece como não sincronizada; uma tarefa ausente dele aparece como ausente, porque
o `sync-plan` recusa remoção de tarefas. Fontes ausentes ou ilegíveis geram um aviso curto
sem bloquear nenhum dos comandos. Uma rodada de planejamento aberta mostra sua idade e a contagem de artefatos aceitos (`0/N`);
um lote registrado mostra `N/N`. Uma rodada que ainda estava aberta quando um `sync-plan` posterior exigiu uma
confirmação de contrato deixa de contar como trabalho em andamento: `status` e `ready` a mostram como
`planning round <id> (<n>) is stale after a contract change; artifacts x/y` (em pt-BR:
`rodada de planejamento <id> (<n>) obsoleta após mudança de contrato; artefatos x/y`). Não espere pelos artefatos dela,
porque `finish-phase-planning`/`finish-planning` os recusariam; comece uma nova rodada de discussão e
confirme o contrato alterado como descrito abaixo. Quando `plan-phase` recebeu `--plan-dir`, a rodada aberta conta os
arquivos `task-plan-<id>.json` já presentes nesse diretório.

Use `show-contract <task> [--diff]` para conferir o contrato de negócio completo antes/depois de aceitar uma
alteração. Ele inclui o texto integral de `expect` e da inspeção, mas omite os comandos executáveis `validation.run`.
Quando uma alteração de contrato reabre uma fase que já teve discussão, rodada de planejamento ou skip atual, a
nova discussão precisa pedir ao usuário que aceite o contrato alterado. Confira cada alvo atual e então inclua
as entradas exatas de tarefa/digest impressas por `begin-phase-discussion` em `questions[].confirmsContract` de uma
pergunta respondida. O motor exige que todos os digests dos alvos correspondam. Um skip não substitui essa
confirmação; depois que a confirmação é registrada, a escolha normal de pular o planejamento continua disponível.

O planejamento por tarefa segue a mesma regra de aceite. Se a sincronização invalidar a discussão atual de uma tarefa,
a rodada de planejamento ou o skip após uma mudança de contrato, `begin-discussion` imprime a entrada atual de tarefa/digest.
Apresente o texto completo de `show-contract <task> --diff` e pergunte ao usuário se ele aceita a mudança. Coloque essa entrada
numa pergunta respondida vinculada à rodada de discussão atual. Resposta de rodada antiga, digest desatualizado ou skip não
satisfaz a confirmação; depois que ela é registrada, o skip normal de planejamento da tarefa continua disponível.

### Reprovação com alteração aprovada do contrato

Um critério realmente não atendido e um pedido de escopo novo são coisas diferentes. Um defeito dentro do
escopo aprovado pode ser corrigido; uma orientação explícita do usuário pode aprovar um critério alterado. Escopo
novo ainda indefinido exige uma decisão, não uma falha de implementação fabricada. Não é obrigatório criar um
script de adaptação: use o editor de plano existente, um backup único e confira o diff e possíveis alterações concorrentes.

Quando a entrega foi realmente reprovada e o contrato aprovado também mudou:

1. Preserve a evidência da revisão e registre `fail <task> --reason <actual-unmet-criterion>`.
2. Edite o plano aprovado, substituindo critérios obsoletos em vez de manter contradições.
3. Rode `sync-plan --plan <approved-plan.json>` enquanto a tarefa está `failed`. Confira a tarefa em
   `graph`: validação, dependências e escopo de escrita precisam corresponder antes de prosseguir.
4. Rode `retry <task>` e depois dispare novo planejamento antes de `start`.

Quando a implementação foi reprovada, mas o contrato e o plano aprovados continuam atuais, registre o motivo
acionável do revisor, rode `retry` e inicie o executor corretivo. O motor registra a origem imutável do plano
em `planSourceAttempt`, a tentativa imediatamente reprovada em `correctionOf` e vincula o motivo à próxima
tentativa. A reutilização exige que todo o contexto de planejamento registrado continue igual, incluindo
revisões do contrato e do planejamento, descoberta canônica, escopo e resultados das dependências. Use
`fail --plan-defect --reason "..."` quando o próprio plano estiver
errado; o retry então exige discussão e novo planejamento. A ausência de motivo do revisor também impede a reutilização.

Antes de qualquer passagem para revisão, o executor em execução continua responsável pelos obstáculos
recuperáveis. Ele inspeciona a falha, faz pesquisa adicional direcionada quando necessário, muda a
estratégia dentro do contrato aprovado, tenta alternativas seguras e repete as verificações relevantes
até acreditar, com base razoável, que o plano completo satisfaz todos os critérios. A revisão é uma etapa
de validação, não uma triagem de falhas. Bloqueio antes da passagem só é adequado por falta de autoridade,
decisão consequencial ainda indefinida, risco destrutivo não autorizado, dependência externa indisponível
após tentativas proporcionais ou impossibilidade comprovada. Essas rotações de estratégia
reutilizam o mesmo plano imutável e nunca disparam outro planejador para o mesmo contrato.

Use o `--run` selecionado em toda chamada. `sync-plan` atualiza o contrato aprovado completo em qualquer
estado não terminal sem mudar ciclo de vida, agentes, tentativas, notas ou evidências. Um escopo ativo alterado
precisa ser bloqueado e replanejado antes da revisão ou conclusão; contratos done/skipped permanecem como histórico imutável.
Se a origem graph-foreman armazenada de uma execução migrada não existir mais, o sync recupera o plano correspondente
no diretório central de planos do Prumo. `retry` não recarrega o plano e recusa uma tarefa
failed cujo contrato registrado difere de sua fonte aprovada, ou cuja decisão global `name`, `description`
ou `requireReview` difere; sincronize e confira antes.
`refresh-contract` só atualiza campos de validação; não registra reprovação. Se nenhuma
implementação foi reprovada e só a verificação precisa ser atualizada, use refresh e revisão na
mesma tentativa. Tarefas concluídas exigem trabalho de acompanhamento explícito, não reescrita do histórico.
Prefira edição estruturada de arquivo. Se um programa temporário for necessário para um plano grande, confira
o backup e o diff exato e remova-o depois; ele não é um comando do motor.

Retome a partir do estado persistido, sem repetir a sequência. Quando `plan-task`/`start`/`review` teve sucesso,
mas o disparo nativo do agente não aconteceu, complete esse disparo na mesma tentativa quando autorizado.
Confirme o identificador real do agente; se o disparo estiver indisponível ou o usuário pausou, bloqueie com o
motivo de orquestração. Não invente outra implementação falha nem afirme que um agente está em execução
apenas pelo rótulo no motor. Registre correções em notas, preservando as tentativas históricas.

### Pausa e retomada

`block` é sempre uma pausa **externa** e guarda a fase atual com `blockKind: "external"`, inclusive
quando contém pergunta ou opções. Bloquear uma tarefa já bloqueada atualiza o motivo e mantém a fase
original. Tarefas concluídas/puladas não podem ser pausadas. Um bloqueio externo remove a tarefa de
`activeTargets` e `queuedTargets` da rodada de fase, registra `originalTargets`/`excludedTargets`, marca-a para
planejamento individual (`individualPlanning: true`) e impede discussão, planejamento, execução, revisão ou
atividade até `unblock`. Comandos diretos para uma tarefa bloqueada falham antes de mutar o estado e informam
`<task> is blocked: ... Use unblock before discussing, planning, reviewing or executing.` Se uma tarefa de fase for desbloqueada
depois da exclusão, ela passa na fase original por `begin-discussion` → `plan-task` → `finish-planning` própria; não retorna
silenciosamente ao lote antigo. Uma tarefa legada `blocked` sem `blockKind` é externa por compatibilidade;
nunca deduza pausa interna pelo texto de `blockReason`.

`pause-replanning <task> --reason <text>` é a pausa interna separada. Só vale para uma tentativa ativa de
tarefa com `planningRequired`, sem pergunta externa, e registra `blockKind: "replan"`. A mesma tentativa
pode executar seu planejamento enquanto está bloqueada; `finish-planning` a mantém bloqueada e um
`unblock` explícito retoma a tentativa. Esse comando nunca transforma uma decisão externa em trabalho de planejamento.

| Comando | Resultado |
| --- | --- |
| `unblock <task>` | Restaura pending/planning/running/reviewing/failed sem acrescentar tentativa. |
| `unblock <task> --reviewer <agent>` | Trabalho running/reviewing pausado vai direto à revisão independente na mesma tentativa aberta. |
| `pause-replanning <task> --reason <text>` | Pausa internamente uma tentativa ativa que exige planejamento para atualizar o plano antes de retomar a mesma tentativa. |

`block --question <text>` guarda a decisão necessária para retomar, e `--option <text>`, repetível,
guarda suas escolhas. Quando uma pergunta foi registrada, `unblock` exige `--answer <text>` e acrescenta
motivo, pergunta, resposta e horário ao histórico de bloqueios. Um bloqueio legado que contém somente motivo
continua podendo usar `unblock <task>`.

A retomada readquire a cota compartilhada `maxAgents` e confere dependências e a disponibilidade do agente ativo.
A revisão direta é uma passagem na mesma vaga ocupada pela tarefa: não é um quarto agente nem uma vaga de
revisão reservada. Nas tarefas que exigem planejamento, `--force` não ignora planejamento, dependências,
capacidade total nem a unicidade de agente simultâneo; ele não fabrica uma tentativa aberta nem uma revisão válida.
Reduzir `maxAgents` nunca encerra agentes atuais; apenas impede novos trabalhadores até a ocupação cair abaixo da cota.
Nenhum comando dispara um agente. Uma retomada recusada mantém intactos o motivo do bloqueio e o histórico.
Retomar trabalho pending ainda exige planejamento atual antes do start, quando obrigatório; trabalho failed ainda exige retry.

Uma tarefa legada bloqueada sem fase registrada volta a pending somente se nunca foi iniciada.
Histórico ausente/inválido em uma tentativa existente é recusado em vez de adivinhado. Inspecione esse
histórico explicitamente. Uma validação em andamento que atravessa uma pausa não pode virar aprovação após a retomada;
um recibo concluído continua sujeito às mesmas verificações de tentativa, revisor e contrato de antes.

Verificações de regressão: `node --test scripts/validation.test.mjs`.

### Artefato de plano da tarefa

Antes de planejar, confira as ferramentas e permissões realmente disponíveis na sessão. Nunca deduza suporte
a subagentes ou gravação de arquivos pelo nome do harness. Se não houver subagente planejador, informe essa limitação
e deixe o orquestrador planejar localmente com pesquisa somente leitura do projeto; essa atuação de planejamento local pode gravar
apenas o artefato de plano da tarefa indicado e não pode implementar o produto.

Cada planejador usa as ferramentas disponíveis para inspecionar regras atuais do projeto, código, artefatos, saídas de dependências
e fontes relevantes. Ele pode gravar somente o arquivo exato task-plan-<id>.json no diretório de artefatos
indicado. Se não puder gravar ali, retorna um objeto JSON completo por alvo em um bloco aberto com ```json, com
o nome exato do arquivo na linha anterior. Nunca abrevie o JSON nem substitua campos por reticências.

O orquestrador interpreta cada bloco JSON retornado, decodifica &gt;, &lt;, &amp; e &quot; somente em valores de texto
do JSON, valida o artefato resultante, grava-o com o nome indicado e então executa
finish-phase-planning ou finish-planning. Se a leitura ou validação falhar, devolva a correção concreta
ao planejador; não invente nem complete localmente o conteúdo ausente do plano. Aplique este protocolo ao planejamento por
fase e por tarefa; omita campos de vínculo exclusivos de fase em um artefato por tarefa.

Tarefas novas, inclusive tarefas acrescentadas por `sync-plan` a execuções antigas, recebem
`discussionRequired: true`, `discoveryRequired: true` e `planningRequired: true`.
Tarefas existentes sem esse marcador mantêm seu ciclo de vida e histórico originais. Não reinicie
trabalho concluído ou ativo 1.2.0/legado na atualização. Metadados de descoberta e do planejador são gerados pelo motor, não
por um campo de dispensa no plano de origem.

O planejamento tem dois níveis. O modo Plan/Spec global define e aprova o grafo e permanece obrigatório.
Em execuções com fases declaradas, discussão e planejamento são etapas opcionais e independentes. Recomende cada
etapa separadamente com base na complexidade observável do escopo, ambiguidade, impacto, dependências e risco, e então aguarde
a escolha explícita do usuário. Registre um skip com `--reason` e `--confirmed-by-user`; execução e
revisão independente continuam obrigatórias. Trabalho corretivo de homologação pode pular uma ou outra etapa somente por escolha
explícita do usuário. Quando escolhidos, a discussão usa a conversa principal visível e o planejamento usa
trabalhadores de planejamento somente leitura, um por alvo ativo. As atribuições
`--agent` são rótulos persistidos, não criação de agente: o orquestrador precisa criar agentes nativos com os
nomes exatos e despachar somente trabalhadores ativos. Os trabalhadores produzem um `task-plan-<id>.json`
imutável e vinculado separadamente para cada tarefa alvo. Uma fase só abre quando todas as dependências
externas de todos os membros não concluídos estão `done` ou `skipped`. Um membro bloqueado externamente é
excluído dos alvos atuais e registrado em `originalTargets`/`excludedTargets`, permitindo que o restante feche
o lote; depois do `unblock`, ele usa o fluxo por tarefa. Dependências internas bloqueiam execução, não planejamento. Fases independentes podem ser discutidas
e planejadas em paralelo quando o usuário as escolhe, independentemente da ordem declarada. Nunca mova tarefas
de fase nem remova dependências para contornar um bloqueio. Uma tarefa existente nomeada explicitamente é um limite rígido de planejamento: pré-requisitos,
lacunas de evidência e entregas internas permanecem em seu único plano de tarefa, e criar tarefas auxiliares ou
planejar irmãs exige aprovação explícita do usuário. Quando o usuário escolhe discutir, a conversa
carrega o contexto global e as saídas conhecidas das dependências, pesquisa a fase e faz ao menos uma pergunta contextual. Ela
usa a interface nativa de perguntas do host quando disponível ou um bloco estruturado em texto na mesma
conversa. Rodadas seguintes continuam até que comportamento, escopo, aceite e execução não tenham
área cinzenta consequencial; ideias fora do escopo são adiadas.

O roteamento das perguntas segue as ferramentas disponíveis na sessão principal, não o nome do harness. O Codex pode
expor `request_user_input_async` fora do Plan; `request_user_input` mantém suas próprias restrições de modo.
O Claude Code documenta [AskUserQuestion](https://code.claude.com/docs/en/tools-reference), enquanto
[integrações SDK](https://code.claude.com/docs/en/agent-sdk/user-input) precisam apresentar a entrada do usuário e
não podem presumir que essa ferramenta esteja disponível em subagentes. O
[catálogo nativo](https://kiro.dev/docs/reference/built-in-tools/) documentado do Kiro não confirma uma ferramenta
equivalente de caixa de perguntas; confira as ferramentas reais antes de escolher a entrada nativa. Seu
[comando /reply](https://kiro.dev/docs/cli/chat/responding/) permite que o usuário responda perguntas do chat ponto
a ponto. No DSH, também confira as ferramentas realmente expostas na sessão principal; não infira
um wrapper de perguntas pelo nome do harness. Caso contrário, apresente O que entendi, Campos cinzentos, Sugestões e Perguntas numeradas no
idioma do usuário. Preserve perguntas pendentes ao trocar de canal e aguarde respostas reais; resultados vazios,
timeouts e sugestões pré-selecionadas nunca encerram a descoberta. Essas são instruções de orquestração, não uma
nova interface fornecida pelo motor.

Depois que o usuário escolhe discutir, o orquestrador executa `begin-phase-discussion F1`; o motor persiste a fase como `discussing` e
emite um `roundId` e um `nonce`. A conversa principal grava a descoberta antes de disparar um planejador. Exemplo:

Antes de continuar uma execução criada por um motor mais antigo, `migrate --check` informa a compatibilidade estrutural.
Todo comando do motor para uma única execução migra automaticamente um estado seguro anterior ao planejamento, grava um backup
versionado, habilita as etapas ausentes e deixa todas as fases pending sem abrir discussão. Tarefas terminais
permanecem inalteradas. Uma tarefa com tentativa legada existente mantém seu ciclo de vida anterior e pode ser retomada, receber retry,
passar por revisão independente e ser concluída sem discussão ou planejamento retroativos. Tarefas novas ou ainda não iniciadas
recebem as etapas atuais e podem avançar quando suas próprias dependências estão concluídas. Somente um
fluxo de planejamento em andamento que não possa ser mapeado com segurança bloqueia a migração, com motivo específico da tarefa.
A migração também adota `maxAgents: 3` quando a execução antiga não tem uma cota compartilhada, preserva
os campos antigos do plano, tarefas e históricos e acrescenta a adoção a `agentLimitHistory`; ela não deduz
uma cota nova de `maxParallel`, `maxExecutors` nem do texto de um bloqueio.
Se o schema já for atual e faltar apenas o limite compartilhado, os comandos usam o padrão 3 sem
reescrever o estado em consultas ou recusas. Grave-o explicitamente com `migrate` ou pelo controle do board.
`sync-plan` pode corrigir contratos aprovados sem reescrever histórico ativo ou terminal.
A mudança de pasta do workspace preserva links de dependências sem percorrer seus destinos; links absolutos internos
acompanham o novo local do workspace, e destinos externos não são alterados.
A skill ainda precisa inspecionar cada contrato não terminal,
normalizar validações obsoletas ou em prosa na fonte aprovada com evidência do repositório e executar `sync-plan`
na execução original. Essa migração de contratos do grafo inteiro não autoriza ampliar o grafo ou o planejamento.
Quando o usuário nomeia uma tarefa existente, mantenha uma discussão e um planejador somente para ela. Nos demais casos, a execução pode
adotar cada fase elegível com `begin-phase-discussion F1 --adopt-legacy`. O histórico terminal permanece
intacto; todo membro não terminal adotado precisa estar antes da execução e não ter discussão nem rodada de planejamento
de tarefa aberta. Uma adoção insegura não altera nada.

```json
{
  "roundId": "<issued-roundId>", "nonce": "<issued-nonce>",
  "research": [{ "source": "src/import.mjs", "findings": "O importador valida antes de gravar." }],
  "questions": [{ "question": "Uma entrada inválida deve rejeitar a importação inteira?", "answer": "Sim; sem gravações parciais.", "channel": "chat-fallback", "round": 1, "roundId": "<issued-roundId>" }],
  "coverage": {
    "problem": "Importações parciais deixam registros inconsistentes.", "affected": "Operadores que importam linhas.",
    "outcome": "Uma entrada inválida não altera nenhum registro armazenado.", "currentBehavior": "A validação já roda antes das gravações.",
    "desiredBehavior": "Preservar a rejeição atômica.", "rules": "Rejeitar a entrada inteira.",
    "exceptions": "Nenhuma aprovada.", "scope": "Somente a validação do importador.", "acceptance": "A verificação de linha inválida passa sem gravações."
  },
  "decisions": [{ "question": "Permitir importação parcial?", "answer": "Não." }],
  "deferred": [],
  "executionBoundary": { "deferredToExecutor": ["T1"], "prematureTaskWork": [] },
  "closure": "O usuário resolveu o comportamento específico da tarefa; não resta área cinzenta consequencial."
}
```

`finish-phase-discussion F1 --context <discovery.json>` exige o recibo atual, pesquisa leve não vazia,
ao menos uma pergunta respondida com rodada positiva e canal `native` ou `chat-fallback`,
todos os nove campos de cobertura PO First, decisões resolvidas, um array de textos `deferred`, um `executionBoundary`
que adie cada tarefa alvo ao seu executor e um motivo de
encerramento. Ele valida tudo antes de persistir atomicamente a descoberta e retornar `ready_to_plan`.
Se `prematureTaskWork` informar que a discussão produziu o resultado de uma tarefa, o encerramento é recusado. Depois que o
orquestrador informa o usuário e recebe aprovação explícita, `--accept-premature-work` registra o incidente;
o planejador trata esse resultado como contexto não confiável e o executor repete o trabalho.
Se a fase foi reaberta após uma mudança sincronizada de contrato, execute antes `show-contract <task> --diff` para
cada alvo, apresente o texto de negócio completo e pergunte ao usuário se ele aceita a mudança. A pergunta respondida da descoberta
deve conter `confirmsContract: [{ "task": "<id>", "digest": "<current-64-character-digest>" }]` para todos os
alvos atuais. Tarefas ausentes, digests antigos e skip de discussão/planejamento não satisfazem a
confirmação.
O motor calcula um digest SHA-256 canônico a partir dos campos persistidos e do recibo da discussão e
o vincula a `plan-phase`. Uma rodada de fase pode ter um trabalhador nativo de planejamento somente leitura por alvo ativo.
Repita `--agent <task>=<agente-nativo>` para todos os alvos, com nomes distintos e exatos, ou informe um
prefixo único para o motor registrar `<prefixo>:<task>`. Essas atribuições são registros, não criação de
agentes: o orquestrador/harness deve criar os agentes nativos exatos e despachar somente `activeTargets`;
`queuedTargets` aguardam uma vaga. Os trabalhadores pesquisam o código e os contratos atuais sem editá-los
e gravam arquivos `task-plan-<id>.json` determinísticos. `plan-phase` imprime um trecho JSON copiável para cada
alvo ativo, lido da rodada de planejamento persistida; copie `phaseBinding` e `unresolvedInputs` daquela tarefa sem alterações
para seu artefato. `discussionRoundId` é o `roundId` da discussão ou o `decisionId` confirmado pelo usuário quando
a discussão foi pulada. Mantenha `plannerRound` como impresso; nunca o renumere. Repetir `plan-phase` na mesma
rodada aberta preserva as atribuições e ativa a próxima onda quando houver vaga.
`finish-phase-discussion --context <discovery.json>` valida a descoberta somente para a onda ativa, acumula
as descobertas e abre a onda seguinte até cobrir os alvos. `finish-phase-planning --plan-dir <directory>`
valida apenas a onda ativa, deixa seus planos em staging e abre a próxima; somente a última onda grava todos
os `taskPlan` atomicamente. Cada artefato inclui `phaseBinding` e lista as dependências diretas ainda incompletas
em `unresolvedInputs`, com tarefa produtora, fase e evidência exigida. Uma nova incerteza material volta à
descoberta principal e a um novo planejamento.
Somente o orquestrador registra transições do motor. Veja [o fluxo](discussion.pt-BR.md#dois-níveis-de-planejamento).

Exemplo para uma tarefa com uma verificação de validação executável:

```json
{
  "summary": "Reutilizar o limite de validação existente para rejeitar linhas malformadas antes de qualquer gravação.",
  "research": [{ "source": "src/import.mjs", "findings": "O importador atual valida cada linha antes de gravar; reutilizar esse limite." }],
  "decisions": [{ "question": "Como tratar linhas inválidas?", "answer": "O contrato aprovado exige rejeição sem gravações parciais." }],
  "steps": ["Ampliar a validação existente do importador.", "Adicionar o cenário de linha inválida que falta à verificação comportamental existente."],
  "verification": [{ "criterion": "Uma linha inválida produz o erro aprovado e deixa os registros armazenados inalterados.", "check": 1, "requires": ["database"] }],
  "writes": ["src/import.mjs", "test/import.test.mjs"],
  "openQuestions": [],
  "phaseBinding": { "phaseId": "F1", "discussionRoundId": "<roundId-or-skip-decisionId>", "plannerRound": 1 },
  "unresolvedInputs": [{ "task": "T2", "phase": "F2", "requiredEvidence": "current terminal receipt for T2" }]
}
```

Cada plano de tarefa pode incluir um `summary` não vazio de 1–2 frases sobre o caminho escolhido e
por que ele se aplica. Cada artefato de tarefa de fase exige `research` (`source`, `findings`),
`steps` (textos) e `verification` (`criterion`, `check`) não vazios. Cada item de verificação pode acrescentar
`requires`, uma lista com o mesmo vocabulário fechado de recursos de `unavailable` da tarefa. Quando um recurso
exigido também está indisponível, o fechamento do planejamento avisa com a tarefa, o índice da verificação e o recurso;
o aviso não rejeita o plano. A inspeção manual aparece como pendente no status e no dashboard
até que o revisor independente atual registre uma inspeção aprovada; nenhum nome de harness implica capacidade.
`writes` é uma lista opcional de caminhos relativos seguros de arquivos ou pastas. Quando presente junto de `touches` da tarefa,
cada gravação precisa caber em um prefixo declarado por segmento de caminho; separadores e `./` são normalizados, e a caixa é
ignorada somente no Windows. `writes` ausente ou vazio gera aviso, mas continua válido para planos de tarefa antigos.
Cada entrada do array
`validation` da tarefa precisa estar mapeada pelo seu **índice numérico a partir de 1**; `verification.check` não
indexa `taskPlan.steps`. Use `"inspection"` somente para um contrato aprovado de inspeção
em texto. `decisions` é um array de pares `question`/`answer` resolvidos; pode estar
vazio. Entradas de `openQuestions` contêm `question`, `blocking` booleano, `answer` opcional e
`decideBy` opcional: `"executor"` (padrão), `"user-now"`, `{ "beforeTask": "T2" }` ou
`{ "beforePhase": "F2" }`. Uma pergunta bloqueante continua exigindo resposta antes de o planejamento
terminar e é tratada como devida agora. Uma pergunta não bloqueante sem resposta e com prazo futuro
não segura sua tarefa de origem; ela aparece quando a tarefa ou fase indicada começa e só vira etapa
de execução nesse momento. `status` informa perguntas programadas e vencidas. Use a
referência de pergunta exibida em uma decisão resolvida posterior, por exemplo
`{ "question": "Qual protocolo?", "answer": "Use o cliente existente.", "resolvesQuestion": "T1:plan:abc123" }`.
No modo de planejamento por tarefa, o prazo `{ "beforePhase": "F2" }` vence quando qualquer tarefa de F2 inicia
discussão ou planejamento. Depois de gravar um plano, `finish-phase-planning` e `finish-planning` imprimem as
perguntas para o usuário agora (com a resposta proposta, se houver) e as de prazo futuro, e avisam quando uma
pergunta `"executor"` explícita não tem `answer` proposto. Somente as perguntas `user-now` vão ao usuário antes da
execução.
Nunca invente uma resposta nem rebaixe uma incerteza consequencial para passar nesta verificação.

O motor guarda cada `taskPlan`, os metadados de planejador/tempo/contexto e o histórico imutável de planejamento, e então
devolve o trabalho comum a pending com estado efetivo `ready`. Ele verifica a estrutura e o frescor
registrado, não a veracidade das fontes nem a identidade do agente. O executor precisa ler e reconferir o artefato;
o revisor independente novo julga a entrega contra os objetivos aprovados/critérios atuais
e pode reprovar um planejamento falho. O planejamento não substitui uma etapa comportamental.

Todo `taskPlan` armazenado tem um `digest` SHA-256 do seu conteúdo canônico de execução, excluindo
resumos só de apresentação, horários de registro e metadados de planejador/contexto. `start` grava o digest completo em `attempts[].planDigest`;
status e o evento `task_start` exibem seus quatro primeiros caracteres. Essa identidade é distinta de
`inputDigest`, que continua identificando recibos de dependências. Execuções antigas sem nenhum dos dois digests de plano
continuam legíveis e podem iniciar normalmente.

Planos de fase calculam o hash dos contratos da tarefa e das dependências sem o estado mutável das entregas. Uma mudança de contrato invalida
aquela tarefa e os escopos de contrato realmente dependentes; descoberta compartilhada da fase invalida os planos de fase não terminais
afetados; `--plan-defect` invalida somente aquela tarefa. Achados comuns e conclusão de dependência não replanejam.
No `start`, dependências diretas precisam estar terminais: `done` fornece seu recibo de validação aprovado atual e
`skipped` fornece uma dispensa explícita vinculada ao seu motivo. Revisão, validação e conclusão rejeitam um recibo de entrada
alterado. Se o escopo de execução mudar durante running/reviewing, use
`pause-replanning` na tentativa ativa que exige planejamento, sincronize a mudança aprovada e então dispare
`plan-task` na tarefa pausada internamente. `finish-planning` devolve a tarefa a **blocked**, preservando a
fase original, o motivo e a tentativa de execução aberta; somente `unblock` explícito a retoma. Um `block`
externo comum precisa de `unblock` antes de qualquer comando de planejamento. Não invente fail/retry para
atualizar o planejamento. `refresh-contract` somente de validação continua possível dentro da mesma tentativa
e exige nova validação. Recibos do escopo de planejamento antigo não aprovam o novo escopo.

Execuções persistidas no modo por tarefa continuam usando `begin-discussion`, `finish-discussion`, `plan-task` e
`finish-planning`, com a semântica existente de dependências prontas.

### Inicialização do dashboard

`prumo dashboard enable` inicia o servidor de dashboard imediatamente e registra a inicialização para o usuário atual.
No Windows, o Prumo tenta primeiro a tarefa ONLOGON `Prumo Dashboard` no Agendador de Tarefas. Se o Windows recusar ou
não conseguir criar essa tarefa, uma única entrada oculta gerenciada pelo Prumo é criada automaticamente na pasta
Inicializar do usuário atual, sem pedir acesso de administrador. O mecanismo escolhido persiste em consultas,
reinícios, atualizações e reinstalações. `prumo dashboard status` o informa, e `prumo dashboard disable` remove
somente esse registro e encerra apenas um processo cujo comando absoluto completo do Node e do servidor foi comprovado.
Um processo alheio escutando na porta 4949 nunca é encerrado.

O dashboard expõe `agentUsage.used`, a cota compartilhada `agentUsage.maxAgents` e um
`agentControlToken` por processo em `GET /api/state`. Seu controle local na mesma origem envia
`POST /api/agent-limit` com `Content-Type: application/json` e JSON `{ "maxAgents": N }`; ele precisa usar a
origem loopback exata e o token `x-prumo-control` dessa resposta. O servidor rejeita qualquer outro método,
origem, token, tipo de conteúdo, corpo malformado ou grande demais e cota não inteira antes de gravar; o
root/run selecionado precisa pertencer ao catálogo descoberto, então parâmetros da URL não autorizam caminho
arbitrário. Requisições válidas delegam `set-agent-limit --max N --actor dashboard-user --confirmed-by-user`
e registram ator e horário em `agentLimitHistory`. A nova cota vale na próxima operação do motor. Reduzi-la
nunca encerra agentes ativos; apenas impede novo despacho até a ocupação ficar abaixo do limite.

### Estados efetivos

`pending` é persistido na tarefa; a prontidão da tarefa é calculada a partir do planejamento atual e das dependências.
Antes de uma tarefa ter um plano de fase atual, qualquer dependência externa não concluída de qualquer membro não concluído
bloqueia a discussão e o planejamento da fase inteira. Dependências internas só bloqueiam a execução.
Depois do planejamento, entradas incompletas da tarefa produzem `waiting`. Fases bloqueadas incluem
`planningBlockedBy` com os IDs das fases das dependências externas (ou IDs de tarefas para dependências sem fase/ausentes).
O fluxo da fase persiste `ready_for_discussion`, `discussing`, `ready_to_plan` e `planning`
independentemente, então discussão e planejamento podem estar ativos enquanto um card continua `waiting` pelas próprias entradas.

| Estado efetivo | Significado | Cor no dashboard |
| --- | --- | --- |
| `waiting` | Dependências incompletas | Cinza |
| `ready_for_discussion` | A fase precisa de descoberta atual; não exige dependências concluídas | Violeta |
| `discussing` | A discussão persistida da fase está ativa na conversa principal | Violeta |
| `ready_to_plan` | A discussão persistida da fase terminou; seu planejador pode começar antes das dependências | Azul |
| `planning` | Trabalhadores somente leitura atribuídos à fase compõem planos; alvos enfileirados não são despachados | Rosa |
| `ready` | Pronto para executar com um plano atual, ou prontidão legada original | Verde-azulado |
| `running` | Executor trabalhando | Âmbar |
| `reviewing` | Revisor independente trabalhando | Ciano |
| `done` | Entrega aceita | Verde |
| `failed` | Tentativa reprovada | Vermelho |
| `blocked` | Pausado aguardando uma decisão ou outro impedimento | Roxo |
| `skipped` | Pulado explicitamente | Cinza |

**Ajuste do paralelismo.** `maxAgents` (padrão 3) é a única cota compartilhada para trabalhadores ativos
de discussão, planejamento, execução e revisão. `maxParallel` e `maxExecutors` de um estado antigo são
somente metadados e não criam uma segunda cota. Reduzir `maxAgents` nunca encerra trabalho atual; impede
novos trabalhadores até a quantidade ativa ficar abaixo do limite. A revisão é uma passagem na mesma vaga
da tarefa, portanto não reserva uma quarta vaga nem exige capacidade separada. Alvos de fase além da onda
ativa permanecem enfileirados e não ocupam a cota.

`deps` ordena a execução. Discussão e planejamento da fase podem terminar antes das dependências, mas uma tarefa só fica
**pronta para executar** com um plano imutável atual e toda dependência `done` ou `skipped`.
A serialização é expressa como uma cadeia de dependências, não como lógica do motor.

Uma tarefa é **isolada no espaço, ordenada no tempo**: ela nunca pode compartilhar um arquivo com uma tarefa que
possa rodar ao seu lado (é isso que `touches` verifica), enquanto depender de tarefas anteriores é
justamente o objetivo — um agente constrói sobre o que suas dependências produziram.

## Conduzindo uma execução

As frações dos eventos mostram o passo ativo do executor em `taskPlan.steps`, informado por `progress`,
e o check de validação atual na revisão. Iniciar uma tentativa planejada emite `[1/total]`; novas tentativas
reiniciam esse índice. A validação emite automaticamente eventos de check iniciado, aprovado, falho e reutilizado.
A fração indica posição, não aprovação nem checks concluídos. Eventos legados sem total conhecido
não mostram fração. A legenda segue o ciclo de vida: o marcador vazado de discussão reflete o estado persistido
`discussing` do motor e a conversa principal visível do orquestrador; não é um agente separado.

`start` imprime a linha `progress` pronta na sintaxe do shell que executou `start`: aspas POSIX quando
`MSYSTEM` ou `SHELL` está definido (Git Bash, MSYS2, qualquer shell fora do Windows); caso contrário, sintaxe
PowerShell com o operador de chamada `&`. Cole-a num shell do mesmo tipo. Quando o shell do executor for diferente
do que executou `start`, adapte somente as aspas e o operador de chamada; mantenha inalterados os caminhos, a tarefa
e os valores de `--step`, `--agent` e `--run`.

A execução exige uma autorização do usuário salva depois que o grafo aprovado estiver no lugar. Pergunte se o
escopo é a execução atual, uma fase ou tarefas escolhidas, e se o despacho deve continuar
automaticamente dentro desse escopo ou aguardar um comando do usuário a cada vez. Registre somente uma autorização
que o usuário aceitou:

```bash
node $ENGINE authorize --scope run --mode auto --confirmed-by-user
node $ENGINE authorize --scope phase:F2 --mode manual --confirmed-by-user
node $ENGINE authorize --scope tasks:T4,T5 --confirmed-by-user  # auto é o padrão
```

`authorize` guarda o escopo, o modo, a data e o canal aceitos; não inicia tarefas nem cria
agentes. `ready` e `status` mostram a autorização de cada tarefa, as vagas de execução livres e uma
ação sugerida. Uma execução sem nenhum escopo registrado mantém o comportamento anterior: `start` funciona e avisa que
não há escopo registrado. Depois que algum escopo existir, `start` recusa tarefas fora dele. No modo auto, continue
preenchendo vagas livres com tarefas autorizadas prontas depois de revisão ou conclusão; quando `review` ou `done` abrir
vaga para trabalho autorizado pronto, o motor imprime os próximos comandos `start` e grava o evento `slot_freed`
(`freedBy`, `cause`, `slots`, `next`). No modo manual, pergunte antes de cada despacho. Uma tarefa cujo contrato muda em
`sync-plan` ou `refresh-contract` perde a autorização até que o usuário aceite essa tarefa novamente. Uma decisão global
alterada do plano exige novo aceite das tarefas não terminais afetadas; tentativas já em andamento continuam no estado
registrado. No modo manual, exija `--confirmed-by-user` em cada `start`, `review` e `retry`, e quando
`unblock` retomar uma tentativa ativa. O motor registra a confirmação, o ID da autorização, a data e o
canal no evento da tarefa e na lista ordenada `manualConfirmations[]` daquela tentativa. Os campos singulares antigos
de confirmação continuam mostrando o valor mais recente por compatibilidade. O modo auto não exige confirmação repetida.

```bash
node $ENGINE start T4 --agent <executor> --confirmed-by-user  # somente manual
node $ENGINE review T4 --agent <reviewer> --confirmed-by-user # somente manual
node $ENGINE retry T4 --confirmed-by-user                     # somente manual
node $ENGINE unblock T4 --confirmed-by-user                   # retoma trabalho ativo
```

Quando `done`, `skip` ou `sync-plan` torna uma fase recém-elegível para discussão, o motor registra
`phase_eligible` com a fase, os IDs das tarefas e a causa, e imprime uma sugestão. Informe ao usuário qual
fase está pronta e recomende `begin-phase-discussion <phase>`; aguarde a escolha do usuário antes de
abri-la. A elegibilidade sozinha nunca abre uma fase.

```bash
PRUMO_HOME="${PRUMO_HOME:-$HOME/.local/share/prumo}"
PRUMO_ROOT="$PRUMO_HOME/my-workspace"
mkdir -p "$PRUMO_ROOT/.specs/graph/plans" && export PRUMO_ROOT
node .claude/skills/prumo/scripts/engine.mjs init --plan "$PRUMO_ROOT/.specs/graph/plans/x.plan.json" --run x-01
node .claude/skills/prumo/scripts/engine.mjs migrate --check          # relatório de compatibilidade somente leitura
node .claude/skills/prumo/scripts/engine.mjs ready                 # o que pode começar agora
node .claude/skills/prumo/scripts/engine.mjs begin-phase-discussion F1 --agent T1=disc-f1-t1 --agent T2=disc-f1-t2 # nomes nativos exatos
node .claude/skills/prumo/scripts/engine.mjs skip-phase-discussion F1 --reason "The approved contract is clear" --confirmed-by-user # após escolha explícita do usuário
node .claude/skills/prumo/scripts/engine.mjs finish-phase-discussion F1 --context <discovery.json>
node .claude/skills/prumo/scripts/engine.mjs plan-phase F1 --agent T1=plan-f1-t1 --agent T2=plan-f1-t2 --plan-dir <artifact-dir>  # diretório opcional
# Um prefixo, por exemplo --agent plan-f1, registra plan-f1:T1, plan-f1:T2 e assim por diante.
node .claude/skills/prumo/scripts/engine.mjs skip-phase-planning F1 --reason "The global contract is sufficient" --confirmed-by-user # após escolha explícita do usuário
node .claude/skills/prumo/scripts/engine.mjs finish-phase-planning F1 --plan-dir <artifact-directory>
node .claude/skills/prumo/scripts/engine.mjs start T1 --agent ag-server      # cota maxAgents compartilhada
node .claude/skills/prumo/scripts/engine.mjs progress T1 --step 2 --agent ag-server  # relato real do executor
node .claude/skills/prumo/scripts/engine.mjs review T1 --agent rev-server    # entrega a um revisor novo
node .claude/skills/prumo/scripts/engine.mjs review-progress T1 --step 1 --agent rev-server # depois de inspecionar o check 1
node .claude/skills/prumo/scripts/engine.mjs show-check T1 --check 1 --attempt 1 # saída completa armazenada
node .claude/skills/prumo/scripts/engine.mjs validate T1 --ok --summary "The import rejects invalid rows before writing." --evidence "reviewed all 3 behavior cases" --cwd <absolute-project> --tail 15
node .claude/skills/prumo/scripts/engine.mjs done T1               # recusa sem uma validação aprovada
node .claude/skills/prumo/scripts/engine.mjs fail T2 --reason "typecheck broke"
node .claude/skills/prumo/scripts/engine.mjs retry T2              # avisa depois de 3 tentativas
node .claude/skills/prumo/scripts/engine.mjs block T9 --reason "needs dev decision" --question "Which policy applies?" --option "Keep current" --option "Adopt proposed"
node .claude/skills/prumo/scripts/engine.mjs unblock T9 --answer "Keep current"
node .claude/skills/prumo/scripts/engine.mjs pause-replanning T9 --reason "approved contract changed during the active attempt"
node .claude/skills/prumo/scripts/engine.mjs set-agent-limit --max 3 --actor dashboard-user --confirmed-by-user
node .claude/skills/prumo/scripts/engine.mjs status | graph        # tabela legível | JSON completo
node .claude/skills/prumo/scripts/engine.mjs status --verify-install # também compara os arquivos instalados com o marcador
```

A primeira linha do `status` identifica o código em execução: `Prumo <version> (<contentId>) — <harness>`, lidos
do marcador de instalação ao lado de `scripts/`. Uma cópia de código-fonte informa o identificador calculado e nenhum
harness. Um marcador antigo sem `contentId` pede `prumo update`. Quando o `engine.mjs` em execução difere do
`engineHash` do marcador, o `status` avisa sem bloquear; `status --verify-install` recalcula o identificador
de conteúdo dos arquivos instalados. `prumo status --verify-install` confere todas as instalações registradas.

### Referência de comandos

Resolva `scripts/engine.mjs` a partir da skill instalada. Acrescente `--run <name>` para selecionar uma execução.

| Comando após `node <ENGINE>` | Efeito |
|---|---|
| `init --plan <file> --run <name> [--cwd <projeto>]` | Inicializa uma execução do plano aprovado e registra a pasta do projeto para os avisos de touches |
| `migrate [--check]` | Migra com backup um schema legado seguro; `--check` apenas diagnostica |
| `status`, `ready`, `graph`, `runs` | Estado, trabalho pronto agora, JSON completo ou a lista de execuções |
| `status --verify-install` | Também compara os arquivos instalados com o marcador de instalação |
| `authorize --scope run\|phase:<phase>\|tasks:<T1,T2> [--mode auto\|manual] [--channel <name>] --confirmed-by-user` | Registra o escopo e o modo de despacho aceitos pelo usuário; `auto` é o padrão |
| `show-contract <task> [--diff]` | Exibe o contrato de negócio antes/depois sem os comandos `validation.run` |
| `show-check <task> --check <N> --attempt <K>` | Exibe stdout, stderr, diretório, código de saída e status de reutilização do check armazenado |
| `begin-phase-discussion <phase> [--agent <task>=<name>]... [--adopt-legacy]` | Persiste a discussão e as atribuições exatas de trabalhadores por alvo; um nome sem tarefa expande para `<name>:<task>` |
| `skip-phase-discussion <phase> --reason <text> --confirmed-by-user` | Registra a escolha explícita de pular a discussão da fase |
| `finish-phase-discussion <phase> --context <discovery.json> [--accept-premature-work]` | Valida a descoberta da onda ativa, acumula-a e abre a próxima quando necessário |
| `plan-phase <phase> --agent <task>=<name>... [--plan-dir <directory>]` | Registra trabalhadores distintos por alvo; somente alvos ativos são despachados e o diretório opcional permite contar artefatos |
| `skip-phase-planning <phase> --reason <text> --confirmed-by-user` | Registra a escolha explícita de pular o planejamento da fase após a decisão de discussão |
| `finish-phase-planning <phase> --plan-dir <directory>` | Valida e faz staging da onda ativa, abre a próxima e grava todos os planos atomicamente na onda final |
| `begin-discussion <task> [--adopt-legacy]` | Persiste uma discussão de tarefa ativa; a opção adota somente uma tarefa legada elegível |
| `skip-discussion <task> --reason <text> --confirmed-by-user` | Registra a escolha explícita de pular a discussão da tarefa |
| `finish-discussion <task> --context <discovery.json>` | Valida as respostas da rodada atual e libera o planejamento |
| `plan-task <task> --agent <name> [--context <file>] [--accept-premature-work]` | Registra o planejador após a discussão fechada |
| `skip-planning <task> --reason <text> --confirmed-by-user` | Registra a escolha explícita de pular o planejamento da tarefa |
| `finish-planning <task> --plan <artifact.json>` | Confere e registra o plano da tarefa; libera a execução se não houver pausa preservada |
| `set-agent-limit --max <N> --actor <name> --confirmed-by-user` | Registra a cota compartilhada aprovada pelo usuário e o ator/horário em `agentLimitHistory` |
| `start <task> --agent <name>` | Registra o executor e abre uma tentativa (`--executor` é um alias) |
| `activity-start <id> --scope task\|phase --role discussion\|planning\|execution\|review --agent <name>` | Inicia um intervalo de trabalho real na rodada ativa; worker de fase usa o ID exato da tarefa e o nome exato do worker atribuído, ou o ID exato da fase e esse mesmo nome |
| `activity-stop <id> --scope task\|phase --role discussion\|planning\|execution\|review --agent <name>` | Encerra o intervalo antes de aguardar, pausar ou terminar; usa o mesmo ID exato e worker atribuído, e ao retomar começa outro `activity-start` |
| `progress <task> --step <index> --agent <executor>` | Registra o passo atual do plano durante a execução, começando em 1 |
| `review <task> --agent <name>` | Encaminha o trabalho para revisão |
| `review-progress <task> --step <index> --agent <reviewer>` | Registra os critérios percorridos na revisão, em ordem |
| `validate <task> --ok --summary <sentence> --evidence <text> --cwd <directory> [--tail <lines>]` | Executa o contrato, guarda o resumo curto e a evidência completa e mostra até 15 linhas; falha real impede a aprovação |
| `validate <task> --failed --summary <sentence> --evidence <text>` | Registra uma reprovação com resumo opcional e evidência completa |
| `done <task>` | Conclui com evidência válida da tentativa e do revisor atuais |
| `fail <task> --reason <text> [--plan-defect]` | Registra uma falha real da tentativa; `--plan-defect` marca o próprio plano como errado |
| `retry <task>` | Volta de failed para pending; reutiliza o plano atual somente em correção limitada com contexto inalterado e motivo de revisão válido |
| `block <task> --reason <text> [--question <text>] [--option <text>...]` | Pausa preservando a fase anterior e, quando informada, a decisão necessária para retomar |
| `pause-replanning <task> --reason <text>` | Pausa internamente uma tentativa ativa que exige planejamento para atualizar o plano antes de retomar a mesma tentativa |
| `unblock <task> [--answer <text>]` | Restaura a fase anterior; registra pergunta e resposta no histórico quando houver decisão |
| `unblock <task> --reviewer <name>` | Leva uma tentativa ativa pausada diretamente à revisão |
| `skip <task> --reason <text>` | Pula uma vez por decisão explícita não vazia; uma tentativa ativa termina como skipped sem inventar recibo |
| `note <task> --text <text>` | Acrescenta uma nota ao histórico |
| `refresh-contract <task> --plan <approved-file>` | Atualiza somente validation, validationMode e inspectionReason |
| `sync-plan --plan <approved-file> [--cwd <projeto>]` | Acrescenta tarefas e reconcilia as alterações permitidas; usa a pasta registrada do projeto, salvo substituição explícita |

`--force` nunca aprova lint como prova funcional nem conclui com recibo inválido ou
autorrevisão. Exceções explícitas de agendamento (`--allow-overlap`) e a substituição de uma execução inicial exigem a
autorização pertinente.

Regras que o motor impõe (todo o resto é julgamento do orquestrador):

- `init` recusa um plano com ciclo de dependência, nomeando o laço (`T1 → T2 → T1`). Sem
  isso, a execução seria inicializada normalmente e travaria em silêncio — cada tarefa do ciclo esperando
  as outras para sempre, e `ready` nunca as listaria. IDs duplicados e dependências desconhecidas também
  são recusados.

- Discussão e planejamento da fase não exigem dependências de tarefa concluídas. `start` exige: ele requer
  um plano atual por tarefa e vincula os recibos atuais, validados ou explicitamente dispensados, das dependências diretas.
  `--force` não contorna o planejamento nem esses recibos.
- `start` e cada novo trabalhador de discussão/planejamento recusam quando a ocupação ativa alcança a cota
  compartilhada `maxAgents` (padrão **3**). `review` é uma passagem na vaga já ocupada pela tarefa, sem
  reservar um quarto agente ou uma cota separada de revisão. Reduzir a cota mantém o trabalho atual e espera
  a ocupação cair antes de abrir trabalho novo; alvos de fase em `queuedTargets` não contam.
- Planejamento, execução e revisão recusam um agente já ocupado em outra tarefa: **um agente, uma tarefa**. Um rótulo
  em duas tarefas simultâneas significa um despacho com rótulo errado ou um único agente fazendo as duas — e
  então o paralelismo é uma ficção que o grafo registraria alegremente como real.
- `review` recusa um revisor que foi autor da tarefa, e `done` recusa uma validação registrada
  pelo executor em vez de um revisor (`"requireReview": false` no plano desativa isso).
  **Autor ≠ verificador** é o ponto: um autorrelato não é um veredito.
- `init` recusa um plano em que duas tarefas que podem rodar em paralelo declaram caminhos `touches`
  sobrepostos — o mesmo arquivo entregue a dois agentes ao mesmo tempo. Em planos legados, `touches` é opcional (prefixos, não
  globs); um plano que o omite recorre à cadeia de dependências como única proteção. Contorne com
  `--allow-overlap`, que NÃO é o que `--force` faz (este apenas sobrescreve uma execução existente).
- `done` recusa sem uma **validação aprovada registrada para a tentativa atual**.
- `retry` avisa depois de 3 tentativas — a proteção contra laços é uma escalada para o humano/orquestrador, não uma
  repetição infinita.

## Acompanhamento

```bash
node .claude/skills/prumo/scripts/serve.mjs      # http://localhost:4949 — consulta o estado a cada 1,5s
```

O dashboard serve para observação e para o controle explícito de cota confirmado pelo usuário. Sua visão de estado
lê o mesmo `state.json` que o motor grava; o controle de cota delega `set-agent-limit` ao motor e nunca é uma
segunda fonte de verdade ou um segundo orquestrador.

O serviço gerenciado é `prumo dashboard enable` (`prumo dashboard status` o informa; `prumo dashboard`
puro o executa em primeiro plano). O endereço padrão, `http://localhost:4949`, é restrito
à máquina local; porta ocupada nunca provoca encerramento de outro processo. O idioma segue a
preferência da instalação ou a escolha explícita de execução; não há seletor no navegador. Textos do usuário são
escapados e nunca traduzidos. Os números derivados não provam cobertura de testes, causas de defeitos ou regras de negócio.
Encerrar o dashboard nunca cancela trabalho.

### Layout

O grafo corre **de cima para baixo**: as fases são faixas horizontais, e as tarefas irmãs se espalham ao longo
da sua faixa. A direção não é preferência — os cards são largos e baixos, então isso só vale enquanto uma
fase fica abaixo de ~10 tarefas; além disso, a faixa fica mais larga do que uma coluna da esquerda para a direita
seria alta, e a troca se inverte. O ganho é que o resultado acompanha o formato de uma tela (~2:1
contra 3,5:1 na horizontal), então ajustar à tela resulta em ~70% de zoom em vez de ~55%.

Por padrão, as faixas são as **fases** do plano: camadas só por profundidade espalham uma fase pela
tela (numa execução de 36 tarefas, F6 caiu em quatro camadas separadas e a primeira camada empilhou 12
tarefas sem relação). O cabeçalho permite voltar às camadas por profundidade.

As tarefas **não são empacotadas a partir da borda** — é isso que transforma um grafo largo num leque de longas
diagonais. Varreduras definem a ORDEM pelo baricentro; depois, cada faixa é reempacotada sem folga e cada
nó se desloca em direção ao X médio daquilo a que se conecta, limitado pela folga dos vizinhos: um
pai acaba centralizado sobre os filhos, e nenhuma faixa fica oca. Existem duas rotas de aresta para
o que uma bezier simples deformaria: uma dependência dentro da mesma faixa **passa por baixo da linha** (um trajeto
reto cruzaria todos os cards entre as duas), e uma dependência cuja origem está numa fase POSTERIOR é
roteada pela LATERAL, com cor própria — ela indica que a numeração das fases esconde uma restrição real de
ordem, que vale ver em vez de disfarçar.

O **planejador**, o **orquestrador** e o **revisor** ficam acima do grafo, com conexões de papel
às suas tarefas ativas. Os detalhes da tarefa mostram o planejador, fontes/achados, decisões, passos de
execução, mapeamento das verificações e perguntas abertas. Rótulos e cores distintas separam pronto para
planejamento, em planejamento e pronto para executar, sem substituir os estados existentes.

### Navegação

A tela é um quadro branco, não uma área de rolagem: **arraste** o quadro para mover, **ctrl/⌘+roda** para
aplicar zoom no cursor, roda simples/trackpad para mover, **`0`** ou o botão `fit` para alternar entre
o grafo completo e uma visão centralizada a 100%, `+`/`-` para zoom. Ele se ajusta automaticamente na primeira pintura,
então a primeira coisa na tela é o grafo inteiro.

Dois detalhes fáceis de quebrar: a transformação é reaplicada depois de cada ciclo (a atualização de 1,5s
faria o quadro voltar à origem), e a captura do ponteiro só começa depois que
um movimento passa do limite de 4px — capturar no `pointerdown` redireciona o clique e nenhum card
abriria. Abaixo de ~55% de zoom, os cards passam a mostrar **somente id + cor**; um subtítulo renderizado a
40% da escala é ruído, e ler a execução pela cor é justamente o objetivo de afastar o zoom.

Para servir uma execução diferente de `CURRENT`: `node .claude/skills/prumo/scripts/serve.mjs --run <name>`.

### Resultados

O botão **results** do cabeçalho (ou `r`) troca o grafo pelo custo da execução. Nas rodadas
novas, `activityTiming: "explicit"` distingue a medição de trabalho dos registros anteriores.
Cada `discussionAttempts[]`, `planningAttempts[]` e `attempts[]` novo contém
`activityIntervals: [{ role, agent, startedAt, endedAt? }]`. Para execução e revisão, os dois
papéis compartilham a tentativa; para discussão e planejamento de fase, a rodada é contada
uma vez, sem multiplicar pelo número de tarefas. Um intervalo aberto representa trabalho em
andamento e pode ser exibido até o horário atual enquanto o papel continua ativo. Intervalos
fechados determinam a duração; `startedAt` e `endedAt` da rodada ou tentativa continuam a
representar seu ciclo de vida, inclusive esperas, e não substituem intervalos explícitos.
Rodadas antigas sem `activityTiming` mantêm a interpretação legada. Se ainda estiverem abertas,
o primeiro START cria os intervalos vazios com `activityTiming: "explicit"` e `activityLegacy: true`:
o prefixo anterior tem duração desconhecida e não é somado retroativamente. O motor não inicia trabalho ao despachar; `activity-start` marca o início
efetivo, `activity-stop` retira a espera da conta, e a transição de estado fecha qualquer
intervalo ainda aberto.

- **Tempo de relógio vs tempo de agente**, e o ganho de paralelismo entre eles (tempo de agente ÷ tempo de relógio).
- **Planejar vs construir vs verificar** — tempo de agente dividido entre planejadores, executores e revisores;
  o tempo de planejamento exclui intervalos pausados. Esta é a
  questão de custo: revisar é uma fatia real da conta, e só aparece como fatia.
- **Caminho crítico** vs tempo de relógio. A cadeia mais longa de trabalho dependente é o piso que nenhum número
  de executores consegue furar, então é isso que separa "adicionar agentes" de "reestruturar o
  plano" — se o caminho é ~todo o tempo de relógio, mais executores não compram nada.
- **Vagas ocupadas ao longo da execução**, amostradas, com o limite de executores desenhado — onde o grafo correu
  largo e onde correu em uma única linha.
- **Por tarefa**: planejamento, execução, revisão, tempo na fila esperando dependências, tempo bloqueado pelo dev, tentativas
  e vereditos.
- **O que os números sustentam** — achados expostos com sua evidência, não conselhos: se o
  custo de revisão é FIXO entre tarefas (a assinatura de rodar a suíte inteira por tarefa,
  em vez de uma etapa restrita ao que mudou), o que a etapa de revisão realmente pegou e quais
  tarefas foram revisadas acima do custo mediano e nunca reprovadas.

Esse último existe para uma decisão: `requireReview` é escrito à mão no plano, e
o motor deliberadamente nunca o decide — um orquestrador que escolhe quais das próprias tarefas
pulam a verificação é a etapa vigiando a si mesma. O papel da aba é substituir o palpite pela
evidência da execução anterior. Ela nomeia candidatas; o dev as marca.

O motor não mede tokens nem chama modelos. Leia o consumo no harness; recibos opcionais
de `report-usage` armazenam contagens fornecidas explicitamente, identificadas como relatos.

## Licença

[MIT](../LICENSE)

## Evidências e controles opcionais

Planos anteriores continuam válidos sem campos novos. A atualização não reinicia runs,
não cria tentativas nem reescreve contratos, autorizações, dependências ou histórico.
Os comandos abaixo usam `node <ENGINE>`; o motor registra atribuições, não cria agentes.

| Recurso | Comando ou campo | Padrão e efeito |
|---|---|---|
| Seleção de execução | `--run nome`, `-r nome`, `PRUMO_RUN`, `CURRENT` | Precedência nessa ordem; `--run` e `-r` são o mesmo argumento e não podem ser duplicados. Todos validam o mesmo nome seguro, inclusive em `init`. `init` mantém CURRENT. Não altera filtros do shell. |
| Briefing atual | `brief T1 --role executor\|reviewer` | JSON do contrato persistido, critérios, task-plan/dispensas, recibos, fontes e entregas de dependências registradas, última reprovação e comandos com aspas adequadas ao shell. Sem caminhos ou experiências inventadas; um novo revisor inspeciona e valida a entrega atual. |
| Preferências por papel | `rolePreferences: { "review": { "model": "nome", "effort": "high" } }` | Opcional no plano; papéis `discussion`, `planning`, `execution`, `review`. `set-role --role review --model nome --effort high` modifica apenas disparos futuros, com histórico. Não revoga contratos nem autorizações. |
| Valores do disparo | `--model nome --effort high` em comandos de atribuição | O motor guarda preferência solicitada e valores informados em `modelDispatches` de cada tentativa/worker. Ausentes ficam `null`. Status e brief identificam esses dados como relatos; não comprovam o modelo real. |
| Pausa geral | `pause-run --reason "motivo" [--until 2099-01-01T00:00:00Z]` | Pausa própria do run: preserva estados, rodadas, filas e bloqueios externos. Fecha intervalos ativos, desconta a pausa nos tempos e bloqueia novos despachos/prontidão. `--until` é previsão futura, nunca uma retomada automática. Não interrompe processos externos. |
| Retomada explícita | `resume-run` | Preserva tentativas/histórico e aplica as cotas atuais ao próximo disparo. Não reabre intervalos de atividade por conta própria. |
| Consumo informado | `report-usage T1 --role execution --attempt 1 --receipt medicao --tokens 100 --tools 3` | Contagens opcionais inteiras não negativas por papel/tentativa ou worker. Recibo igual é idempotente; valores conflitantes são recusados. Status soma por tarefa/run, sem copiar consumo entre validate/done. Não é custo financeiro nem medição independente. Para workers de fase informe `--attempt` da rodada explicitamente. |
| Consultar checagens | `show-check T1 [--attempt K] [--check N]` | Sem check lista recibos e comandos exatos. Com check e sem attempt seleciona a última tentativa de execução registrada, nunca a última validação histórica. Uma tentativa atual sem recibo informa as opções; preserva stdout/stderr, erro, sinal e código de saída. |

### Checagem de identificadores nas entregas

Antes de `review` e `unblock --reviewer`, o motor compara arquivos visíveis pelo Git
sob `touches` com a linha de base anterior a `start`. Verifica nomes novos e linhas
novas de conteúdo, ignorando maiúsculas/minúsculas. Nomes de arquivos alterados e de
entregas explicitamente declaradas também são conferidos; nomes inalterados de arquivos
preexistentes sem essa relação são preservados. Fronteiras usam letras/números:
`t6_resumo.tsv` contém `T6`, mas `T60` não contém `T6`. IDs existentes de tarefas/fases,
nome do run e `plan.name` são literais; palavras comuns como executor/reviewer não
são proibidas automaticamente. Linhas preexistentes idênticas são descontadas por ocorrência.
A linha de base persiste hashes de linhas, sem copiar seu texto para o estado.

Campos opcionais da tarefa:

```json
{
  "deliveries": ["out/resumo.json"],
  "textRules": {
    "patterns": ["nome-interno-adicional"],
    "exceptions": [{ "path": "out/exemplo.json", "line": 4, "identifier": "T6" }]
  }
}
```

`deliveries` declara caminhos reais dentro de `touches`, inclusive arquivos ignorados.
Padrões são literais (sem regex), até 64 textos de até 128 caracteres; exceções são
específicas por caminho, linha e identificador, até 64. Linha 0 significa nome de arquivo.
São campos de contrato: uma alteração aprovada usa `sync-plan` e os gates atuais.
Links e pais vinculados são recusados antes de ler; arquivos binários não são tratados
como prosa e aparecem na limitação do recibo. A leitura limita 256 arquivos, 1 MiB por
arquivo e 8 MiB no total; o erro informa somente caminho/linha, sem conteúdo sensível.
Sem Git, a travessia fica sob `touches` aprovados e visita no máximo 4096 entradas.
Caminhos ausentes por exclusão são preservados como exclusões do diff, sem leitura externa.

Runs antigos sem linha de base de conteúdo mantêm a tentativa: somente `deliveries`
explicitamente registradas são atribuíveis, com limitação no recibo. Sem escopo de arquivo
ou cwd conhecido, a checagem informa que não pôde inspecionar conteúdo; não inventa baseline.
Isso nunca dispensa revisão independente, comparação de escopo ou validação funcional.
`validate` e `done` reconferem a entrega e seu frescor; uma mudança posterior exige validar novamente.

### Procedência executável de sínteses numéricas

O contrato declara o manifesto entregue e as fontes aprovadas, sem inferir todos os números da prosa:

```json
"numericProvenance": {
  "manifest": "out/procedencia.json",
  "sources": ["dados/entrada.json"]
}
```

O manifesto JSON associa origem, localização por JSON Pointer, valor declarado, regra
de cálculo e localização do resultado entregue:

```json
{
  "claims": [{
    "source": "dados/entrada.json", "pointer": "/valores",
    "operation": "sum", "value": 5,
    "result": { "source": "out/resumo.json", "pointer": "/total" }
  }]
}
```

Operações: `value` para um número, `sum` para array de números finitos e `count` para
quantidade de elementos de um array. Pointer vazio seleciona o documento inteiro;
`~0`/`~1` representam `~` e `/`. O manifesto precisa de 1–256 claims. Origem precisa
estar na lista aprovada, resultado e manifesto dentro de `touches`. Arquivos são lidos
sem links, com os mesmos limites; referências ausentes, JSON inválido, cálculo divergente,
resultado divergente ou manifesto ausente recusam a verificação. Use
`verify-provenance T1`; `validate --ok` também executa essa checagem e preserva hashes
antes/depois dos comandos. `done` recusa fontes/manifestações alterados desde o recibo,
mesmo se outra mudança preservar a soma. Recibo de dependência não prova contagem.
Sem `numericProvenance`, nenhum gate numérico novo é imposto a contratos históricos.
O comando explícito `verify-provenance` recusa contrato numérico ausente; a validação histórica normal continua válida.

### Feedback do planejamento e identidade do artefato

O fechamento do planejamento avisa quando uma pergunta aberta repete literalmente uma
pergunta de discussão ou decisão respondida, ignorando maiúsculas e espaços. O aviso não
infere resposta, equivalência semântica nem resolução e preserva a pergunta original.
Decisões do contrato com outra redação continuam exigindo inspeção humana do briefing atual.

Planos novos registram o `sourcePath` real do artefato. `start`, retry corretivo e `brief`
mostram o digest completo do plano aprovado embutido no estado, a tentativa de origem e
a rodada do planejador da fase. Um plano antigo sem caminho informa `null`; não se inventa
origem nem se recarrega um arquivo alterado para substituir silenciosamente o plano aprovado.
O caminho é metadado de procedência, sem afirmar que o arquivo atual ainda tenha aquele conteúdo.

Se o planejador não puder gravar, devolve JSON completo por stdout com o nome designado
`task-plan-<task>.json`. O orquestrador salva esse artefato e usa o comando de fechamento
existente. Saída vazia não é um plano; permanecem os gates de esquema, vínculo, frescor,
autorização e revisão independente. O disparo da fase imprime esse caminho de retorno.

### Duração registrada e trabalho ativo

O painel de atividade soma separadamente cada agente em cada papel. Workers de fase
substituem o envelope da rodada, sem dupla contagem. Quando há intervalos START/STOP,
mostra trabalho ativo aferido; quando eles estão vazios mas há horários válidos de etapa,
mostra duração registrada, que pode incluir espera. Esse fallback não participa de ganhos
aferidos. O relógio usa a união dos períodos de etapas, mantém continuidade entre papéis
e desconta pausas/bloqueios registrados: três agentes por dez minutos somam trinta no papel
e dez no relógio. Dados ausentes e históricos parciais são identificados, sem tempos inventados.

### Diagnóstico de filtros de shell

`prumo doctor --codex [--shell-filter-config arquivo.json] [--shell-block-evidence arquivo.json]`
lê apenas arquivos explicitamente fornecidos, até 64 KiB. Configuração acessível no formato
`{"allowedCommands":["comando aprovado"]}` comprova a lista,
mas não um bloqueio ocorrido. Evidência de bloqueio no formato
`{"decision":"blocked","command":"node scripts/engine.mjs ready"}`
permite sugerir ajustar a lista permitida para o comando aprovado. O diagnóstico não
autentica a origem do relato. Sem configuração/evidência pertinente, este diagnóstico permanece silencioso.
Nunca recomenda contornar filtros de segurança do shell.

Entregas declaradas são inspecionadas integralmente, inclusive conteúdo preexistente; linhas inalteradas da linha de base sem essa relação continuam descontadas. Rodadas históricas de fase sem workers aceitam consumo na rodada existente somente quando seus targets registrados incluem a tarefa; `--phase` distingue o histórico da fase. Totais de tokens/ferramentas devem permanecer dentro dos limites de inteiro seguro.

Após resume-run explícito, um checkpoint fechado pela pausa passa a contribuir duração registrada da etapa até o próximo checkpoint ou encerramento; não cria trabalho aferido. Timestamps persistidos no task-plan podem fornecer duração histórica parcial de planejamento quando não existe rodada; nenhuma tentativa é inventada.
