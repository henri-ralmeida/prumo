# Referência do motor Prumo

[English](runtime.md) · [Instalação](../README.pt-BR.md)

O motor é uma CLI Node.js, não um serviço que chama modelos. O ambiente de IA dispara planejadores, executores e revisores; o motor registra planejamento, trabalho, dependências e evidências. O dashboard observa os mesmos arquivos sem alterá-los.

`npm install -g @henri-ralmeida/prumo` instala a CLI, a skill, o PO First e o serviço de dashboard do usuário. O `postinstall` global configura os ambientes suportados detectados; uma instalação npm local é inerte. Use `prumo install --all` quando os scripts do npm estavam desabilitados ou para reparar um novo ambiente. Instalação e atualização reiniciam o dashboard quando ele está habilitado e preservam a desativação explícita. O dashboard global é somente observador: apenas uma chamada explícita do orquestrador a `sync-plan` reconcilia um plano aprovado.

`prumo update` atualiza a CLI, a skill, os dois READMEs, as referências, os scripts e a configuração PO First em todas as instalações registradas do Claude Code, Kiro, Codex e DSH. Ele compara o conteúdo gerenciado, retoma ativação pendente e nunca rebaixa uma CLI global mais nova que o `latest` do npm. Um marcador danificado só é recuperado para seu ambiente/caminho exato registrado e a partir de um backup Prumo conferido byte a byte.

O DSH precisa estar instalado e detectado antes de `prumo install --dsh`; o Prumo nunca instala o pacote externo `@deepseek-ai/dsh`. Um `DSH_HOME` não vazio prevalece; caso contrário, usa-se `~/.dsh`. Os destinos gerenciados são `<DSH_HOME>/skills/prumo` e o bloco PO First no `<DSH_HOME>/AGENTS.md` global. A instalação explícita retorna código diferente de zero sem gravar quando o DSH está ausente; `--all` e `postinstall` atuam apenas nos ambientes detectados, enquanto update pode reparar uma instalação Prumo exata detectada ou registrada.

## Armazenamento

Selecione `PRUMO_ROOT` como workspace existente dentro de `PRUMO_HOME`. Novos planos ficam em `~/.local/share/prumo`; a instalação migra para lá os dados centrais duráveis do graph-foreman: estado do grafo, backups salvos do grafo e arquivos de plano ou handoff no topo. Diretórios gerados de execução, cópias de dependências e saídas de build só são removidos depois de conferir o destino durável. `GRAPH_ROOT` e `GRAPH_FOREMAN_HOME` continuam aceitos como compatibilidade explícita; um workspace legado dentro de projeto também é aceito no local original.

Cada execução usa `.specs/graph/<run>/state.json` e `events.ndjson`. `CURRENT` seleciona a execução padrão. Use `--run <nome>` em toda chamada quando houver várias execuções. Nomes aceitam letras, números, ponto, hífen e sublinhado, sem ponto inicial ou separadores de caminho.

`state.json` é a fonte de verdade. O histórico é aditivo. Escritas usam arquivo temporário, renomeação e trava por execução. Validações liberam a trava enquanto executam comandos; antes de registrar o resultado, conferem tentativa, contrato, revisor e estado.

## Plano

```json
{
  "name": "resultado-observavel",
  "requireReview": true,
  "maxParallel": 4,
  "maxExecutors": 3,
  "phases": [{ "id": "P1", "title": "Entrega" }],
  "tasks": [{
    "id": "T1", "title": "Comprovar o resultado solicitado",
    "label": "Cartões",
    "summary": "Os dados aprovados chegam à conta sem uma segunda etapa manual.",
    "validationSummary": "A conta mostra o status de cartão aprovado.",
    "phase": "P1", "deps": [], "touches": ["entrega/"],
    "unavailable": ["database", "manual-inspection"],
    "validationMode": "functional",
    "validation": [{
      "kind": "functional", "run": "node verificacao.mjs",
      "expect": "O verificador confirma os resultados aprovados"
    }]
  }]
}
```

`deps` define a ordem. Dependências concluídas ou explicitamente puladas liberam a tarefa. Ciclos, IDs duplicados e dependências desconhecidas são recusados. `touches` detecta gravações sobrepostas entre tarefas paralelas; `--allow-overlap` é uma exceção explícita de agendamento.

`unavailable` é opcional e aceita somente `database`, `network`, `credential`, `external-service`,
`production-data` e `manual-inspection`. Alterar essa lista muda o contrato da tarefa e exige planejamento atual.
`init` e `sync-plan` avisam quando um prefixo de `touches` não existe no cwd da validação ou no `cwd`
declarado por um passo; o aviso não bloqueia, pois novos arquivos e pastas são legítimos. Cwd inacessível
é informado como checagem não realizada.

`label` aceita de 1 a 3 palavras e até 24 caracteres; `summary` descreve em 1–2 frases o resultado esperado e por quê; `validationSummary` resume em uma frase o aceite. Todos são textos opcionais e precisam estar preenchidos quando presentes. Uma alteração apenas nesses textos via `sync-plan` atualiza a apresentação sem mudar o contrato nem invalidar o planejamento. O dashboard preserva o `title` completo em detalhes e tooltips; não gera nem corta um rótulo substituto.

