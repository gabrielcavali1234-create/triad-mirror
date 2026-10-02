# TRIAD Mirror — backend

Análise de **extratos bancários + faturas de cartão** para consultoria financeira pessoal.
Motor herdado da TRIAD (fila, chunking de PDF, descriptografia RC4, limitador de chamadas, fallback de modelo, cálculo de custo), reorganizado em módulos.

## Rodar

```bash
npm install
cp .env.example .env      # preencha ANTHROPIC_API_KEY
npm run dev               # porta 3002 (a TRIAD fica na 3001)
npm run test:consolidacao # teste da consolidação, sem IA e sem custo
```

## Estrutura

```
src/
  env.ts                  carrega .env (primeiro import do servidor)
  server.ts               rotas
  core/                   ── herdado da TRIAD ──
    ia.ts                 cliente Anthropic, preços, limitador global, fallback de modelo
    pdf.ts                recorte em pedaços + descriptografia RC4
    pipeline.ts           processa pedaços em paralelo e junta (genérico por módulo)
    supabase.ts           cache de arquivos duplicados (tabelas mirror_*)
    jobs.ts               fila em memória, erros amigáveis
  modules/                ── específico do Mirror ──
    categorias.ts         taxonomia única (extrato + cartão)
    extrato.ts            prompt da TRIAD adaptado
    fatura.ts             NOVO — fatura Itaú + conferência de total
    consolidacao.ts       NOVO — visão unificada + aviso de duplicidade
```

## Rotas

Todas as rotas `/api/mirror/*`, exceto `/health`, exigem o cabeçalho `x-mirror-key` com o valor de `MIRROR_ACCESS_KEY`. Sem essa variável configurada, ficam bloqueadas.

- Página de teste: **`/teste`** (envio de documento, conferência e consolidação com incluir/excluir).
- Saúde: **`/api/mirror/health`** (aberta).
- Excel: **`POST /api/mirror/exportar-excel`** com o mesmo corpo do `/consolidar` → `.xlsx` com abas Resumo, Lançamentos (consolidado, com a coluna "No resumo"), uma aba por fatura (dados, conferência e lançamentos) e uma por extrato. Exemplo local: `npm run exemplo:excel`.

| Método | Rota | O que faz |
|---|---|---|
| POST | `/api/mirror/analyze-async` | multipart: `file`, `tipoDocumento` (`extrato` ou `fatura`), `password?`, `userId?`, `orgId?` → `{ jobId }` |
| GET | `/api/mirror/status/:jobId` | progresso e resultado |
| POST | `/api/mirror/consolidar` | `{ extratos, faturas, exclusoes?, inclusoes? }` → lançamentos + resumo. Sem IA, custo zero. |
| POST | `/api/mirror/save-cost` | `{ jobId, extractionId }` — grava custo real de IA |

## Regra de reconciliação (extrato × fatura)

Pagamento de fatura no **extrato** **não é removido sozinho**. Ele continua no resumo com um alerta `possivel_duplicidade_fatura`, e o analista decide. Para excluir, mande o `id` dele em `exclusoes` e chame `/consolidar` de novo.
Quando o valor bate (±1%) com uma fatura carregada, o alerta diz qual é.

Já o pagamento da fatura anterior que aparece **dentro da fatura** fica fora do resumo por padrão, porque não é gasto nem receita. Ele continua visível e pode ser incluído via `inclusoes`.

## Diferenças em relação à TRIAD

- Removidos: comparação com assessoria (batalha), Ficha Cadastral, Renda de App, sinalização de parentesco.
- Categorias novas para cartão: Delivery, Assinaturas, Viagem, Vestuário, IOF, Anuidade, Encargos e juros, Pagamento de fatura etc.
- O cache de duplicados considera o tipo do documento.

## Fatura Itaú — calibração

Calibrada com uma fatura Itaú real (Gold, 3 páginas, titular + adicional, em rotativo e com parcelamento de fatura). O gabarito transcrito está em `scripts/fixtures/fatura-itau-gabarito.json`, com os portadores anonimizados.

A cada leitura, o sistema confere a extração contra **6 totais impressos pelo próprio Itaú**: o subtotal de cada cartão, o total dos lançamentos atuais, o total de encargos, os pagamentos e o total da fatura. Quando algo não bate, ele aponta **onde** está a divergência (qual cartão, qual seção), e não só que o total geral não fechou.

```bash
npm test                                             # consolidação + fatura (sem IA, custo zero)
npx tsx scripts/extrair-fatura.ts fatura.pdf scripts/fixtures/fatura-itau-gabarito.json
                                                     # extração REAL + comparação com o gabarito
```

## Pendências

- [ ] Rodar `extrair-fatura.ts` com a chave de API na fatura de calibração e ajustar o prompt se algo divergir.
- [ ] Testar com mais faturas Itaú: outro produto (Uniclass, Personnalité), uma sem rotativo e uma com 2+ adicionais.
- [ ] Criar no Supabase as tabelas `mirror_extraction_cache` (`file_hash, tipo_documento, org_id, user_id, resultado, created_at`) e `mirror_extractions` (mesmas colunas de custo da TRIAD + `tipo_documento`).
- [ ] Conectar o front (telas da prévia) às rotas.
