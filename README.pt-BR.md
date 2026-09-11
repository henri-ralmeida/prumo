# Prumo

[English](README.md) · **Português (Brasil)**

Prumo reúne o motor do [graph-foreman](https://github.com/JrSantiaggo/graph-foreman) com PO First: execução de planos aprovados, tarefas ordenadas por dependências, revisão independente, evidências de validação e um dashboard local. O mesmo fluxo atende software, dados, automação, migrações e outras demandas.

O plano define o resultado esperado; o motor controla estados e registros. O ambiente de IA executa o trabalho e dispara seus agentes.

## Instalação

Requer **Node.js 22 ou superior** e o ambiente escolhido. O instalador não instala Claude Code, Kiro ou Codex, nem altera suas permissões de execução.

Abra o instalador interativo ou escolha um ambiente diretamente:

| Destino | Comando |
|---|---|
| Detectar e escolher ambientes disponíveis | `bunx @henri-ralmeida/prumo@latest install` |
| Todos os ambientes detectados, sem perguntas | `bunx @henri-ralmeida/prumo@latest install --all` |
| Claude Code | `bunx @henri-ralmeida/prumo@latest install --claude` |
| Kiro | `bunx @henri-ralmeida/prumo@latest install --kiro` |
| Codex | `bunx @henri-ralmeida/prumo@latest install --codex` |

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

`--dry-run` apenas mostra as alterações; sem terminal ou opção de ambiente, mostra a prévia de todos os detectados. A instalação real mostra progresso enxuto; `--dry-run` informa arquivos, backups e conflitos. Repita o comando para atualizar; arquivos e blocos idênticos não são duplicados. `--project <caminho>` inclui um projeto adicional na busca por instalações e dados existentes; pode ser repetido. Não há varredura indiscriminada do disco.

| Ambiente | Invocação | PO First |
|---|---|---|
| Claude Code | `/prumo` | Output style instalado e selecionado nas configurações |
| Kiro | `/prumo` | Steering permanente e recursos explícitos dos agentes JSON encontrados |
| Codex | `$prumo` / seletor de skills | Bloco no arquivo global de instruções efetivamente carregado |

PO First vale também fora do Prumo. Prioriza resultado, regras, escopo, decisões e evidência; não depende de outras skills pessoais. No Claude, as instruções de programação permanecem habilitadas no estilo.

Abra uma nova sessão depois de instalar. `doctor` distingue arquivos instalados, configuração concluída e condições pendentes. Configurações locais, skills explicitamente desabilitadas e agentes Markdown que exigem conferência da herança são informados; o instalador não promete sobrepor políticas do ambiente. Inspeção de arquivos não comprova o comportamento de um modelo.

## Atualizar os ambientes instalados

O instalador e o atualizador disponibilizam o comando curto:

```sh
prumo update --dry-run
prumo update
```

`bunx @henri-ralmeida/prumo@latest update` oferece a mesma atualização em qualquer pasta. Uma atualização real instala ou atualiza a CLI global e atualiza Prumo/PO First em todos os ambientes instalados detectados; `--dry-run` apenas mostra essas alterações. O npm precisa estar disponível; falha no download mantém as instalações intactas.

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
bunx @henri-ralmeida/prumo@1.1.0 restore "<diretório-do-backup>"
```

A reversão recusa sobrescrever arquivos que você editou depois. Os planos continuam no estado atual: reverter uma instalação não deve apagar trabalho em andamento. Mantenha sua rotina de backup dos dados de negócio; o instalador não captura uma imagem consistente de todos os planos ativos.

Um dashboard já aberto pode carregar a nova interface no próximo acesso. Seu processo continua com o código já carregado até ser reiniciado; a instalação não o reinicia silenciosamente.

## Executar um plano

Apresente e aprove o plano no ambiente de IA. Invoque `/prumo <plano-ou-execução>` ou `$prumo` no Codex. O motor registra despachos; quem cria agentes é o ambiente. Sem suporte a executores e revisores independentes, o fluxo deve informar a limitação.

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

Mantenha contexto e requisitos substituídos nos documentos aprovados e no histórico, critérios vigentes em `expect` e provas reais em `run`. Cada critério funcional precisa de evidência relevante; um rótulo funcional não comprova a tarefa inteira. Após reprovação real **com** mudança aprovada do contrato: registre a falha, edite o plano, rode `sync-plan` enquanto está failed, confira a definição persistida e siga com `retry` e `start` junto do disparo real do agente. Consulte [reprovação e alteração de contrato](references/runtime.pt-BR.md#reprovação-real-com-alteração-aprovada-do-contrato). Após interrupções, retome da fase registrada; não invente tentativas por um disparo que não aconteceu.

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
