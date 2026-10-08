# Revisão das melhorias do run

Base: main `efadd0d3fd4af393608cd1864f5fc7f78ad3fc3e`, confirmada remotamente em 2026-10-07.
Branch de implementação: `feat/run-evidence-and-agent-timing`.

## Entregas

1. Identificadores: nomes novos/alterados e conteúdo acrescentado sob `touches`, mais entregas declaradas integralmente. Literais de tarefa/fase/run, comparação sem distinguir maiúsculas e fronteiras Unicode que incluem underscore como separador. Exceções por caminho/linha/identificador; padrões adicionais literais. Links são recusados, binários não viram texto e leituras têm limites. Diagnóstico não imprime conteúdo. Hashes da linha de base descontam conteúdo antigo sem relação com a entrega. A correção permite nova solicitação de review com os demais gates preservados.
2. Briefing: `brief <task> --role executor|reviewer` monta contrato e critérios atuais, plano aprovado ou dispensas, discussão pertinente, recibos, dependências registradas, regras e reprovação atribuída. Mantém identidade do plano persistido e comandos adequados ao shell. Um novo revisor recebe contexto após handoff; recibos anteriores não substituem inspeção independente.
3. Modelo/esforço: preferências opcionais para os quatro papéis, `set-role` e valores informados por disparo/worker. Status, dispatch e brief identificam origem solicitada/informada. Alterações valem para disparos futuros; o motor não cria agentes, chama modelos ou verifica qual modelo realmente trabalhou.
4. Pausa/consumo: `pause-run --reason ... [--until ...]` e `resume-run` explícito preservam tarefas, rodadas, workers, fila e bloqueios externos. Pausa desconta intervalos próprios e fecha somente checkpoints atuais, marcando a origem para não sugerir revisão prematuramente. Retorno previsto não é retomada automática; processos externos não são interrompidos. Tokens/ferramentas informados têm recibos idempotentes e totais seguros, incluindo rodadas antigas com targets registrados, sem duplicação entre validate/done nem alegação de preço ou medição independente.
5. Procedência: modelo de contrato e checklist; manifestos JSON declaram fonte, JSON Pointer, valor, operação value/sum/count e localização do resultado. Verificação executável recusa ausência, origem não aprovada, referência inválida ou divergência. Fingerprints antes/depois dos checks e no done impedem usar evidência obsoleta mesmo quando uma edição mantém a soma. Não infere todos os números da prosa.
6. Seleção/doctor: precedência `--run`/`-r` > `PRUMO_RUN` > `CURRENT`, com validação de caminho igual e init sem exigir --run. Doctor só diagnostica lista acessível ou bloqueio de comando Prumo registrado; não assume lean-ctx instalado ou bloqueando, não contorna filtros e não expõe JSON inválido em erros.
7. Show-check: sem seletores lista tentativas/checagens e comandos citados; seleção sem --attempt usa a tentativa atual mais recente, inclusive quando ela não tem recibo. Não busca silenciosamente uma validação anterior. Erros mostram escolhas existentes e a consulta conserva stdout/stderr e metadados.
8. Painel: soma por agente nos quatro papéis, sem duplicar envelope de fase quando existem workers. Intervalos explícitos continuam separados de duração registrada da etapa; esta pode incluir espera e não comprova atividade ou ganho. O relógio usa união dos períodos, desconta pausas/bloqueios e retoma duração sem inventar atividade. Histórico parcial só usa timestamps reais; não cria tentativas.

## Sugestões do Claude Code verificadas

- Pergunta já respondida: aviso de repetição literal em openQuestions, confrontando discussão/decisões persistidas; não resolve perguntas por inferência semântica.
- Plano reutilizado: fonte real quando registrada, digest, rodada e tentativa de origem aparecem no disparo/brief. Histórico sem caminho mantém null; não reconstrói um arquivo suposto.
- Planejador sem escrita: o fluxo canônico stdout JSON + gravação pelo orquestrador já existia. Disparo e documentação o tornam explícito; saída vazia não é aprovada e finish-planning continua validando o artefato.

## Compatibilidade e evidências

Campos novos são opcionais, com defaults/limitações documentados em runtime EN/PT-BR. Nenhuma migração exige recriar run ou inventar tentativas. Contratos sem os novos campos conservam digest e aprovação; preferências operacionais não alteram autorização de negócio. Linhas de base ausentes em tentativas antigas não provocam varredura indiscriminada: somente entregas declaradas são inspecionadas, com a limitação informada. Contratos numéricos antigos não recebem um gate numérico obrigatório. Exigir verify-provenance explicitamente sem contrato é recusado.

