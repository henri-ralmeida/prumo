# Prumo

[English](README.md) · **Português (Brasil)**

Prumo reúne o motor do [graph-foreman](https://github.com/JrSantiaggo/graph-foreman) com PO First: planos aprovados, pesquisa e planejamento por fase, execução ordenada por dependências, revisão independente, evidências de validação e um dashboard local. O mesmo fluxo atende software, dados, automação, migrações e outras demandas.

O plano define o resultado esperado; o motor controla estados e registros. O ambiente de IA executa o trabalho e dispara seus agentes.

## Instalação

Requer **Node.js 22 ou superior** e o ambiente escolhido. O instalador não instala Claude Code, Kiro ou Codex, nem altera suas permissões de execução.

Instale a CLI, a skill Prumo, o PO First e o serviço de dashboard do usuário em uma etapa:

```sh
npm install -g @henri-ralmeida/prumo
```

O `postinstall` global do npm configura todos os ambientes suportados detectados e habilita o dashboard em [http://localhost:4949](http://localhost:4949). Uma instalação npm local no projeto é inerte: não altera configurações globais nem registra inicialização. Se os scripts do npm estavam desabilitados, ou um novo ambiente foi instalado depois, repare a configuração com `prumo install --all`.

Ao menos um ambiente configurado com sucesso é preservado e o dashboard é habilitado mesmo se outro falhar, mas o comando retorna código diferente de zero e informa a configuração incompleta. Se nenhum puder ser configurado, a instalação retorna erro e não habilita o dashboard. Repetir o comando retoma com segurança, sem duplicar arquivos, blocos gerenciados ou registros de inicialização.

Você também pode abrir o instalador interativo, escolher um ambiente ou conferir a prévia:

| Destino | Comando |
|---|---|
| Detectar e escolher ambientes disponíveis | `bunx @henri-ralmeida/prumo@latest install` |
| Todos os ambientes detectados, sem perguntas | `bunx @henri-ralmeida/prumo@latest install --all` |
| Claude Code | `bunx @henri-ralmeida/prumo@latest install --claude` |
| Kiro | `bunx @henri-ralmeida/prumo@latest install --kiro` |
| Codex | `bunx @henri-ralmeida/prumo@latest install --codex` |
| Reparar após scripts npm desabilitados | `prumo install --all` |
| Conferir mudanças de ambientes e dashboard | `prumo install --all --dry-run` |

Ele detecta ambientes por configurações reais ou comandos no `PATH` (`claude`, `kiro-cli` / `kiro`, `codex`). Pastas vazias como `~/.claude`, `~/.kiro` e `~/.codex` não bastam. O menu mostra somente os ambientes detectados, inicialmente todos marcados. Use as setas para navegar, Espaço para marcar/desmarcar, A para todos/nenhum, Enter para instalar ou Esc para cancelar. A instalação é por usuário e vale para seus projetos; nenhuma alteração é aplicada antes da seleção.

Para instalar em todos os ambientes detectados sem perguntas, inclusive em scripts:

```sh
bunx @henri-ralmeida/prumo@latest install --all
```

Sem terminal interativo, use `--all` ou uma opção explícita de ambiente. Se nenhum ambiente for detectado, o instalador informa isso sem gravar arquivos. Para escolher um ambiente diretamente:

```sh
bunx @henri-ralmeida/prumo@latest install --claude --lang pt-BR
bunx @henri-ralmeida/prumo@latest install --kiro --lang pt-BR
bunx @henri-ralmeida/prumo@latest install --codex --lang pt-BR
```

O idioma é detectado pelo **país/região configurado no sistema operacional**: Brasil seleciona português do Brasil; outras regiões ou configuração indisponível selecionam inglês. Usa a região residencial do Windows, as preferências regionais do macOS ou a localidade de endereços do Linux, independentemente do idioma de exibição/navegador. Não usa geolocalização por IP. Para escolher explicitamente, use `--lang pt-BR` ou `--lang en`. Por exemplo:

```sh
bunx @henri-ralmeida/prumo@latest install --claude --lang en
```

Sem `--lang`, instalações existentes mantêm a preferência salva. O dashboard segue a instalação e não tem seletor de idioma separado. As respostas dos agentes seguem o idioma do usuário.

A instalação real também instala a CLI global persistente pelo npm; em um novo terminal, `prumo -v` e `prumo update` ficam disponíveis. Os arquivos dos ambientes continuam independentes do cache do Bun. `--dry-run` não altera CLI nem ambientes.

```sh
bunx @henri-ralmeida/prumo@latest install --claude --lang pt-BR --dry-run
bunx @henri-ralmeida/prumo@latest doctor --claude --lang pt-BR
```

`--dry-run` apenas mostra mudanças nos ambientes e a criação ou reinício do serviço do dashboard. A instalação real mostra progresso enxuto; a prévia informa arquivos, backups e conflitos. Repita o comando para reparar ou atualizar; arquivos, blocos e registros de inicialização idênticos não são duplicados. `--project <caminho>` registra um projeto adicional e o inclui na busca por instalações e runs; pode ser repetido. O Prumo não varre o disco inteiro.

| Ambiente | Invocação | PO First |
|---|---|---|
| Claude Code | `/prumo` | Output style instalado e selecionado nas configurações |
| Kiro | `/prumo` | Steering permanente e recursos explícitos dos agentes JSON encontrados |
| Codex | `$prumo` / seletor de skills | Bloco no arquivo global de instruções efetivamente carregado |

PO First vale também fora do Prumo. Prioriza resultado, regras, escopo, decisões e evidência; não depende de outras skills pessoais. No Claude, as instruções de programação permanecem habilitadas no estilo.

Abra uma nova sessão depois de instalar. `doctor` distingue arquivos instalados, configuração concluída e condições pendentes. Configurações locais, skills explicitamente desabilitadas e agentes Markdown que exigem conferência da herança são informados; o instalador não promete sobrepor políticas do ambiente. Inspeção de arquivos não comprova o comportamento de um modelo.

### Operações do dashboard

```sh
prumo dashboard status
prumo dashboard enable
prumo dashboard disable
prumo dashboard
```

`status` informa registro, processo, versão, porta, URL e o mecanismo de inicialização escolhido. `enable` registra a inicialização para o usuário atual e inicia o servidor imediatamente: no Windows, tenta primeiro o Agendador de Tarefas; se a tarefa do usuário não puder ser criada, o Prumo usa automaticamente uma única entrada oculta na pasta Inicializar do usuário atual, sem pedir acesso de administrador. O macOS usa um LaunchAgent, e o Linux usa um serviço systemd do usuário com fallback XDG. Reinstalações e atualizações preservam o mecanismo escolhido. `disable` encerra um processo Prumo identificado com exatidão e remove somente o registro gerenciado; essa escolha sobrevive a reinstalações e atualizações. `prumo dashboard` sem complemento executa o servidor em primeiro plano.

O servidor escuta somente em `127.0.0.1:4949` e é somente leitura. Ele descobre workspaces centrais conhecidos e projetos registrados em `installations.json`, escolhe a run atual modificada mais recentemente, percebe novas runs sem reiniciar e mostra estado vazio quando nenhuma existe. Ele não executa tarefas, edita o estado do grafo, sincroniza planos nem varre o disco.

O dashboard mantém todos os cards no lugar enquanto os filtros reduzem a opacidade do trabalho não relacionado. Os filtros cobrem todos, concluídos, incompletos, aguardando dependências, prontos para discussão, em discussão, prontos para planejamento, planejando, prontos para executar, executando, revisando, bloqueados, falhos e ignorados; `done` e `skipped` são terminais. Ligue o contexto de dependências para revelar predecessores, sucessores diretos e suas curvas. A densidade é detalhada até 24 tarefas, compacta até 100 e densa acima disso; as fases também quebram conforme a largura da janela, e o painel lateral pode ser recolhido sem perder seleção ou navegação.

Em problemas de inicialização ou porta, comece por `prumo dashboard status`. Se outro Prumo ocupa a porta 4949, a configuração reutiliza ou reinicia o serviço gerenciado. Se for outro processo, o Prumo informa o conflito e nunca o encerra; resolva o processo identificado e execute `prumo dashboard enable`.

## Atualizar os ambientes instalados

O instalador e o atualizador disponibilizam o comando curto:

```sh
prumo update --dry-run
prumo update
```

`bunx @henri-ralmeida/prumo@latest update` oferece a mesma atualização em qualquer pasta. Uma atualização real instala ou atualiza a CLI global, atualiza Prumo/PO First em todos os ambientes instalados detectados e reinicia o dashboard habilitado. Um `dashboard disable` explícito continua respeitado. `--dry-run` apenas mostra essas alterações. O npm precisa estar disponível; falha no download mantém as instalações intactas.

Atualizações normais mostram uma barra colorida e compacta de progresso por etapas em terminais interativos e terminam com `Prumo atualizado com sucesso`, seguido da versão instalada em `Prumo v<versão>`. Use `prumo update --dry-run` para ver a prévia detalhada de arquivos e conflitos. O instalador registra ambientes e caminhos personalizados em `~/.local/share/prumo/installations.json`. A atualização também reconhece marcadores existentes do Prumo nos locais padrão e nos projetos informados com `--project`. Preserva o idioma de cada instalação, salvo uso de `--lang`, e reutiliza os backups e o tratamento de conflitos da instalação. Ambientes que contêm somente graph-foreman ficam fora da atualização. Não retoma planos nem cria tentativas. Após `prumo update` concluir, `prumo -v` mostra a versão publicada usada na atualização.

Executar `install` novamente é seguro. Ambientes completos na mesma versão são informados como já instalados, sem regravar arquivos nem criar backup. Instalações antigas, incompletas ou alteradas seguem as verificações normais de prévia, backup e conflito.

## Instalação sobre graph-foreman

Use o mesmo comando `install` para substituir uma instalação existente do graph-foreman pelo Prumo. Para todos os ambientes detectados, confira a prévia e depois aplique:

```sh
bunx @henri-ralmeida/prumo@latest install --all --dry-run
bunx @henri-ralmeida/prumo@latest install --all
```

Omita `--all` para escolher pelas caixas de seleção, ou use `--claude`, `--kiro` ou `--codex` para selecionar um diretamente. Se a instalação estiver dentro de um projeto, execute na pasta dele ou acrescente `--project "<caminho-do-projeto>"`. Essa primeira troca usa `install`; `update` só atualiza ambientes que já contêm Prumo. Depois da migração, use `/prumo` (ou `$prumo` no Codex); a skill legada `/graph-foreman` é removida.

Não é necessário migrar os dados manualmente. Encerre sessões que estejam carregando arquivos da skill graph-foreman antes de instalar; o instalador nunca encerra processos. Ele detecta os locais padrão, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, projetos informados e ancestrais do diretório atual.

- Instala Prumo na mesma raiz de skills, copia arquivos adicionais da instalação legada quando não há conflito, confere a instalação e depois remove a pasta da skill graph-foreman.
- Preserva os dados das runs no lugar, incluindo `.specs/graph` dentro de projetos e o armazenamento central antigo. Instalar não executa comandos do motor nem modifica contratos, estados, tentativas, evidências ou histórico.
- Faz backup completo das instalações e configurações afetadas antes de escrever. Dados vivos dos planos ficam fora da transação e não são revertidos junto com a instalação.
- Aplica cada conjunto separadamente. Arquivos personalizados conflitantes, configuração inválida, caminho vinculado ou arquivo ocupado impedem somente aquele conjunto. O instalador não encerra processos.
- Confere os bytes gravados e reverte o conjunto antes de informar sucesso em caso de falha. Alterações concorrentes são detectadas.

O backup informa o comando de reversão:

```sh
bunx @henri-ralmeida/prumo@1.3.0 restore "<diretório-do-backup>"
```

A reversão recusa sobrescrever arquivos que você editou depois. Os planos continuam no estado atual: reverter uma instalação não deve apagar trabalho em andamento. Mantenha sua rotina de backup dos dados de negócio; o instalador não captura uma imagem consistente de todos os planos ativos.

O dashboard habilitado é reiniciado depois de instalação ou atualização para servir a versão instalada. Um dashboard desabilitado permanece desabilitado.

## Executar um plano

Apresente e aprove o plano global no modo Plan/Spec do ambiente de IA. Se esse modo bloquear escrita ou despacho de agentes, saia dele depois da aprovação. Então invoque `/prumo <plano-ou-execução>` no Claude Code ou Kiro, ou `$prumo` no Codex. O motor registra despachos; quem cria agentes é o ambiente. Sem suporte a planejadores dedicados, executores ou revisores independentes, o fluxo deve informar a limitação.

Na **1.3.0**, há dois níveis de planejamento. O modo Plan/Spec global define e aprova o grafo. Cada fase então segue **discutir → planejar → executar → revisar**: primeiro o orquestrador registra a fase em discussão, pesquisa e faz ao menos uma pergunta contextual na conversa principal. Quando as áreas cinzentas relevantes estão fechadas, um planejador dedicado e somente leitura pesquisa o projeto e grava um `task-plan-<id>.json` separado e imutável para cada tarefa da fase. O planejador não edita arquivos do produto nem o estado do grafo.

A discussão e o planejamento da fase podem ocorrer antes de suas dependências terminarem. O DAG continua sendo a autoridade de execução: cada executor só começa quando suas próprias entradas estão prontas, e um revisor independente confere o resultado. Uma tarefa anterior que depende de fase posterior registra a entrada como não resolvida. O recibo atual de validação aprovada do produtor, ou uma dispensa explícita por tarefa pulada, satisfaz a entrada na execução sem reescrever um plano correto.

Resolva `$ENGINE` como `scripts/engine.mjs` dentro da skill Prumo instalada. A passagem completa da fase é:

```sh
node "$ENGINE" begin-phase-discussion F1
# Faça e responda às perguntas da fase na conversa principal.
node "$ENGINE" finish-phase-discussion F1 --context "$PRUMO_ROOT/.specs/graph/plans/discovery-F1.json"
node "$ENGINE" plan-phase F1 --agent plan-F1
# O planejador somente leitura grava um task-plan-<id>.json por tarefa alvo.
node "$ENGINE" finish-phase-planning F1 --plan-dir "$PRUMO_ROOT/.specs/graph/plans"
node "$ENGINE" start T1 --agent executor-T1
node "$ENGINE" review T1 --agent reviewer-T1
```

| Estado no dashboard | Cor | Significado |
|---|---|---|
| Pronto para discussão (`ready_for_discussion`) | Violeta | A fase precisa de discussão atual na conversa principal; ela pode acontecer antes das dependências das tarefas terminarem |
| Em discussão (`discussing`) | Violeta | Estado persistido da fase enquanto a conversa principal resolve áreas cinzentas relevantes |
| Pronto para planejamento (`ready_to_plan`) | Azul | Estado persistido da fase após encerrar a discussão; o planejador pode começar antes das dependências terminarem |
| Em planejamento (`planning`) | Rosa | Um planejador somente leitura prepara planos separados para as tarefas da fase |
| Pronto para executar (`ready`) | Verde-azulado | O plano da tarefa está atual e suas entradas do DAG estão prontas |

A descoberta usa a caixa nativa de perguntas do ambiente quando disponível e um bloco estruturado na conversa principal quando não estiver. Ela registra pesquisa leve, respostas reais, cobertura PO First, decisões, ideias adiadas e o motivo de não restar área cinzenta relevante. O planejador a consome sem repetir a discussão. Mudanças materiais de escopo, contrato ou decisões compartilhadas da fase exigem nova discussão e planejamento do trabalho afetado; um defeito de plano marcado pelo revisor replaneja somente aquela tarefa. Achados comuns do executor e retries corretivos reutilizam o plano imutável quando ele continua correto e atual.

Runs existentes no modo por tarefa preservam fluxo e histórico. Uma fase compatível antes da execução pode aderir com `begin-phase-discussion <fase> --adopt-legacy`; adoção insegura é recusada de forma atômica. Consulte [artefato de planejamento por fase](references/runtime.pt-BR.md#descoberta-e-planejamento-por-fase) e [planos em andamento](references/runtime.pt-BR.md#planos-em-andamento).

Para novos planos, selecione um workspace central. No PowerShell:

```powershell
$prumoDefault = Join-Path $HOME '.local/share/prumo'
$prumoLegacy = Join-Path $HOME '.local/share/graph-foreman'
if (Test-Path -LiteralPath $prumoLegacy) { $prumoDefault = $prumoLegacy }
if (-not $env:PRUMO_HOME) {
  $env:PRUMO_HOME = if ($env:GRAPH_FOREMAN_HOME) { $env:GRAPH_FOREMAN_HOME } else { $prumoDefault }
}
$env:PRUMO_ROOT = Join-Path $env:PRUMO_HOME 'meu-workspace'
New-Item -ItemType Directory -Force -Path $env:PRUMO_ROOT | Out-Null
```

No macOS/Linux:

```sh
DEFAULT_PRUMO_HOME="$HOME/.local/share/prumo"
[ ! -d "$HOME/.local/share/graph-foreman" ] || DEFAULT_PRUMO_HOME="$HOME/.local/share/graph-foreman"
export PRUMO_HOME="${PRUMO_HOME:-${GRAPH_FOREMAN_HOME:-$DEFAULT_PRUMO_HOME}}"
export PRUMO_ROOT="$PRUMO_HOME/meu-workspace"
mkdir -p "$PRUMO_ROOT"
```

Nos planos existentes, preserve o workspace original. `GRAPH_ROOT` e `GRAPH_FOREMAN_HOME` continuam aceitos; as variáveis `PRUMO_*` têm precedência quando definidas. Sem configuração explícita, o armazenamento central legado existente é reutilizado. Nos demais casos, novos planos usam `~/.local/share/prumo`.

Claude Code, Kiro e Codex locais, executados pelo mesmo usuário, compartilham essa pasta. Os comandos criam as pastas ausentes. Preserve os caminhos existentes e use as mesmas configurações nos três ambientes. O acesso depende das permissões de cada ambiente; sessões na nuvem não compartilham automaticamente os arquivos locais.

Os scripts ficam em `scripts/`, junto da skill. Resolva caminhos a partir dela. Consulte a [referência do motor](references/runtime.pt-BR.md) para comandos, contratos e estados.

## O que significa aprovar

Uma mudança funcional precisa de um passo executável marcado `kind: "functional"`. Lint, compilação, tipagem e texto isolados não bastam. O motor executa comandos aprovados e registra saída, retorno, diretório e prazo; o revisor avalia se a evidência comprova o comportamento pedido.

Documentação e outras tarefas sem efeito de execução podem usar `validationMode: "inspection"`, com `inspectionReason` e evidência. A exceção não deve mascarar mudança funcional. Um rótulo no plano não prova a qualidade do teste.

Atualizar um contrato aprovado não exige inventar falha ou nova tentativa. `refresh-contract` preserva trabalho e estado, inclusive bloqueios, e invalida recibos antigos. Desbloquear e retomar são decisões separadas; instalar não faz nenhuma delas.

Mantenha contexto e requisitos substituídos nos documentos aprovados e no histórico, critérios vigentes em `expect` e provas reais em `run`. Cada critério funcional precisa de evidência relevante; um rótulo funcional não comprova a tarefa inteira. Após reprovação real **com** mudança aprovada do contrato: registre a falha, edite o plano, rode `sync-plan` enquanto está failed, confira a definição persistida e siga com `retry`, planejamento exigido e `start` junto dos disparos reais dos agentes. Consulte [reprovação e alteração de contrato](references/runtime.pt-BR.md#reprovação-real-com-alteração-aprovada-do-contrato). Após interrupções, retome da fase registrada; não invente tentativas por um disparo que não aconteceu.

## Idiomas e compatibilidade

O idioma inicial segue a região configurada no sistema, com inglês como fallback. Use `--lang en|pt-BR` ou `PRUMO_LANG` para uma escolha explícita. O dashboard segue a preferência salva na instalação e não tem seletor de idioma. Interface, mensagens e documentação têm inglês e PT-BR; instruções internas ficam em inglês e orientam responder no idioma do usuário. Identificadores, contratos, comandos e saídas dos processos não são traduzidos.

Os testes do instalador e motor para Windows, macOS e Linux, com Node.js 22 e 24, estão definidos em [CI](.github/workflows/ci.yml). Cada aplicativo depende dos sistemas suportados por seu fornecedor. A [matriz de verificação](references/verification.md) distingue testes automatizados e sessões reais.

## Publicação de atualizações

Enviar alterações para `main` executa o CI; isso não publica o pacote npm nem atualiza uma release do GitHub. Cada atualização publicada precisa de uma nova versão em `package.json`, verificações de release e changelog correspondentes, CI aprovado, tag Git e release do GitHub. Publique o arquivo testado no npm como `@henri-ralmeida/prumo`; a tag `latest` do npm determina a versão instalada pelos comandos acima.

## Desenvolvimento e licença

```sh
npm test
npm run check
npm pack
```

Ao editar traduções: `node scripts/build-dashboard.mjs --write`. O dashboard incorpora o catálogo para funcionar em servidores antigos sem novas rotas de arquivos.

Prumo é um fork do graph-foreman de **JrSantiaggo**, com histórico e [licença MIT](LICENSE) preservados. As alterações estão documentadas no [changelog](CHANGELOG.md).
