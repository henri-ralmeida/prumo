# Autorização, despacho e execução

[English](dispatch.md)

Leia isto quando uma tarefa estiver em `ready` ou `running`: antes de registrar uma autorização de execução, antes de cada
`start`, enquanto um executor relata obstáculos ou progresso e ao retomar depois de uma interrupção.
A revisão está em [review.pt-BR.md](review.pt-BR.md); bloqueios e retomada estão em [recovery.pt-BR.md](recovery.pt-BR.md).

## Escopo e modo da autorização

Depois que o usuário aprovar o grafo e `init` ou `sync-plan` o tiver persistido, pergunte qual escopo de execução
ele autoriza: a execução atual, uma fase ou tarefas selecionadas. Pergunte se o despacho deve continuar
automaticamente dentro desse escopo (`auto`, o padrão) ou pausar para uma confirmação do usuário antes de cada despacho
(`manual`). Registre o escopo aceito somente depois que o usuário concordar:

```bash
node $ENGINE authorize --scope run --mode auto --confirmed-by-user
node $ENGINE authorize --scope phase:F2 --mode manual --confirmed-by-user
node $ENGINE authorize --scope tasks:T4,T5 --confirmed-by-user  # auto é o padrão
```

A autorização registra o escopo, o modo, o horário e o canal do usuário. Ela não dispara um agente nem abre uma
fase. Use `ready` ou `status` para ver a autorização por tarefa, as vagas disponíveis e a próxima ação sugerida.
Uma execução sem escopo registrado mantém o comportamento anterior: `start` continua funcionando e informa que nenhum escopo
foi registrado. Assim que algum escopo for registrado, `start` recusa tarefas fora dele e tarefas cuja autorização foi
revogada por uma mudança de contrato. No modo auto, continue preenchendo vagas livres com tarefas prontas autorizadas depois de uma revisão
ou conclusão: quando `review` ou `done` abre uma vaga para trabalho pronto autorizado, o motor imprime
`execution slot freed by ...; authorized next: start <task> ...` (em pt-BR: `vaga de execução liberada por ...; próxima autorizada: start <task> ...`) e registra um evento `slot_freed`. Dispare
essas tarefas sem perguntar de novo; pare somente nas etapas que exigem o usuário. No modo
manual, pergunte antes de cada despacho. Se `sync-plan` ou `refresh-contract` mudar o contrato de uma tarefa, mostre o contrato alterado e obtenha
nova aceitação para essa tarefa antes da execução. Uma decisão alterada do plano global renova a aceitação das
tarefas não terminais afetadas; o trabalho que já está em execução continua sob a tentativa registrada.
Na autorização manual, passe `--confirmed-by-user` em cada `start`, `review` e `retry`. Retomar uma
tentativa ativa por meio de `unblock` também exige essa flag. O motor registra cada confirmação com o ID da
autorização, o horário e o canal no evento da tarefa e em uma lista ordenada `manualConfirmations[]` na
tentativa. Os campos antigos de confirmação no singular guardam o valor mais recente por compatibilidade. O modo auto
não exige confirmação repetida.

```bash
node $ENGINE start T4 --agent <executor> --confirmed-by-user  # somente manual
node $ENGINE review T4 --agent <reviewer> --confirmed-by-user # somente manual
node $ENGINE retry T4 --confirmed-by-user                     # somente manual
node $ENGINE unblock T4 --confirmed-by-user                   # retomando execução ativa
```

## Registrar um papel não cria um agente

**Use um subagente nativo para plan-phase quando houver um realmente disponível; caso contrário, informe a limitação e siga o fallback do planejador local e somente leitura em [planning.pt-BR.md](planning.pt-BR.md). Todo start continua exigindo um despacho real de executor nativo na MESMA mensagem.**
Dispare agentes planejadores prontos dentro da capacidade total e agentes de execução prontos dentro dos dois limites — o paralelismo é
o propósito do grafo, mas inspecione conflitos de arquivos e recursos compartilhados antes de considerar tarefas independentes. O motor só enxerga
a string de `--agent`; por isso, um orquestrador que roda `start` e depois escreve o código ele mesmo
passa em todas as verificações e deixa um arquivo de estado que mente: `--agent` precisa nomear um agente que
EXISTE. Essa é a única regra aqui que o motor não consegue impor por você.
O planejamento local grava somente o artefato designado e não inventa um agente disparado nem consome uma vaga de agente.