`requireReview` pode ser definido por tarefa ou plano; o padrão exige revisão. Desabilitar revisão não elimina a comprovação funcional. `maxAttempts` por tarefa define o limite de tentativas antes de escalar; o padrão é três. `tags` é uma lista opcional de classificações.

## Descoberta e planejamento por fase

Antes de planejar, confira as ferramentas e permissões realmente disponíveis na sessão. Nunca deduza suporte
a subagentes ou gravação pelo nome do harness. Se não houver subagente planejador, informe essa limitação e
faça o planejamento local com pesquisa somente leitura do projeto; essa atuação pode gravar apenas o artefato
de plano indicado e não pode implementar o produto.

Cada planejador usa as ferramentas disponíveis para inspecionar regras atuais do projeto, código, artefatos,
saídas de dependências e fontes relevantes. Ele pode gravar somente o arquivo exato task-plan-<id>.json no
diretório indicado. Se não puder gravar ali, retorna um objeto JSON completo por tarefa em um bloco aberto
com ```json, com o nome exato do arquivo na linha anterior. Nunca abrevie o JSON nem substitua campos
por reticências.

O orquestrador interpreta cada bloco como JSON, decodifica &gt;, &lt;, &amp; e &quot; somente em valores de texto,
valida o artefato resultante, grava-o com o nome indicado e então executa finish-phase-planning ou
finish-planning. Se a leitura ou validação falhar, devolva a correção concreta ao planejador; não invente nem
complete localmente o conteúdo ausente. A regra vale para planejamento por fase e por tarefa; não acrescente
campos de vínculo exclusivos de fase a um artefato por tarefa.

Há dois níveis. O modo Plan/Spec monta e aprova o grafo global, que permanece obrigatório. Em execuções
com fases, discussão e planejamento são etapas opcionais e independentes. Antes de cada escolha, avalie
tamanho e complexidade do escopo, ambiguidade, impacto, dependências, novidade, risco e suficiência do
contrato e contexto aprovados. Recomende fazer ou pular cada etapa e aguarde a escolha explícita do usuário.
Registre cada skip com `--reason` e `--confirmed-by-user`; executor e revisor independente continuam
obrigatórios. Correções de homologação podem pular uma ou ambas as etapas somente por escolha explícita.
Quando escolhidos, a discussão é uma conversa visível na sessão principal e o planejamento usa um
planejador somente leitura por fase. O planejador produz um
`task-plan-<id>.json` imutável e separado para cada tarefa alvo. Uma fase só abre quando todas as
dependências externas de todos os membros não concluídos estão `done` ou `skipped`. Um membro bloqueado
segura a fase inteira. Dependências internas à fase bloqueiam execução, não planejamento. O usuário pode
escolher fases independentes para discutir e planejar em paralelo, independentemente da numeração.
Não mova tarefas de fase nem remova dependências para contornar bloqueios.
Uma tarefa existente nomeada explicitamente é um limite rígido: pré-requisitos, lacunas de evidência e
entregas internas permanecem em seu único plano; criar tarefas auxiliares ou planejar irmãs exige aprovação.
Quando o usuário escolhe discutir, a conversa executa
`begin-phase-discussion <fase>` antes do prompt, pesquisa a fase e faz ao menos uma pergunta contextual.

Use a caixa nativa de perguntas do Codex, Claude Code, Kiro ou DSH quando disponível; caso contrário, use
um bloco estruturado na conversa principal. Reaproveite respostas atuais e faça rodadas adaptativas até
fechar as áreas cinzentas que mudam comportamento, escopo, aceite ou execução. Ideias fora do escopo
vão para `deferred`. A conversa principal grava um JSON de descoberta com pesquisa, perguntas e
respostas reais, canal/rodada, cobertura PO First, decisões e motivo de encerramento.

Antes de continuar uma run antiga, a skill inspeciona cada contrato não terminal, normaliza validações
obsoletas ou em prosa na fonte aprovada com evidência do repositório e executa `sync-plan` no run original.
Uma migração parcial segura cria a estrutura atual e marca por tarefa as tentativas legadas já iniciadas
para manterem o ciclo anterior. Elas podem ser retomadas, revisadas e concluídas sem discussão ou
planejamento retroativos. Tarefas novas ou ainda não iniciadas recebem as etapas atuais e avançam quando
suas próprias dependências estão prontas. Somente um planejamento em andamento que não possa ser mapeado
com segurança bloqueia a migração, com motivo específico. Use `sync-plan` para sincronizar contratos
corrigidos sem apagar histórico. Não remova tentativas nem pule trabalho real para contornar bloqueios. Links de dependências e junctions são preservados na
mudança de pasta: destinos internos acompanham o workspace e destinos externos não são alterados.

Essa migração do contrato inteiro não autoriza ampliar o grafo ou o planejamento. Quando o usuário nomeia
uma tarefa existente, mantenha uma discussão e um planner somente para ela. Nos demais casos, a adoção de
cada fase elegível é explícita com `begin-phase-discussion <fase> --adopt-legacy`: o histórico terminal permanece intacto e todas as
tarefas não terminais adotadas precisam estar antes da execução, sem rodada de tarefa aberta. Uma adoção
insegura é recusada sem alterar estado ou eventos.

A escolha depende das ferramentas expostas e permitidas na sessão principal. No Codex,
`request_user_input_async` pode estar disponível fora do Plan; `request_user_input` mantém suas
restrições de modo. O Claude Code documenta
[`AskUserQuestion`](https://code.claude.com/docs/en/tools-reference); em
[integrações SDK](https://code.claude.com/docs/en/agent-sdk/user-input), a aplicação precisa apresentar
as perguntas, e a ferramenta não deve ser presumida em subagentes. O
[catálogo do Kiro](https://kiro.dev/docs/reference/built-in-tools/) não confirma uma ferramenta
equivalente de caixinha: confira as capacidades reais da sessão. O usuário do Kiro CLI pode usar
[`/reply`](https://kiro.dev/docs/cli/chat/responding/) para responder ponto a ponto.
No DSH, também confira as ferramentas realmente expostas na sessão principal; não infira um wrapper de
perguntas apenas pelo nome do harness.
Sem ferramenta nativa permitida, apresente **O que entendi**, **Campos cinzentos**, **Sugestões** e
**Perguntas** numeradas no chat. Preserve perguntas pendentes ao trocar de canal. Retorno assíncrono,
timeout, resposta vazia e sugestão pré-selecionada não são respostas: aguarde a resposta real antes
de encerrar a descoberta. Essa seleção pertence à skill; o motor não cria uma interface nativa.

`finish-phase-discussion <fase> --context <descoberta.json>` exige o `roundId`, o `nonce` e uma resposta
nova vinculada à rodada. `plan-phase <fase> --agent <planejador>` ocupa uma única vaga. O planejador
consome a descoberta sem repetir perguntas, pesquisa todas as tarefas alvo e apenas escreve os artefatos.
`finish-phase-planning <fase> --plan-dir <diretório>` valida o lote inteiro antes de gravar qualquer plano.
Se a fase foi reaberta após uma mudança sincronizada de contrato, execute `show-contract <tarefa> --diff`
para cada alvo, apresente o texto completo ao usuário e pergunte se ele aceita a mudança. Uma pergunta
respondida da descoberta deve conter `confirmsContract: [{ "task": "<id>", "digest": "<digest-atual-de-64-caracteres>" }]`
para todos os alvos atuais. Tarefa ausente, digest antigo e skip de discussão/planejamento não satisfazem a
confirmação.
O mesmo aceite vale para planejamento por tarefa: quando o sync invalida uma discussão, rodada de
planejamento ou skip atual após mudança de contrato, `begin-discussion` imprime o par atual de tarefa/digest.
Apresente o texto completo de `show-contract <tarefa> --diff` e pergunte se o usuário aceita a mudança. Inclua
esse par em uma pergunta respondida vinculada ao `roundId` da discussão atual. Resposta de rodada antiga,
digest desatualizado ou skip não satisfaz a confirmação; depois do aceite, o skip normal de planejamento fica
disponível.
Cada artefato inclui `phaseBinding` e lista dependências diretas incompletas em `unresolvedInputs`, com
tarefa produtora, fase e evidência exigida. Exemplo da parte comum do contrato:

O JSON de descoberta exige `research` com `source`/`findings`; `questions` com ao menos um
`question`/`answer`, `round` positivo e `channel` igual a `native` ou `chat-fallback`; `coverage`
com `problem`, `affected`, `outcome`, `currentBehavior`, `desiredBehavior`, `rules`, `exceptions`,
`scope` e `acceptance`; pares resolvidos em `decisions`; textos em `deferred`; `executionBoundary` com
`deferredToExecutor` nomeando todas as tarefas alvo e `prematureTaskWork` normalmente vazio; e `closure` explicando
por que não restou área cinzenta relevante. Uma síntese pode cobrir vários campos, sem virar questionário.
Se a discussão produziu o resultado de uma tarefa, `prematureTaskWork` registra a tarefa e a ação e o motor
recusa o fechamento. Depois de informar o usuário e receber aprovação explícita,
`--accept-premature-work` registra o incidente; o executor ainda repete o trabalho.
O motor calcula um SHA-256 canônico da descoberta e do recibo da discussão e liga o digest à rodada.
`plan-phase` imprime um trecho JSON copiável por tarefa alvo, lido da rodada de planejamento persistida;
copie `phaseBinding` e `unresolvedInputs` daquela tarefa sem alterações para seu artefato. `discussionRoundId`
é o `roundId` da discussão ou o `decisionId` da decisão confirmada pelo usuário quando a discussão foi pulada.
Mantenha `plannerRound` como impresso; não renumere. Repetir `plan-phase` na mesma rodada aberta imprime os
mesmos trechos sem criar outra rodada. `finish-phase-planning` valida o lote inteiro antes de gravar qualquer plano
e recusa artefatos incompletos, alterados ou ligados a uma descoberta desatualizada.

```json
{
  "research": [{ "source": "src/importacao.mjs", "findings": "O importador atual valida as linhas antes de gravar; reutilizar essa validação." }],
  "summary": "Reutilizar o limite de validação existente rejeita linhas inválidas antes de qualquer gravação.",
  "decisions": [{ "question": "Como tratar uma linha inválida?", "answer": "O contrato aprovado exige rejeição sem gravação parcial." }],
  "steps": ["Ampliar a validação existente.", "Adicionar o caso de linha inválida à verificação funcional existente."],
  "verification": [{ "criterion": "Linha inválida produz o erro aprovado e preserva os registros existentes.", "check": 1, "requires": ["database"] }],
  "writes": ["src/importacao.mjs", "test/importacao.test.mjs"],
  "openQuestions": [],
  "phaseBinding": { "phaseId": "F1", "discussionRoundId": "<roundId-ou-decisionId-do-skip>", "plannerRound": 1 },
  "unresolvedInputs": [{ "task": "T2", "phase": "F2", "requiredEvidence": "current terminal receipt for T2" }]
}
```

`research` exige fonte e achados; `steps`, passos de execução; `verification`, critérios observáveis
associados a **todas** as entradas de `task.validation` pelo índice numérico a partir de 1. Cada verificação
pode declarar `requires`, usando o mesmo vocabulário fechado de `unavailable`. Se um recurso exigido também
estiver indisponível, o fechamento avisa com tarefa, índice da verificação e recurso, mas continua. A inspeção
manual aparece como pendente no status e no dashboard até o revisor independente registrar aprovação atual;
o motor não deduz capacidade pelo nome do harness. `writes` é uma lista opcional de caminhos relativos seguros
de arquivos ou pastas; se a tarefa declara `touches`, cada caminho precisa estar dentro de um prefixo por segmento.
Separadores e `./` são normalizados; caixa é ignorada somente no Windows. Ausência ou lista vazia gera aviso,
sem invalidar planos antigos.
`verification.check` não indexa `taskPlan.steps`. Use `"inspection"`
somente quando o contrato aprovado for inspeção em texto. Esses três arrays não podem estar vazios.
`decisions` contém pares `question`/`answer` resolvidos e pode ser vazio. `openQuestions` contém
`question`, `blocking` booleano, `answer` opcional e `decideBy` opcional: `"executor"` (padrão),
`"user-now"`, `{ "beforeTask": "T2" }` ou `{ "beforePhase": "F2" }`. Perguntas bloqueantes
continuam exigindo resposta antes de concluir o planejamento e equivalem a `user-now`. Uma pergunta
futura não segura a tarefa de origem; ela reaparece quando a tarefa ou fase indicada começa e vira
impedimento de execução somente nesse momento. `status` mostra perguntas programadas e vencidas.
Resolva uma pergunta posterior com um item de `decisions` que informe a referência exibida em
`resolvesQuestion`, por exemplo `{ "question": "Qual protocolo?", "answer": "Use o cliente existente.",
"resolvesQuestion": "T1:plan:abc123" }`. No planejamento por tarefa, o prazo `{ "beforePhase": "F2" }`
vence quando qualquer tarefa de F2 inicia discussão ou planejamento. Não invente respostas nem omita uma incerteza consequencial.

Cada plano de tarefa pode ter um `summary` não vazio de 1–2 frases sobre o caminho escolhido e por quê.
O motor salva cada `taskPlan` e seu histórico imutável. O escopo usa contratos, sem estado mutável das
entregas. Mudança de contrato invalida a tarefa afetada e dependentes reais; descoberta compartilhada
invalida planos não terminais da fase; `--plan-defect` invalida somente aquela tarefa. Achados comuns e
conclusão de dependência não replanejam. No `start`, uma dependência `done` fornece a validação atual e
uma `skipped` fornece dispensa explícita ligada ao motivo. O recibo não altera o plano e precisa permanecer
igual durante revisão, validação e conclusão.

Cada `taskPlan` persistido recebe `digest` SHA-256 do conteúdo canônico de execução, sem resumos de
apresentação, horários ou metadados de registro. `start` grava o digest completo em `attempts[].planDigest`; status e evento `task_start`
exibem os quatro primeiros caracteres. Ele é distinto de `inputDigest`, que identifica recibos de
dependências. Runs antigas sem digest continuam legíveis e podem iniciar normalmente.

Runs persistidas no modo por tarefa continuam usando `begin-discussion`, `finish-discussion`, `plan-task`
e `finish-planning`, com a semântica anterior de dependências concluídas.

`maxParallel` limita o total de planejadores, executores e revisores ativos; `maxExecutors` limita
execução. Planejar não consome tentativa de execução. Cada agente pode ocupar uma tarefa ativa.
No fluxo novo, `--force` não ignora planejamento, dependências, capacidade total ou agente ocupado;
a exceção legada para a cota de executores permanece.

## Contrato de validação

Cada passo exige `run` e `expect` preenchidos. `kind` aceita `static` e `functional`; ausência de `kind` conta como estático. O modo padrão, `functional`, exige um passo funcional executável.

| Campo | Comportamento |
|---|---|
| `cwd` | Caminho absoluto de trabalho; substitui `--cwd` no passo |
| `env` | Variáveis com valores de texto, passadas sem interpolação pelo motor |
| `shell` | Executável do shell; padrão cmd.exe no Windows e /bin/sh em Unix |
| `expectedExitCodes` | Códigos aceitos; padrão `[0]`, inteiros de 0 a 255 |
| `timeoutMs` | Prazo por passo; padrão 600000; `0` desabilita explicitamente |
| `cacheable` | Reutiliza aprovação somente em passo `static`, na mesma tentativa, estado, contrato e árvore Git |
| `cachePaths` | Caminhos relativos cobertos pelo passo `cacheable`; permitem reutilizá-lo após retry somente quando seu conteúdo não mudou |

No Windows, use `env` em vez da sintaxe Unix `NAME=value comando`. Comandos pertencem ao contrato aprovado; o motor não os converte entre plataformas. Retorno diferente de zero pode representar um resultado de negócio esperado se o contrato o declarar.

Tarefas sem efeito de execução podem usar `validationMode: "inspection"` com `inspectionReason`, uma descrição de inspeção ou passos estáticos. Evidência permanece obrigatória.

Os comandos seguem a ordem declarada e param na primeira falha. Por padrão, todos executam novamente. Um passo `static` com `cacheable: true` pode reutilizar resultado aprovado na mesma tentativa e estado somente quando contrato, Git HEAD e árvore de trabalho permanecem iguais. Com `cachePaths`, um novo revisor também pode reutilizá-lo após um retry corretivo quando esses caminhos continuam idênticos, retomando na primeira etapa falha ou alterada. Passos `functional` e passos estáticos sem esse escopo sempre recomeçam numa nova tentativa. O recibo registra comando, expectativa, categoria, diretório, shell, prazo, códigos esperados, saída, erro, sinal e código real. Saída acima de 4 MiB e timeout são falhas; os processos filhos da verificação são encerrados. Saída e evidências mantêm seu idioma original.

O motor verifica execução e integridade. O revisor julga se o teste prova o comportamento pedido e se as classificações são honestas. Um rótulo no plano não comprova qualidade do teste.

Separe contexto, critérios vigentes e provas usando os campos existentes:

- Contexto e decisões ficam em `description` ou nos documentos aprovados referenciados. Critérios substituídos ficam identificados no histórico e nos backups.
- `expect` descreve o resultado atual que aquele passo pode comprovar. Não carregue o contrato antigo inteiro como critério ativo nem preserve requisitos contraditórios.
- `run` executa a prova correspondente. Build comprova compilação; escrever um resultado funcional ao lado dele não comprova esse resultado. Não crie passos `echo` para guardar contexto ou instruções.

Um passo funcional é o mínimo estrutural, não a cobertura completa. O revisor confere cada critério funcional vigente. Prepare pré-requisitos antes dos testes dependentes; confirme que testes filtrados ou sem compilação usam a entrega atual e executam casos relevantes. Não esconda falhas nem descarte alterações alheias. Preserve evidências anteriores com saídas distintas e prefira verificações de leitura quando suficientes; repetir efeitos operacionais exige autorização própria.

## Comandos

Resolva `scripts/engine.mjs` a partir da skill instalada. Acrescente `--run <nome>` para selecionar uma execução.

| Comando após `node <ENGINE>` | Efeito |
|---|---|
| `init --plan <arquivo> --run <nome>` | Inicializa execução do plano aprovado |
| `migrate [--check]` | Migra com backup o schema legado seguro; `--check` apenas diagnostica |
| `status`, `ready`, `graph`, `runs` | Consulta estado, trabalho pronto, JSON ou execuções |
| `authorize --scope run\|phase:<fase>\|tasks:<T1,T2> [--mode auto\|manual] --confirmed-by-user` | Registra o escopo e o modo de despacho aceitos pelo usuário; `auto` é o padrão |
| `show-contract <tarefa> [--diff]` | Exibe os contratos de negócio antes/depois sem comandos `validation.run` |
| `show-check <tarefa> --check <N> --attempt <K>` | Exibe stdout, stderr, diretório, código de saída e reutilização do recibo armazenado |
| `begin-phase-discussion <fase> [--adopt-legacy]` | Persiste a discussão escolhida da fase antes da primeira pergunta; a opção adota uma fase legada segura |
| `skip-phase-discussion <fase> --reason <texto> --confirmed-by-user` | Registra a escolha explícita de pular a discussão da fase |
| `finish-phase-discussion <fase> --context <descoberta.json>` | Valida o recibo e as respostas da rodada atual |
| `plan-phase <fase> --agent <nome>` | Registra o único planejador somente leitura da fase |
| `skip-phase-planning <fase> --reason <texto> --confirmed-by-user` | Registra a escolha explícita de pular o planejamento da fase após a decisão de discussão |
| `finish-phase-planning <fase> --plan-dir <diretório>` | Valida e grava atomicamente um plano imutável por tarefa alvo |
| `begin-discussion <tarefa> [--adopt-legacy]` | Persiste discussão ativa; a opção adota somente uma tarefa legada elegível |
| `skip-discussion <tarefa> --reason <texto> --confirmed-by-user` | Registra a escolha explícita de pular a discussão da tarefa |
| `finish-discussion <tarefa> --context <descoberta.json>` | Valida respostas da rodada atual e libera o planejamento |
| `plan-task <tarefa> --agent <nome>` | Registra o planejador após a discussão fechada |
| `skip-planning <tarefa> --reason <texto> --confirmed-by-user` | Registra a escolha explícita de pular o planejamento da tarefa |
| `finish-planning <tarefa> --plan <artefato.json>` | Confere e registra o plano específico; libera execução se não houver pausa preservada |
| `start <tarefa> --agent <nome>` | Registra executor e inicia tentativa |
| `progress <tarefa> --step <índice> --agent <executor>` | Registra o passo atual do plano durante a execução, começando em 1 |
| `review <tarefa> --agent <nome>` | Encaminha trabalho para revisão |
| `review-progress <tarefa> --step <índice> --agent <revisor>` | Registra os critérios percorridos na revisão, em ordem |
| `show-check <tarefa> --check <índice> --attempt <número>` | Mostra a saída completa, pasta, código de saída e reuso de um check registrado |
| `validate <tarefa> --ok --summary <frase> --evidence <texto> --cwd <diretório> [--tail <linhas>]` | Executa o contrato, guarda resumo curto e evidência completa e mostra até 15 linhas; falha real impede aprovação |
| `validate <tarefa> --failed --summary <frase> --evidence <texto>` | Registra reprovação com resumo opcional e evidência completa |
| `done <tarefa>` | Conclui com evidência válida da tentativa e revisor atuais |
| `fail <tarefa> --reason <texto>` | Registra falha real da tentativa |
| `retry <tarefa>` | Volta de failed para pending; reutiliza plano atual somente em correção limitada com contexto imutável da tarefa e do plano global e motivo de revisão válido |
| `block <tarefa> --reason <texto> [--question <texto>] [--option <texto>...]` | Pausa preservando a fase anterior e, quando informada, a decisão necessária para retomar |
| `unblock <tarefa> [--answer <texto>]` | Restaura a fase anterior; registra pergunta e resposta no histórico quando houver decisão |
| `unblock <tarefa> --reviewer <nome>` | Leva tentativa ativa pausada diretamente à revisão |
| `skip <tarefa> --reason <texto>` | Pula uma vez por decisão explícita não vazia; uma tentativa ativa termina como skipped sem inventar recibo de validação |
| `note <tarefa> --text <texto>` | Acrescenta nota ao histórico |

Antes de `validate --ok`, o revisor inspeciona a saída dos checks. `show-check` exibe o recibo completo;
`validate` mostra por padrão as últimas 15 linhas de cada check funcional ou falho. `--tail 0` oculta
essa prévia, mas mantém a saída integral no recibo. Linhas de resumo são marcadas como texto; a aprovação
depende do código de saída e do resultado relevante, não de palavras como “passed”. Em inspeções com
checks ou critérios estruturados, percorra cada item com `review-progress` antes de aprovar. O evento
registra um relato rastreável do revisor; não prova que houve inspeção nem que o trabalho passou. Um
estado legado sem denominador continua sem total inventado.

Depois que o usuário aprovar o plano, pergunte se a autorização cobre a execução inteira, uma fase ou
tarefas escolhidas, e se o modo é `auto` ou `manual`. Só então execute `authorize` com
`--confirmed-by-user`. O comando registra o aceite; não cria agentes nem inicia tarefas ou fases.
`ready` e `status` mostram autorização por tarefa, vagas livres e uma ação sugerida. No modo `auto`,
preencha vagas livres com tarefas autorizadas quando revisão ou conclusão liberar capacidade. No modo
`manual`, pergunte ao usuário antes de cada despacho. Exija `--confirmed-by-user` em cada `start`,
`review`, `retry` e `unblock` que retome uma tentativa ativa; o motor registra esse aceite com ID da autorização,
data e canal no evento e na lista ordenada `manualConfirmations[]` da tentativa. Os campos singulares antigos
continuam mostrando a confirmação mais recente por compatibilidade. O modo `auto` não exige confirmação repetida.
`sync-plan` ou `refresh-contract` remove o aceite da tarefa cujo contrato mudou até nova confirmação.
Uma decisão global alterada exige novo aceite das tarefas não terminais
afetadas; tentativas já em andamento continuam no estado persistido.

Quando `done`, `skip` ou `sync-plan` liberar uma fase para discussão, leia o evento `phase_eligible`,
informe ao usuário a fase e as tarefas e recomende `begin-phase-discussion <fase>`. Aguarde a escolha
explícita; a elegibilidade não inicia a fase. Se `block` registrar `--question` e opções, apresente a
pergunta pela abordagem PO First e registre a resposta em `unblock --answer`. Bloqueios legados que
contêm somente motivo continuam aceitando `unblock` sem resposta.

O histórico mostra `Executando T4 [2/4]` a partir dos passos de `taskPlan.steps`, conforme o executor
informa o avanço ao orquestrador. O índice indica o passo atual, não uma aprovação; repetição é
idempotente e uma tentativa nova reinicia em 1. Sem plano registrado, não se inventa o total.
Na revisão, `Revisão T4 [2/4]` acompanha os checks do contrato automaticamente, com início, resultado
e indicação de reutilização quando aplicável. Falhas interrompem os próximos checks.

A legenda segue o fluxo: aguardando → pronto para discussão → discussão do orquestrador →
pronto para planejamento → em planejamento → pronto para executar → em execução → em revisão → validado → concluído.
Discussão é um estado do motor conduzido na conversa principal; não cria outro agente. As ferramentas de perguntas são escolhidas pelas capacidades e restrições
da sessão, incluindo perguntas nativas assíncronas quando disponíveis fora do modo Plan.
| `refresh-contract <tarefa> --plan <arquivo-aprovado>` | Atualiza somente validação, modo e justificativa |
| `sync-plan --plan <arquivo-aprovado>` | Acrescenta tarefas e reconcilia alterações permitidas |

`--force` não aprova lint como prova funcional nem permite concluir com recibo inválido ou autorrevisão. Exceções explícitas de agendamento e substituição de uma execução inicial exigem a autorização pertinente.

## Planos em andamento

`sync-plan` atualiza o contrato completo de qualquer tarefa não terminal sem mudar estado, tentativas, agentes, notas, evidências ou bloqueio. A saída mostra por tarefa os campos aplicados, resume contratos de validação sem imprimir seu conteúdo e registra no evento estruturado avisos de contradição entre dependências e `blockReason`. Mudanças de escopo deixam o planejamento anterior desatualizado e impedem revisão ou conclusão até que o trabalho seja bloqueado e replanejado. Tarefas done/skipped permanecem como histórico imutável e exigem acompanhamento explícito. Remover tarefas pelo sync é recusado. Quando uma run migrada ainda aponta para uma origem graph-foreman removida, o comando recupera o plano correspondente no workspace central do Prumo.

O `sync-plan` também avisa quando invalida uma discussão/rodada de planejamento aberta ou um skip atual, mas continua a sincronização. `begin-phase-discussion` encerra uma rodada aberta desatualizada como `superseded` e registra a causa. `status` e `ready` comparam a fonte aprovada aos contratos persistidos e informam IDs de tarefas e campos divergentes. Fonte ausente ou ilegível gera um aviso curto, sem bloquear os comandos. Uma rodada de planejamento aberta mostra sua idade e a contagem de artefatos aceitos (`0/N`); após gravar o lote, mostra `N/N`.

Use `show-contract <tarefa> [--diff]` para conferir o contrato de negócio completo antes/depois da alteração. Ele exibe o texto integral de `expect` e da justificativa de inspeção, mas omite os comandos executáveis `validation.run`. Quando uma alteração reabre uma fase que já teve discussão, planejamento ou skip atual, a nova discussão precisa pedir ao usuário que aceite o contrato alterado. Confira cada alvo atual e inclua os pares exatos de tarefa/digest impressos por `begin-phase-discussion` em `questions[].confirmsContract` de uma pergunta respondida. O motor exige todos os digests atuais; um skip não substitui essa confirmação. Depois do aceite registrado, a escolha normal de pular o planejamento continua disponível.

Use `refresh-contract` quando a única mudança aprovada for validação. Ele preserva estado, tentativas, agentes, notas e bloqueio. A revisão do contrato invalida recibos anteriores, mesmo quando o texto volta à versão anterior, e revoga a autorização de execução, preservando-a no histórico até novo aceite.

Trabalho entregue pode seguir à revisão, que pode completar verificações faltantes. Não use fail/retry **somente** para atualizar contrato nem registre erro de orquestração como falha do executor. Um bloqueio solicitado permanece até uma decisão explícita de desbloqueio.

Nas tarefas que exigem planejamento, mudanças na tarefa, dependências ou decisões globais podem invalidar a pesquisa.
Uma implementação reprovada pelo revisor pode reutilizar o plano aprovado somente para correção limitada,
com motivo acionável, enquanto todo o contexto de planejamento continuar igual, incluindo revisões do
contrato e do planejamento, descoberta, escopo e resultados das dependências. O engine registra a origem
imutável do plano em `planSourceAttempt` e a tentativa imediatamente reprovada em `correctionOf`.
Use `fail --plan-defect --reason "..."` quando o próprio plano estiver errado; esse retry exige nova
discussão e planejamento, preservando planos anteriores. Se o escopo de execução mudar durante running
ou reviewing, bloqueie, sincronize a mudança aprovada e dispare `plan-task` na tarefa bloqueada.
`finish-planning` devolve a tarefa a **blocked**, mantendo fase anterior, motivo e tentativa aberta;
`unblock` explícito retoma a mesma tentativa. Não invente fail/retry para replanejar. Recibos do escopo
anterior não aprovam o novo. Uma mudança somente de validação continua usando `refresh-contract`
e nova verificação na mesma tentativa.

Antes de qualquer passagem para revisão, o executor em execução continua responsável pelos obstáculos
recuperáveis. Ele inspeciona a falha, faz pesquisa adicional direcionada quando necessário, muda a
estratégia dentro do contrato aprovado, tenta alternativas seguras e repete as verificações relevantes
até acreditar, com base nas evidências, que o plano completo satisfaz todos os critérios. A revisão é uma
etapa de validação, não uma triagem de falhas. Bloqueio antes da passagem só é adequado por falta de
autoridade, decisão consequencial ainda indefinida, risco destrutivo não autorizado, dependência externa
indisponível após tentativas proporcionais ou impossibilidade comprovada. Essas rotações de estratégia
reutilizam o mesmo plano imutável e nunca disparam outro planejador para o mesmo contrato.

Bloquear durante planejamento preserva essa fase; desbloquear retoma a pesquisa, respeitando
dependências, capacidade e disponibilidade do agente. Confira estado e agente reais após interrupções.

### Reprovação real com alteração aprovada do contrato

Corrigir um defeito dentro do escopo aprovado já está autorizado. Uma orientação explícita do usuário pode aprovar um critério novo; peça decisão apenas se o novo escopo continuar indefinido. Solicitação nova não transforma retroativamente uma entrega correta em falha.

Quando a entrega foi realmente reprovada e o contrato aprovado também mudou:

1. Preserve a evidência e registre `fail <tarefa> --reason <critério-real-não-atendido>`.
2. Edite o plano aprovado, substituindo critérios obsoletos. Use o editor existente, backup único e confira o diff e possíveis alterações concorrentes; não é obrigatório criar um script de adaptação.
3. Rode `sync-plan --plan <arquivo-aprovado>` enquanto a tarefa está `failed`. Confira em `graph` o contrato, as dependências e os caminhos de escrita persistidos.
4. Rode `retry <tarefa>`, faça novo planejamento e só então use `start <tarefa> --agent <executor>`.

Acrescente `--run <nome>` em cada chamada. `retry` não recarrega o plano e recusa contrato divergente ou mudança ainda não sincronizada nas decisões globais `name`, `description` e `requireReview`; `refresh-contract` só muda validação e não registra reprovação. Se apenas faltam atualizar verificações da entrega correta, use refresh e revisão na mesma tentativa. Novos requisitos após conclusão exigem acompanhamento explícito.

Retome da fase persistida, sem repetir a sequência inteira. Se `plan-task`, `start` ou `review` foi registrado, mas o agente não foi disparado, complete o disparo na mesma rodada/tentativa quando autorizado. Confirme o agente real. Se o disparo está indisponível ou o usuário pausou, registre bloqueio pelo motivo de orquestração. Um nome no estado não prova execução. Corrija relatos com notas e preserve tentativas anteriores.

## Dashboard

```sh
prumo dashboard status
prumo dashboard enable
# ou, em primeiro plano:
prumo dashboard
```

O endereço padrão é `http://localhost:4949`, restrito à máquina. O serviço global é somente leitura e mostra workspaces centrais conhecidos e projetos registrados. Para reconciliar um plano aprovado, o orquestrador chama `sync-plan` explicitamente no motor. Porta ocupada não provoca encerramento de outro processo.

