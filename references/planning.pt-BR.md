# Pesquisa da fase e planos por tarefa

[English](planning.md)

Leia isto quando uma fase ou tarefa estiver em `ready_to_plan` ou `planning`: antes de disparar o planejador (ou
planejar localmente), quando um planejador devolver artefatos e depois que `finish-phase-planning`/`finish-planning`
imprimir perguntas em aberto. O schema do artefato está em [runtime.pt-BR.md](runtime.pt-BR.md#artefato-de-plano-da-tarefa); a descoberta
vem antes, em [discussion.pt-BR.md](discussion.pt-BR.md).

## Conteúdo

- [Quem planeja e com quais permissões](#quem-planeja-e-com-quais-permissões)
- [O que o planejador produz](#o-que-o-planejador-produz)
- [Prompt do planejador (inglês)](#prompt-do-planejador-inglês)
- [Prompt do planejador (português)](#prompt-do-planejador-português)
- [Registrando os artefatos](#registrando-os-artefatos)
- [Linha de base antes de executar](#linha-de-base-antes-de-executar)
- [Perguntas abertas depois do planejamento](#perguntas-abertas-depois-do-planejamento)

## Quem planeja e com quais permissões

Depois que a descoberta termina, cada alvo ativo da fase recebe um trabalhador de planejamento somente leitura,
e cada contrato de tarefa aprovado recebe exatamente um planejador (veja "One planner per approved task contract"
em [SKILL.md](../SKILL.md)). Os comandos de fase aceitam `--agent <task>=<agente-nativo>` repetido, cobrindo
cada alvo uma vez com nomes distintos, ou um prefixo que registra `<prefixo>:<task>`. Esses nomes são atribuições
persistidas, não criação de agentes nativos: confira as ferramentas reais, crie os agentes com os nomes exatos e
despache somente `activeTargets`; um coordenador não pode representar vários workers. Primeiro confira as ferramentas e permissões reais desta sessão para determinar
se os trabalhadores podem ser disparados e se conseguem gravar no diretório de artefatos indicado. Nunca deduza
nenhuma dessas capacidades pelo nome do harness. Cada trabalhador continua somente leitura para o trabalho do
projeto e pode gravar apenas o artefato designado para seu alvo.
Pesquise primeiro o código atual, os artefatos, as saídas de dependências, as regras do projeto e a documentação
de origem relevante; reaproveite pesquisas anteriores úteis, mas confirme que ainda se aplicam. Inspeção
somente leitura e verificações seguras de pesquisa são permitidas. O planejador grava somente o artefato de plano
da tarefa designado; ele não implementa a tarefa nem edita o estado do grafo. Se não houver subagente planejador
dedicado disponível, o orquestrador informa essa limitação e faz o mesmo planejamento localmente, com
pesquisa somente leitura e apenas a gravação do artefato designado. Esse fallback não autoriza implementação
do produto. Registre o ator de planejamento local seguindo as mesmas regras de capacidade; nunca o descreva
como um subagente nativo. Se houver apenas um ator, obtenha a escolha do usuário para definir o limite em 1
antes de abrir uma fase, para não inventar identidades paralelas. Trabalhadores de planejamento ativos usam a mesma cota `maxAgents` compartilhada
com discussão, execução e revisão; alvos de fase enfileirados não consomem vaga. `maxParallel`/`maxExecutors`
legados são apenas metadados ([dispatch.pt-BR.md](dispatch.pt-BR.md#capacidade)).

Consuma a descoberta persistida e não repita suas perguntas. Aplique PO First para pesquisar a fundo a abordagem
de implementação escolhida, os impactos e a verificação. Se a pesquisa revelar uma nova decisão consequencial,
devolva-a ao orquestrador: atualize a descoberta pela conversa principal e dispare um
novo planejamento. Nunca invente uma resposta nem rotule uma lacuna material como não bloqueante para passar da etapa.
Refinamento comum dentro do escopo aprovado não precisa de nova aprovação da tarefa. Mudanças materiais de
escopo, comportamento, aceite ou decisões compartilhadas voltam ao usuário e ao fluxo do plano global.
Encerre a pesquisa quando cada critério material e cada dependência estiverem mapeados para evidência atual e não
restar risco concreto sem resolução. Não releia fontes equivalentes nem amplie a investigação só
para acumular confiança; registre uma lacuna real em vez de buscar certeza indefinidamente.

## O que o planejador produz

Quando se escolhe planejar, o trabalhador ativo grava `task-plan-<id>.json` para seu alvo. Nunca transforme passos, lacunas de evidência,
pré-requisitos ou saídas de dependências de uma tarefa explicitamente selecionada em tarefas separadas do grafo ou
em atribuições separadas de planejador sem aprovação explícita do usuário. O motor valida o lote inteiro
antes de registrar qualquer artefato final. O planejamento da fase valida a onda ativa, coloca seus planos em
staging, abre a próxima onda e só registra todos os planos atomicamente na última onda. Cada artefato é imutável e lista dependências diretas incompletas como
entradas não resolvidas. Um recibo de validação revisado de forma independente de um produtor posterior, ou uma dispensa explícita de pulo,
satisfaz essa entrada no momento da execução sem reescrever o plano. Mudanças de contrato invalidam apenas o plano
afetado e os escopos realmente a jusante; a descoberta compartilhada da fase invalida os planos não terminais daquela fase; um
defeito de plano marcado invalida apenas aquela tarefa.

Todo plano de tarefa pode acrescentar `verification[].requires` usando o vocabulário de recursos documentado e uma lista `writes`
com os caminhos de projeto previstos. `writes` precisa caber nos `touches` aprovados da tarefa; `writes` ausente ou vazio
gera um aviso que o revisor precisa resolver a partir do diff real. Um recurso exigido e indisponível é um
aviso de planejamento não bloqueante. Mantenha `manual-inspection` visível como pendente para o revisor e o usuário até
que a inspeção tenha evidência atual; nunca a deduza pelo nome do harness.

O motor calcula o hash da descoberta validada e do recibo emitido com JSON canônico e vincula esse digest à
rodada de planejamento e aos planos finais das tarefas. Repetir `plan-phase` enquanto essa rodada está ativa
preserva as atribuições e pode ativar a próxima onda enfileirada. `finish-phase-discussion` valida a descoberta
somente para a onda ativa, acumula cada onda concluída e abre a próxima. `finish-phase-planning` recusa uma
rodada cuja descoberta não corresponde mais ao contexto persistido.

Em planos com `scopePolicy: "explicit"`, investigue `writeScope`, `touches` e `sharedResources` antes de propor `writes`. Para `read-only`, `writes` fica vazio ou ausente. Para `files`, `writes` deve caber nos prefixos aprovados; ausência continua sendo um aviso, não autorização para gravar fora deles. Escopo `unknown` não autoriza execução: devolva a investigação para alterar o contrato por `sync-plan`, sem inventar caminhos. Recurso compartilhado com qualquer gravação exige dependências; não deduza independência só pelos arquivos.

## Prompt do planejador (inglês)

```text
You are the read-only PLANNING WORKER assigned to the active target(s) of the approved phase. Inspect the actual tools and write permissions available to you; do not infer capabilities from the harness name. Work
only on the target IDs assigned to your exact native agent name; do not act on queued targets and do not implement them.
Read project rules, approved objective/constraints, member contracts and known dependency outputs: <references>.
Read the persisted phase discovery and its locked decisions: <phaseWorkflows.F2.discovery from state.json>.
Use the available tools to inspect the current implementation/artifacts, real project rules, dependency outputs
and relevant sources; identify existing solutions and impacts.
Apply PO First. Do not repeat discovery questions; return newly found consequential gaps to the orchestrator.
For product text you recommend, state the observable business rule and why; name its owner only when approved
context establishes it, otherwise surface the ownership question to the PO. Keep workflow identifiers and
internal process details out of comments, tests, messages and README drafts; required planning identifiers
belong only in the designated task-plan contract fields.
Preserve known decisions; propose any material contract change for the authorized global-plan workflow.
Include `summary` in each artifact: 1–2 sentences describing the chosen approach and why it meets the expected result.
Write ONLY the exact `task-plan-<id>.json` for each active target in <absolute artifact directory>: research, decisions,
steps, verification, open questions, writes, phaseBinding and unresolvedInputs. For every open question,
state who decides and by when with `decideBy`: `executor` (with the proposed `answer` the executor applies),
`user-now`, `{ "beforeTask": "<id>" }` or `{ "beforePhase": "<id>" }`. Each verification item may
declare required resources with `requires`; use only the documented vocabulary. Record anticipated project
paths in `writes`, all contained by that task's `touches`; use no file writes for `read-only`. Investigate shared resource access and unresolved scope; never invent paths. Copy the exact phaseBinding and
that task's unresolvedInputs from the `plan-phase` output; do not recalculate them or renumber plannerRound.
When discussion was skipped, discussionRoundId is the confirmed skip decisionId printed by the engine.
Schema: references/runtime.md#task-plan-artifact.
Inspect the real `git status --short` and relevant staged/unstaged diff while planning. Identify changes
already present before execution so the reviewer can distinguish them from this task's delivery.
If you can write to the indicated directory, write only the exact task-plan-<id>.json file there for each
target. If you cannot write it, return one complete artifact per task: put its exact filename on the line
immediately before a block opened with ```json containing the entire valid JSON object. Do not abbreviate, omit
fields, use ellipses or return a partial object. The orchestrator decodes &gt;, &lt;, &amp; and &quot; in JSON
string values, validates each complete object, writes each artifact to the indicated directory and then
finishes planning. If validation reports a correction, send it back to the planner to fix; the orchestrator
must not invent missing plan content.
Inspect the actual available tools and permissions; never infer file-write or subagent capability from the
harness name. If no planner subagent is available, report that limitation and do this planning locally with
read-only research, writing only the designated task-plan artifact. Do not implement product work.
Do not edit .specs/graph/ state. Report the artifact path, findings and any decision that blocks execution.
```

As mesmas regras de artefato, capacidade, fallback com JSON completo e correção valem para o planejamento por tarefa.
Use o diretório de artefatos e o schema de tarefa informados para essa tarefa, sem acrescentar campos de vínculo exclusivos de fase.

## Prompt do planejador (português)

Quando a conversa de planejamento estiver em português, use este prompt equivalente do planejador:

```text
Você é o TRABALHADOR DE PLANEJAMENTO somente leitura atribuído aos alvos ativos da fase aprovada. Confira
as ferramentas e permissões de gravação realmente disponíveis; não deduza capacidades pelo nome do harness.
Trabalhe somente nos IDs atribuídos ao seu nome nativo exato; não atue sobre alvos enfileirados nem implemente tarefas.
Leia as regras do projeto, o objetivo e as restrições aprovados, os contratos das tarefas e as saídas de
dependências conhecidas: <referências>.
Leia a descoberta persistida da fase e suas decisões travadas: <phaseWorkflows.F2.discovery do state.json>.
Use as ferramentas disponíveis para inspecionar a implementação e os artefatos atuais, as regras reais do
projeto, as saídas de dependências e as fontes relevantes; identifique soluções existentes e impactos.
Aplique PO First. Não repita perguntas da descoberta; devolva ao orquestrador novas lacunas consequenciais.
Se recomendar texto de produto, descreva a regra observável e o motivo; nomeie a área responsável apenas
quando o contexto aprovado confirmar essa informação; caso contrário, leve a dúvida de responsabilidade ao PO.
Mantenha identificadores e detalhes internos do fluxo fora de comentários, testes, mensagens e rascunhos de
README; identificadores exigidos pelo planejamento pertencem somente aos campos do contrato do task-plan.
Preserve as decisões conhecidas; proponha qualquer mudança material de contrato para o fluxo autorizado do plano global.
Inclua `summary` em cada artefato: 1–2 frases descrevendo a abordagem escolhida e por que ela atende ao resultado esperado.
Grave SOMENTE o `task-plan-<id>.json` exato de cada alvo ativo em <diretório absoluto do artefato>: research, decisions,
steps, verification, openQuestions, writes, phaseBinding e unresolvedInputs. Para cada pergunta em aberto,
diga quem decide e até quando com `decideBy`: `executor` (com a resposta proposta em `answer`, que o executor
aplica), `user-now`, `{ "beforeTask": "<id>" }` ou `{ "beforePhase": "<id>" }`. Cada item de verificação pode
declarar recursos exigidos com `requires`; use somente o vocabulário documentado. Registre em `writes` os
caminhos de projeto previstos, todos contidos nos `touches` da tarefa; não declare gravações de arquivos para `read-only`. Investigue acesso a recursos compartilhados e escopo pendente; não invente caminhos. Copie exatamente phaseBinding e os
unresolvedInputs da tarefa do resultado de `plan-phase`; não os recalcule nem renumere plannerRound.
Quando a discussão foi pulada, discussionRoundId é o decisionId da confirmação do pulo impresso pelo motor.
Schema: references/runtime.md#task-plan-artifact.
Inspecione o `git status --short` real e o diff relevante, staged e unstaged, durante o planejamento.
Identifique mudanças já presentes antes da execução para que o revisor as distinga da entrega desta tarefa.
Se puder gravar no diretório indicado, grave somente o arquivo exato task-plan-<id>.json para cada tarefa.
Se não puder gravar, devolva um artefato completo por tarefa: escreva o nome exato do arquivo na linha
imediatamente antes de um bloco aberto com ```json que contenha o objeto JSON inteiro e válido. Não abrevie,
omita campos, use reticências nem devolva objeto parcial. O orquestrador decodifica &gt;, &lt;, &amp; e &quot;
nos valores de texto do JSON, valida cada objeto completo, grava cada artefato no diretório indicado e então
conclui o planejamento. Se a validação apontar uma correção, ela volta ao planejador; o orquestrador não
inventa conteúdo de plano ausente.
Se não houver subagente planejador disponível, informe essa limitação e faça o planejamento localmente, com
pesquisa somente leitura, gravando apenas o artefato task-plan indicado. Não implemente o trabalho de produto.
Não edite o estado em .specs/graph/. Reporte o caminho do artefato, as descobertas e qualquer decisão que
bloqueie a execução.
```

## Registrando os artefatos

O orquestrador interpreta cada bloco devolvido como JSON, decodifica as entidades HTML listadas apenas dentro dos
valores de texto, valida o artefato completo, grava-o com o nome de arquivo indicado e então registra
finish-phase-planning ou finish-planning. Se a interpretação ou a validação falhar, envie a correção concreta de volta ao
planejador. O motor exige pesquisa, passos, um mapeamento para cada verificação de validação e nenhuma pergunta bloqueante sem resposta;
ele confere estrutura e atualidade, não a veracidade da pesquisa nem a identidade real do agente. `init` continua
exigindo um contrato comportamental válido: o planejamento nunca permite verificações falsas com `echo` nem exceções
de inspeção para trabalho funcional. O executor lê e reconfere o plano; o revisor independente
pode contestar um plano incompleto ou incorreto em relação ao objetivo aprovado e aos critérios atuais.
Esses papéis reduzem as oportunidades de erro; nenhum deles garante que os modelos não cometam erros.

```bash
node $ENGINE plan-phase F2 --agent T1=plan-f2-t1 --agent T2=plan-f2-t2  # trabalhadores nativos exatos dos alvos ativos
# Um único prefixo --agent plan-f2 registra plan-f2:T1, plan-f2:T2 e assim por diante; alvos enfileirados aguardam vaga.
node $ENGINE finish-phase-planning F2 --plan-dir <artifact-directory>
node $ENGINE plan-task T4 --agent <planner>     # execuções por tarefa
node $ENGINE finish-planning T4 --plan <artifact.json>
```

## Linha de base antes de executar

Antes de o executor começar, registre o `git status --short` real, o diff staged e unstaged dos
`writes` declarados da tarefa (ou dos `touches` aprovados quando `writes` estiver ausente) e os caminhos relevantes
não rastreados já existentes em uma nota durável da tarefa ou no handoff de revisão. O planejador identifica essas
mudanças existentes; o revisor compara com essa linha de base e as exclui do julgamento da entrega.

A tentativa registra os escopos de arquivos disjuntos dos executores contemporâneos; um novo executor também acrescenta seu escopo às tentativas anteriores ainda ativas. O Git observa caminhos alterados globalmente, não a autoria. Alterações fora desta tarefa só podem ser desconsideradas se couberem nesses outros escopos registrados e o revisor independente atual fornecer atribuição explícita por `--scope-evidence`. O recibo de escopo registra `excludedPaths` e a limitação de autoria. Alterações observadas fora de todos os escopos autorizados registrados sempre bloqueiam, mesmo com evidência do revisor. `done` exige a mesma impressão da entrega e a identidade do revisor do recibo aprovado; alterações após a validação exigem nova verificação. Arquivos ignorados não são auditados automaticamente: o recibo de escopo sempre expõe essa limitação e o revisor independente precisa conferi-los separadamente, sem obrigatoriedade de `--scope-evidence` somente por haver caminhos ignorados. Git/linha de base indisponíveis, submódulos e ambientes sem Git exigem `--scope-evidence` explícita, assim como a atribuição a outro executor; efeitos em recursos externos precisam de observações próprias. A impressão inclui conservadoramente todas as mudanças visíveis pelo Git: qualquer alteração após validar, inclusive de outro executor, exige nova validação para que a evidência de atribuição não fique obsoleta.

## Perguntas abertas depois do planejamento

Depois de `finish-phase-planning` ou `finish-planning`, o motor lista as perguntas em aberto para o usuário agora e
as que têm prazo posterior, e avisa quando uma pergunta `executor` não tem resposta proposta. Antes da execução,
leve ao usuário somente as perguntas `user-now`. Uma pergunta não bloqueante cuja resposta proposta o executor
aplica não é pergunta para o usuário. Uma pergunta com prazo antes de uma tarefa ou fase posterior não é feita agora e não é
agrupada com a autorização de execução; ela reaparece na discussão ou no planejamento desse alvo.

`openQuestions[].decideBy` pode ser `executor`, `user-now`, `{ "beforeTask": "T2" }` ou
`{ "beforePhase": "F2" }`; perguntas bloqueantes ainda precisam de resposta antes de o planejamento ser encerrado e significam
`user-now`. Um prazo futuro não retém sua tarefa de origem. Na tarefa ou fase indicada, a referência
aparece na discussão/planejamento e `status` a informa quando estiver vencida. Resolva-a em uma entrada posterior de `decisions`
com `resolvesQuestion` definido como a referência exibida; o início só fica bloqueado depois que esse
prazo chega. No modo de planejamento por tarefa, um prazo `{ "beforePhase": "F2" }` vence quando qualquer
tarefa de F2 inicia discussão ou planejamento.
