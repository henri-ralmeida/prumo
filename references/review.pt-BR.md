# Revisão independente, validação e reprovação

[English](review.md)

Leia isto quando uma tarefa estiver em `reviewing` ou tiver um recibo de validação atual, antes de disparar um revisor,
antes de `validate`/`done`, e quando um veredito voltar `failed` ou a tarefa estiver em `failed`. As regras de
contrato que o revisor aplica estão em [contracts.pt-BR.md](contracts.pt-BR.md).

## Conteúdo

- [O que o revisor recebe](#o-que-o-revisor-recebe)
- [Profundidade da revisão](#profundidade-da-revisão)
- [Inspecionar verificações e registrar o veredito](#inspecionar-verificações-e-registrar-o-veredito)
- [Falhas que não são reprovações](#falhas-que-não-são-reprovações)
- [Depois do veredito](#depois-do-veredito)
- [Reprovação real, inclusive com mudança aprovada do contrato](#reprovação-real-inclusive-com-mudança-aprovada-do-contrato)

## O que o revisor recebe

Entregue ao revisor o **contrato de validação atual**, o **contexto aprovado** relevante e o
**diff ou os artefatos entregues**, sem a narrativa persuasiva do executor. Identifique
requisitos substituídos como histórico. O revisor executa ELE MESMO a etapa de controle do projeto (veja Project
overrides em [SKILL.md](../SKILL.md)), confere o contrato cláusula por cláusula e responde `--ok` ou `--failed`.

```bash
node $ENGINE review T4 --agent rev-scenes       # executor terminou → entregue a um revisor novo
node $ENGINE validate T4 --ok --evidence "..." --cwd <absolute-project>  # o veredito do REVISOR
node $ENGINE done T4
```

```text
Você é o REVISOR de <T4>: <título>. Você NÃO produziu esta entrega.
Inspecione o `git status --short` real e os diffs staged e unstaged, depois compare com esta linha de base anterior ao início: <baseline>.
Julgue apenas as mudanças novas dentro dos `writes` declarados (ou dos `touches` aprovados quando `writes` estiver ausente): <diff, artefatos entregues ou estado antes/depois>
Contra este contrato, cláusula por cláusula: <validation>
Contexto e restrições aprovados relevantes: <referências; distinga o histórico substituído>.
taskPlan registrado: <artefato>; trate-o como evidência a inspecionar, não como autoridade sobre o objetivo aprovado.
Conteste planejamento/critérios ausentes ou incorretos em vez de aprovar a implementação de um plano falho.
Leia as regras de agentes do projeto e a implementação, as entradas, as saídas e as verificações relevantes.
Inspecione comentários, testes, mensagens, README e outros textos de produto novos. Reprove referências novas ali a
identificadores de tarefa/rodada/achado/critério, a nomes de processo interno ou do orquestrador, a nomes de pessoas, ou à
data ou autoria de uma decisão; isso pertence ao contrato aprovado, ao commit ou ao ticket. Preserve datas que
sustentem uma medição ou descrevam comportamento do produto. Confira se as regras de negócio
dizem o porquê e nomeiam a área ou organização responsável quando conhecida. Se o responsável for desconhecido, sinalize ao PO
sem inventar um; a ausência de um responsável conhecido é um aviso, não por si só uma reprovação. Razões técnicas
não devem atribuir um responsável de negócio sem evidência.
Confira se o contrato prova o comportamento alterado e se qualquer exceção de inspeção se ajusta ao diff.
Confira o `requires` de cada item de verificação; informe a inspeção manual como pendente até tê-la inspecionado.
Execute a etapa de controle VOCÊ MESMO por meio de engine validate: <Project overrides, caminho do motor, cwd absoluto do projeto>.
Confira a saída registrada, a contagem real de testes relevantes e os resultados contra cada critério.
Nunca aceite lint/build/typecheck, instruções de echo ou zero testes relevantes como prova funcional.
Responda:
  verdict:  ok | failed
  summary: uma frase dizendo o resultado e por que ele atende ou não ao aceite
  evidence: o que você EXECUTOU e o que isso RESPONDEU — comandos e contagens, não impressões.
  se failed: o que falta, de forma específica o bastante para o próximo executor agir.
```

O que está ausente dessa mensagem é o ponto: nenhum relatório do executor, nenhuma contagem de tentativas, nenhum "a
suíte já estava verde". Um agente novo, um contexto limpo e o contrato.

## Profundidade da revisão

O primeiro revisor deve inspecionar o caminho comportamental completo e a relevância dos testes, não apenas
as linhas alteradas. Derive de forma independente um contraexemplo focado para o critério aplicável de maior risco,
especialmente uma regra de ordenação, limite, entrada inválida ou transição; não copie os
exemplos do executor nem espelhe a implementação. Se as verificações aprovadas não conseguirem estabelecer um critério
atual, reprove com uma razão acionável em vez de aprovar com base em testes aprovados sem relação. Sob a
regra de um único planejador, feedback com contrato inalterado volta ao executor; uma decisão de aceite ausente bloqueia
para o usuário em vez de disparar silenciosamente outro planejador. Mantenha esta sondagem
proporcional: um caso discriminante é preferível a uma matriz genérica. Em uma nova tentativa corretiva delimitada,
o próximo revisor inspeciona a reprovação, os caminhos alterados e as verificações restantes, e pode confiar em recibos
de passos atuais que o motor reutiliza explicitamente.
Assim que todo critério aplicável tiver evidência atual e a sondagem independente passar, encerre a revisão.
Continue apenas diante de uma falha, contradição, critério não coberto ou risco concreto; comandos equivalentes
repetidos e verificações amplas e especulativas acrescentam custo sem fortalecer o veredito.
Fluxos de navegador/API precisam de verificações que exercitem esse fluxo na
camada apropriada; um teste de helper puro não prova uma jornada do usuário. Mantenha os testes restritos à
tarefa e acrescente uma verificação final de integração quando tarefas separadas precisarem funcionar juntas.

## Inspecionar verificações e registrar o veredito

Antes de `validate --ok`, inspecione a saída das verificações aprovadas. Use `show-check <task> --check N --attempt K`
para ver stdout, stderr, diretório de trabalho, código de saída e status de reutilização completos de uma verificação armazenada. Em uma primeira
revisão, execute você mesmo cada verificação aprovada e inspecione sua saída antes de registrar o veredito. Marque cada
verificação revisada ou critério estruturado de inspeção com `review-progress <task> --step N --agent <reviewer>`;
tarefas de inspeção com critérios estruturados não podem passar na validação até que todo critério seja percorrido.
Esse progresso é um relato rastreável do revisor, não prova de que uma inspeção aconteceu ou de que o trabalho passou.
Trabalho de inspeção legado sem denominador registrado permanece desconhecido e não ganha critérios inventados.
`validate --ok` reexecuta os comandos aprovados e imprime até 15 linhas de saída das verificações funcionais e das
que falharam; use `--tail 0` para suprimir essa prévia. Os rótulos do resumo apenas destacam texto de saída: julgue o
código de saída e o resultado relevante contra o critério, nunca apenas palavras-chave.

Chame `validate --ok --summary "<veredito PO First em uma frase>" --evidence "<observações completas contra cada critério>" --cwd <absolute-project>`
depois de inspecionar o `git status --short` real e os diffs staged/unstaged contra a linha de base anterior ao início,
os `writes` declarados e os `touches` aprovados, e os comandos aprovados. Desconsidere caminhos e hunks
já presentes antes da execução; um caminho sujo, por si só, não atribui uma mudança à tarefa atual.
Confira o `requires` de cada item de verificação, inclusive inspeção manual pendente, e registre as observações.
Isso executa os comandos do plano e registra
sua saída e seus códigos de saída; inspecione esses recibos antes de `done`. Evite registrar credenciais em log.
Não altere o código revisado enquanto as verificações executam; reexecute a validação se ele mudar depois.
Todos os passos são reexecutados por padrão. Marque como `cacheable: true` apenas passos `static` determinísticos; o Prumo
pode reutilizar o resultado aprovado deles dentro da mesma tentativa e do mesmo estado da tarefa quando o contrato e o
workspace Git estiverem inalterados. Acrescente `cachePaths` relativos e seguros quando essa verificação estática cobrir um
conjunto isolado de arquivos: depois de uma nova tentativa corretiva, o próximo revisor retoma no primeiro passo que falhou ou
foi invalidado e reutiliza recibos aprovados anteriores somente enquanto esses caminhos declarados estiverem inalterados byte a byte.
Passos funcionais sempre executam, e passos estáticos sem escopo recomeçam em uma nova tentativa. O motor confere a
execução, não a verdade semântica de `expect` nem o `kind` declarado.
Nunca rotule lint como funcional para satisfazer a etapa de controle. Comandos de shell executam com as
permissões de quem chama; o plano aprovado não é permissão para efeitos colaterais sem relação ou destrutivos.

Uma reprovação é registrada da mesma forma com `validate <task> --failed --summary "..." --evidence "..."`.

## Falhas que não são reprovações

- `validate --ok` **executa os comandos do contrato**, incluindo operações de banco de dados e de rede. Não é uma flag de aprovação manual. Leia a saída e o índice de falha de cada verificação antes de decidir se a falha está relacionada à implementação, ao ambiente ou ao contrato.
- Uma verificação de rede/VPN que falhou mantém a etapa de controle reprovada mesmo que o revisor considere a implementação correta. Restaure o ambiente e peça ao revisor independente que valide de novo na mesma tentativa. Use `fail`/`retry` para uma implementação efetivamente reprovada, não para uma falha transitória de ambiente. Verificações funcionais sempre são reexecutadas; somente verificações estáticas explicitamente cacheáveis podem reutilizar evidência inalterada.
- O executor não deve aprovar o próprio trabalho. O orquestrador não deve se passar pelo revisor emitindo aprovação em nome dele. O motor confere os papéis registrados, não a identidade de quem chama o shell. Se a sessão do revisor não existir mais, dispare um novo agente de revisão independente; faça a passagem por `block` e `unblock --reviewer <new-agent>` e então deixe esse agente real executar a validação.
- Coloque diretórios de trabalho absolutos entre aspas. Em um shell POSIX no Windows use barras normais, por exemplo `--cwd "C:/work/project"`. Diretórios inválidos são recusados antes de se criar um recibo da etapa de controle.

## Verificação do escopo entregue

Em `scopePolicy: "explicit"`, compare a entrega real com a linha de base anterior a `start`, incluindo arquivos rastreados e não rastreados visíveis pelo Git. Alterações novas de `files` devem caber em `touches`; `read-only` não pode alterar arquivos. Um arquivo já modificado antes e que permaneceu igual não pertence à entrega desta tarefa. Verifique também o acesso autorizado aos recursos externos e suas evidências; o Git não observa tabelas, serviços ou ambientes.

O motor verifica o escopo em `validate` e novamente em `done`, mas arquivos ignorados pelo Git ficam fora dessa observação. Quando Git ou a linha de base não estão disponíveis, registre a limitação e exija evidência atual do revisor independente com `validate --ok --scope-evidence "<observações do escopo e limitações>"`. Esse recibo não finge uma comparação automática nem libera gravações observadas sem autorização. Preserve as validações de produção e a revisão independente.

A tentativa registra os escopos de arquivos disjuntos dos executores contemporâneos; um novo executor também acrescenta seu escopo às tentativas anteriores ainda ativas. O Git observa caminhos alterados globalmente, não a autoria. Alterações fora desta tarefa só podem ser desconsideradas se couberem nesses outros escopos registrados e o revisor independente atual fornecer atribuição explícita por `--scope-evidence`. O recibo de escopo registra `excludedPaths` e a limitação de autoria. Alterações observadas fora de todos os escopos autorizados registrados sempre bloqueiam, mesmo com evidência do revisor. `done` exige a mesma impressão da entrega e a identidade do revisor do recibo aprovado; alterações após a validação exigem nova verificação. Arquivos ignorados não são auditados automaticamente: o recibo de escopo sempre expõe essa limitação e o revisor independente precisa conferi-los separadamente, sem obrigatoriedade de `--scope-evidence` somente por haver caminhos ignorados. Git/linha de base indisponíveis, submódulos e ambientes sem Git exigem `--scope-evidence` explícita, assim como a atribuição a outro executor; efeitos em recursos externos precisam de observações próprias. A impressão inclui conservadoramente todas as mudanças visíveis pelo Git: qualquer alteração após validar, inclusive de outro executor, exige nova validação para que a evidência de atribuição não fique obsoleta.

## Depois do veredito

- **`--summary` registra o veredito PO First conciso do revisor** quando fornecido; valores em branco são recusados.
  **`--evidence` registra as observações comportamentais completas** e não pode ficar vazio nem ser substituído pelo resumo.
  Os resultados dos comandos são coletados pelo motor; o revisor ainda confere a relevância deles.
  `done` recusa sem uma validação de revisão aprovada para a tentativa ATUAL — a única regra
  que impede que "parece certo" vire estado.
- **Entrega reprovada** → siga "Reprovação real" abaixo; sincronize qualquer mudança aprovada do
  contrato antes da nova tentativa. A razão segue para o próximo executor e deve ser acionável.
- Depois de **3 tentativas** o motor avisa — escale para o dev em vez de gastar mais.
- O revisor precisa do dev, ou falta uma decisão → bloqueie a tarefa como descrito em
  [recovery.pt-BR.md](recovery.pt-BR.md#bloqueios-e-decisões-do-usuário).
- Recibos de dispensa de discussão/planejamento nunca dispensam o revisor independente. Trabalho novo do Prumo mantém a revisão ligada;
  `requireReview: false` é estado de compatibilidade para execuções antigas, não uma recomendação atual de roteamento.

## Reprovação real, inclusive com mudança aprovada do contrato

Distinga uma implementação que falhou em um critério aplicável de um pedido de novo escopo
ou de verificação ausente. Corrigir um defeito real dentro do escopo aprovado já está autorizado.
Reutilize uma orientação explícita do usuário como aprovação; pergunte apenas quando um novo requisito continuar indefinido.

| Situação | Próxima ação |
| --- | --- |
| Entrega efetivamente reprovada, contrato inalterado e plano sólido | Registre o `fail --reason` acionável do revisor, depois `retry` e `start`; o motor reutiliza o plano aprovado somente enquanto seu contrato, descoberta, escopo e vínculo de dependências continuarem atuais. |
| O revisor considera a orientação de implementação incompleta, mas o contrato aprovado está inalterado | Registre um `fail --reason` acionável sem `--plan-defect`, depois `retry` e envie o mesmo plano da tarefa mais essa razão ao próximo executor; não dispare outro planejador. |
| Entrega efetivamente reprovada, e o contrato aprovado também mudou | Registre a falha real; edite o plano aprovado; `sync-plan` enquanto estiver `failed`; inspecione o contrato persistido, os `touches` e as dependências; depois `retry`, novo planejamento da tarefa e execução. |
| O trabalho entregue precisa apenas de uma atualização aprovada da validação | `refresh-contract`, depois verificação por um revisor independente na mesma tentativa; sem falha ou executor inventados. |
| Novo escopo depois de `done`/`skipped` | Crie uma continuação explícita pelo fluxo de planejamento aprovado; preserve o histórico concluído. |

Para o caso combinado de reprovação, execuções com fases usam o fluxo de sua fase. Um defeito seletivo atinge apenas
a tarefa afetada; uma decisão compartilhada da fase atinge os membros não terminais da fase. Execuções legadas por
tarefa mantêm `begin-discussion`, `finish-discussion`, `plan-task` e `finish-planning`. Para uma execução com fases:

```bash
node $ENGINE fail T4 --reason "review: <actual unmet criterion>" --run <run-name>
# Edite o plano aprovado; separe os critérios atuais do contexto substituído.
node $ENGINE sync-plan --plan <approved-plan.json> --run <run-name>
node $ENGINE graph --run <run-name>  # inspecione a definição persistida de T4 antes da nova tentativa
node $ENGINE show-contract T4 --diff --run <run-name>
node $ENGINE retry T4 --run <run-name>
node $ENGINE begin-phase-discussion F2 --run <run-name> # antes da pergunta no chat principal
node $ENGINE finish-phase-discussion F2 --context <discovery.json> --run <run-name>
node $ENGINE plan-phase F2 --agent <planner> --run <run-name> # combine com um único disparo de planejador somente leitura
node $ENGINE finish-phase-planning F2 --plan-dir <artifact-directory> --run <run-name>
node $ENGINE start T4 --agent <executor> --run <run-name>  # combine com o disparo real
```

Retome a partir da fase registrada se alguns passos já aconteceram. `retry` sozinho não recarrega
o plano e se recusa a prosseguir quando a tarefa com falha registrada difere de sua fonte aprovada;
execute `sync-plan` e inspecione primeiro. `sync-plan` atualiza toda definição não terminal sem alterar seu
ciclo de vida e preserva definições concluídas como histórico imutável; o refresh apenas atualiza campos de validação
e não registra uma reprovação. Preserve a razão e a evidência da
tentativa anterior. Uma nova tentativa corretiva delimitada registra `planSourceAttempt` separadamente da
tentativa imediatamente reprovada `correctionOf` e leva essa razão da revisão como contexto de execução,
sem alterar o plano da tarefa aprovado nem acrescentar uma rodada de planejamento fabricada. Justificativa ausente do revisor,
`--plan-defect`, ou um resultado alterado de contrato, descoberta, escopo ou dependência faz o motor exigir
planejamento. Não use `--plan-defect` para feedback de revisão com contrato inalterado sob a regra de um único planejador;
bloqueie e obtenha uma decisão explícita de contrato quando o contrato existente não conseguir resolver a lacuna. Prefira o editor estruturado do ambiente para o plano aprovado. Se um
programa temporário for a forma mais segura de alterar um plano grande, confira seu backup e o diff exato,
e então remova-o; esse auxiliar não é uma transição do Prumo.

Uma implementação reprovada pelo revisor com contrato aprovado inalterado deve reutilizar seu plano aprovado
atual em toda correção, independentemente do número de novas tentativas, enquanto o contexto completo de planejamento registrado ainda
corresponder. O feedback da revisão segue para o próximo executor; ele não dispara um planejador. Somente uma mudança
material de contrato explicitamente aprovada exige novo planejamento, preservando planos e evidências anteriores.

## Checklist de briefing e procedência

Gere `brief <task> --role reviewer` após a passagem, inclusive após `unblock --reviewer`.
Confira o contrato persistido e o diff atual; recibos antigos não são inspeção do novo revisor.
Confira nomes/linhas novas e exceções específicas de texto dentro do escopo aprovado.
Para sínteses numéricas, verifique cada fonte/caminho e localização, o valor declarado,
a regra explícita de soma/contagem e a localização do resultado. Execute `verify-provenance`
ou o gate de `validate`; não aceite um recibo de dependência como prova da contagem.
Valores de modelo/esforço e tokens/ferramentas são informados, não medições independentes.
