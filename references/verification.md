# Verification / Verificação

Observed checks, not a guarantee that every model or client configuration behaves identically.

Verificações observadas, não uma garantia de comportamento idêntico de todos os modelos e configurações.

| Layer / Camada | Evidence / Evidência |
|---|---|
| Existing engine suite / Suíte existente | 38 tests passed locally on Windows, Node.js 26.5.0 / 38 testes passaram localmente |
| Windows, macOS, Linux; Node.js 22 and 24 | CI matrix defined; verify results on the release commit / Matriz definida; conferir resultados no commit da release |
| Installer and rollback / Instalação e reversão | Temporary-home tests; never active personal installations / Testes em diretórios temporários |
| Local consolidated checks / Verificações locais consolidadas | 53 tests passed together on Windows Node.js 26.5.0; two subsequent HTTP and external-project restore checks also passed / 53 testes em conjunto e dois testes adicionais passaram |
| Packaged npm and Bun / Pacote via npm e Bun | Both entrypoints installed all three adapters in a temporary home / Ambas as entradas instalaram os três adaptadores em perfil temporário |
| Dashboard browser / Dashboard no navegador | EN/PT-BR switching and persistence, untranslated task content, results view, no console errors / Troca e persistência de idioma, conteúdo das tarefas preservado, resultados e ausência de erros no console |
| Claude Code, Kiro, Codex | Adapter configuration tests; real new-session activation still pending / Testes de configuração; ativação em sessão real nova ainda pendente |
| Data, automation, migration / Dados, automação, migração | Local executable artifact fixtures, not live external integrations / Artefatos locais executáveis, não integrações externas reais |

The maintainer explicitly deferred local installation while graph-foreman remains in use. Installation or activation in those live harnesses is not claimed.

O mantenedor adiou a instalação local enquanto usa graph-foreman. Não é afirmada instalação ou ativação nesses ambientes em uso.
