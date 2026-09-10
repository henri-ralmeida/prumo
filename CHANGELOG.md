# Changelog / Histórico

## 1.0.6

### English

- Make a real installation persist the global `prumo` command. `prumo update` now updates that CLI and installed harness adapters together, so `prumo -v` reports the new version. Runner-based `npx`/`bunx update` remains non-global.
- Verify install, dry-run, self-update and `prumo -v` against an isolated npm prefix and registry; no test writes to the user's global installation.
- Remove nested borders from the dashboard's empty parallel-work state and ignore stale requests when switching runs, preventing old data from briefly repainting the selected plan.

### Português (Brasil)

- Faz a instalação real persistir o comando global `prumo`. `prumo update` passa a atualizar a CLI e os adaptadores instalados juntos; `prumo -v` mostra a nova versão. `npx`/`bunx update` continuam sem criar instalação global.
- Verifica instalação, prévia, autoatualização e `prumo -v` com prefixo e registro npm isolados; nenhum teste grava na instalação global do usuário.
- Remove bordas duplicadas do estado vazio no dashboard e ignora respostas antigas ao trocar de run, evitando que dados do plano anterior reapareçam brevemente.

## 1.0.5

### English

- Clarify domain-neutral contracts: separate approved context, current acceptance criteria and executable proof using existing fields. Replace superseded criteria instead of keeping contradictory historical requirements active.
- Document real rejection combined with an approved contract change: preserve the failure, synchronize the plan before retry, verify persisted criteria and dispatch the actual agent. Recover interrupted dispatch in the same attempt without inventing an implementation failure.
- Require relevant evidence for every functional criterion; clarify prerequisites, current test execution, artifact preservation and legitimate prose inspection without placeholder commands.
- Add an executable regression covering the combined rejection/change/retry lifecycle, including rejection of the old behavior and preservation of earlier evidence and unrelated active work. Keep engine commands, run formats and installer behavior unchanged.

### Português (Brasil)

- Esclarece contratos agnósticos: separa contexto aprovado, critérios vigentes e provas executáveis usando os campos existentes. Substitui critérios obsoletos sem manter requisitos históricos contraditórios ativos.
- Documenta reprovação real com mudança aprovada do contrato: preserva a falha, sincroniza o plano antes do retry, confere critérios persistidos e dispara o agente real. Recupera disparos interrompidos na mesma tentativa sem inventar falha da implementação.
- Exige evidência relevante para cada critério funcional; esclarece pré-requisitos, execução de testes atuais, preservação de artefatos e inspeção legítima em texto sem comandos de fachada.
- Adiciona regressão executável do ciclo de reprovação/alteração/retry, incluindo recusa do comportamento antigo e preservação das evidências anteriores e de trabalho ativo independente. Preserva comandos do motor, formatos das runs e comportamento do instalador.

## 1.0.4

### English

- Detect available Claude Code, Kiro and Codex environments and let users select one, several or all with terminal checkboxes. Add `install --all` for unattended installation; keep explicit harness flags and preview support.
- Use the operating system's configured country/region for the initial language: Brazil selects PT-BR; other regions or unavailable settings select English. Preserve installed preferences and explicit `--lang` overrides.
- Remove the dashboard language selector. The dashboard follows the installation, including when served by an already-running legacy server; browser language and old browser preferences no longer override it.
- Preserve existing graph-foreman runs, backups, compatibility entrypoints and automatic updates.

### Português (Brasil)

- Detecta Claude Code, Kiro e Codex disponíveis e permite selecionar um, vários ou todos com caixas de seleção no terminal. Adiciona `install --all` para instalação sem interação; preserva opções explícitas de ambiente e prévia.
- Usa o país/região configurado no sistema para o idioma inicial: Brasil seleciona PT-BR; demais regiões ou configuração indisponível selecionam inglês. Preserva preferências instaladas e escolhas explícitas com `--lang`.
- Remove o seletor de idioma do dashboard. O dashboard segue a instalação, inclusive em servidores legados já abertos; o idioma e as preferências antigas do navegador não o sobrescrevem.
- Preserva runs do graph-foreman, backups, caminhos de compatibilidade e atualização automática.

## 1.0.3

### English

- Standardize the displayed product name as Prumo across documentation, the installer, messages, skill instructions and dashboard. Keep commands, environment variables, storage keys and data formats compatible.
- Use version-only GitHub release titles. Register 1.0.1 retrospectively from the npm-scope change preceding 1.0.2; it was not previously published on npm.
- Align workspace setup examples with the engine: preserve explicit paths and reuse an existing central graph-foreman store across local harnesses; create the central directories when absent.
- Preserve the immutable npm 1.0.2 package; the branding adjustment ships as 1.0.3.

