import { Server } from 'node:http'
import { takeCoverage } from 'node:v8'
import './coverage-alias.mjs'

// No Windows, encerrar um processo externamente pode impedir o despejo final do V8.
// Registre as respostas do servidor isolado enquanto ele ainda esta em execucao;
// esse preload existe somente na coleta de testes e nao e distribuido no pacote.
if (process.env.NODE_V8_COVERAGE && process.env.PRUMO_TEST_COVERAGE_FLUSH === '1'
    && /(?:serve|dashboard|prumo-test-serve)\.mjs$/.test(process.argv[1] ?? '')) {
  const emit = Server.prototype.emit
  Server.prototype.emit = function (event, ...args) {
    if (event === 'request') args[1].once('finish', takeCoverage)
    return emit.call(this, event, ...args)
  }
}