`review` também é uma chamada de subagente — um `review` sem revisor por trás é o mesmo autorrelato
com outro rótulo. Ele não tem limite de capacidade, então é disparado no momento em que o trabalho termina.

`start --executor <name>` é um alias de `start --agent <name>`. Esses comandos registram a atribuição; eles
não criam o agente.

## Depois de uma interrupção

Depois de uma interrupção, inspecione o estado persistido e o status real do agente antes de repetir comandos.
Se o planejamento previa um planejador nativo, ou se start/review foi registrado sem despacho, conclua esse despacho
na mesma tentativa quando autorizado; não repita fail/retry/start. No fallback documentado de planejamento
local, retome a pesquisa somente leitura e o trabalho no artefato em vez de inventar um despacho. Registre em uma nota o
identificador real do agente se ele for diferente do rótulo do motor. Se o despacho estiver indisponível
ou o usuário tiver pausado o trabalho, bloqueie com o motivo real de orquestração. Um rótulo registrado não é
prova de que um agente está rodando, e um problema de despacho não é uma falha de implementação.

## Prompt do executor

Cada executor recebe o contrato atual da tarefa, o contexto aprovado e o plano da tarefa registrado, quando existir.
Quando o planejamento foi explicitamente pulado, entregue a ele o contrato global, as saídas das dependências, os motivos
registrados da etapa e todo o feedback disponível de homologação/revisão; não invente um plano da tarefa nem reduza o contrato de aceite:

```text
Você é o EXECUTOR de <T4>: <título>. Entregue exatamente isso; não passe para revisão até
acreditar, com razoável segurança, que cada passo planejado e cada cláusula de validação foram atendidos.
Leia primeiro as regras de agente do projeto.
Em comentários, testes, mensagens e outros textos de produto que você acrescentar, descreva a regra de negócio observável e o motivo;
nomeie a área ou organização responsável somente quando ela for conhecida. Descreva motivos técnicos sem inventar um responsável.
Não copie para o texto de produto identificadores de tarefa, rodada, achado ou critério, nomes de processos internos ou do orquestrador, nomes
de pessoas, nem a data ou a autoria de uma decisão. Datas que sustentam uma medição ou descrevem
comportamento do produto podem ser incluídas. Mantenha a rastreabilidade no contrato aprovado, no commit ou no ticket.
Respeite `writeScope`: `files` grava SOMENTE em <touches>; `read-only` não grava arquivos; `unknown` precisa de alteração aprovada por `sync-plan` antes de iniciar.
Respeite os acessos de <sharedResources> e as dependências; arquivos distintos não comprovam independência.
Construa sobre o que estas já produziram: <deps>.
Leia o taskPlan atual e reconfira a pesquisa e os passos dele contra o workspace real: <artefato, ou "planejamento explicitamente pulado" mais o recibo>.
Informe um plano desatualizado ou uma decisão consequencial não resolvida; não altere silenciosamente o contrato aprovado.
Contexto aprovado relevante: <propósito, restrições e referências de origem; identifique o histórico superado>.
Seu trabalho precisa atender, cláusula por cláusula: <validation>
  Um agente DIFERENTE confere sua entrega contra esse contrato e nunca vê esta mensagem.
<em uma nova tentativa: o --reason do revisor, literalmente>
Trate um obstáculo recuperável como trabalho do executor, não como motivo para passar trabalho incompleto para revisão:
inspecione a falha, faça pesquisa adicional direcionada quando necessário, mude de estratégia, tente alternativas seguras
dentro do contrato aprovado e rode de novo as verificações de implementação relevantes. Continue até que o plano
da tarefa completo seja entregue. Pare antes somente por falta de autoridade, decisão consequencial de escopo/comportamento
não resolvida, risco destrutivo não autorizado, dependência externa indisponível depois de tentativas proporcionais
ou impossibilidade comprovada. Registre esse bloqueio e as tentativas feitas; não amplie o escopo nem reescreva o plano.
Ao começar cada passo planejado, rode esta linha de progresso com o índice desse passo, começando em 1:
<o comando de progresso impresso por start, com --step <índice>>
Política de commit: <Project overrides>. Nunca mexa em .specs/graph/ — o orquestrador é dono do estado.
Relate: o que você mudou e o que um revisor precisa para reproduzir.
```

