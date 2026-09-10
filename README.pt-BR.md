# PRUMO

[English](README.md) · **Português (Brasil)**

PRUMO reúne o motor do [graph-foreman](https://github.com/JrSantiaggo/graph-foreman) com PO First: execução de planos aprovados, tarefas ordenadas por dependências, revisão independente, evidências de validação e um dashboard local. O mesmo fluxo atende software, dados, automação, migrações e outras demandas.

O plano define o resultado esperado; o motor controla estados e registros. O ambiente de IA executa o trabalho e dispara seus agentes.

## Instalação

Requer **Node.js 22 ou superior** e o ambiente escolhido. O instalador não instala Claude Code, Kiro ou Codex, nem altera suas permissões de execução.

```sh
bunx prumo@latest install --claude
bunx prumo@latest install --kiro
bunx prumo@latest install --codex
```

Pode substituir `bunx` por `npx`. Bun é opcional; o executável usa Node.js. Os arquivos são cópias persistentes, independentes do cache do gerenciador.

```sh
npx prumo@latest install --claude --lang pt-BR --dry-run
npx prumo@latest install --claude --lang pt-BR
npx prumo@latest doctor --claude --lang pt-BR
```

`--dry-run` apenas mostra as alterações. A instalação real mostra os arquivos antes de aplicá-las e informa o backup. Repita o comando para atualizar; arquivos e blocos idênticos não são duplicados. `--project <caminho>` inclui um projeto adicional na busca por instalações e dados existentes; pode ser repetido. Não há varredura indiscriminada do disco.

| Ambiente | Invocação | PO First |
|---|---|---|
| Claude Code | `/prumo` | Output style instalado e selecionado nas configurações |
| Kiro | `/prumo` | Steering permanente e recursos explícitos dos agentes JSON encontrados |
| Codex | `$prumo` / seletor de skills | Bloco no arquivo global de instruções efetivamente carregado |

PO First vale também fora do PRUMO. Prioriza resultado, regras, escopo, decisões e evidência; não depende de outras skills pessoais. No Claude, as instruções de programação permanecem habilitadas no estilo.

Abra uma nova sessão depois de instalar. `doctor` distingue arquivos instalados, configuração concluída e condições pendentes. Configurações locais, skills explicitamente desabilitadas e agentes Markdown que exigem conferência da herança são informados; o instalador não promete sobrepor políticas do ambiente. Inspeção de arquivos não comprova o comportamento de um modelo.

## Instalação sobre graph-foreman

Não é necessário migrar planos, parar agentes ou encerrar o dashboard previamente. O instalador detecta os locais padrão, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, projetos informados e ancestrais do diretório atual.

- Instala PRUMO na mesma raiz de skills e mantém compatibilidade com os caminhos antigos dos scripts.
- Preserva os dados no lugar, incluindo `.specs/graph` dentro de projetos e o armazenamento central antigo. Instalar não executa comandos do motor nem modifica contratos, estados, tentativas, evidências ou histórico.
- Faz backup completo das instalações e configurações afetadas antes de escrever. Dados vivos dos planos ficam fora da transação e não são revertidos junto com a instalação.
- Aplica cada conjunto separadamente. Configuração inválida, caminho vinculado ou arquivo ocupado impede somente aquele conjunto. Não encerra processos para liberar arquivos.
- Confere os bytes gravados e reverte o conjunto em caso de falha. Alterações concorrentes de configurações são detectadas.

O backup informa o comando de reversão:

```sh
npx prumo@0.1.0 restore "<diretório-do-backup>"
```

A reversão recusa sobrescrever arquivos que você editou depois. Os planos continuam no estado atual: reverter uma instalação não deve apagar trabalho em andamento. Mantenha sua rotina de backup dos dados de negócio; o instalador não captura uma imagem consistente de todos os planos ativos.

Um dashboard já aberto pode carregar a nova interface no próximo acesso. Seu processo continua com o código já carregado até ser reiniciado; a instalação não o reinicia silenciosamente.

## Executar um plano

Apresente e aprove o plano no ambiente de IA. Invoque `/prumo <plano-ou-execução>` ou `$prumo` no Codex. O motor registra despachos; quem cria agentes é o ambiente. Sem suporte a executores e revisores independentes, o fluxo deve informar a limitação.

Para novos planos, selecione um workspace central. No PowerShell:

```powershell
$env:PRUMO_HOME = Join-Path $HOME '.local/share/prumo'
$env:PRUMO_ROOT = Join-Path $env:PRUMO_HOME 'meu-workspace'
New-Item -ItemType Directory -Force -Path $env:PRUMO_ROOT | Out-Null
```

No macOS/Linux:

```sh
export PRUMO_HOME="$HOME/.local/share/prumo"
export PRUMO_ROOT="$PRUMO_HOME/meu-workspace"
mkdir -p "$PRUMO_ROOT"
```

Nos planos existentes, preserve o workspace original. `GRAPH_ROOT` e `GRAPH_FOREMAN_HOME` continuam aceitos; as variáveis `PRUMO_*` têm precedência quando definidas. Sem configuração explícita, o armazenamento central legado existente é reutilizado. Nos demais casos, novos planos usam `~/.local/share/prumo`.

Os scripts ficam em `scripts/`, junto da skill. Resolva caminhos a partir dela. Consulte a [referência do motor](references/runtime.pt-BR.md) para comandos, contratos e estados.

## O que significa aprovar

Uma mudança funcional precisa de um passo executável marcado `kind: "functional"`. Lint, compilação, tipagem e texto isolados não bastam. O motor executa comandos aprovados e registra saída, retorno, diretório e prazo; o revisor avalia se a evidência comprova o comportamento pedido.

Documentação e outras tarefas sem efeito de execução podem usar `validationMode: "inspection"`, com `inspectionReason` e evidência. A exceção não deve mascarar mudança funcional. Um rótulo no plano não prova a qualidade do teste.

Atualizar um contrato aprovado não exige inventar falha ou nova tentativa. `refresh-contract` preserva trabalho e estado, inclusive bloqueios, e invalida recibos antigos. Desbloquear e retomar são decisões separadas; instalar não faz nenhuma delas.

## Idiomas e compatibilidade

Use `--lang en|pt-BR`, `PRUMO_LANG`, detecção do ambiente ou o seletor persistente no dashboard. Interface, mensagens e documentação têm inglês e PT-BR; instruções internas ficam em inglês e orientam responder no idioma do usuário. Identificadores, contratos, comandos e saídas dos processos não são traduzidos.

Os testes do instalador e motor para Windows, macOS e Linux, com Node.js 22 e 24, estão definidos em [CI](.github/workflows/ci.yml). Cada aplicativo depende dos sistemas suportados por seu fornecedor. A [matriz de verificação](references/verification.md) distingue testes automatizados e sessões reais.

## Desenvolvimento e licença

```sh
npm test
npm run check
npm pack
```

Ao editar traduções: `node scripts/build-dashboard.mjs --write`. O dashboard incorpora o catálogo para funcionar em servidores antigos sem novas rotas de arquivos.

PRUMO é um fork do graph-foreman de **JrSantiaggo**, com histórico e [licença MIT](LICENSE) preservados. As alterações estão documentadas no [changelog](CHANGELOG.md).
