# Diretrizes do Prumo

## Idioma dos commits

- Subjects e bodies dos commits devem ser escritos em inglês, conforme preferência explícita do usuário.

## Verificação obrigatória do GitHub Actions

- Toda alteração deve considerar os seis jobs de teste (Windows, Linux e macOS; Node.js 22 e 24) e a consolidação de cobertura.
- Antes de enviar mudanças, leia o workflow vigente e execute as verificações correspondentes ao comportamento alterado. Mudanças em instalação, atualização, migração ou fixtures exigem também a integração real afetada.
- O sucesso de testes isolados do dashboard não comprova o sucesso do CI completo. Informe claramente o alcance da verificação local.
- A matriz de atualização inclui todas as versões publicadas no npm. Quando uma nova versão for publicada, confirme que a preparação dos cenários históricos continua compatível com ela.
- Preserve validações de produção, dados históricos e a exigência de cobertura. Não exclua versões, desabilite jobs, enfraqueça asserções ou reduza limites de cobertura para obter aprovação.
- Após cada push, confirme que o workflow foi disparado para o SHA enviado, acompanhe os seis jobs e a cobertura e investigue falhas antes de declarar o CI aprovado ou autorizar uma publicação.
- Registre falhas observadas e crie regressões relevantes. Não prometa ausência absoluta de falhas: apresente evidências verificadas e limitações reais.
