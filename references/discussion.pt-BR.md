# Discussão da fase

[English](discussion.md)

Leia isto quando uma fase ou tarefa estiver `ready_for_discussion` ou `discussing`, quando o usuário precisar escolher
entre discutir ou planejar, ou quando o motor informar uma fase recém-elegível. A discussão acontece na
conversa principal; é um estado do motor, não outro agente. O planejamento em si está em
[planning.pt-BR.md](planning.pt-BR.md); o schema JSON da descoberta está em [runtime.pt-BR.md](runtime.pt-BR.md#artefato-de-plano-da-tarefa).

## Dois níveis de planejamento

O modo global Plan/Spec define e aprova o grafo e continua obrigatório. Discussão e planejamento são
duas etapas opcionais e independentes para toda fase elegível; execução e revisão independente continuam obrigatórias.
Antes de cada etapa, examine sinais observáveis como tamanho e complexidade do escopo, ambiguidade, impacto,
dependências, novidade, risco e
se o contrato/contexto aprovado já é suficiente. Dê uma recomendação fundamentada para realizar ou
pular aquela etapa, deixe claro que ela é opcional, ofereça as duas escolhas e aguarde a escolha explícita do usuário.
Nunca use economia de tokens como motivo para pular e nunca imponha a recomendação. A etapa existe para capturar
incerteza consequente, e só o usuário pode aceitar o risco de pulá-la. Registre a dispensa com um
motivo não vazio e `--confirmed-by-user`. As combinações suportadas são discutir+planejar, pular discussão+planejar,
discutir+pular planejamento e pular ambas.

```bash
node $ENGINE begin-phase-discussion F2          # depois que o usuário escolhe a discussão
node $ENGINE skip-phase-discussion F2 --reason "..." --confirmed-by-user
node $ENGINE skip-phase-planning F2 --reason "..." --confirmed-by-user
```

Uma fase só pode iniciar a discussão
ou o planejamento quando toda dependência externa de todo membro não concluído estiver `done` ou `skipped`.
Um membro bloqueado bloqueia a fase inteira, inclusive membros sem dependências. Dependências internas
dentro da mesma fase controlam a execução, não o planejamento da fase. A numeração das fases, por si só, nunca bloqueia fases
independentes. O usuário escolhe quais fases elegíveis planejar, inclusive várias fases em paralelo; a elegibilidade
não autoriza abrir todas as fases automaticamente. Mantenha as atribuições de fase e as cadeias de dependência
aprovadas. `touches` sobrepostos devem ser resolvidos pelo grafo de dependências aprovado, não movendo tarefas.

## Quando uma fase fica elegível

Depois de `done`, `skip` ou `sync-plan`, examine qualquer evento `phase_eligible` e a sugestão do motor. Diga ao
usuário qual fase e quais tarefas estão prontas para discussão e então recomende `begin-phase-discussion <phase>`. Aguarde
a escolha do usuário antes de iniciá-la; a elegibilidade, por si só, nunca abre uma fase.

## Conduzindo a descoberta

Quando o usuário escolhe a discussão, o orquestrador conduz um protocolo de descoberta agnóstico na conversa principal
do Codex, Claude Code, Kiro ou DSH. Carregue o plano global, as decisões já tomadas e as saídas das dependências;
explore o código e os artefatos atuais da fase; identifique zonas cinzentas específicas do PO First; então faça pelo
menos uma pergunta contextual. Escolha o canal de pergunta entre as ferramentas efetivamente expostas e permitidas na
sessão principal, respeitando o schema atual e as restrições de modo delas (veja os canais abaixo).

A discussão resolve significado e decisões; ela não entrega uma tarefa. Inspeção local do código-fonte é permitida.
Não execute builds, testes, comandos de aceite, consultas a banco de dados ou cluster, sondagens de APIs externas, migrações
ou gravações quando a saída deles for, ela própria, o resultado ou a evidência de aceite de uma tarefa-alvo. O planejador pode fazer
pesquisa somente leitura necessária para determinar **como** o executor deve trabalhar, mas não deve produzir o
resultado solicitado. O executor realiza todo entregável da tarefa, inclusive uma medição somente leitura quando essa medição
é a tarefa. Classifique um comando ambíguo pelo seu propósito: se um resultado bem-sucedido puder satisfazer uma tarefa ou um
dos seus critérios de aceite, deixe-o para o executor dessa tarefa.

### Canais de pergunta

- **Codex:** antes de recorrer ao chat, examine os nomes das ferramentas efetivamente expostas. Chame
  `request_user_input_async` primeiro quando ela estiver presente; é o wrapper não bloqueante preferido e pode estar
  disponível no modo Default. Caso contrário, chame `request_user_input` apenas quando as regras do modo atual permitirem.
  O nome de protocolo do app-server `tool/requestUserInput` descreve a requisição host/cliente por baixo desses
  wrappers; ele não é, por si só, um nome de ferramenta que o modelo possa chamar. A indisponibilidade de um `request_user_input` exclusivo do Plan
  não prova que `request_user_input_async` esteja ausente, e lembrar de uma ferramenta de outra sessão não
  prova que o host atual a expôs.
- **Claude Code:** use `AskUserQuestion` quando exposta. Mantenha a descoberta na conversa principal;
  não presuma que a ferramenta esteja disponível para um subagente ou uma integração SDK restrita.
- **Kiro, DSH ou outro ambiente:** use uma ferramenta nativa de esclarecimento exposta, se houver. Não invente
  um nome de ferramenta nem deduza suporte apenas pelo nome do produto ou pelo modo Plan.
- **Alternativa (fallback):** somente depois que o inventário atual de ferramentas não tiver nenhum wrapper nativo permitido, ou que o wrapper exposto
  informar explicitamente operação não suportada,
  pergunte na mesma conversa usando **O que entendi**, **Zonas cinzentas**, **Sugestões** e **Perguntas**
  numeradas e focadas, traduzidos para o idioma do usuário. No Kiro CLI, o usuário pode opcionalmente usar
  `/reply` para responder ponto a ponto; é um comando do usuário, não uma ferramenta de pergunta do agente.

Preserve as perguntas pendentes ao trocar de canal; não repita uma chamada não suportada nem altere permissões do host
para forçá-la. Aguarde respostas reais antes de encerrar a descoberta ou disparar o planejador dela.
O retorno de uma chamada assíncrona, um timeout, um resultado vazio ou uma sugestão pré-selecionada não é uma resposta.
Continue a pesquisa independente enquanto aguarda. Registre apenas o canal que de fato recebeu cada resposta.
Reaproveite as respostas atuais, faça perguntas de acompanhamento adaptativas e pare somente quando não restar incerteza capaz de
mudar comportamento, escopo, aceite ou execução. Coloque ideias fora do escopo em `deferred`.

## Mudanças de contrato antes e durante uma rodada

Edite o plano aprovado e execute `sync-plan` ANTES de `begin-phase-discussion` ou `begin-discussion`. Alterar o
contrato de uma tarefa enquanto a rodada dela está aberta invalida essa rodada: `sync-plan` avisa, e o próximo `begin-*`
imprime a rodada substituída com a causa, incluindo os campos do contrato que `sync-plan` alterou. Se as
respostas do usuário mudarem o contrato no meio da rodada, registre a decisão, edite o plano, execute `sync-plan` e então
inicie uma rodada nova em vez de encerrar a obsoleta. As regras de sincronização em si estão em
[recovery.pt-BR.md](recovery.pt-BR.md#sincronizar-uma-mudança-aprovada-do-plano).

Uma fase reaberta depois de uma mudança de contrato sincronizada também precisa de um aceite explícito. Execute `show-contract
<task> --diff` para cada alvo atual, apresente ao usuário o texto de negócio completo e pergunte se ele aceita
o contrato alterado. Acrescente a lista exata de tarefa/digest impressa por `begin-phase-discussion` em
`questions[].confirmsContract` de uma pergunta recém-respondida. `finish-phase-discussion` confere se toda
tarefa e todo digest atuais estão presentes. Um digest obsoleto ou uma dispensa de discussão/planejamento não satisfaz esta etapa.

## Registrando a descoberta

Execute `begin-phase-discussion` antes de apresentar a primeira pergunta. Ele persiste a fase como `discussing` e emite o
`roundId` e o `nonce` atuais. Grave o JSON de descoberta resultante com esses valores e vincule pelo menos
uma pergunta recém-respondida a esse `roundId`; inclua a pesquisa leve, o canal real `native` ou
`chat-fallback`, a cobertura PO First, as decisões, as ideias adiadas, `executionBoundary` e o encerramento.
`executionBoundary.deferredToExecutor` deve nomear toda tarefa-alvo, e `prematureTaskWork` normalmente fica
vazio. Se houve trabalho de tarefa durante a discussão, registre a tarefa e a ação, pare, avise o usuário e não
reaproveite o resultado. Somente após aprovação explícita do usuário `finish-*-discussion --accept-premature-work` pode encerrar
a rodada; o executor ainda repete o trabalho. Então execute:

```bash
node $ENGINE finish-phase-discussion F2 --context <discovery.json>
node $ENGINE plan-phase F2 --agent <planner> --plan-dir <artifact-directory>
node $ENGINE finish-phase-planning F2 --plan-dir <artifact-directory>
```

Passar o diretório de artefatos para `plan-phase` é opcional; com ele, `status` e `ready` contam os
arquivos `task-plan-<id>.json` já gravados ali enquanto a rodada está aberta. Antes de disparar o
planejador, leia [planning.pt-BR.md](planning.pt-BR.md).

## Discussão por tarefa em execuções existentes

Execuções existentes com escopo por tarefa usam `begin-discussion`, `finish-discussion`, `plan-task` e
`finish-planning` quando o usuário selecionou explicitamente uma tarefa existente ou quando os limites de fase legados
não podem ser mapeados sem ampliar o escopo. Esse caminho ainda recebe a descoberta atual e exatamente um
planejador somente leitura. Caso contrário, adote explicitamente uma fase segura inteira com
`begin-phase-discussion <phase> --adopt-legacy`; o histórico terminal é preservado e todo membro adotado
não terminal ainda deve estar antes da execução, sem rodada aberta. As dispensas no nível da tarefa são
`skip-discussion <task>` e `skip-planning <task>`, com os mesmos `--reason` e `--confirmed-by-user`.