Antes de o executor começar, registre a linha de base anterior ao início descrita em
[planning.pt-BR.md](planning.pt-BR.md#linha-de-base-antes-de-executar); o revisor precisa dela para separar esta entrega das
mudanças que já estavam presentes.

## Obstáculos recuperáveis ficam com o executor

Um obstáculo recuperável é trabalho do executor, não motivo para passar trabalho incompleto para revisão. Se um executor
relatar um, mantenha esse executor trabalhando (ou retome a execução interrompida na mesma tentativa) com o
mesmo plano imutável e o feedback atual. Não rode `review` só porque o executor bateu em um obstáculo.
O revisor é uma etapa de validação, não uma triagem de falhas. A passagem para revisão só é elegível quando o executor relata
o plano inteiro entregue, cada cláusula de validação atendida, as verificações seguras relevantes passando e nenhuma lacuna
recuperável conhecida. Essa persistência não autoriza novo escopo, ação destrutiva nem decisões de negócio
inventadas; esses são bloqueios reais nas condições acima. O despacho do planejador continua ocorrendo exatamente uma vez por
contrato aprovado, inclusive enquanto o executor alterna estratégias.

Correções descobertas durante a homologação mantêm seu feedback e seu histórico de tentativas. Recomende discussão
e planejamento separadamente, conforme a incerteza/o risco observável, mas deixe o usuário pular um deles ou ambos. Uma
correção com contrato inalterado normalmente fica no ciclo executor/revisor; nenhum replanejamento é inventado.

## Registro de progresso

Registre cada passo de execução quando ele começar, usando o índice, começando em 1, em `taskPlan.steps` registrado.
Ao relatar a conclusão, entregue ao orquestrador um resumo de 1–2 frases com o resultado e o motivo para `task.summary`.
`start` imprime uma linha pronta `progress <task> --step 1 --agent <executor> --run <run>`. Coloque essa linha no
prompt do executor; o executor a roda com o índice do passo atual à medida que cada passo começa. Somente quando o
executor não tem shell é que o orquestrador registra os passos relatados pelo executor com o mesmo comando.
A linha impressa usa a sintaxe do shell que rodou `start`: fora do Windows é sempre POSIX; no Windows é
POSIX quando `MSYSTEM` ou `SHELL` está definido (Git Bash), PowerShell caso contrário. O executor a cola em um shell do mesmo tipo; se o shell dele for diferente, ele
adapta apenas as aspas e o operador de chamada, nunca os caminhos ou argumentos.
`review` e um `unblock --reviewer` direto avisam quando a posição registrada está antes do último passo.
`start` registra o passo 1; progresso repetido não tem efeito, e uma nova tentativa recomeça do início. Esses contadores descrevem
o passo atual, não a conclusão verificada; eles nunca substituem a revisão. Tarefas legadas sem plano da tarefa
não recebem denominador inventado. Durante a validação, o motor emite automaticamente o índice/total de cada verificação,
incluindo início, aprovação, falha ou reaproveitamento de cache. Uma nova tentativa roda de novo as verificações funcionais, como de costume.

## Capacidade

- **3 executores entre 4 agentes ocupados** por padrão (`maxExecutors`/`maxParallel` por plano).
  Ajuste os dois, mas mantenha os executores **estritamente abaixo do total**: essa folga é o que mantém
  a revisão sempre desbloqueável, e trabalho terminado mas não verificado é o pior estado que o grafo pode ter.
- **A revisão nunca é bloqueada por capacidade e roda em paralelo.** `review` é uma passagem de papel em uma
  vaga que a tarefa já ocupa, então três tarefas terminando juntas recebem três revisores ao mesmo tempo.
  Elas ocupam, sim, o limite total: 1 em execução + 3 em revisão = 4 ocupados.
- **O planejamento usa a capacidade total, não a capacidade de executores nem uma tentativa de execução.** Planejamento,
  execução e revisão juntos ocupam `maxParallel`; priorize execução e revisão prontas
  ao distribuir vagas liberadas. Novas tarefas não podem contornar planejamento, dependências, capacidade total
  ou a unicidade de agentes simultâneos com `--force`; a sobreposição legada da cota de executores continua valendo.
- **Um agente, uma tarefa ativa**, entre planejamento, execução e revisão; o motor recusa um `--agent` ocupado.
  Um rótulo em duas tarefas simultâneas registra um paralelismo que não aconteceu.
- **Um revisor NOVO por tarefa.** Um agente revisando trinta acumula exatamente o contexto que o
  grafo existe para evitar, e deixa de ler com olhos frescos muito antes do fim.
