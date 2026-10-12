# Diretrizes do Prumo

## Idioma dos commits

- Subjects e bodies dos commits devem ser escritos em inglês, conforme preferência explícita do usuário.

## Compatibilidade e execução proporcional

- Configurações, limites e regras do motor devem proteger uma invariante concreta sem impedir trabalho legítimo. Não acrescente uma restrição genérica para contornar um caso isolado; identifique a causa e corrija o caminho afetado.
- Não endureça por padrão as execuções, acrescente etapas obrigatórias ou peça novamente uma decisão já registrada sem uma mudança material que justifique isso. Um aceite vinculado ao contrato exato deve bastar para o escopo e a continuação explicitamente autorizados; contratos diferentes continuam exigindo novo aceite.
- Limitar memória ou conteúdo inspecionado não significa limitar indiscriminadamente o tamanho dos artefatos. Prefira processamento em blocos, evidências explícitas e limitações comunicadas; nunca omita um arquivo silenciosamente nem apresente um hash como inspeção funcional.
- Antes de alterar uma configuração ou um comportamento padrão, confira seus consumidores, instalações e execuções existentes. Preserve compatibilidade, histórico, tentativas, dependências, contratos imutáveis, aprovações humanas e revisão independente. Não reabra tarefas concluídas nem edite estado persistido para facilitar a mudança.
- Quando um controle novo for realmente necessário, explique o risco observado, a condição exata de aplicação e o impacto na execução. Verifique tanto a recusa do caso inseguro quanto a continuidade de um caso legítimo representativo, sem criar uma bateria genérica para ajustes de baixo risco.
- Simplificar o fluxo não autoriza remover validação de caminhos, proteção contra links ou alterações concorrentes, autorização por escopo ou aprovação independente. Se a mudança exigir uma quebra de compatibilidade ou um endurecimento material inevitável, apresente a evidência e peça a decisão do usuário antes de implementá-la.

## Verificação obrigatória do GitHub Actions

- Todo pedido do usuário que altere código deve incluir testes do comportamento novo ou corrigido e uma nova execução do c8 após a última alteração de código. Cubra os casos relevantes de sucesso, falha e regressão e preserve os limites de cobertura exigidos pelo projeto.
- Antes de concluir a entrega, verifique a compatibilidade das mudanças com o workflow vigente. Se houver push, acompanhe todos os jobs das seis combinações de plataforma e Node.js, incluindo cada lote separado e a consolidação de cobertura do SHA enviado, corrija as falhas relacionadas e não declare a entrega aprovada enquanto houver verificações pendentes ou falhando.
- Toda alteração deve considerar as seis combinações de teste (Windows, Linux e macOS; Node.js 22 e 24), todos os seus lotes e a consolidação de cobertura. Dividir testes entre runners não autoriza omitir arquivos ou versões; a união dos lotes deve preservar a matriz completa.
- Antes de enviar mudanças, leia o workflow vigente e execute as verificações correspondentes ao comportamento alterado. Mudanças em instalação, atualização, migração ou fixtures exigem também a integração real afetada.
- O sucesso de testes isolados do dashboard não comprova o sucesso do CI completo. Informe claramente o alcance da verificação local.
- A matriz de atualização inclui todas as versões publicadas no npm. Quando uma nova versão for publicada, confirme que a preparação dos cenários históricos continua compatível com ela.
- Preserve validações de produção, dados históricos e a exigência de cobertura. Não exclua versões, desabilite jobs, enfraqueça asserções ou reduza limites de cobertura para obter aprovação.
- Após cada push, confirme que o workflow foi disparado para o SHA enviado, acompanhe todos os jobs e a cobertura e investigue falhas antes de declarar o CI aprovado ou autorizar uma publicação.
- Crie e envie uma nova tag de versão somente depois que todos os jobs das seis combinações, incluindo os lotes históricos separados, e a consolidação de cobertura da main passarem no GitHub para o SHA exato que será marcado.
- Registre falhas observadas e crie regressões relevantes. Não prometa ausência absoluta de falhas: apresente evidências verificadas e limitações reais.
