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

export type Situacao = 'incluido' | 'excluido' | 'entre_contas';
/** Onde o lançamento entra na planilha da consultoria (decisão do analista). */
export type Classe = 'fixo' | 'variavel' | 'investimento' | 'entrada' | 'fora';

export interface AjusteLancamento {
    categoria?: string | null;
    subcategoria?: string | null;
    observacao?: string | null;
    situacao?: Situacao | null;
    classe?: Classe | null;
}

export interface Alerta {
    tipo: 'possivel_duplicidade_fatura' | 'pagamento_na_fatura' | 'possivel_entre_contas';
    mensagem: string;
    faturaRelacionada?: { indice: number; vencimento?: string; valorTotal?: number; relacao: 'esta' | 'anterior' };
}

export interface Lancamento {
    id: string;
    origem: Origem;
    documentoIndice: number;
    documentoId?: string;              // id no banco (quando a análise está salva)
    ref: number;                       // posição do lançamento dentro do documento
    documento: string;                 // ex: "Extrato Itaú" / "Fatura Itaú final 1234"
    banco?: string;
    data: string;                      // data do lançamento (no cartão: data da COMPRA)
    /** Mês em que o dinheiro sai (YYYY-MM): conta = data; cartão = mês do vencimento da fatura. */
    mesReferencia: string;
    vencimentoFatura?: string;         // só cartão
    descricao: string;
    valor: number;                     // sempre positivo
    direcao: 'entrada' | 'saida';
    categoria: string;
    subcategoria?: string;
    categoriaIA: string;               // o que a IA sugeriu (para o analista poder voltar)
    subcategoriaIA?: string;
    observacao?: string;
    situacao: Situacao;
    classe: Classe | null;             // null = "a classificar"
    incluidoNoResumo: boolean;         // = situacao === 'incluido'
    padraoIncluido: boolean;           // o que o sistema decidiu antes do analista mexer
    ajustadoPeloAnalista: boolean;
    parcela?: string;                  // ex: "3/10"
    parcelaInicio?: string;            // YYYY-MM da fatura da 1ª parcela
    parcelaFim?: string;               // YYYY-MM da fatura da última parcela
    parcelasRestantes?: number;        // quantas ainda vão cair DEPOIS desta fatura
    alerta?: Alerta;
}

export interface EntradaConsolidacao {
    extratos: ResultadoExtrato[];
    faturas: ResultadoFatura[];
    /** ids que o analista mandou EXCLUIR do resumo */
    exclusoes?: string[];
    /** ids que o analista mandou INCLUIR (para lançamentos que por padrão ficam fora) */
    inclusoes?: string[];
    /** ids dos documentos no banco, na mesma ordem de extratos/faturas → id do lançamento vira "docId:ref" */
    idsDocumentos?: { extratos?: string[]; faturas?: string[] };
    /** ajustes do analista por id de lançamento */
    ajustes?: Record<string, AjusteLancamento>;
}

const REGEX_TRANSFERENCIA = /\b(pix|ted|doc|transf|transfer[eê]ncia|tef)\b/i;
const normalizar = (s: string) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const PARTICULAS = new Set(['da', 'de', 'do', 'das', 'dos', 'e']);

/** Transferência para/de alguém com o nome do titular (primeiro + último sobrenome). */
function pareceMesmoTitular(descricao: string, titular?: string): boolean {
    if (!titular) return false;
    const partes = normalizar(titular).split(/\s+/).filter(p => p.length > 1 && !PARTICULAS.has(p));
    if (partes.length < 2) return false;
    const d = normalizar(descricao);
    return REGEX_TRANSFERENCIA.test(d) && d.includes(partes[0]) && d.includes(partes[partes.length - 1]);
}

const REGEX_PAGAMENTO_FATURA = /(pgto|pagto|pag|pagamento|deb\.?\s*aut|debito\s*aut).{0,20}(fatura|fat\b|cart[aã]o|itaucard|credicard)|fatura\s*cart|itaucard/i;
const arred = (n: number) => Math.round(n * 100) / 100;

