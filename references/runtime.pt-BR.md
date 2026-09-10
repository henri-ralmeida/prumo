# Referência do motor Prumo

[English](runtime.md) · [Instalação](../README.pt-BR.md)

O motor é uma CLI Node.js, não um serviço que chama modelos. O ambiente de IA dispara agentes; o motor registra trabalho, dependências, revisão e evidências. O dashboard observa os mesmos arquivos. Com `--sync-plan`, ele delega a reconciliação ao motor.

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

## Contrato de validação

Cada passo exige `run` e `expect` preenchidos. `kind` aceita `static` e `functional`; ausência de `kind` conta como estático. O modo padrão, `functional`, exige um passo funcional executável.

| Campo | Comportamento |
|---|---|
| `cwd` | Caminho absoluto de trabalho; substitui `--cwd` no passo |
| `env` | Variáveis com valores de texto, passadas sem interpolação pelo motor |
| `shell` | Executável do shell; padrão cmd.exe no Windows e /bin/sh em Unix |
| `expectedExitCodes` | Códigos aceitos; padrão `[0]`, inteiros de 0 a 255 |
| `timeoutMs` | Prazo por passo; padrão 600000; `0` desabilita explicitamente |

No Windows, use `env` em vez da sintaxe Unix `NAME=value comando`. Comandos pertencem ao contrato aprovado; o motor não os converte entre plataformas. Retorno diferente de zero pode representar um resultado de negócio esperado se o contrato o declarar.

Tarefas sem efeito de execução podem usar `validationMode: "inspection"` com `inspectionReason`, uma descrição de inspeção ou passos estáticos. Evidência permanece obrigatória.

Os comandos seguem a ordem declarada e param na primeira falha. O recibo registra comando, expectativa, categoria, diretório, shell, prazo, códigos esperados, saída, erro, sinal e código real. Saída acima de 4 MiB e timeout são falhas; os processos filhos da verificação são encerrados. Saída e evidências mantêm seu idioma original.

O motor verifica execução e integridade. O revisor julga se o teste prova o comportamento pedido e se as classificações são honestas. Um rótulo no plano não comprova qualidade do teste.

## Comandos

Resolva `scripts/engine.mjs` a partir da skill instalada. Acrescente `--run <nome>` para selecionar uma execução.

| Comando após `node <ENGINE>` | Efeito |
|---|---|
| `init --plan <arquivo> --run <nome>` | Inicializa execução do plano aprovado |
| `status`, `ready`, `graph`, `runs` | Consulta estado, trabalho pronto, JSON ou execuções |
| `start <tarefa> --agent <nome>` | Registra executor e inicia tentativa |
| `review <tarefa> --agent <nome>` | Encaminha trabalho para revisão |
| `validate <tarefa> --ok --evidence <texto> --cwd <diretório>` | Executa o contrato; falha real impede aprovação |
| `validate <tarefa> --failed --evidence <texto>` | Registra reprovação |
| `done <tarefa>` | Conclui com evidência válida da tentativa e revisor atuais |
| `fail <tarefa> --reason <texto>` | Registra falha real da tentativa |
| `retry <tarefa>` | Volta de failed para pending; start começa nova tentativa |
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

Trabalho entregue pode seguir à revisão, que pode completar verificações faltantes. Não use fail/retry para atualizar contrato nem registre erro de orquestração como falha do executor. Um bloqueio solicitado permanece até uma decisão explícita de desbloqueio.

## Dashboard

```sh
node <skill>/scripts/serve.mjs --sync-plan --lang pt-BR
```

O endereço padrão é `http://localhost:4949`, restrito à máquina. `--port` escolhe outra porta e `--run` fixa uma execução. O seletor mostra workspaces centrais e o workspace legado selecionado. Porta ocupada não provoca encerramento de outro servidor.

O painel apresenta estados, dependências, tentativas, evidências, eventos e tempos derivados. Idioma persiste no navegador. Textos do usuário são escapados e não traduzidos. Os números não provam cobertura de testes, causas de defeitos ou regras de negócio.

Encerrar o dashboard não cancela trabalho. Instalar não reinicia dashboard ou agentes. Um processo já aberto passa a usar o código de servidor atualizado quando for reiniciado.
