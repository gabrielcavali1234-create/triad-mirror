// ══════════════════════════════════════════════════════════════════════════
// Módulo FATURA DE CARTÃO — Itaú e Bradesco (genérico para os demais).
//
// ── BRADESCO — calibrado em 13/10/2026 com uma fatura real (Visa Infinite
// Prime, venc. 01/05/2026, 3 páginas, 2 cartões do MESMO titular):
//  - Resumo: "Saldo anterior", "(-) Créditos/Pagamentos", "(+)Compras/Débitos",
//    "(=)Total". Total = anterior − créditos/pagamentos + compras/débitos.
//  - Cada cartão abre com "NOME  Cartão 4066 XXXX XXXX 9635" e fecha com
//    "Total para NOME  valor". Dois cartões podem ter o MESMO nome: a conferência
//    por cartão usa o FINAL, não o nome.
//  - Parcela no fim da descrição, às vezes GRUDADA ("SHOPPING05/06",
//    "TURKISH AIRL5010340003/05" → 3/5) ou numa coluna própria ("IPLACE 04/09").
//  - Pagamento antes dos cartões: "01/04 PAGTO. POR DEB EM C/C 4.761,86 -".
//  - Coluna da direita com quadros (limites, taxas, teto de juros, Livelo)
//    intercalados com os lançamentos — não são lançamentos.
//  - "Total parcelados para próximas faturas" = soma das parcelas que faltam
//    (conferido: R$ 8.758,23 bate com as linhas).
//
// ── ITAÚ — calibrado em 02/10/2026 com uma fatura Itaú real (Gold, venc. 17/08/2026,
// 3 páginas, titular + 1 adicional, rotativo + parcelamento de fatura ativos).
// O que o PDF real mostrou e está tratado aqui:
//  - Total da fatura = saldo anterior − pagamentos + ENCARGOS + lançamentos atuais.
//    Os encargos NÃO aparecem como lançamento: ficam no quadro "Encargos
//    cobrados nesta fatura", sem data.
//  - Bloco de cada cartão vem encabeçado só pelo NOME (adicional não mostra o
//    final do cartão) e fecha com "Lançamentos no cartão" = subtotal.
//  - Linha de ramo/cidade abaixo da compra ("supermercado JANDIRA", e às vezes em
//    inglês maiúsculo: "HEALTH Barueri", "GOVERNMENT SAO PAULO"); parcelas antigas
//    podem vir sem ela.
//  - Estorno aparece no meio das compras com sinal "-" (já descontado do subtotal).
//  - Internacional: moeda original pode ser BRL (cobrança em real convertida), com
//    linha "valor MOEDA valorUS$" e "Dólar de Conversão R$ x,xx" embaixo.
//    "Repasse de IOF" vem numa linha só, sem data.
//  - "Produtos e serviços": FINANCIAM FAT (parcelamento de fatura), Itaú Avisa,
//    mensalidades/anuidade — descrições quebradas em 2 linhas.
//  - Parcelas antigas com data do ano ANTERIOR (24/10 numa fatura de agosto).
//  - Não há "data de fechamento" impressa — só Emissão e "Previsão próx. Fechamento".
// ══════════════════════════════════════════════════════════════════════════
import Anthropic from '@anthropic-ai/sdk';
import { ExtracaoConfig, normalizarNomeBanco } from '../core/ia';
import { ModuloDocumento } from '../core/pipeline';
import { CATEGORIAS_TEXTO, REGRA_SUBCATEGORIA } from './categorias';

export type TipoLancamentoFatura =
    'compra' | 'saque' | 'estorno' | 'encargo' | 'anuidade' | 'tarifa' | 'iof' | 'financiamento' | 'pagamento';

export type SecaoFatura = 'compras' | 'internacional' | 'produtos_servicos' | 'encargos' | 'pagamentos';

export interface TransacaoFatura {
    data: string;                       // YYYY-MM-DD (data da compra original)
    estabelecimento: string;
    secao?: SecaoFatura;
    cidadePais?: string;
    ramo?: string;                      // ramo informado pelo próprio Itaú, ex: "supermercado"
    parcelaAtual?: number | null;
    parcelaTotal?: number | null;
    valor: number;                      // em BRL, sempre positivo — a direção vem do "tipo"
    tipo: TipoLancamentoFatura;
    categoria: string;
    subcategoria?: string;
    internacional?: boolean;
    moedaOriginal?: string | null;      // USD, EUR... ou BRL (cobrança em real convertida em dólar)
    valorMoedaOriginal?: number | null;
    valorDolar?: number | null;         // valor em US$ usado na conversão
    cotacao?: number | null;            // "Dólar de Conversão"
    cartaoFinal?: string;
    portador?: string;
}