/** Soma n meses a "YYYY-MM". */
export function somarMeses(mes: string, n: number): string {
    const [a, m] = mes.split('-').map(Number);
    const total = a * 12 + (m - 1) + n;
    return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

export interface ParcelamentoItem {
    id: string;
    descricao: string;
    portador?: string;
    documento: string;
    valorParcela: number;
    parcelaAtual: number;
    parcelaTotal: number;
    inicio: string;          // YYYY-MM (fatura da 1ª parcela)
    fim: string;             // YYYY-MM (fatura da última parcela)
    restantes: number;       // parcelas depois da fatura atual
    valorRestante: number;
    categoria: string;
    financiamento: boolean;  // parcelamento de fatura / empréstimo do cartão
}

export interface MesCompromisso {
    mes: string;             // YYYY-MM
    valor: number;           // soma das parcelas que caem nesse mês
    quantidade: number;
    terminam: { descricao: string; valorParcela: number }[];   // parcelas cuja ÚLTIMA cai nesse mês
}
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
    const venc = fat?.vencimento && /^\d{4}-\d{2}-\d{2}$/.test(fat.vencimento)
        ? ` de vencimento ${fat.vencimento.slice(8, 10)}/${fat.vencimento.slice(5, 7)}/${fat.vencimento.slice(0, 4)}` : '';
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

    const ajustes = entrada.ajustes || {};
    const idsExt = entrada.idsDocumentos?.extratos || [];
    const idsFat = entrada.idsDocumentos?.faturas || [];

    /** Situação final: ajuste do analista > listas exclusoes/inclusoes > padrão do sistema. */
    const situacaoDe = (id: string, padrao: boolean): Situacao => {
        const aj = ajustes[id]?.situacao;
        if (aj) return aj;
        if (exclusoes.has(id)) return 'excluido';
        if (inclusoes.has(id)) return 'incluido';
        return padrao ? 'incluido' : 'excluido';
    };

    /** Monta o lançamento aplicando os ajustes do analista por cima do que a IA leu. */
    const montar = (base: Omit<Lancamento, 'situacao' | 'classe' | 'incluidoNoResumo' | 'ajustadoPeloAnalista' | 'categoriaIA' | 'subcategoriaIA' | 'observacao'>): Lancamento => {
        const aj = ajustes[base.id] || {};
        const situacao = situacaoDe(base.id, base.padraoIncluido);
        return {
            ...base,
            categoriaIA: base.categoria,
            subcategoriaIA: base.subcategoria,
            categoria: aj.categoria || base.categoria,
            subcategoria: aj.subcategoria || base.subcategoria,
            observacao: aj.observacao || undefined,
            situacao,
            classe: aj.classe || null,
            incluidoNoResumo: situacao === 'incluido',
            ajustadoPeloAnalista: !!(aj.categoria || aj.subcategoria || aj.observacao || aj.situacao || aj.classe)
        };
    };

    // ── Extratos ────────────────────────────────────────────────────────────
    const extratos = entrada.extratos || [];
    extratos.forEach((ext, di) => {
        const nomeDoc = `Extrato ${ext.banco || ''}`.trim();
        ext.transacoes.forEach((t, i) => {
            const id = idsExt[di] ? `${idsExt[di]}:${i}` : `extrato-${di}-${i}`;
            let alerta: Alerta | undefined;

            if (t.tipo === 'DEBITO' && ehPagamentoDeFatura(t.descricao, t.categoria)) {
                const fat = acharFaturaCorrespondente(t.valor, faturas);
                alerta = {
                    tipo: 'possivel_duplicidade_fatura',
                    faturaRelacionada: fat,
                    mensagem: mensagemDuplicidade(t.valor, fat)
                };
            } else if (pareceMesmoTitular(t.descricao, ext.titular)) {
                alerta = {
                    tipo: 'possivel_entre_contas',
                    mensagem: 'Parece transferência para outra conta da própria cliente (mesmo nome do titular). Se for, marque como "entre contas" para não contar como gasto nem como renda.'
                };
            }

            lancamentos.push(montar({
                id, origem: 'extrato', documentoIndice: di, documentoId: idsExt[di], ref: i, documento: nomeDoc,
                banco: ext.banco, data: t.data, mesReferencia: (t.data || '').slice(0, 7), descricao: t.descricao, valor: t.valor,
                direcao: t.tipo === 'CREDITO' ? 'entrada' : 'saida',
                categoria: alerta?.tipo === 'possivel_duplicidade_fatura' ? 'Pagamento de fatura' : t.categoria,
                subcategoria: (t as any).subcategoria,
                padraoIncluido: true,                    // regra do cliente: nunca tira sozinho
                alerta
            }));
        });
    });

    // Par de transferência entre bancos diferentes: mesmo valor, mesmo dia (±1),
    // uma saída num extrato e uma entrada em outro, ambas com cara de transferência.
    const doExtrato = lancamentos.filter(l => l.origem === 'extrato' && REGEX_TRANSFERENCIA.test(l.descricao));
    const diaNum = (d: string) => Date.parse(d + 'T00:00:00Z') / 86400000;
    for (const s of doExtrato.filter(l => l.direcao === 'saida')) {
        const par = doExtrato.find(e => e.direcao === 'entrada' && e.documentoIndice !== s.documentoIndice
            && Math.abs(e.valor - s.valor) < 0.01 && Math.abs(diaNum(e.data) - diaNum(s.data)) <= 1);
        if (!par) continue;
        for (const l of [s, par]) {
            if (l.alerta) continue;
            l.alerta = {
                tipo: 'possivel_entre_contas',
                mensagem: `Mesmo valor saiu de uma conta e entrou em outra (${s.banco || 'banco'} → ${par.banco || 'banco'}) no mesmo dia. Provável transferência entre contas da cliente.`
            };
        }
    }

    // ── Faturas ─────────────────────────────────────────────────────────────
    faturas.forEach((fat, di) => {
        const finais = (fat.cartoes || []).map(c => c.final).filter(Boolean);
        const nomeDoc = `Fatura ${fat.banco || ''}${finais.length ? ` final ${finais.join('/')}` : ''}`.trim();
        // Tudo da fatura conta no mês do VENCIMENTO (quando o cliente paga), não no mês da compra.
        const mesFatura = /^\d{4}-\d{2}/.test(fat.vencimento || '') ? fat.vencimento!.slice(0, 7) : null;
        const refDe = (data: string) => mesFatura || (data || '').slice(0, 7);

        fat.transacoes.forEach((t, i) => {
            const id = idsFat[di] ? `${idsFat[di]}:${i}` : `fatura-${di}-${i}`;
            const parcela = t.parcelaAtual && t.parcelaTotal ? `${t.parcelaAtual}/${t.parcelaTotal}` : undefined;
            const temParcela = !!(mesFatura && t.parcelaAtual && t.parcelaTotal && t.parcelaTotal >= t.parcelaAtual);
            const infoParcela = temParcela ? {
                parcelaInicio: somarMeses(mesFatura!, -(t.parcelaAtual! - 1)),
                parcelaFim: somarMeses(mesFatura!, t.parcelaTotal! - t.parcelaAtual!),
                parcelasRestantes: t.parcelaTotal! - t.parcelaAtual!
            } : {};

            if (t.tipo === 'pagamento') {
                // Pagamento da fatura ANTERIOR, lançado dentro desta fatura. Não é gasto nem
                // receita do cliente — fica fora do resumo por padrão, mas visível.
                lancamentos.push(montar({
                    id, origem: 'fatura', documentoIndice: di, documentoId: idsFat[di], ref: i, documento: nomeDoc,
                    banco: fat.banco, data: t.data, mesReferencia: refDe(t.data), vencimentoFatura: fat.vencimento, descricao: t.estabelecimento, valor: t.valor,
                    direcao: 'entrada', categoria: 'Pagamento de fatura', subcategoria: (t as any).subcategoria,
                    padraoIncluido: false,
                    alerta: {
                        tipo: 'pagamento_na_fatura',
                        mensagem: 'Pagamento da fatura anterior registrado nesta fatura. Fica fora do resumo por padrão (não é gasto nem receita); inclua só se fizer sentido para a análise.'
                    }
                }));
                return;
            }

            lancamentos.push(montar({
                id, origem: 'fatura', documentoIndice: di, documentoId: idsFat[di], ref: i, documento: nomeDoc,
                banco: fat.banco, data: t.data, mesReferencia: refDe(t.data), vencimentoFatura: fat.vencimento,
                descricao: t.estabelecimento + (t.portador ? ` — ${t.portador}` : ''),
                valor: t.valor,
                // estorno de cartão volta dinheiro: entra como "entrada" e abate os gastos
                direcao: TIPOS_DEBITO_FATURA.includes(t.tipo) ? 'saida' : 'entrada',
                categoria: t.categoria, subcategoria: (t as any).subcategoria,
                padraoIncluido: true,
                parcela,
                ...infoParcela
            }));
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

    // ── Calendário de parcelas ─────────────────────────────────────────────
    // Usa a fatura MAIS RECENTE de cada cartão (se houver faturas de meses
    // seguidos, a mesma compra apareceria em todas). Respeita o analista: o que
    // ele marcou como ignorado / entre contas fica fora da projeção.
    const ultimaPorCartao = new Map<string, number>();
    faturas.forEach((f, di) => {
        if (!f.vencimento) return;
        const chave = `${f.banco || ''}|${f.produto || ''}|${(f.cartoes || []).map(c => c.final || c.portador).join(',')}`;
        const atual = ultimaPorCartao.get(chave);
        if (atual === undefined || (faturas[atual].vencimento || '') < f.vencimento) ultimaPorCartao.set(chave, di);
    });
    const faturasProjecao = new Set(ultimaPorCartao.values());
    const itensParcela: ParcelamentoItem[] = lancamentos
        .filter(l => l.origem === 'fatura' && l.parcelaFim && l.direcao === 'saida' && l.situacao === 'incluido' && faturasProjecao.has(l.documentoIndice))
        .map(l => {
            const t = faturas[l.documentoIndice].transacoes[l.ref];
            const restantes = l.parcelasRestantes || 0;
            return {
                id: l.id, descricao: t.estabelecimento, portador: t.portador, documento: l.documento,
                valorParcela: l.valor, parcelaAtual: t.parcelaAtual!, parcelaTotal: t.parcelaTotal!,
                inicio: l.parcelaInicio!, fim: l.parcelaFim!, restantes, valorRestante: arred(l.valor * restantes),
                categoria: l.categoria, financiamento: t.tipo === 'financiamento'
            };
        })
        .sort((a, b) => a.fim.localeCompare(b.fim) || b.valorParcela - a.valorParcela);
    const mesesFatura = Array.from(faturasProjecao).map(di => faturas[di].vencimento!.slice(0, 7)).sort();
    const mesAtual = mesesFatura[0];
    const porMesParcelas: MesCompromisso[] = [];
    if (mesAtual && itensParcela.length) {
        const ultimo = itensParcela.reduce((m, i) => (i.fim > m ? i.fim : m), mesAtual);
        for (let mes = mesAtual; mes <= ultimo; mes = somarMeses(mes, 1)) {
            const caem = itensParcela.filter(i => i.inicio <= mes && mes <= i.fim);
            porMesParcelas.push({
                mes, valor: arred(caem.reduce((a, i) => a + i.valorParcela, 0)), quantidade: caem.length,
                terminam: caem.filter(i => i.fim === mes).map(i => ({ descricao: i.descricao, valorParcela: i.valorParcela }))
            });
        }
    }
    const futuros = porMesParcelas.slice(1);
    const pico = futuros.reduce<MesCompromisso | null>((m, x) => (!m || x.valor > m.valor ? x : m), null);
    const parcelamentos = {
        mesFaturaAtual: mesAtual || null,
        itens: itensParcela,
        porMes: porMesParcelas,
        mesMaisApertado: pico?.mes || null,
        livreDeParcelasEm: porMesParcelas.length ? somarMeses(porMesParcelas[porMesParcelas.length - 1].mes, 1) : null,
        totalRestante: arred(itensParcela.reduce((a, i) => a + i.valorRestante, 0))
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
            parcelamentos,
            pagamentosDeFaturaNoExtrato: {
                quantidade: alertasDuplicidade.length,
                valor: soma(alertasDuplicidade),
                aindaIncluidosNoResumo: alertasDuplicidade.filter(l => l.incluidoNoResumo).length
            },
            temEncargosNoCartao: temEncargos
        },
        conferenciaFaturas: faturas.map((f, i) => ({ indice: i, vencimento: f.vencimento, ...f.conferencia })),
        sugestoesEntreContas: lancamentos.filter(l => l.alerta?.tipo === 'possivel_entre_contas' && l.situacao !== 'entre_contas').length
    };
}