`prumo dashboard enable` inicia o servidor imediatamente e registra a inicialização para o usuário atual. No Windows, o Prumo tenta primeiro a tarefa ONLOGON `Prumo Dashboard` no Agendador de Tarefas. Se o Windows recusar ou não conseguir criar essa tarefa, uma única entrada oculta gerenciada pelo Prumo é criada automaticamente na pasta Inicializar do usuário atual, sem pedir acesso de administrador. O mecanismo escolhido persiste em consultas, reinícios, atualizações e reinstalações; `prumo dashboard status` o informa. `prumo dashboard disable` remove somente esse registro e encerra apenas um processo cujo comando absoluto completo do Node e do servidor foi comprovado.

O painel apresenta estados, dependências, tentativas, evidências, eventos e tempos derivados. O idioma segue a preferência da instalação ou a escolha explícita de execução; não há seletor no navegador. Textos do usuário são escapados e não traduzidos. Os números não provam cobertura de testes, causas de defeitos ou regras de negócio.

| Estado efetivo | Significado | Cor |
|---|---|---|
| `waiting` | Aguardando dependências | Cinza |
| `ready_for_discussion` | A fase precisa de descoberta atual; não exige dependências concluídas | Violeta |
| `discussing` | A discussão persistida da fase está ativa na conversa principal | Violeta |
| `ready_to_plan` | A discussão persistida terminou; o planejador pode começar antes das dependências | Azul |
| `planning` | Um planejador somente leitura compõe planos separados para as tarefas da fase | Rosa |
| `ready` | Pronto para executar; em tarefa legada, prontidão original | Verde-azulado |
| `running` | Em execução | Âmbar |
| `reviewing` | Em revisão | Ciano |
| `done` | Concluído | Verde |
| `failed` | Falhou | Vermelho |
| `blocked` | Bloqueado | Roxo |
| `skipped` | Pulado por decisão explícita | Cinza |

`pending` é persistido na tarefa; as prontidões são calculadas pelas dependências e pelo plano atual.
O fluxo da fase persiste `ready_for_discussion`, `discussing`, `ready_to_plan` e `planning`
independentemente. Assim, discussão e planejamento podem estar ativos enquanto um card continua
`waiting` pelas próprias entradas.
O planejador aparece junto do orquestrador e do revisor, com conexões às tarefas em planejamento.
Os detalhes mostram pesquisa, decisões, passos, verificações e perguntas. Resultados separam tempo
de planejamento, execução e revisão; pausas ficam fora do tempo ativo de planejamento.

Encerrar o dashboard não cancela trabalho. Instalação e atualização reiniciam o dashboard habilitado para carregar a versão instalada; a desativação explícita é preservada. Esses comandos não reiniciam agentes.
