# Cobertura e verificacao de comportamento

A cobertura deve apontar caminhos ainda nao exercitados, para que erros de comandos,
atualizacao e recuperacao sejam detectados antes de uma entrega. Percentual de cobertura
nao comprova sozinho a preservacao dos dados nem a ausencia de defeitos.

## Escopo elegivel

- Codigo proprio executavel em `bin/`, `lib/`, `scripts/` e `tools/`, incluindo caminhos de falha.
- JavaScript do dashboard, com correspondencia ao codigo realmente entregue.
- Comandos publicos, preferencias de instalacao e recuperacao apos falhas.

Testes, fixtures, scripts de smoke que executam os cenarios de teste e dependencias de
terceiros ficam fora do denominador. HTML estatico, CSS e documentacao nao possuem
cobertura V8; seus comportamentos relevantes precisam de verificacao funcional.
Codigo nao carregado deve continuar no relatorio com cobertura zero. Nao exclua um
arquivo, ramo ou funcao apenas porque falta um teste.

A agregação usa `merge-async` do c8 para ler os perfis de subprocessos de forma
incremental, evitando manter toda a coleta simultaneamente na memória. Essa opção
mantém os mesmos contadores e o mesmo denominador; não remove código da medição.

### Exclusoes pontuais comprovadas

- `scripts/atomic-state.mjs`: o V8 cria um ramo para a passagem vazia entre o laco
  de tentativas e `finally`. O laco sempre retorna apos renomear ou lanca apos uma
  falha definitiva; nao existe caminho que saia normalmente dele. A exclusao
  cobre somente essa passagem, mantendo a limpeza e suas falhas nos testes.

## Executar

A coleta de desenvolvimento usa Node 22.15 ou superior para atribuir a cobertura
das instalacoes temporarias ao fonte atual. O requisito do produto permanece Node 22.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run test:coverage
```

O c8 exige 100% de linhas, instrucoes, funcoes e ramos por arquivo elegivel. O relatorio
fica em `.test-output/coverage/index.html`, com dados em `coverage-final.json` e
`coverage-summary.json`. Esses resultados sao locais e nao entram no pacote npm.

As verificacoes precisam preservar diretorios e processos reais: use instalacoes e
portas isoladas. Uma falha simulada deve comprovar tanto o erro quanto os arquivos,
preferencias ou processos que precisam permanecer intactos.

No GitHub Actions, os seis ambientes coletam dados sem ocultar ramos exclusivos de
um sistema operacional. A consolidacao exige os mesmos fontes e 100% em todas as
dimensoes por arquivo. Relatorios antigos, fontes ausentes e denominador vazio
fazem a verificacao falhar, inclusive quando um arquivo aparece sem instrucoes medidas.
Cada ambiente verifica as versões efetivamente publicadas no npm usando seus tarballs
reais. Essa matriz faz parte da coleta c8, para que os subprocessos do código atual
também contribuam para a cobertura. Não há uma segunda execução da mesma matriz após
o empacotamento.

Copias instaladas so compartilham contadores quando seu JavaScript e identico ao
fonte atual. A instrumentacao nao muda `import.meta.url`, a origem da instalacao
nem os arquivos distribuidos. Codigo de uma versao antiga nao recebe credito na atual.

## Versoes antigas

O registro npm define quais versões entram na matriz automática. Tags que nunca
foram publicadas não representam instalações distribuídas por esse canal e ficam
fora dessa rotina. As verificações de reinstalação das tags v1.0.0 e v1.0.1 continuam
disponíveis mediante `PRUMO_TEST_GIT_RELEASES=1`, para uma investigação explícita.

As versões publicadas são verificadas com seus instaladores e comandos reais.
Dados de produtos distintos permanecem separados; migrações de versões antigas do
Prumo copiam dados duráveis e preservam a origem.