export interface CartaoFatura {
    final?: string;
    portador?: string;
    adicional?: boolean;
    subtotal?: number;                  // "Lançamentos no cartão"
}

export interface ResultadoFatura {
    banco: string;
    bandeira?: string;
    produto?: string;
    titular?: string;
    emissao?: string;                   // YYYY-MM-DD
    vencimento?: string;                // YYYY-MM-DD
    fechamento?: string;                // YYYY-MM-DD (Itaú não imprime — fica vazio)
    proximoFechamento?: string;
    valorTotal?: number;                // "Total desta fatura"
    pagamentoMinimo?: number;
    limiteTotal?: number;
    limiteDisponivel?: number;
    saldoFaturaAnterior?: number;       // "Total da fatura anterior"
    pagamentosEfetuados?: number;       // positivo
    saldoFinanciado?: number;           // anterior − pagamentos (dívida rolada no rotativo)
    encargosTotal?: number;             // "Total de encargos"
    totalLancamentosAtuais?: number;    // "Total dos lançamentos atuais"
    proximaFatura?: number;             // parcelas já comprometidas na próxima fatura
    totalProximasFaturas?: number;      // parcelas já comprometidas em todas as futuras
    cartoes?: CartaoFatura[];
    transacoes: TransacaoFatura[];
    relatorioFalado: string;
    qualidadeRuim: boolean;
    motivoQualidadeRuim?: string;
    // Preenchido pelo sistema (não pela IA):
    conferencia?: ConferenciaFatura;
}

export interface Verificacao {
    nome: string;
    declarado: number;
    calculado: number;
    diferenca: number;
    bateu: boolean;
}

export interface ConferenciaFatura {
    totalDeclarado: number | null;
    totalCalculado: number;
    diferenca: number | null;
    bateu: boolean | null;              // true só se TODAS as verificações possíveis bateram
    verificacoes: Verificacao[];
    observacao: string;
}

