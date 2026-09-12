# Referência do motor Prumo

[English](runtime.md) · [Instalação](../README.pt-BR.md)

O motor é uma CLI Node.js, não um serviço que chama modelos. O ambiente de IA dispara planejadores, executores e revisores; o motor registra planejamento, trabalho, dependências e evidências. O dashboard observa os mesmos arquivos. Com `--sync-plan`, ele delega a reconciliação ao motor.

## Armazenamento

Selecione `PRUMO_ROOT` como workspace existente dentro de `PRUMO_HOME`. Novos planos ficam no armazenamento central. `GRAPH_ROOT` e `GRAPH_FOREMAN_HOME` continuam aceitos; um workspace legado contendo `.specs/graph` também é aceito no local original.

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
    "phase": "P1", "deps": [], "touches": ["entrega/"],
    "validationMode": "functional",
    "validation": [{
      "kind": "functional", "run": "node verificacao.mjs",
      "expect": "O verificador confirma os resultados aprovados"
    }]
  }]
}
```

`deps` define a ordem. Dependências concluídas ou explicitamente puladas liberam a tarefa. Ciclos, IDs duplicados e dependências desconhecidas são recusados. `touches` detecta gravações sobrepostas entre tarefas paralelas; `--allow-overlap` é uma exceção explícita de agendamento.

`requireReview` pode ser definido por tarefa ou plano; o padrão exige revisão. Desabilitar revisão não elimina a comprovação funcional. `maxAttempts` por tarefa define o limite de tentativas antes de escalar; o padrão é três. `tags` é uma lista opcional de classificações.

## Planejamento por tarefa

O plano global continua exigindo aprovação e contrato válido no `init`. Depois que as dependências
entregam, **cada tarefa nova recebe um subagente planejador dedicado**, antes do executor. Ele
pesquisa código, artefatos, entregas das dependências e fontes relevantes no estado atual, aplica
PO First e prepara os passos daquela tarefa. O modo Plan/Spec do ambiente não substitui essa etapa.

Pesquise antes de perguntar, reutilize decisões conhecidas e não imponha questionário obrigatório.
Áreas cinzentas que mudam comportamento, escopo ou aceite voltam à conversa principal, usando
ferramentas nativas de perguntas quando disponíveis. Registre respostas reais e decisões compartilhadas.
Refinamento comum dentro do escopo não exige nova aprovação; mudanças materiais voltam ao usuário
e ao plano global. Uma resposta necessária mantém a tarefa bloqueada até ser resolvida.

`plan-task T1 --agent <planejador>` deve acompanhar o disparo real do subagente. Ele escreve somente
o artefato designado, sem implementar nem editar estado. O orquestrador confere o resultado e registra
`finish-planning T1 --plan <plano-da-tarefa.json>`. Exemplo para um contrato com uma verificação:

```json
{
  "research": [{ "source": "src/importacao.mjs", "findings": "O importador atual valida as linhas antes de gravar; reutilizar essa validação." }],
  "decisions": [{ "question": "Como tratar uma linha inválida?", "answer": "O contrato aprovado exige rejeição sem gravação parcial." }],
  "steps": ["Ampliar a validação existente.", "Adicionar o caso de linha inválida à verificação funcional existente."],
  "verification": [{ "criterion": "Linha inválida produz o erro aprovado e preserva os registros existentes.", "check": 1 }],
  "openQuestions": []
}
```

`research` exige fonte e achados; `steps`, passos de execução; `verification`, critérios observáveis
associados a **todos** os passos do contrato pelo índice numérico a partir de 1. Use `"inspection"`
somente quando o contrato aprovado for inspeção em texto. Esses três arrays não podem estar vazios.
`decisions` contém pares `question`/`answer` resolvidos e pode ser vazio. `openQuestions` contém
`question`, `blocking` booleano e `answer` opcional; também pode ser vazio. Pergunta bloqueante
sem resposta impede concluir planejamento; não invente resposta nem omita seu efeito para liberar execução.

O motor gera metadados de planejador, contexto, tentativa e tempo, salva `taskPlan` e preserva o
histórico dos planejamentos. Ele verifica estrutura e atualidade registrada, não a verdade da pesquisa
ou a identidade real do agente. O executor lê e reconfere o plano; o revisor independente avalia a
entrega contra o objetivo aprovado e os critérios vigentes, podendo contestar um plano defeituoso.
Planejamento não elimina erros nem substitui comprovação funcional por `echo` ou inspeção indevida.

Tarefas novas recebem `planningRequired: true`, inclusive as adicionadas a uma run antiga.
Tarefas existentes sem esse marcador preservam o fluxo anterior e o histórico; uma atualização
não reinicia trabalho ativo nem obriga tarefas concluídas a planejar novamente.

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

No Windows, use `env` em vez da sintaxe Unix `NAME=value comando`. Comandos pertencem ao contrato aprovado; o motor não os converte entre plataformas. Retorno diferente de zero pode representar um resultado de negócio esperado se o contrato o declarar.

Tarefas sem efeito de execução podem usar `validationMode: "inspection"` com `inspectionReason`, uma descrição de inspeção ou passos estáticos. Evidência permanece obrigatória.

Os comandos seguem a ordem declarada e param na primeira falha. Por padrão, todos executam novamente. Um passo `static` com `cacheable: true` pode reutilizar resultado aprovado na mesma tentativa e estado somente quando contrato, Git HEAD e árvore de trabalho permanecem iguais; passos `functional` sempre executam. O recibo registra comando, expectativa, categoria, diretório, shell, prazo, códigos esperados, saída, erro, sinal e código real. Saída acima de 4 MiB e timeout são falhas; os processos filhos da verificação são encerrados. Saída e evidências mantêm seu idioma original.

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
| `status`, `ready`, `graph`, `runs` | Consulta estado, trabalho pronto, JSON ou execuções |
| `plan-task <tarefa> --agent <nome>` | Registra planejador e inicia pesquisa após dependências entregues |
| `finish-planning <tarefa> --plan <artefato.json>` | Confere e registra o plano específico; libera execução se não houver pausa preservada |
| `start <tarefa> --agent <nome>` | Registra executor e inicia tentativa |
| `review <tarefa> --agent <nome>` | Encaminha trabalho para revisão |
| `validate <tarefa> --ok --evidence <texto> --cwd <diretório>` | Executa o contrato; falha real impede aprovação |
| `validate <tarefa> --failed --evidence <texto>` | Registra reprovação |
| `done <tarefa>` | Conclui com evidência válida da tentativa e revisor atuais |
| `fail <tarefa> --reason <texto>` | Registra falha real da tentativa |
| `retry <tarefa>` | Volta de failed para pending; tarefas novas precisam planejar novamente antes de start |
| `block <tarefa> --reason <texto>` | Pausa preservando a fase anterior |
| `unblock <tarefa>` | Restaura a fase anterior, sem nova tentativa |
| `unblock <tarefa> --reviewer <nome>` | Leva tentativa ativa pausada diretamente à revisão |
| `skip <tarefa> --reason <texto>` | Pula por decisão explícita |
| `note <tarefa> --text <texto>` | Acrescenta nota ao histórico |
| `refresh-contract <tarefa> --plan <arquivo-aprovado>` | Atualiza somente validação, modo e justificativa |
| `sync-plan --plan <arquivo-aprovado>` | Acrescenta tarefas e reconcilia alterações permitidas |

`--force` não aprova lint como prova funcional nem permite concluir com recibo inválido ou autorrevisão. Exceções explícitas de agendamento e substituição de uma execução inicial exigem a autorização pertinente.

## Planos em andamento

`sync-plan` preserva tarefas ativas e concluídas e informa diferenças não aplicadas. Tarefas pending, failed e blocked podem receber alterações aprovadas permitidas. Remover tarefas pelo sync é recusado.

Use `refresh-contract` para mudar somente o contrato aprovado de uma tarefa ativa. Ele preserva estado, tentativas, agentes, notas e bloqueio. A revisão do contrato invalida recibos anteriores, mesmo quando o texto volta à versão anterior. Tarefas done/skipped exigem acompanhamento explícito.

Trabalho entregue pode seguir à revisão, que pode completar verificações faltantes. Não use fail/retry **somente** para atualizar contrato nem registre erro de orquestração como falha do executor. Um bloqueio solicitado permanece até uma decisão explícita de desbloqueio.

Nas tarefas que exigem planejamento, mudanças na tarefa, dependências ou decisões globais podem invalidar a pesquisa; `retry` também
exige pesquisa atual, preservando planos anteriores. Se o escopo de execução mudar durante running
ou reviewing, bloqueie, sincronize a mudança aprovada e dispare `plan-task` na tarefa bloqueada.
`finish-planning` devolve a tarefa a **blocked**, mantendo fase anterior, motivo e tentativa aberta;
`unblock` explícito retoma a mesma tentativa. Não invente fail/retry para replanejar. Recibos do escopo
anterior não aprovam o novo. Uma mudança somente de validação continua usando `refresh-contract`
e nova verificação na mesma tentativa.

Bloquear durante planejamento preserva essa fase; desbloquear retoma a pesquisa, respeitando
dependências, capacidade e disponibilidade do agente. Confira estado e agente reais após interrupções.

### Reprovação real com alteração aprovada do contrato

Corrigir um defeito dentro do escopo aprovado já está autorizado. Uma orientação explícita do usuário pode aprovar um critério novo; peça decisão apenas se o novo escopo continuar indefinido. Solicitação nova não transforma retroativamente uma entrega correta em falha.

Quando a entrega foi realmente reprovada e o contrato aprovado também mudou:

1. Preserve a evidência e registre `fail <tarefa> --reason <critério-real-não-atendido>`.
2. Edite o plano aprovado, substituindo critérios obsoletos. Use o editor existente, backup único e confira o diff e possíveis alterações concorrentes; não é obrigatório criar um script de adaptação.
3. Rode `sync-plan --plan <arquivo-aprovado>` enquanto a tarefa está `failed`. Confira em `graph` o contrato, as dependências e os caminhos de escrita persistidos.
4. Rode `retry <tarefa>`. Para tarefas que exigem planejamento, dispare `plan-task`, pesquise e registre `finish-planning`; depois use `start <tarefa> --agent <executor>` com o disparo real do executor.

Acrescente `--run <nome>` em cada chamada. `retry` não recarrega o plano; `refresh-contract` só muda validação e não registra reprovação. Se apenas faltam atualizar verificações da entrega correta, use refresh e revisão na mesma tentativa. Novos requisitos após conclusão exigem acompanhamento explícito.

Retome da fase persistida, sem repetir a sequência inteira. Se `plan-task`, `start` ou `review` foi registrado, mas o agente não foi disparado, complete o disparo na mesma rodada/tentativa quando autorizado. Confirme o agente real. Se o disparo está indisponível ou o usuário pausou, registre bloqueio pelo motivo de orquestração. Um nome no estado não prova execução. Corrija relatos com notas e preserve tentativas anteriores.

## Dashboard

```sh
node <skill>/scripts/serve.mjs --sync-plan --lang pt-BR
```

O endereço padrão é `http://localhost:4949`, restrito à máquina. `--port` escolhe outra porta e `--run` fixa uma execução. O seletor mostra workspaces centrais e o workspace legado selecionado. Porta ocupada não provoca encerramento de outro servidor.

