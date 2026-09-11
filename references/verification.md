# Verification / Verificação

Observed checks, not a guarantee that every model or client configuration behaves identically.

Verificações observadas, não uma garantia de comportamento idêntico de todos os modelos e configurações.

| Layer / Camada | Evidence / Evidência |
|---|---|
| 1.1.0 automated suite / Suíte automatizada 1.1.0 | Engine, installer, update and dashboard checks run in CI; the release commit's Actions result is the source of truth / Verificações de motor, instalador, atualização e dashboard rodam no CI; o resultado do Actions para o commit da release é a fonte de verdade |
| Behavioral gate / Aprovação funcional | Lint-only rejection, real code execution, justified documentation inspection, obsolete receipts and independent review / Recusa de lint isolado, execução real, inspeção justificada de documentação, recibos obsoletos e revisão independente |
| Rejection and changed contract / Reprovação e contrato alterado | Real failure, synchronization while failed, retry, rejection of old behavior and acceptance of new behavior; prior attempts, evidence and unrelated active work preserved / Falha real, sincronização em failed, retry, recusa do comportamento antigo e aprovação do novo; tentativas, evidências e trabalho ativo independente preservados |
| Installer and rollback / Instalação e reversão | Isolated profiles exercise existing configuration, conflicts, languages, legacy runs and rollback / Perfis isolados verificam configuração existente, conflitos, idiomas, runs legadas e reversão |
| Packaged npm and Bun / Pacote via npm e Bun | Both entrypoints install all three complete adapters (`SKILL.md`, engine, validation, storage, server and dashboard) in a temporary home / Ambas as entradas instalam os três adaptadores completos (`SKILL.md`, motor, validação, armazenamento, servidor e dashboard) em perfil temporário |
| Public update command / Comando público de atualização | `scripts/package-smoke.mjs` uses an isolated npm prefix and registry to verify persistent CLI installation, clean `prumo -v`, compact self-update, all three adapters and registry failure / O script usa prefixo e registro npm isolados para verificar instalação persistente da CLI, `prumo -v` limpo, autoatualização compacta, os três adaptadores e falha do registro |
| Dashboard / Dashboard | Automated checks verify installation language, untranslated task data, a single empty-state border and stale-response rejection when switching runs / Testes conferem idioma da instalação, dados sem tradução, borda única no estado vazio e descarte de resposta antiga ao trocar de run |
| Reinstall / Reinstalação | A current, complete installation reports its version and creates no files or backups; older or incomplete installations follow the normal protected update / Uma instalação atual e completa informa sua versão e não cria arquivos nem backups; instalações antigas ou incompletas seguem a atualização protegida normal |
| Data, automation, migration / Dados, automação, migração | Local executable artifact fixtures, not live external integrations / Artefatos locais executáveis, não integrações externas reais |

The [CI matrix](../.github/workflows/ci.yml) runs the engine, installer and packaged npm/Bun checks on Windows, macOS and Linux with Node.js 22 and 24. Check the [Actions run for the release commit](https://github.com/henri-ralmeida/prumo/actions) and release notes for the exact result; Windows-specific tests are skipped on Unix. The previously verified [1.0.7 run](https://github.com/henri-ralmeida/prumo/actions/runs/34546288455) passed all six jobs.

A matriz executa motor, instalador e verificações do pacote via npm/Bun no Windows, macOS e Linux com Node.js 22 e 24. Confira no Actions o commit da release e suas notas para o resultado exato; testes exclusivos do Windows são ignorados em Unix. A execução anterior verificada da 1.0.7 passou nos seis jobs.

1.1.0 migrates an existing graph-foreman skill into Prumo, removes the legacy skill only after integrity checks and keeps run data in place. The engine records execution and receipts; it cannot determine the semantic truth of arbitrary criteria or prove that a harness dispatched a real agent. The orchestrator and reviewer must perform those checks. Isolated package checks do not establish activation in an already-open client session.

A 1.1.0 migra uma skill graph-foreman existente para Prumo, remove a skill legada somente após conferir a integridade e mantém os dados das runs no lugar. O motor registra execução e recibos; não determina a verdade de critérios arbitrários nem comprova que o ambiente disparou um agente real. Orquestrador e revisor fazem essas conferências. Testes isolados do pacote não comprovam ativação em uma sessão de cliente já aberta.
