// ══════════════════════════════════════════════════════════════════════════
// CONSOLIDAÇÃO — junta extratos + faturas numa visão única "pra onde vai o
// dinheiro". Função pura, sem IA (custo zero): o frontend pode chamar de novo
// toda vez que o analista marcar/desmarcar um lançamento.
//
// Regra de reconciliação combinada com o cliente:
//   O pagamento de fatura que aparece no EXTRATO NÃO é removido automaticamente.
//   Ele continua somado no resumo, mas ganha um aviso de possível duplicidade,
//   e o ANALISTA decide excluir ou manter (lista "exclusoes" / "inclusoes").
// ══════════════════════════════════════════════════════════════════════════
import { ResultadoExtrato } from './extrato';
import { ResultadoFatura, TIPOS_DEBITO_FATURA } from './fatura';

export type Origem = 'extrato' | 'fatura';

export interface Alerta {
    tipo: 'possivel_duplicidade_fatura' | 'pagamento_na_fatura';
    mensagem: string;
    faturaRelacionada?: { indice: number; vencimento?: string; valorTotal?: number; relacao: 'esta' | 'anterior' };
}

export interface Lancamento {
    id: string;
    origem: Origem;
    documentoIndice: number;
    documento: string;                 // ex: "Extrato Itaú" / "Fatura Itaú final 1234"
    data: string;
    descricao: string;
    valor: number;                     // sempre positivo
    direcao: 'entrada' | 'saida';
    categoria: string;
    incluidoNoResumo: boolean;
    padraoIncluido: boolean;           // o que o sistema decidiu antes do analista mexer
    parcela?: string;                  // ex: "3/10"
    alerta?: Alerta;
}

export interface EntradaConsolidacao {
    extratos: ResultadoExtrato[];
    faturas: ResultadoFatura[];
    /** ids que o analista mandou EXCLUIR do resumo */
    exclusoes?: string[];
    /** ids que o analista mandou INCLUIR (para lançamentos que por padrão ficam fora) */
    inclusoes?: string[];
}

const REGEX_PAGAMENTO_FATURA = /(pgto|pagto|pag|pagamento|deb\.?\s*aut|debito\s*aut).{0,20}(fatura|fat\b|cart[aã]o|itaucard|credicard)|fatura\s*cart|itaucard/i;
const arred = (n: number) => Math.round(n * 100) / 100;
const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function ehPagamentoDeFatura(descricao: string, categoria: string): boolean {
    return categoria === 'Pagamento de fatura' || REGEX_PAGAMENTO_FATURA.test(descricao || '');
}

/**
 * Procura uma fatura carregada que bata com o valor pago no extrato (±1%).
 *  - "esta": o valor bate com o TOTAL de uma fatura carregada → é o pagamento dela,
 *    e os gastos já estão detalhados item a item (duplicidade provável).
 *  - "anterior": o valor bate com o pagamento registrado DENTRO de uma fatura
 *    carregada → ele quitou a fatura ANTERIOR, cujos gastos são de outro ciclo
 *    (só duplica se a fatura anterior também estiver na análise).
 */
function acharFaturaCorrespondente(valor: number, faturas: ResultadoFatura[]) {
    const perto = (a?: number) => a != null && a > 0 && Math.abs(a - valor) / a <= 0.01;
    for (let i = 0; i < faturas.length; i++) {
        const f = faturas[i];
        if (perto(f.valorTotal)) return { indice: i, vencimento: f.vencimento, valorTotal: f.valorTotal, relacao: 'esta' as const };
    }
    for (let i = 0; i < faturas.length; i++) {
        const f = faturas[i];
        const pagamentosNaFatura = f.transacoes.filter(t => t.tipo === 'pagamento').map(t => t.valor);
        if (perto(f.pagamentosEfetuados) || pagamentosNaFatura.some(p => perto(p))) {
            return { indice: i, vencimento: f.vencimento, valorTotal: f.valorTotal, relacao: 'anterior' as const };
        }
    }
    return undefined;
}

function mensagemDuplicidade(valor: number, fat: ReturnType<typeof acharFaturaCorrespondente>): string {
    const venc = fat?.vencimento ? ` de vencimento ${fat.vencimento}` : '';
    if (fat?.relacao === 'esta') {
        return `Este pagamento (${brl(valor)}) bate com o total da fatura${venc} carregada nesta análise — os gastos dela já estão detalhados item a item. Considere excluí-lo do resumo.`;
    }
    if (fat?.relacao === 'anterior') {
        return `Este pagamento (${brl(valor)}) aparece como "pagamento efetuado" na fatura${venc}, ou seja, quitou a fatura ANTERIOR a ela. Os gastos detalhados na fatura carregada são de outro ciclo: só exclua se a fatura anterior também estiver nesta análise.`;
    }
    return `Possível pagamento de fatura de cartão (${brl(valor)}). Se a fatura correspondente estiver nesta análise, os gastos já estão detalhados nela. Revise e decida se mantém ou exclui.`;
}

