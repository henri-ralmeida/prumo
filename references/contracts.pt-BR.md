# Contratos de validação

[English](contracts.md)

Cada etapa executável de validação pode declarar `requiresEnv: ["SERVICE_TOKEN", "API_URL"]`. Os nomes devem seguir a sintaxe portátil de variáveis de ambiente (`[A-Za-z_][A-Za-z0-9_]*`). O ambiente efetivo combina o ambiente do processo com `step.env`; o valor da etapa prevalece, e valores vazios ou contendo somente espaços são considerados ausentes. No Windows, os nomes não distinguem maiúsculas de minúsculas. Os requisitos pertencem ao contrato de validação. Etapas estáticas com `requiresEnv` não vazio são executadas novamente mesmo com `cacheable`, pois valores externos podem mudar sem alteração no projeto; etapas históricas sem requisitos mantêm seu cache. Não inclua valores de credenciais no plano para satisfazer um pré-requisito.

Leia isto ao escrever ou traduzir a `validation` de um plano, ao conferir um plano aprovado antes do
primeiro despacho e ao adaptar um contrato antigo. A sintaxe dos campos (`kind`, `cacheable`, `cachePaths`,
`env`, `shell`, `expectedExitCodes`, `timeoutMs`) está em [runtime.pt-BR.md](runtime.pt-BR.md#contrato-da-tarefa); como um
revisor usa o contrato está em [review.pt-BR.md](review.pt-BR.md).

## Contratos independentes de domínio

O motor gerencia dependências, papéis, tentativas, pausas e evidências, independentemente do domínio.
A execução pode produzir código, dados transformados, resultados de automação, configuração migrada ou
outros entregáveis. Não deduza escopo novo nem prescreva um framework a partir da categoria da tarefa.
Aqui, funcional significa verificar o resultado observável pretendido, não necessariamente um teste unitário:
confira os valores migrados e o consumidor de destino, os registros resultantes ou a ação
concluída de uma automação, conforme o caso. O plano fornece o critério e o método de verificação.
Quando não houver diff de código, entregue ao revisor os artefatos entregues e o estado antes/depois relevante.
Uma exceção de inspeção serve para entregáveis cuja correção pode ser estabelecida por inspeção;
ela não deve substituir a observação de um fluxo executável alterado ou de um efeito colateral operacional.
Atualmente o motor coleta verificações executáveis por meio de comandos de shell. Ele próprio não
opera uma GUI, não consulta um conector nem certifica uma observação humana. Para esse tipo de trabalho, use um comando de
verificação aprovado quando existir; aponte um método de verificação não suportado em vez de
inventar um comando que passe ou tratar ferramentas indisponíveis como exceção de inspeção.

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

## Contexto, critérios atuais e prova executável

Mantenha estas três coisas separadas, usando o formato de plano existente:

- **Contexto:** propósito, decisões e histórico na `description` do plano ou em documentos
  aprovados referenciados. Preserve critérios anteriores no histórico/backups, claramente marcados como substituídos.
- **Critérios atuais:** condições de aceite consistentes e observáveis. O `expect` de cada passo
  declara o que aquele passo de fato consegue estabelecer; não é lugar para colar o plano antigo inteiro.
- **Prova executável:** `run` executa a verificação correspondente contra a entrega atual.
  Um build prova a compilação; escrever uma promessa comportamental ao lado dele não prova essa promessa.

Quando uma mudança aprovada substitui um critério, substitua o critério obsoleto em vez de
manter requisitos contraditórios ativos. Não crie passos `echo` para guardar contexto,
contratos históricos ou instruções. Para inspeção legítima, uma `validation` em prosa não vazia
com `validationMode: "inspection"` e `inspectionReason` não precisa de comando de preenchimento.
Use o editor de plano existente; um script de adaptação personalizado não é necessário. Antes de alterar um
plano, mantenha um backup com nome único, verifique edições concorrentes e examine o diff resultante.
Registre a mudança aprovada e o motivo em uma nota; nunca edite o histórico da execução para esconder um erro.

## Validação comportamental

Antes do despacho, confira se o plano aprovado contém verificações comportamentais executáveis para
tarefas funcionais. O padrão é `validationMode: "functional"`. Pelo menos um passo de
validação deve ter `kind: "functional"`, um comando `run` real e um `expect` observável.
Classifique passos de lint, sintaxe, build e typecheck como `kind: "static"`; passos sem tipo são estáticos.
Uma instrução `echo`, análise estática, um teste que apenas busca texto no código-fonte ou um teste que
reimplementa a lógica de produção não conta como cobertura funcional. Examine o teste
e a contagem real de execuções; um processo bem-sucedido com zero testes relevantes é insuficiente.
Para a correção de um bug, demonstre que o teste comportamental detecta o defeito quando for viável.

Pelo menos um passo funcional é um mínimo estrutural, não uma cobertura suficiente por si só.
Mapeie todo critério funcional atual para uma verificação relevante e seu resultado observável antes
do despacho e da revisão. Preserve nesse mapeamento toda dimensão que molda o resultado: ordem e
precedência, limites, entrada malformada ou ausente, repetição e transições de estado quando
se aplicarem. Não deixe uma verificação mais ampla, como pertinência, sucesso ou saída não vazia, fazer as vezes de
uma dessas regras explícitas. Os comandos rodam em ordem: prepare os pré-requisitos antes das verificações que
precisam deles e garanta que testes com build pulado ou filtrados usem a entrega atual e executem os casos
relevantes. Não esconda falhas nem descarte edições não relacionadas para fazer uma verificação passar. Preserve evidências
anteriores com caminhos de saída distintos quando uma verificação gravar artefatos. Revise artefatos existentes
com verificações somente leitura quando isso bastar; repetir um efeito colateral operacional exige autorização
própria e não deve sobrescrever a entrega em revisão.

## Inspeção legítima

Documentação e outras tarefas que não afetam o comportamento em tempo de execução podem usar
`validationMode: "inspection"` com um `inspectionReason` concreto no plano aprovado.
Revise o diff real antes de aceitar a exceção. Não use inspeção para comportamento em tempo de execução
alterado, ferramentas ausentes, ambientes indisponíveis ou um teste que falha. Esses casos exigem uma
reprovação acionável ou uma tarefa bloqueada. `requireReview: false` nunca dispensa verificações funcionais.

## Ambiente, códigos de saída e prazos

Antes de executar uma verificação, torne explícitos o ambiente e os resultados aceitos: use step.env
para variáveis de ambiente (prefixos Unix NAME=value não funcionam no cmd.exe do Windows),
step.expectedExitCodes para resultados diferentes de zero aprovados (padrão [0]) e step.timeoutMs para
verificações longas (padrão 600000; 0 desativa explicitamente o prazo). Nunca amplie os códigos aceitos
nem aumente uma janela de dados apenas para satisfazer a etapa. Veja references/runtime.pt-BR.md para as opções de execução.

Isso vale também no Windows. Mantenha o diretório de trabalho real no passo de validação aprovado; não traduza nem
reescreva seus comandos.

## Modelo para sínteses numéricas

Quando o aceite exigir números de uma síntese, declare `numericProvenance` na tarefa
([schema e exemplo](runtime.pt-BR.md#procedência-executável-de-sínteses-numéricas)).
O contrato exige fontes preservadas, caminho e JSON Pointer de cada origem, valor declarado,
regra explícita de soma/contagem e localização do resultado entregue. Use uma checagem
funcional relevante além da procedência: a conciliação de números não prova todas as regras
de negócio. O motor recusa manifesto ausente/referência inválida/divergência e evidencia
fontes alteradas entre validação e conclusão; recibos de dependência não substituem a origem.