const SYSTEM_PROMPT_FATURA = `Você é uma IA analista financeira especializada em FATURAS DE CARTÃO DE CRÉDITO brasileiras, trabalhando para uma consultoria financeira pessoal.
Sua tarefa é extrair TODOS os lançamentos da fatura e os dados do resumo, e gerar um breve "Relatório Falado".

LEITURA DO DOCUMENTO:
Faturas brasileiras costumam ter DUAS COLUNAS ou quadros laterais. Leia cada coluna inteira, de cima a baixo, e NUNCA junte o texto de uma coluna com o da linha vizinha na outra coluna.
- Itaú: lançamentos nas duas colunas (esquerda inteira, depois direita).
- Bradesco: lançamentos só à esquerda; à direita ficam quadros (Limites, Taxas mensais, Novo teto de juros, Programa de fidelidade/Livelo) que se intercalam visualmente com as compras — NUNCA são lançamentos e NUNCA fazem parte da descrição de uma compra.
A primeira página tem o resumo e o boleto (código de barras, ficha de compensação) — do boleto, não extraia nada. Ignore também caracteres sem sentido (código de barras renderizado como texto, ex: "<Wnn WnWn...>").

PARTICULARIDADES POR BANCO:
- BRADESCO: resumo "Saldo anterior" → saldoFaturaAnterior; "(-) Créditos/Pagamentos" → pagamentosEfetuados; "(+)Compras/Débitos" → totalLancamentosAtuais; "(=)Total" / "Total da fatura" → valorTotal. "Total parcelados para próximas faturas" / "Total para as próximas faturas" → totalProximasFaturas. "Previsão de fechamento da próxima fatura" → proximoFechamento. Pagamento mínimo na caixa "Pagamento mínimo".
  Cada cartão começa com "NOME  Cartão 4066 XXXX XXXX 9635" (final = últimos 4 dígitos) e termina com "Total para NOME  VALOR" (subtotal do bloco). O MESMO nome pode ter mais de um cartão: preencha SEMPRE "cartaoFinal" em cada transação com o final do bloco, e liste cada cartão separado em "cartoes" (final + subtotal). Não marque como adicional um cartão com o mesmo nome do titular.
  O pagamento vem antes dos cartões, com o sinal "-" DEPOIS do valor: "01/04 PAGTO. POR DEB EM C/C 4.761,86 -" → secao "pagamentos", tipo "pagamento". Outros valores com "-" depois do número dentro dos cartões são estornos/créditos.
  A cidade vem numa coluna ao lado da descrição ("SAO PAULO", "CAMPINAS") → cidadePais. Não há linha de ramo.
- Outros bancos: use os mesmos conceitos (resumo, blocos por cartão com subtotal, parcelas NN/NN, pagamentos, encargos) com os nomes que o banco usar. Na dúvida, prefira omitir um total a preenchê-lo com o número errado.

DADOS DO RESUMO (nível da fatura):
- banco, bandeira (cartão iniciado em 4 = Visa, 5 = Mastercard), produto (ex: "Itaú Gold"), titular ("Titular NOME").
- emissao ("Emissão: DD/MM/AAAA"), vencimento ("Vencimento"), proximoFechamento ("Previsão próx. Fechamento"). Se houver "Data de fechamento" explícita, preencha fechamento; o Itaú normalmente NÃO imprime — então deixe vazio.
- saldoFaturaAnterior ("Total da fatura anterior"), pagamentosEfetuados (soma dos pagamentos, POSITIVO), saldoFinanciado ("Saldo financiado"), encargosTotal ("Encargos (Financiamento + moratório)" ou "Total de encargos em R$"), totalLancamentosAtuais ("Lançamentos atuais" / "Total dos lançamentos atuais"), valorTotal ("Total desta fatura").
- pagamentoMinimo ("Pagamento mínimo"), limiteTotal ("Limite total de crédito"), limiteDisponivel ("Limite disponível").
- proximaFatura e totalProximasFaturas: no final do quadro "Compras parceladas - próximas faturas", linhas "Próxima fatura" e "Total para próximas faturas".
Se o trecho recebido não contiver algum desses dados, omita o campo — NUNCA invente nem calcule.

CARTÕES (titular + adicionais):
Cada bloco de lançamentos começa com o NOME do portador (Itaú: numa linha própria, ex: "BERENICE C SILVA"; Bradesco: "NOME  Cartão XXXX XXXX XXXX 1234") e termina no subtotal do bloco (Itaú: "Lançamentos no cartão  VALOR"; Bradesco: "Total para NOME  VALOR").
- Em cada transação, preencha "portador" com o nome do bloco. Se um bloco continuar em outra página/coluna sem repetir o nome, mantenha o último portador visto.
- "cartaoFinal": preencha com o final impresso no cabeçalho do bloco (ex: "Cartão 4100.XXXX.XXXX.1234" ou "Cartão 4066 XXXX XXXX 9635" → "1234"/"9635"), em TODAS as transações daquele bloco. Se o bloco não mostrar final (adicionais do Itaú), deixe vazio. NUNCA invente.
- Em "cartoes", liste cada bloco com portador, final (se houver), adicional=true só para quem tem nome DIFERENTE do titular, e subtotal = o subtotal impresso daquele bloco.

SEÇÕES — preencha "secao" em cada transação:
- "pagamentos": quadro "Pagamentos efetuados" (ex: "18/07 PAGAMENTO -4.213,00") → tipo "pagamento".
- "compras": "Lançamentos: compras e saques".
- "internacional": "Lançamentos internacionais".
- "produtos_servicos": "Lançamentos: produtos e serviços".
- "encargos": quadro "Encargos cobrados nesta fatura" (juros do rotativo, juros de mora, multa por atraso, IOF de financiamento). Cada linha com valor vira UMA transação tipo "encargo" (o IOF de financiamento → tipo "iof"), com data = data de emissão e estabelecimento = nome do encargo. NÃO extraia a linha "Total de encargos".

IGNORAR COMPLETAMENTE (não são lançamentos desta fatura):
- "Compras parceladas - próximas faturas" (só leia dali os totais "Próxima fatura"/"Total para próximas faturas").
- Linhas de total/subtotal ("Total dos pagamentos", "Lançamentos no cartão", "Total transações inter.", "Total lançamentos inter.", "Lançamentos produtos e serviços", "Total dos lançamentos atuais").
- Quadros "Limites de crédito", "Novo teto de juros", "Parcelamento de fatura", "Simulação de Compras parc.", opções de pagamento/parcelas fixas, textos legais, SAC.
- A sublinha "Principal (R$ x) + Juros (R$ y)" abaixo de FINANCIAM FAT — é detalhamento, não lançamento.

REGRAS DE CADA LANÇAMENTO:
1. Data: DD/MM → "YYYY-MM-DD" usando o ANO DO VENCIMENTO. Parcelas antigas mostram a data da compra original; se essa data, com o ano do vencimento, ficar DEPOIS do vencimento, ela é do ano anterior (ex: "24/10" numa fatura com vencimento 17/08/2026 → 2025-10-24).
2. Estabelecimento: texto como aparece, SEM o indicador de parcela. Descrições quebradas em duas linhas (ex: "Mensalidade - Plano do" + "Anuidade Diferenciada") devem ser JUNTADAS numa só.
3. Parcela: o "NN/NN" no fim da descrição é parcela atual/total ("JIM.COM GABRIE 07/12" → estabelecimento "JIM.COM GABRIE", parcelaAtual 7, parcelaTotal 12). À vista → null.
   - Pode vir GRUDADO no nome: "DD PAULISTA SHOPPING05/06" → "DD PAULISTA SHOPPING", 5/6; "TURKISH AIRL5010340003/05" → "TURKISH AIRL50103400", 3/5 (só os ÚLTIMOS "NN/NN" são a parcela; os dígitos antes fazem parte do nome).
   - Pode vir numa coluna própria entre a descrição e a cidade: "PETZ CONGONHAS  01/04  SAO PAULO  129,60" → parcela 1/4 (o primeiro "01/04" da linha é a DATA; o segundo é a parcela).
   - Linhas idênticas (mesmo dia, nome e valor, ex: duas "COCO BAMBU JK 204,00") são compras DIFERENTES: extraia todas.
4. Ramo e cidade: logo ABAIXO de cada compra pode vir uma linha menor com ramo + cidade ("supermercado JANDIRA", "vestuário Franca", "HEALTH Barueri", "GOVERNMENT SAO PAULO", "ELETRONICS CURITIBA"). Preencha "ramo" (primeira palavra) e "cidadePais" (o resto). Essa linha NUNCA é um lançamento. Nem toda compra tem essa linha.
5. Valor: número POSITIVO em reais ("1.234,56" → 1234.56). A direção vem do "tipo". O sinal "-" pode vir antes ("-59,79") ou depois ("4.761,86 -").
6. Tipo:
   - "compra": compras (inclusive parcelas e assinaturas) e lançamentos internacionais
   - "saque": saque no crédito
   - "estorno": valor com "-" dentro das compras/internacionais (ex: "PG *TIP TOP FRANQSAO PA -59,79"), créditos, devoluções
   - "pagamento": quadro "Pagamentos efetuados"
   - "encargo": juros do rotativo, juros de mora, multa por atraso
   - "iof": "Repasse de IOF" dos internacionais (uma transação, data = data de emissão) e "IOF de financiamento"
   - "financiamento": parcela de parcelamento de fatura/empréstimo do cartão ("FINANCIAM FAT 07/12")
   - "anuidade": anuidade, "Mensalidade - Plano", "Mensalidade do Adicional"
   - "tarifa": demais serviços cobrados pelo banco ("Itaú Avisa", seguros como "SEGURO SUPERPROTEGIDO", avaliação emergencial de crédito)
7. Internacional: marque internacional=true. A linha principal traz o valor em R$. A linha de baixo traz "VALOR MOEDA VALOR_US$" (ex: "10,00 USD 10,00" ou "110,00 BRL 21,75") → valorMoedaOriginal, moedaOriginal (pode ser "BRL"!) e valorDolar. "Dólar de Conversão R$ 5,41" → cotacao. Nada disso é lançamento separado.
8. Categoria — use APENAS uma destas: ${CATEGORIAS_TEXTO}
   - pagamento → "Pagamento de fatura"; encargo → "Encargos e juros"; iof → "IOF"; anuidade → "Anuidade"; tarifa → "Tarifa bancária"; financiamento → "Empréstimo e financiamento".
   - estorno → mesma categoria da compra original (ex: estorno de um serviço → mesma categoria do serviço), para abater no lugar certo.
   - compras: use o ramo impresso (Itaú) como pista principal: supermercado → "Supermercado"; restaurante → "Alimentação"; vestuário → "Vestuário"; educacao → "Educação"; HEALTH/saúde → "Saúde"; lazer → "Lazer"; GOVERNMENT → "Impostos"; serviços/outros/ELETRONICS → decida pelo estabelecimento.
     Pelo estabelecimento: APPLE.COM/BILL, assinaturas de software/IA (ANTHROPIC, CLAUDE), streaming, HOSTINGER → "Assinaturas"; academias/TOTALPASS/GYMPASS → "Lazer"; iFood/Rappi → "Delivery"; postos → "Combustível"; Uber/99/estacionamento/pedágio → "Transporte"; aéreas/hotéis → "Viagem"; ótica/farmácia → "Saúde"/"Farmácia"; salão/barbearia/estética → "Cuidados pessoais"; marketplace (SHOPEE, MAGALU, MERCADO LIVRE, AMAZON) → "Compras" salvo ramo mais específico.
   - Parcelas antigas costumam vir SEM a linha de ramo. Se o MESMO estabelecimento aparecer em outra compra desta fatura COM ramo (ex: "JIM.COM GABRIE" sem ramo e outra "JIM.COM GABRIE" com "supermercado JANDIRA"), use aquele ramo e a mesma categoria para as duas.

${REGRA_SUBCATEGORIA}

ANÁLISE DE QUALIDADE:
qualidadeRuim=true só se o documento estiver ilegível, cortado, ou não for fatura de cartão. Uma página só de resumo/boleto, limites ou "próximas faturas" com "transacoes" vazio é resultado CORRETO, não qualidade ruim.

RELATÓRIO FALADO:
Exatamente 2 frases curtas para um consultor financeiro: total da fatura e principais categorias; e alertas relevantes (rotativo/saldo financiado, juros e multa, parcelamento de fatura, volume comprometido em parcelas futuras, gastos internacionais). NUNCA deixe vazio.

IMPORTANTE: chame a ferramenta "registrar_fatura" exatamente uma vez. Não responda em texto livre.`;