export function consolidar(entrada: EntradaConsolidacao) {
    const exclusoes = new Set(entrada.exclusoes || []);
    const inclusoes = new Set(entrada.inclusoes || []);
    const faturas = entrada.faturas || [];
    const lancamentos: Lancamento[] = [];

    const decidir = (id: string, padrao: boolean) =>
        exclusoes.has(id) ? false : inclusoes.has(id) ? true : padrao;

    // ── Extratos ────────────────────────────────────────────────────────────
    (entrada.extratos || []).forEach((ext, di) => {
        const nomeDoc = `Extrato ${ext.banco || ''}`.trim();
        ext.transacoes.forEach((t, i) => {
            const id = `extrato-${di}-${i}`;
            let alerta: Alerta | undefined;

            if (t.tipo === 'DEBITO' && ehPagamentoDeFatura(t.descricao, t.categoria)) {
                const fat = acharFaturaCorrespondente(t.valor, faturas);
                alerta = {
                    tipo: 'possivel_duplicidade_fatura',
                    faturaRelacionada: fat,
                    mensagem: mensagemDuplicidade(t.valor, fat)
                };
            }

            lancamentos.push({
                id, origem: 'extrato', documentoIndice: di, documento: nomeDoc,
                data: t.data, descricao: t.descricao, valor: t.valor,
                direcao: t.tipo === 'CREDITO' ? 'entrada' : 'saida',
                categoria: alerta ? 'Pagamento de fatura' : t.categoria,
                padraoIncluido: true,                    // regra do cliente: nunca tira sozinho
                incluidoNoResumo: decidir(id, true),
                alerta
            });
        });
    });

    // ── Faturas ─────────────────────────────────────────────────────────────
    faturas.forEach((fat, di) => {
        const finais = (fat.cartoes || []).map(c => c.final).filter(Boolean);
        const nomeDoc = `Fatura ${fat.banco || ''}${finais.length ? ` final ${finais.join('/')}` : ''}`.trim();

        fat.transacoes.forEach((t, i) => {
            const id = `fatura-${di}-${i}`;
            const parcela = t.parcelaAtual && t.parcelaTotal ? `${t.parcelaAtual}/${t.parcelaTotal}` : undefined;

            if (t.tipo === 'pagamento') {
                // Pagamento da fatura ANTERIOR, lançado dentro desta fatura. Não é gasto nem
                // receita do cliente — fica fora do resumo por padrão, mas visível.
                lancamentos.push({
                    id, origem: 'fatura', documentoIndice: di, documento: nomeDoc,
                    data: t.data, descricao: t.estabelecimento, valor: t.valor,
                    direcao: 'entrada', categoria: 'Pagamento de fatura',
                    padraoIncluido: false, incluidoNoResumo: decidir(id, false),
                    alerta: {
                        tipo: 'pagamento_na_fatura',
                        mensagem: 'Pagamento da fatura anterior registrado nesta fatura. Fica fora do resumo por padrão (não é gasto nem receita); inclua só se fizer sentido para a análise.'
                    }
                });
                return;
            }

            lancamentos.push({
                id, origem: 'fatura', documentoIndice: di, documento: nomeDoc,
                data: t.data,
                descricao: t.estabelecimento + (t.portador ? ` — ${t.portador}` : ''),
                valor: t.valor,
                // estorno de cartão volta dinheiro: entra como "entrada" e abate os gastos
                direcao: TIPOS_DEBITO_FATURA.includes(t.tipo) ? 'saida' : 'entrada',
                categoria: t.categoria,
                padraoIncluido: true, incluidoNoResumo: decidir(id, true),
                parcela
            });
        });
    });

    lancamentos.sort((a, b) => (a.data || '').localeCompare(b.data || ''));

    // ── Resumo ──────────────────────────────────────────────────────────────
    const noResumo = lancamentos.filter(l => l.incluidoNoResumo);
    const soma = (ls: Lancamento[]) => arred(ls.reduce((s, l) => s + l.valor, 0));

    const entradasExtrato = noResumo.filter(l => l.origem === 'extrato' && l.direcao === 'entrada');
    const saidasExtrato = noResumo.filter(l => l.origem === 'extrato' && l.direcao === 'saida');
    const saidasCartao = noResumo.filter(l => l.origem === 'fatura' && l.direcao === 'saida');
    const creditosCartao = noResumo.filter(l => l.origem === 'fatura' && l.direcao === 'entrada');

    const totalEntradas = soma(entradasExtrato);
    const totalSaidas = arred(soma(saidasExtrato) + soma(saidasCartao) - soma(creditosCartao));

    // Gasto líquido por categoria (saídas − estornos/créditos da mesma categoria)
    const porCategoria = new Map<string, number>();
    for (const l of noResumo) {
        if (l.origem === 'extrato' && l.direcao === 'entrada') continue; // receitas ficam fora do ranking de gastos
        const sinal = l.direcao === 'saida' ? 1 : -1;
        porCategoria.set(l.categoria, (porCategoria.get(l.categoria) || 0) + sinal * l.valor);
    }
    const gastosPorCategoria = Array.from(porCategoria.entries())
        .map(([categoria, valor]) => ({
            categoria, valor: arred(valor),
            percentual: totalSaidas > 0 ? arred((valor / totalSaidas) * 100) : 0
        }))
        .filter(c => Math.abs(c.valor) >= 0.01)
        .sort((a, b) => b.valor - a.valor);

    // Compromisso futuro com parcelas. Usa o total que o próprio banco imprime
    // ("Total para próximas faturas"); só estima quando a fatura não traz esse total.
    let compromissoFuturoParcelas = 0;
    let comprometidoProximaFatura = 0;
    let comprasParceladas = 0;
    let compromissoEstimado = false;
    for (const fat of faturas) {
        const parceladas = fat.transacoes.filter(t =>
            (t.tipo === 'compra' || t.tipo === 'financiamento') && t.parcelaAtual && t.parcelaTotal && t.parcelaTotal > t.parcelaAtual);
        comprasParceladas += parceladas.length;
        if (fat.totalProximasFaturas != null) {
            compromissoFuturoParcelas += fat.totalProximasFaturas;
        } else {
            compromissoEstimado = true;
            compromissoFuturoParcelas += parceladas.reduce((s, t) => s + t.valor * (t.parcelaTotal! - t.parcelaAtual!), 0);
        }
        comprometidoProximaFatura += fat.proximaFatura ?? parceladas.reduce((s, t) => s + t.valor, 0);
    }

    // Sinais de endividamento no cartão — o que mais interessa a um consultor.
    const somaTipo = (tipos: string[]) => arred(faturas.reduce((s, f) =>
        s + f.transacoes.filter(t => tipos.includes(t.tipo)).reduce((a, t) => a + t.valor, 0), 0));
    const endividamentoCartao = {
        saldoFinanciado: arred(faturas.reduce((s, f) => s + (f.saldoFinanciado ?? 0), 0)),
        // juros do rotativo + mora + multa + IOF de financiamento (quadro "Encargos cobrados")
        encargos: arred(faturas.reduce((s, f) =>
            s + f.transacoes.filter(t => t.secao === 'encargos' || t.tipo === 'encargo').reduce((a, t) => a + t.valor, 0), 0)),
        parcelasDeFinanciamento: somaTipo(['financiamento']),
        emRotativo: faturas.some(f => (f.saldoFinanciado ?? 0) > 0 || f.transacoes.some(t => t.tipo === 'encargo')),
        pagamentoMinimo: arred(faturas.reduce((s, f) => s + (f.pagamentoMinimo ?? 0), 0))
    };

    const temEncargos = endividamentoCartao.emRotativo;
    const alertasDuplicidade = lancamentos.filter(l => l.alerta?.tipo === 'possivel_duplicidade_fatura');

    return {
        lancamentos,
        resumo: {
            totalEntradas,
            totalSaidas,
            saldo: arred(totalEntradas - totalSaidas),
            totalSaidasExtrato: soma(saidasExtrato),
            totalGastosCartao: arred(soma(saidasCartao) - soma(creditosCartao)),
            gastosPorCategoria,
            comprasParceladas,
            compromissoFuturoParcelas: arred(compromissoFuturoParcelas),
            comprometidoProximaFatura: arred(comprometidoProximaFatura),
            compromissoEstimado,
            endividamentoCartao,
            pagamentosDeFaturaNoExtrato: {
                quantidade: alertasDuplicidade.length,
                valor: soma(alertasDuplicidade),
                aindaIncluidosNoResumo: alertasDuplicidade.filter(l => l.incluidoNoResumo).length
            },
            temEncargosNoCartao: temEncargos
        },
        conferenciaFaturas: faturas.map((f, i) => ({ indice: i, vencimento: f.vencimento, ...f.conferencia }))
    };
}