### Português (Brasil)

- Padroniza o nome visível como Prumo na documentação, instalador, mensagens, instruções da skill e dashboard. Preserva comandos, variáveis de ambiente, identificadores de armazenamento e formatos de dados.
- Usa somente a versão nos títulos das releases do GitHub. Registra a 1.0.1 retrospectivamente a partir da alteração do escopo npm anterior à 1.0.2; ela não havia sido publicada no npm.
- Alinha os exemplos de preparação ao motor: preserva caminhos explícitos e reutiliza o armazenamento central existente do graph-foreman entre ambientes locais; cria as pastas centrais quando ausentes.
- Preserva o pacote npm 1.0.2, que é imutável; o ajuste de marca sai na 1.0.3.

## 1.0.2

### English

- Use the npm package name `@henri-ralmeida/prumo`; keep the product, executable and skill named Prumo / `prumo`.
- Add `prumo update`: fetch the latest published installer, detect previously installed environments and registered custom paths, and preserve each installation's language. Preview, backups, independent conflicts and rollback reuse the installation workflow. Environments containing only graph-foreman remain untouched.
- Verify the public update command against a temporary npm registry, including old installations, preview and download failure.
- This is the first npm publication. GitHub's initial 1.0.0 release remains in history; no 1.0.1 npm package was published.

### Português (Brasil)

- Usa o nome npm `@henri-ralmeida/prumo`; mantém produto, executável e skill como Prumo / `prumo`.
- Adiciona `prumo update`: busca o instalador publicado mais recente, detecta ambientes já instalados e caminhos personalizados registrados, preservando o idioma de cada instalação. Prévia, backups, conflitos independentes e reversão reutilizam a instalação. Ambientes que contêm somente graph-foreman permanecem intactos.
- Verifica o comando público de atualização com registro npm temporário, instalações antigas, prévia e falha no download.
- Esta é a primeira publicação no npm. A release inicial 1.0.0 do GitHub permanece no histórico; não houve pacote 1.0.1 publicado no npm.

## 1.0.0

### English

- Introduce Prumo: graph-foreman plus PO First, with one shared engine for Claude Code, Kiro and Codex.
- Add a persistent, dependency-free installer with preview, complete installation/configuration backups, independent conflict handling and restore.
- Preserve existing run locations, schemas and old entrypoints; installing never resumes tasks or manufactures attempts.
- Require executable behavioral evidence for functional approval while preserving justified inspection for documentation and other non-runtime work.
- Preserve attempts and paused state during contract refresh and direct review handoff; discard obsolete validation receipts.
- Add English/Brazilian Portuguese interface, messages, dashboard and documentation. Keep agent instructions in English and user data unchanged.
- Describe dashboard timings as observations; duration alone does not prove coverage, defects or a reason to disable review.
- Add Windows/macOS/Linux CI for Node.js 22 and 24, plus package-runner smoke checks.

### Português (Brasil)

- Apresenta Prumo: graph-foreman com PO First e motor comum para Claude Code, Kiro e Codex.
- Adiciona instalador persistente, sem dependências, com prévia, backup completo das instalações/configurações, conflitos isolados e reversão.
- Preserva locais dos planos, formatos e caminhos antigos; instalar não retoma tarefas nem cria tentativas.
- Exige evidência comportamental executável para mudanças funcionais, preservando inspeções justificadas de documentação e outros trabalhos sem efeito de execução.
- Preserva tentativas e pausas ao atualizar contratos e encaminhar revisões; descarta recibos desatualizados.
- Adiciona interface, mensagens, dashboard e documentação em inglês/PT-BR. Mantém instruções internas em inglês e dados intactos.
- Apresenta tempos como observações; duração isolada não comprova cobertura, defeitos ou motivo para dispensar revisão.
- Adiciona CI Windows/macOS/Linux com Node.js 22 e 24 e conferência da execução do pacote pelos gerenciadores.

## Upstream

Based on [JrSantiaggo/graph-foreman](https://github.com/JrSantiaggo/graph-foreman), retaining its MIT license and Git history. Prumo's first public release is 1.0.0; earlier local corrections were not published Prumo releases.

Baseado em graph-foreman, preservando a licença MIT e o histórico Git. A primeira release pública do Prumo é 1.0.0; as correções locais anteriores não foram releases publicadas do Prumo.