const num = { type: 'number' } as const;
const FATURA_TOOL: Anthropic.Tool = {
    name: 'registrar_fatura',
    description: 'Registra os dados estruturados extraídos da fatura de cartão de crédito.',
    input_schema: {
        type: 'object',
        properties: {
            banco: { type: 'string' },
            bandeira: { type: 'string' },
            produto: { type: 'string' },
            titular: { type: 'string' },
            emissao: { type: 'string', description: 'YYYY-MM-DD' },
            vencimento: { type: 'string', description: 'YYYY-MM-DD' },
            fechamento: { type: 'string', description: 'YYYY-MM-DD — só se impresso explicitamente' },
            proximoFechamento: { type: 'string', description: 'YYYY-MM-DD' },
            valorTotal: num, pagamentoMinimo: num, limiteTotal: num, limiteDisponivel: num,
            saldoFaturaAnterior: num, pagamentosEfetuados: num, saldoFinanciado: num,
            encargosTotal: num, totalLancamentosAtuais: num, proximaFatura: num, totalProximasFaturas: num,
            cartoes: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: { final: { type: 'string' }, portador: { type: 'string' }, adicional: { type: 'boolean' }, subtotal: num },
                    required: ['portador']
                }
            },
            transacoes: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        data: { type: 'string', description: 'YYYY-MM-DD (data da compra)' },
                        estabelecimento: { type: 'string' },
                        secao: { type: 'string', enum: ['compras', 'internacional', 'produtos_servicos', 'encargos', 'pagamentos'] },
                        cidadePais: { type: 'string' },
                        ramo: { type: 'string' },
                        parcelaAtual: { type: ['integer', 'null'] },
                        parcelaTotal: { type: ['integer', 'null'] },
                        valor: { type: 'number', description: 'Valor em BRL, sempre positivo.' },
                        tipo: { type: 'string', enum: ['compra', 'saque', 'estorno', 'encargo', 'anuidade', 'tarifa', 'iof', 'financiamento', 'pagamento'] },
                        categoria: { type: 'string' },
                        subcategoria: { type: 'string', description: 'Subcategoria detalhada, da lista da categoria escolhida.' },
                        internacional: { type: 'boolean' },
                        moedaOriginal: { type: ['string', 'null'] },
                        valorMoedaOriginal: { type: ['number', 'null'] },
                        valorDolar: { type: ['number', 'null'] },
                        cotacao: { type: ['number', 'null'] },
                        cartaoFinal: { type: 'string' },
                        portador: { type: 'string' }
                    },
                    required: ['data', 'estabelecimento', 'secao', 'valor', 'tipo', 'categoria']
                }
            },
            relatorioFalado: { type: 'string' },
            qualidadeRuim: { type: 'boolean' },
            motivoQualidadeRuim: { type: 'string' }
        },
        required: ['banco', 'transacoes', 'relatorioFalado', 'qualidadeRuim']
    } as any
};