Fixtures sintéticas reproduzem oito tentativas/discussões com activityTiming explicit e arrays vazios, além dos intervalos 2026-10-07T13:07:30.480Z–13:19:29.980Z e 13:07:30.821Z–13:16:03.311Z: 1.231.990 ms somados e 719.500 ms na união. Casos cobrem abertos/encerrados, paralelismo, retomadas, revisões múltiplas, troca de agente, histórico parcial, caminhos/links/binários/limites, recibos obsoletos e compatibilidade do planejamento/validação antigos.

Resultados finais de testes, c8 e CI são registrados abaixo após a execução. Os seis jobs e a consolidação só podem ser considerados aprovados para o SHA que efetivamente os executar. Nenhum limite, job, versão npm ou automação foi alterado; nenhuma publicação, tag, Release ou alteração de main faz parte desta branch.

### Verificações já concluídas do commit de código 6d3b283

- Node.js 22.23.3: 264 testes focados aprovados, zero falhas/skips (38 casos novos, dashboard, readiness e escopo).
- Node.js 24.19.0: planejamento/validação históricos, 102 testes aprovados, zero falhas e 3 skips de plataforma. Os casos novos incluem sucesso, recusa e regressão.
- `npm run check`, `npm pack` e integração real `scripts/package-smoke.mjs` com Bun 1.4.2: aprovados. Pacote instalado configurou sete harnesses em oito raízes isoladas; prévia/falha de registro preservaram arquivos existentes. Empacotar não publicou o pacote.
- c8 focado após as alterações: delivery-evidence, run-metadata, recorded-timing, shell-diagnostics e review-readiness têm 100% de linhas/statements/functions. Branches: 99,57%, 100%, 100%, 97,56% e 100%, respectivamente. As duas alternativas locais não exercitadas são ausência das constantes de plataforma O_NOFOLLOW/O_NONBLOCK. Essa coleta focada não aprova a cobertura global nem substitui a consolidação entre sistemas.
- Base original separada: atualização 2.5.1 → candidato da main original falhou em `Startup process stop failed: kill ESRCH`; três testes originais de entradas especiais falharam em `listen EPERM` para sockets Unix. Esses mesmos bloqueios locais são tratados como falhas reais da execução, sem skip adicional, redução de limites ou remoção de versões.
- CI da main de base: [run 37679769926](https://github.com/henri-ralmeida/prumo/actions/runs/37679769926), cinco jobs aprovados, Windows/Node.js 22 falhou e consolidação pulada. Esse resultado pertence ao SHA de base; não aprova esta branch.

### Resultado final local e limites de aprovação

Após a última alteração de código do painel (commit 7981130), a coleta completa com concorrência 4, correspondente ao job Linux, registrou 2.568 testes: 2.551 aprovados, quatro falhas e 13 skips existentes de plataforma; nenhum teste cancelado. As falhas foram as três entradas especiais com `listen EPERM` e a integração de versões npm. Nesta última coleta, o executor informou `network approval was cancelled before a decision was returned`; o arquivo da matriz registrou 25 versões (sete aprovadas e 18 falhas ESRCH) antes da interrupção. A coleta serial anterior concluiu todas as 33 versões (sete aprovadas e 26 falhas ESRCH). Nenhuma versão foi excluída do código da matriz.

O relatório c8 dos dados finais foi recuperado localmente com `c8 report`, sem nova solicitação de rede: linhas/statements 99,95% (13.358/13.364), funções 100% (832/832), branches 99,44% (12.417/12.486). O comando manteve exit code 1 porque os limites de 100% por arquivo não foram atingidos nesta execução Linux. Não há aprovação global de cobertura local.

Uma última asserção de discussão com timestamps completos foi adicionada ao teste do painel. O c8 focado final do script efetivamente renderizado alcançou 100% de linhas (3.225/3.225), funções (226/226) e branches (3.148/3.148), sem exclusões novas. Os 215 testes do painel passaram. Node.js 22.23.3 foi executado novamente com esse teste final: 266 testes focados aprovados, sem falhas/skips. `npm run check`, empacotamento e integração npm/Bun passaram novamente após o último código.

Os dois pontos dos módulos novos ainda não exercitados na coleta Linux são as alternativas de ausência de O_NOFOLLOW/O_NONBLOCK; dependem da consolidação com os ambientes que não oferecem essas constantes. A cobertura do painel renderizado está comprovada pelo c8 focado; isso não transforma a suíte global com quatro falhas em aprovação nem comprova Windows/macOS.

CI da branch: não verificado no instante deste registro anterior ao push. O SHA final precisa executar os seis jobs Windows/Linux/macOS com Node.js 22/24 e a consolidação do workflow vigente. Limites, testes, versões npm, jobs e automações foram preservados. Não houve publicação npm/marketplace, criação/movimentação de tag/Release ou envio para main.

### Correspondência do envio remoto

O Git local não disponibilizou credencial de escrita por HTTPS. O conector GitHub recebeu os arquivos e criou commits com o mesmo conteúdo e mensagens; a autoria/data atribuídas pela API produzem SHA diferentes dos commits locais usados nos testes. As árvores foram conferidas exatamente:

| Commit local de código | Commit remoto correspondente | Árvore Git idêntica |
|---|---|---|
| 6d3b2830e798b4ef2f05f32ca59ffed1d2096fb3 | 35b801e21549061bdcb2cd70683e24fe1f8b7c67 | 73b6516aa6cd56857e489267cb060c3f49713857 |
| 79811304d0366b5c3a47c94cf7738560da7626bc | e50b77382be426e7bade4c184aa3bd5eb2ee17ca | 52d24874805a09e8a02980312fef16a2542c7093 |

Este relatório acompanha o terceiro commit. Consultas de CI devem usar o SHA remoto final da branch, sem atribuir os resultados do SHA de base ou do commit local a uma execução remota inexistente.

### Correção Windows e orientação posterior para main

Em 2026-10-08 UTC, o usuário substituiu a restrição inicial de branch isolada e autorizou levar o trabalho à main. A main remota continuava em `efadd0d3fd4af393608cd1864f5fc7f78ad3fc3e`; a atualização será um avanço direto, preservando os três commits existentes e sem force push. Nenhuma autorização de publicação, tag, Release ou reativação de automações foi adicionada.

O [CI 37703728854](https://github.com/henri-ralmeida/prumo/actions/runs/37703728854) do SHA `1481c2979af2ccf4db0b59e591aa6c6e87855741` terminou com Linux/macOS Node.js 22/24 aprovados e os dois jobs Windows falhando no teste `file replacement, special entries, partial reads and growth cannot bypass safe evidence reads`. A consolidação foi pulada. Os logs dos dois jobs registraram apenas essa falha: `Missing expected exception`, ao incrementar `stat.ino` no mock de substituição de arquivo.

IDs de arquivo Windows podem exceder a precisão inteira de Number: `Number(2n ** 60n)` e `Number(2n ** 60n + 1n)` são iguais. A correção lê as identidades de lstat/fstat com `{ bigint: true }`, compara dispositivo/inode exatos e converte tamanho para Number somente no cálculo de orçamento limitado de leitura. Os mocks repassam as opções. A regressão reproduz IDs grandes, aceita a identidade correta e recusa tanto inode quanto dispositivo diferentes; nenhuma asserção, limite ou job foi removido.

Node.js 24.19.0: 39 testes das melhorias aprovados. Node.js 22.23.3: 267 testes focados aprovados, zero falhas/skips. `npm run check`, `npm pack` e integração real npm/Bun passaram após a correção; sete harnesses em oito raízes isoladas, preservando prévia e falha de registro.

O c8 completo foi executado novamente após a última alteração de código: 2.569 testes, 2.552 aprovados, quatro falhas locais e 13 skips existentes. Foram as três entradas especiais com `listen EPERM` e a matriz de atualização com `kill ESRCH`. Todas as 33 versões npm foram tentadas: sete aprovadas e 26 falhas ESRCH, sem exclusão de versão. Cobertura global Linux: linhas/statements 99,95% (13.359/13.365), funções 100% (832/832), branches 99,44% (12.407/12.476), mantendo exit code 1 e os limites de 100% por arquivo. Painel renderizado, run-metadata e recorded-timing atingiram 100% de linhas/functions/branches. Delivery-evidence teve 100% de linhas/functions e 99,59% de branches; permanece a alternativa de ausência de O_NOFOLLOW nesse Linux. Não há aprovação global local.

O SHA novo da main precisa de sua própria execução dos seis jobs e consolidação; a correção local não aprova o CI. Nenhuma publicação faz parte dessa atualização.
