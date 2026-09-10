# Verification / Verificação

Observed checks, not a guarantee that every model or client configuration behaves identically.

Verificações observadas, não uma garantia de comportamento idêntico de todos os modelos e configurações.

| Layer / Camada | Evidence / Evidência |
|---|---|
| 1.0.5 local suite / Suíte local 1.0.5 | 64 tests passed on Windows, Node.js 26.5.0 / 64 testes aprovados no Windows |
| Behavioral gate / Aprovação funcional | Lint-only rejection, real code execution, justified documentation inspection, obsolete receipts and independent review / Recusa de lint isolado, execução real, inspeção justificada de documentação, recibos obsoletos e revisão independente |
| Rejection and changed contract / Reprovação e contrato alterado | Real failure, synchronization while failed, retry, rejection of old behavior and acceptance of new behavior; prior attempts, evidence and unrelated active work preserved / Falha real, sincronização em failed, retry, recusa do comportamento antigo e aprovação do novo; tentativas, evidências e trabalho ativo independente preservados |
| Installer and rollback / Instalação e reversão | Isolated profiles exercise existing configuration, conflicts, languages, legacy runs and rollback / Perfis isolados verificam configuração existente, conflitos, idiomas, runs legadas e reversão |
| Packaged npm and Bun / Pacote via npm e Bun | Both entrypoints installed all three adapters in a temporary home / Ambas as entradas instalaram os três adaptadores em perfil temporário |
| Public update command / Comando público de atualização | `scripts/package-smoke.mjs` checks all three adapters against a temporary registry, including instruction delivery, dry-run and registry failure / O script confere os três adaptadores com registro temporário, incluindo entrega das instruções, prévia e falha do registro |
| Dashboard language / Idioma do dashboard | Automated checks verify installation preference and untranslated task data; the selector was removed in 1.0.4 / Testes conferem preferência da instalação e dados sem tradução; seletor removido na 1.0.4 |
| Local Claude Code, Kiro, Codex / Ambientes locais | 1.0.4 files and adapter configuration verified; a new conversation demonstrating Prumo and PO First in each client remains unverified / Arquivos e configuração da 1.0.4 verificados; falta observar conversa nova demonstrando Prumo e PO First em cada cliente |
| Data, automation, migration / Dados, automação, migração | Local executable artifact fixtures, not live external integrations / Artefatos locais executáveis, não integrações externas reais |

The [CI matrix](../.github/workflows/ci.yml) runs the engine, installer and packaged npm/Bun checks on Windows, macOS and Linux with Node.js 22 and 24. Check the [Actions run for the release commit](https://github.com/henri-ralmeida/prumo/actions) and release notes for the exact result; Windows-specific tests are skipped on Unix. The previously verified [1.0.4 run](https://github.com/henri-ralmeida/prumo/actions/runs/34521145627) passed all six jobs.

A matriz executa motor, instalador e verificações do pacote via npm/Bun no Windows, macOS e Linux com Node.js 22 e 24. Confira no Actions o commit da release e suas notas para o resultado exato; testes exclusivos do Windows são ignorados em Unix. A execução anterior verificada da 1.0.4 passou nos seis jobs.

1.0.5 changes instructions and regression coverage, preserving engine transitions and run formats. The engine records execution and receipts; it cannot determine the semantic truth of arbitrary criteria or prove that a harness dispatched a real agent. The orchestrator and reviewer must perform those checks. The maintainer will test the public `prumo update` separately; isolated package checks do not establish activation in an already-open client session.

A 1.0.5 altera orientações e cobertura de regressão, preservando transições do motor e formatos das runs. O motor registra execução e recibos; não determina a verdade de critérios arbitrários nem comprova que o ambiente disparou um agente real. Orquestrador e revisor fazem essas conferências. O mantenedor testará `prumo update` público separadamente; testes isolados do pacote não comprovam ativação em uma sessão de cliente já aberta.