const configFatura: ExtracaoConfig<ResultadoFatura> = {
    nome: 'fatura',
    systemPrompt: SYSTEM_PROMPT_FATURA,
    tool: FATURA_TOOL,
    userText: 'Extraia os lançamentos e o resumo desta fatura de cartão seguindo as regras do sistema.',
    validar: (r) => (!r?.transacoes || !Array.isArray(r.transacoes))
        ? 'A fatura não pôde ser lida corretamente (formato inesperado).'
        : null,
    posProcessar: (r) => ({
        ...r,
        banco: normalizarNomeBanco(r.banco),
        pagamentosEfetuados: r.pagamentosEfetuados != null ? Math.abs(r.pagamentosEfetuados) : undefined,
        transacoes: r.transacoes.map(t => ({ ...t, valor: Math.abs(Number(t.valor) || 0) }))
    })
};

const arred = (n: number) => Math.round(n * 100) / 100;
const TOLERANCIA = 0.05;

/** Lançamentos que AUMENTAM a fatura. */
export const TIPOS_DEBITO_FATURA: TipoLancamentoFatura[] =
    ['compra', 'saque', 'encargo', 'anuidade', 'tarifa', 'iof', 'financiamento'];

const valorAssinado = (t: TransacaoFatura) =>
    t.tipo === 'pagamento' ? 0 : TIPOS_DEBITO_FATURA.includes(t.tipo) ? t.valor : -t.valor;
