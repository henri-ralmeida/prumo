# Diretrizes do Prumo

## Idioma dos commits

- Subjects e bodies dos commits devem ser escritos em inglês, conforme preferência explícita do usuário.

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
