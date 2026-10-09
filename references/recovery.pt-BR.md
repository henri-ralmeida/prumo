# Bloqueios, retomada, mudanças de plano e execuções legadas

[English](recovery.md)

Leia isto quando uma tarefa estiver em `blocked`, quando um bloqueio ou um executor precisar de uma decisão do usuário, quando o plano
aprovado mudou depois de `init` (antes de continuar qualquer discussão, planejamento ou execução), quando `status`/`ready`
avisarem que a fonte aprovada difere dos contratos persistidos, e antes de retomar uma execução existente ou
legada. Uma entrega reprovada é tratada em [review.pt-BR.md](review.pt-BR.md#reprovação-real-inclusive-com-mudança-aprovada-do-contrato).

## Conteúdo

- [Retomar ou migrar uma execução existente](#retomar-ou-migrar-uma-execução-existente)
- [Sincronizar uma mudança aprovada do plano](#sincronizar-uma-mudança-aprovada-do-plano)
- [Adaptar uma execução legada sem refazer o que foi entregue](#adaptar-uma-execução-legada-sem-refazer-o-que-foi-entregue)
- [Bloqueios e decisões do usuário](#bloqueios-e-decisões-do-usuário)
- [Retomar trabalho pausado](#retomar-trabalho-pausado)
- [Notas sobre o ciclo de vida legado](#notas-sobre-o-ciclo-de-vida-legado)

## Retomar ou migrar uma execução existente

O dashboard global observa e expõe somente o controle explícito de cota de agentes confirmado pelo usuário; ele nunca sincroniza um plano. Antes de retomar uma execução existente, use
`node $ENGINE migrate --check --run <name>` quando precisar de um relatório de compatibilidade somente leitura. Todo
comando do motor de execução única aplica antes, automaticamente, uma migração estrutural segura e versionada, cria
`state.pre-migrate-v<schema>.json`, habilita as etapas de discussão e planejamento ausentes e não abre nenhuma rodada.
Ela preserva tarefas terminais. Uma migração parcial segura cria a estrutura atual da execução e marca cada
tarefa legada já iniciada para manter seu ciclo de vida anterior; essas tentativas podem ser retomadas, receber nova tentativa e terminar por
revisão independente sem planejamento retroativo. Tarefas novas ou nunca iniciadas recebem as etapas atuais de discussão e
planejamento e podem prosseguir quando suas próprias dependências estiverem prontas. O `migrate` explícito ainda nomeia
bloqueadores inseguros de planejamento em andamento; não limpe tentativas, não pule trabalho real nem reescreva o histórico para contorná-los. Sincronize
contratos corrigidos com `sync-plan` enquanto conclui o trabalho existente. Antes de `init`, `sync-plan` ou de retomar
uma execução existente, inspecione a fonte aprovada e o grafo persistido em busca de contratos legados. Normalize toda
validação em prosa ou obsoleta de tarefa não terminal para o esquema atual de validação executável usando evidências do
repositório, restaure a ordem e a composição declaradas das fases a partir da estrutura do plano aprovado, preserve IDs de tarefas,
dependências, escopo e histórico, e então execute `sync-plan` na mesma execução
e inspecione o resultado persistido. Não crie uma execução auxiliar para evitar adaptar tarefas antigas. Pergunte na
discussão principal apenas quando um significado consequencial do contrato não puder ser estabelecido a partir do repositório.
A migração também adota a cota compartilhada padrão `maxAgents: 3` quando ausente, preserva campos do plano,
tarefas e históricos e acrescenta a mudança a `agentLimitHistory`. Valores legados de `maxParallel`/`maxExecutors`
permanecem como metadados; tarefas antigas `blocked` sem `blockKind` continuam externas, independentemente do texto do motivo.

## Sincronizar uma mudança aprovada do plano

A ordem importa: edite o plano aprovado e execute `sync-plan` **antes** de `begin-phase-discussion` ou
`begin-discussion`, para que a nova rodada abra sobre o contrato atual (veja
[discussion.pt-BR.md](discussion.pt-BR.md#mudanças-de-contrato-antes-e-durante-uma-rodada)).

```bash
node $ENGINE sync-plan --plan <approved-plan.json> --run <run-name>
node $ENGINE show-contract <task> --diff --run <run-name>
```

`sync-plan` acrescenta tarefas aprovadas e atualiza contratos em todo estado não terminal, preservando o
ciclo de vida atual, agentes, tentativas, notas e evidências. Trabalho ativo cujo escopo mudou não pode avançar
por revisão ou conclusão até que o planejamento atual seja restaurado; use `pause-replanning` na tentativa
ativa que exige planejamento, replaneje e faça `unblock` explícito sem inventar uma falha. Um `block` externo
comum precisa de `unblock` antes do planejamento. Contratos done/skipped permanecem como histórico imutável e precisam de uma tarefa de continuação explícita. A remoção de tarefas
é recusada. Se uma execução migrada ainda nomear uma fonte graph-foreman ausente, `sync-plan` recupera o plano
correspondente a partir do workspace central do Prumo. Sua saída lista mudanças delimitadas de campos por tarefa, resume os contratos
de validação sem imprimir seu conteúdo e avisa quando um `blockReason` em espera contradiz a direção das
dependências; o log de eventos mantém a mesma auditoria estruturada. Uma tarefa nomeada no pedido do usuário é um limite rígido de escopo: suas
dependências, pré-requisitos ou entregas internas são contexto, não permissão para acrescentar tarefas, planejar
tarefas irmãs ou disparar mais planejadores. Mantenha uma discussão e um planejador para essa tarefa, a menos que o usuário
aprove explicitamente uma mudança mais ampla no grafo. Caso contrário, adote uma execução legada por tarefa migrada uma fase elegível
por vez com `begin-phase-discussion <phase> --adopt-legacy`. Uma mudança aprovada de validação para trabalho
ativo precisa de `refresh-contract`, não de fail/retry. Sempre confira a tarefa persistida antes da revisão.

Uma alteração de descrição que invalide rodadas concluídas de discussão ou planejamento lista as fases e tarefas afetadas antes de qualquer persistência e exige `--confirm-invalidation`. Confira primeiro `sync-plan --plan <approved-plan.json> --dry-run`: a prévia não grava estado, eventos, fontes, backups nem migração. Descrição igual ou fases sem rodadas concluídas não exigem confirmação. A invalidação de contratos e os avisos de touches continuam válidos.

`sync-plan` avisa, sem recusar a sincronização, quando invalida uma rodada aberta de discussão/planejamento ou
uma dispensa atual. `status` e `ready` também avisam quando a fonte do plano aprovado difere dos contratos
de tarefa persistidos, nomeando campos alterados, tarefas novas ainda não sincronizadas e tarefas ausentes do plano aprovado;
esse aviso não bloqueia a prontidão. Trate-o como "execute `sync-plan`" depois que o usuário aprovou a edição. Use `show-contract <task> [--diff]` para apresentar o texto
de negócio completo antes e depois de uma mudança; ele omite os comandos executáveis de `validation.run`. Quando um contrato
alterado reabre uma fase ou tarefa que já tinha uma discussão, rodada de planejamento ou dispensa atual, a próxima
discussão registra a rodada aberta antiga como substituída, com sua causa, e imprime os digests atuais das tarefas. Execute
`show-contract <task> --diff` para todo contrato afetado, apresente o texto de negócio completo e peça ao usuário
que aceite o comportamento alterado. Para o planejamento da fase, coloque as entradas exatas `{ "task": "...", "digest": "..." }`
de todos os alvos atuais em `questions[].confirmsContract` em uma única pergunta recém-respondida. Para o planejamento da tarefa,
use a entrada única impressa por `begin-discussion` em uma pergunta recém-respondida. Nos dois modos, a
confirmação deve estar na mesma pergunta vinculada ao `roundId` atual; uma resposta de rodada antiga, um digest desatualizado,
uma dispensa de discussão ou uma dispensa de planejamento não podem substituí-la. Depois que a confirmação é registrada, a dispensa
explícita comum de planejamento continua disponível.

Uma mudança de contrato também revoga a autorização de execução dessa tarefa; obtenha um novo aceite antes de executá-la
([dispatch.pt-BR.md](dispatch.pt-BR.md#escopo-e-modo-da-autorização)).

## Adaptar uma execução legada sem refazer o que foi entregue

Uma atualização da skill não acrescenta escopo de negócio, não amplia uma janela de dados nem exige um novo executor.
Mantenha a validação proporcional à tarefa aprovada. Um revisor pode executar a verificação ausente
sobre o trabalho entregue na tentativa atual. Artefatos existentes ajudam a revisão; o relatório de um executor,
sozinho, ainda não é aprovação.

Para uma execução legada do graph-foreman, a adaptação dos contratos é obrigatória antes de um novo despacho. Inspecione cada
tarefa não terminal, traduza a validação antiga em prosa para verificações executáveis atuais sustentadas por evidências do
repositório, atualize a fonte aprovada e execute `sync-plan` contra a execução original. Essa normalização de contratos
em todo o grafo não autoriza planejar todas as tarefas. Preserve IDs, arestas de dependência, composição das
fases, histórico entregue e tentativas existentes; nunca edite `state.json`. Quando o usuário selecionar uma
tarefa, planeje apenas essa tarefa existente e mantenha o trabalho interno dela dentro do único plano da tarefa imutável. Se o trabalho
já estiver em running ou reviewing, mantenha a tentativa e use `refresh-contract` abaixo. Se a redação antiga deixar um significado consequencial sem resolução, resolva apenas esse
ponto na discussão principal e então conclua a migração em vez de abandoná-la.

Depois de adaptar o plano aprovado, use:

```bash
node $ENGINE refresh-contract T4 --plan <approved-plan.json> --run <run-name>
```

Isso copia apenas validation, validationMode e inspectionReason para a tarefa, preservando seu
estado, executor, revisor, histórico de tentativas e razão de bloqueio. Ele invalida recibos de validação
anteriores, então o revisor deve validar o contrato atual. Ele não dispara um agente
nem desbloqueia uma tarefa pausada. O histórico done/skipped é imutável. Nunca use fail/retry apenas para
atualizar um contrato; reserve esse caminho para uma implementação efetivamente reprovada. As regras de escrita
de contrato para a validação adaptada estão em [contracts.pt-BR.md](contracts.pt-BR.md).

## Bloqueios e decisões do usuário

Precisa do dev → `block T4 --reason "..."`. `block` é sempre uma pausa externa e registra
`blockKind: "external"`; deixá-la em `running` enquanto você espera é como um grafo mente. Uma decisão do
usuário é registrada com `--question "<the decision in one sentence>" --option "<answer> => <effect>"`
(repita `--option` para cada resposta). O evento de bloqueio e o dashboard carregam a pergunta, e
`unblock T4 --answer "<answer>"` registra a escolha.

Bloqueios externos excluem uma tarefa de fase de `activeTargets` e `queuedTargets`, preservam o conjunto
original em `originalTargets`, acrescentam a razão em `excludedTargets` e marcam a tarefa para planejamento
individual (`individualPlanning: true`). A onda restante pode terminar.
Depois do `unblock`, a tarefa excluída usa `begin-discussion`, `plan-task` e `finish-planning` próprios na fase original.
Comandos diretos falham antes de mutar o estado com a mensagem `is blocked` e a instrução `unblock`.
Nenhum comando de discussão, planejamento, execução, revisão ou atividade pode contornar um bloqueio externo.
Uma tarefa legada `blocked` sem `blockKind` é externa; nunca deduza uma pausa interna pelo texto de `blockReason`.

Se um bloqueio externo pausar uma tentativa que exige planejamento em `running` ou `reviewing` e o escopo
aprovado mudar antes da retomada, `unblock --answer` registra a decisão, mas mantém a tarefa bloqueada e a
converte para `blockKind: "replan"` com a razão `approved scope needs current planning`. A tentativa e o revisor
originais permanecem associados. Inicie uma discussão nova da tarefa, execute `plan-task` e `finish-planning`
enquanto ela continua bloqueada; `finish-planning` mantém o bloqueio, e um `unblock` explícito posterior retoma
a mesma tentativa ou revisão.

Quando um bloqueio incluir um `blockQuestion` registrado, apresente exatamente essa pergunta e suas `blockOptions`
por meio do PO First, peça a decisão ao usuário e então passe a resposta com `unblock <task> --answer`.
Mantenha a razão, a pergunta, a resposta e o horário registrados no histórico. Bloqueios legados só com razão
continuam retomáveis com `unblock <task>`, mas permanecem externos.

Para uma tentativa ativa que exige planejamento e cujo contrato aprovado precisa ser atualizado, use
`pause-replanning <task> --reason "..."`. Ele registra `blockKind: "replan"` sem pergunta externa; a mesma
tentativa pode planejar enquanto bloqueada, `finish-planning` a mantém bloqueada e `unblock` explícito a retoma.

Resolva ou aguarde o bloqueador registrado; nunca o contorne. Use `note <task> --text "..."` para o que um
leitor posterior precisa saber e os estados não conseguem dizer.

## Retomar trabalho pausado

`unblock <task>` restaura a fase registrada (pending, planning, running, reviewing ou failed), preservando
a tentativa e o trabalho anterior. Para trabalho entregue pausado durante a execução ou a revisão, use
`unblock <task> --reviewer <independent-agent>` para entregá-lo diretamente à revisão na mesma tentativa.
Isso é uma passagem na vaga já ocupada pela tarefa, não um quarto agente nem uma vaga de revisão reservada.
Ele reconfere dependências, a cota compartilhada `maxAgents` e a disponibilidade do revisor; a retomada comum
de execução também confere essa mesma cota. Reduzir a cota nunca encerra agentes atuais e apenas adia trabalho novo. Uma recusa
deixa a tarefa bloqueada. Tarefas pending/failed não podem usar essa passagem para contornar start/retry.
No modo de autorização manual, um `unblock` que retoma uma tentativa ativa também precisa de `--confirmed-by-user`.

Esses comandos apenas registram estado. Retome o agente real apropriado ou dispare o revisor;
não inicie um novo executor para trabalho já entregue. Respeite a pausa do usuário até que a retomada
seja autorizada. Para uma mudança aprovada de contrato durante a pausa, refresh-contract vem antes de
unblock. Tanto uma validação pendente em andamento quanto um contrato alterado precisam de nova verificação;
a evidência concluída e o histórico de tentativas continuam registrados. Explique um erro anterior de orquestração
com uma nota; não o reescreva como falha de implementação nem apague tentativas históricas.

Para tarefas que exigem planejamento, mudanças de tarefa/dependência/decisão global podem tornar a pesquisa desatualizada. Trabalho pendente precisa de novo planejamento.
Uma implementação reprovada pelo revisor com contrato aprovado inalterado deve reutilizar seu plano aprovado
atual em toda correção, independentemente do número de novas tentativas, enquanto o contexto completo de planejamento registrado ainda
corresponder. O feedback da revisão segue para o próximo executor; ele não dispara um planejador. Somente uma mudança
material de contrato explicitamente aprovada exige novo planejamento, preservando planos e evidências anteriores. Se o escopo de uma
execução ativa mudar, mantenha sua tentativa, use `pause-replanning`, sincronize a mudança aprovada e use o
planejamento por tarefa. `finish-planning` devolve esse trabalho a **blocked**, preservando sua fase original e sua razão;
um `unblock` explícito então retoma a mesma tentativa. Não use `block` externo seguido de planejamento nem fabrique fail/retry para replanejar.
Mudanças apenas de validação ainda podem usar `refresh-contract` e nova revisão na mesma tentativa.

## Notas sobre o ciclo de vida legado

- Tarefas existentes sem `planningRequired` mantêm seu ciclo de vida, estados e histórico originais;
  não force trabalho legado concluído ou ativo a passar por planejamento. Tarefas acrescentadas a uma execução antiga recebem
  o novo requisito de planejamento. A instalação nunca reinicia uma execução.
- `sync-plan` preserva contratos `done` e `skipped` como histórico. Sua prosa antiga não bloqueia a sincronização nem a nova tentativa de outras tarefas. Não rerrotule trabalho funcional concluído como inspeção. Tarefas novas e não terminais ainda precisam de contratos válidos; a estrutura do grafo é conferida para toda tarefa.

### Acrescentar uma fase ao plano

Após aprovação do novo escopo, `sync-plan` aceita fases novas anexadas ao final, com os próximos IDs `F` e tarefas com os próximos números `T` livres. Preserve IDs, fases e histórico anteriores; declare as dependências reais da fase nova e confira `sync-plan --dry-run` antes de gravar. Números novos em fases já existentes continuam recusados; ampliações nessas fases usam letras vinculadas à tarefa-base. A fase nova segue os mesmos gates de discussão, planejamento, autorização, execução e revisão.