const somaAssinada = (ts: TransacaoFatura[]) => arred(ts.reduce((s, t) => s + valorAssinado(t), 0));

/**
 * Compara um total impresso com o calculado. "alternativas": outras formas
 * legítimas de o banco montar o mesmo total (ex.: Bradesco põe estornos em
 * "Créditos/Pagamentos" em vez de abater de "Compras/Débitos") — vale a que bater.
 */
function verificar(nome: string, declarado: number | undefined | null, calculado: number,
    opcoes: { alternativas?: number[]; tolerancia?: number } = {}): Verificacao | null {
    if (declarado == null) return null;
    const tol = opcoes.tolerancia ?? TOLERANCIA;
    const candidatos = [calculado, ...(opcoes.alternativas || [])];
    const melhor = candidatos.reduce((m, c) => Math.abs(declarado - c) < Math.abs(declarado - m) ? c : m, calculado);
    const diferenca = arred(declarado - melhor);
    return { nome, declarado, calculado: melhor, diferenca, bateu: Math.abs(diferenca) <= tol };
}

/** Quanto ainda falta pagar das parcelas desta fatura (parcela × parcelas que restam). */
export function parcelasRestantesDaFatura(ts: TransacaoFatura[]): number {
    return arred(ts
        .filter(t => (t.tipo === 'compra' || t.tipo === 'financiamento') && t.parcelaAtual && t.parcelaTotal && t.parcelaTotal > t.parcelaAtual)
        .reduce((s, t) => s + t.valor * (t.parcelaTotal! - t.parcelaAtual!), 0));
}

/**
 * Confere a extração contra todos os totais que o próprio banco imprime.
 * Cada verificação que não bate aponta ONDE está o problema (qual cartão,
 * qual seção), em vez de só dizer que o total geral não fechou.
 */