O painel apresenta estados, dependências, tentativas, evidências, eventos e tempos derivados. O idioma segue a preferência da instalação ou a escolha explícita de execução; não há seletor no navegador. Textos do usuário são escapados e não traduzidos. Os números não provam cobertura de testes, causas de defeitos ou regras de negócio.

| Estado efetivo | Significado | Cor |
|---|---|---|
| `waiting` | Aguardando dependências | Cinza |
| `ready_to_plan` | Pronto para planejamento | Azul |
| `planning` | Em planejamento | Rosa |
| `ready` | Pronto para executar; em tarefa legada, prontidão original | Verde-azulado |
| `running` | Em execução | Âmbar |
| `reviewing` | Em revisão | Ciano |
| `done` | Concluído | Verde |
| `failed` | Falhou | Vermelho |
| `blocked` | Bloqueado | Roxo |
| `skipped` | Pulado por decisão explícita | Cinza |

`pending` é persistido; as prontidões são calculadas pelas dependências e pelo plano atual.
O planejador aparece junto do orquestrador e do revisor, com conexões às tarefas em planejamento.
Os detalhes mostram pesquisa, decisões, passos, verificações e perguntas. Resultados separam tempo
de planejamento, execução e revisão; pausas ficam fora do tempo ativo de planejamento.

Encerrar o dashboard não cancela trabalho. Instalar não reinicia dashboard ou agentes. Um processo já aberto passa a usar o código de servidor atualizado quando for reiniciado.