export function conferirFatura(f: ResultadoFatura): ConferenciaFatura {
    const ts = f.transacoes;
    const naoEncargo = ts.filter(t => t.secao !== 'encargos' && t.tipo !== 'pagamento');
    const encargos = ts.filter(t => t.secao === 'encargos');
    const pagamentosNasLinhas = arred(ts.filter(t => t.tipo === 'pagamento').reduce((s, t) => s + t.valor, 0));

    const lancamentosAtuais = somaAssinada(naoEncargo);
    // Estornos/créditos: o Itaú abate das compras; o Bradesco pode somar em "Créditos/Pagamentos".
    const creditos = arred(naoEncargo.filter(t => valorAssinado(t) < 0).reduce((s, t) => s + t.valor, 0));
    const lancamentosBrutos = arred(lancamentosAtuais + creditos);
    const encargosCalc = somaAssinada(encargos);
    const pagamentos = f.pagamentosEfetuados ?? pagamentosNasLinhas;
    const encargosParaTotal = f.encargosTotal ?? encargosCalc;
    const anterior = f.saldoFaturaAnterior ?? 0;
    const totalCalculado = arred(anterior - pagamentos + encargosParaTotal + lancamentosAtuais);
    // se os créditos já estão dentro de "pagamentos" impresso, as compras entram brutas
    const totalAlternativo = arred(anterior - pagamentos + encargosParaTotal + lancamentosBrutos);

    const verificacoes: Verificacao[] = [];
    const add = (v: Verificacao | null) => { if (v) verificacoes.push(v); };

    // Por cartão: pelo FINAL quando houver (o mesmo nome pode ter dois cartões); senão pelo nome.
    const cartoes = f.cartoes || [];
    const temFinalNasLinhas = ts.some(t => t.cartaoFinal);
    const nomeRepetido = (nome?: string) => !!nome && cartoes.filter(c => (c.portador || '').toLowerCase() === nome.toLowerCase()).length > 1;
    for (const c of cartoes) {
        const peloFinal = c.final && temFinalNasLinhas ? ts.filter(t => t.secao === 'compras' && t.cartaoFinal === c.final) : [];
        const doCartao = peloFinal.length ? peloFinal
            : ts.filter(t => t.secao === 'compras' && !!c.portador && !!t.portador && t.portador.toLowerCase() === c.portador.toLowerCase()
                && (!t.cartaoFinal || !cartoes.some(o => o !== c && o.final === t.cartaoFinal)));
        const brutoCartao = arred(somaAssinada(doCartao) + doCartao.filter(t => valorAssinado(t) < 0).reduce((s, t) => s + t.valor, 0));
        const rotulo = nomeRepetido(c.portador) || !c.portador ? `final ${c.final}${c.portador ? ` (${c.portador})` : ''}` : c.portador;
        add(verificar(`Compras do cartão ${rotulo}`, c.subtotal, somaAssinada(doCartao), { alternativas: [brutoCartao] }));
    }
    add(verificar('Total dos lançamentos atuais', f.totalLancamentosAtuais, lancamentosAtuais, { alternativas: [lancamentosBrutos] }));
    add(verificar('Total de encargos', f.encargosTotal, encargosCalc));
    add(verificar('Pagamentos efetuados', f.pagamentosEfetuados, pagamentosNasLinhas, { alternativas: [arred(pagamentosNasLinhas + creditos)] }));
    const vTotal = verificar('Total desta fatura', f.valorTotal, totalCalculado, { alternativas: [totalAlternativo] });
    add(vTotal);
    // Parcelas: o banco arredonda cada parcela; centavos de diferença são normais (tolerância R$ 1).
    const futuras = ts.filter(t => (t.tipo === 'compra' || t.tipo === 'financiamento') && t.parcelaAtual && t.parcelaTotal && t.parcelaTotal > t.parcelaAtual);
    add(verificar('Parcelas na próxima fatura', f.proximaFatura, arred(futuras.reduce((s, t) => s + t.valor, 0)), { tolerancia: 1 }));
    add(verificar('Parcelas de todas as próximas faturas', f.totalProximasFaturas, parcelasRestantesDaFatura(ts), { tolerancia: 1 }));

    const falhas = verificacoes.filter(v => !v.bateu);
    const bateu = verificacoes.length === 0 ? null : falhas.length === 0;
    return {
        totalDeclarado: f.valorTotal ?? null,
        totalCalculado: vTotal?.calculado ?? totalCalculado,
        diferenca: vTotal?.diferenca ?? null,
        bateu,
        verificacoes,
        observacao: bateu === null
            ? 'Nenhum total encontrado no documento — conferência não realizada.'
            : bateu
                ? `Todas as ${verificacoes.length} conferências bateram com os totais impressos na fatura.`
                : 'Divergência em: ' + falhas.map(v => `${v.nome} (diferença de R$ ${v.diferenca.toFixed(2)})`).join('; ') + '. Revise esses lançamentos.'
    };
}

/** Parcelas antigas vêm com o ano do vencimento; se caírem depois dele, são do ano anterior. */
function corrigirAnoDasDatas(f: ResultadoFatura): ResultadoFatura {
    const ref = f.vencimento || f.emissao;
    if (!ref || !/^\d{4}-\d{2}-\d{2}$/.test(ref)) return f;
    let corrigidas = 0;
    const transacoes = f.transacoes.map(t => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(t.data || '') || t.data <= ref) return t;
        corrigidas++;
        return { ...t, data: `${Number(t.data.slice(0, 4)) - 1}${t.data.slice(4)}` };
    });
    if (corrigidas) console.log(`[Fatura] ${corrigidas} data(s) de parcela antiga corrigidas para o ano anterior.`);
    return { ...f, transacoes };
}

/** Passo final, depois de juntar os pedaços: corrige datas e roda a conferência. */
export function finalizarFatura(f: ResultadoFatura): ResultadoFatura {
    const corrigida = corrigirAnoDasDatas(f);
    const conferencia = conferirFatura(corrigida);
    return { ...corrigida, conferencia };
}

function juntarPedacosFatura(resultados: ResultadoFatura[]): ResultadoFatura {
    const primeiroValor = <K extends keyof ResultadoFatura>(campo: K): ResultadoFatura[K] | undefined => {
        for (const r of resultados) {
            const v = r[campo];
            if (v !== undefined && v !== null && v !== '') return v;
        }
        return undefined;
    };

    // Portador "herdado": se um pedaço começa no meio de um bloco, a IA pode não saber
    // de quem é — usa o último portador do pedaço anterior.
    let ultimoPortador: string | undefined;
    let ultimoFinal: string | undefined;
    const transacoes: TransacaoFatura[] = [];
    for (const r of resultados) {
        for (const t of Array.isArray(r.transacoes) ? r.transacoes : []) {
            const deCartao = t.secao === 'compras' || t.secao === 'internacional';
            const portador = t.portador || (deCartao ? ultimoPortador : undefined);
            // o final só é herdado se o portador for o mesmo do bloco anterior
            const cartaoFinal = t.cartaoFinal || (deCartao && portador && portador === ultimoPortador ? ultimoFinal : undefined);
            if (t.portador) { if (t.portador !== ultimoPortador) ultimoFinal = undefined; ultimoPortador = t.portador; }
            if (t.cartaoFinal) ultimoFinal = t.cartaoFinal;
            transacoes.push({ ...t, ...(portador ? { portador } : {}), ...(cartaoFinal ? { cartaoFinal } : {}) });
        }
    }

    const cartoes = new Map<string, CartaoFatura>();
    for (const r of resultados) {
        for (const c of r.cartoes || []) {
            const chave = (c.final || c.portador || '').toLowerCase();
            if (!chave) continue;
            const atual = cartoes.get(chave) || {};
            cartoes.set(chave, {
                final: atual.final || c.final,
                portador: atual.portador || c.portador,
                adicional: atual.adicional ?? c.adicional,
                subtotal: atual.subtotal ?? c.subtotal
            });
        }
    }

    const relatorios = Array.from(new Set(resultados.map(r => (r.relatorioFalado || '').trim()).filter(Boolean)));
    const comProblema = resultados.filter(r => r.qualidadeRuim);

    return finalizarFatura({
        banco: (primeiroValor('banco') as string) || 'Não identificado',
        bandeira: primeiroValor('bandeira'),
        produto: primeiroValor('produto'),
        titular: primeiroValor('titular'),
        emissao: primeiroValor('emissao'),
        vencimento: primeiroValor('vencimento'),
        fechamento: primeiroValor('fechamento'),
        proximoFechamento: primeiroValor('proximoFechamento'),
        valorTotal: primeiroValor('valorTotal'),
        pagamentoMinimo: primeiroValor('pagamentoMinimo'),
        limiteTotal: primeiroValor('limiteTotal'),
        limiteDisponivel: primeiroValor('limiteDisponivel'),
        saldoFaturaAnterior: primeiroValor('saldoFaturaAnterior'),
        pagamentosEfetuados: primeiroValor('pagamentosEfetuados'),
        saldoFinanciado: primeiroValor('saldoFinanciado'),
        encargosTotal: primeiroValor('encargosTotal'),
        totalLancamentosAtuais: primeiroValor('totalLancamentosAtuais'),
        proximaFatura: primeiroValor('proximaFatura'),
        totalProximasFaturas: primeiroValor('totalProximasFaturas'),
        cartoes: Array.from(cartoes.values()),
        transacoes,
        relatorioFalado: relatorios.slice(0, 2).join(' ') || 'Análise da fatura concluída.',
        qualidadeRuim: transacoes.length === 0 || comProblema.length / resultados.length > 0.5,
        motivoQualidadeRuim: comProblema.map(r => r.motivoQualidadeRuim).filter(Boolean).join(' | ')
    });
}

export const moduloFatura: ModuloDocumento<ResultadoFatura> = {
    config: configFatura,
    juntarPedacos: juntarPedacosFatura
};
