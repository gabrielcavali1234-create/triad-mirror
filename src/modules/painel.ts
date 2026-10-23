// ══════════════════════════════════════════════════════════════════════════
// PAINEL — visão da carteira, produtividade e evolução mês a mês.
// Tudo calculado a partir da apuração (consolidar) que o sistema já faz:
// nenhum dado novo é pedido ao analista.
// ══════════════════════════════════════════════════════════════════════════
import { Lancamento } from './consolidacao';

const arred = (n: number) => Math.round(n * 100) / 100;

export interface MesEvolucao {
    mes: string;              // YYYY-MM
    entradas: number;         // o que entrou na conta
    saidasConta: number;      // o que saiu da conta (inclui pagamento de fatura que o analista não ignorou)
    gastosCartao: number;     // compras do cartão no mês da fatura (estornos abatidos)
    parcelas: number;         // parte dos gastos do cartão que são parcelas
    encargos: number;         // juros, mora, multa, IOF
    sobra: number | null;     // entradas − saídas da conta (só quando há extrato no mês)
    temExtrato: boolean;
    temFatura: boolean;
}

const ehEncargo = (l: Lancamento) => /Encargos|IOF/i.test(l.categoria);

/** Números do cliente mês a mês (mês do extrato / mês do vencimento da fatura). */
export function evolucaoMensal(lancamentos: Lancamento[]): MesEvolucao[] {
    const meses = new Map<string, MesEvolucao>();
    const doMes = (m: string) => {
        if (!meses.has(m)) meses.set(m, { mes: m, entradas: 0, saidasConta: 0, gastosCartao: 0, parcelas: 0, encargos: 0, sobra: null, temExtrato: false, temFatura: false });
        return meses.get(m)!;
    };
    for (const l of lancamentos) {
        if (!/^\d{4}-\d{2}$/.test(l.mesReferencia)) continue;
        const m = doMes(l.mesReferencia);
        if (l.origem === 'extrato') m.temExtrato = true; else m.temFatura = true;
        if (l.situacao !== 'incluido') continue;
        const sinal = l.direcao === 'saida' ? 1 : -1;
        if (l.origem === 'extrato') {
            if (l.direcao === 'entrada') m.entradas += l.valor; else m.saidasConta += l.valor;
        } else {
            m.gastosCartao += sinal * l.valor;
            if (l.parcelaCartao) m.parcelas += l.valor;
            if (ehEncargo(l)) m.encargos += sinal * l.valor;
        }
    }
    return Array.from(meses.values()).sort((a, b) => a.mes.localeCompare(b.mes)).map(m => ({
        ...m,
        entradas: arred(m.entradas), saidasConta: arred(m.saidasConta), gastosCartao: arred(m.gastosCartao),
        parcelas: arred(m.parcelas), encargos: arred(m.encargos),
        sobra: m.temExtrato ? arred(m.entradas - m.saidasConta) : null
    }));
}

export interface LinhaPainel {
    clienteId: string;
    nome: string;
    criadoEm: string;
    analiseId: string | null;
    status: 'novo' | 'em_revisao' | 'concluida';
    atualizadoEm: string | null;
    extratos: number;
    faturas: number;
    meses: string[];
    renda: number | null;               // declarada na ficha; se não houver, média das entradas
    rendaFonte: 'declarada' | 'extrato' | null;
    gastoMedioMensal: number | null;    // saídas da conta + cartão, média por mês
    parcelasProximaFatura: number;
    pctRendaEmParcelas: number | null;
    emRotativo: boolean;
    encargos: number;
    aClassificar: number;
    custoIA: number;                    // US$
    tempoLeituraSeg: number;            // soma do tempo de leitura da IA
    alertas: string[];
}

interface DocLeve { tipo: 'extrato' | 'fatura'; qualidade_ruim?: boolean; custo_usd?: number | null; tempo_processamento?: number | null; criado_em?: string }

export function linhaDoPainel(
    cliente: { id: string; nome: string; criado_em: string; renda_declarada?: number | null },
    analise: { id: string; status: string; atualizado_em: string } | null,
    docs: DocLeve[],
    apuracao: { lancamentos: Lancamento[]; resumo: any } | null
): LinhaPainel {
    const lanc = apuracao?.lancamentos || [];
    const r = apuracao?.resumo || {};
    const evol = evolucaoMensal(lanc);
    const mesesExtrato = evol.filter(m => m.temExtrato);
    const rendaDeclarada = Number(cliente.renda_declarada) > 0 ? Number(cliente.renda_declarada) : null;
    const rendaExtrato = mesesExtrato.length ? arred(mesesExtrato.reduce((a, m) => a + m.entradas, 0) / mesesExtrato.length) : null;
    const renda = rendaDeclarada ?? (rendaExtrato && rendaExtrato > 0 ? rendaExtrato : null);
    const mesesComGasto = evol.filter(m => m.saidasConta || m.gastosCartao);
    const gastoMedio = mesesComGasto.length ? arred(mesesComGasto.reduce((a, m) => a + m.saidasConta + m.gastosCartao, 0) / mesesComGasto.length) : null;
    const parcelas = Number(r.comprometidoProximaFatura) || 0;
    const aClassificar = lanc.filter(l => l.situacao === 'incluido' && !l.classe).length;
    const emRotativo = !!r.endividamentoCartao?.emRotativo;
    const encargos = Number(r.endividamentoCartao?.encargos) || 0;
    const pct = renda && parcelas ? arred(parcelas / renda * 100) : null;

    const alertas: string[] = [];
    if (emRotativo) alertas.push('Rotativo no cartão');
    if (pct !== null && pct >= 30) alertas.push(`${Math.round(pct)}% da renda em parcelas`);
    if (docs.some(d => d.qualidade_ruim)) alertas.push('Documento ilegível');
    const temExt = docs.some(d => d.tipo === 'extrato'), temFat = docs.some(d => d.tipo === 'fatura');
    if (temExt && !temFat) alertas.push('Falta fatura');
    if (temFat && !temExt) alertas.push('Falta extrato');

    return {
        clienteId: cliente.id, nome: cliente.nome, criadoEm: cliente.criado_em,
        analiseId: analise?.id || null,
        status: !docs.length ? 'novo' : analise?.status === 'concluida' ? 'concluida' : 'em_revisao',
        atualizadoEm: docs.length ? analise?.atualizado_em || null : null,
        extratos: docs.filter(d => d.tipo === 'extrato').length,
        faturas: docs.filter(d => d.tipo === 'fatura').length,
        meses: evol.map(m => m.mes),
        renda, rendaFonte: rendaDeclarada ? 'declarada' : renda ? 'extrato' : null,
        gastoMedioMensal: gastoMedio,
        parcelasProximaFatura: arred(parcelas),
        pctRendaEmParcelas: pct,
        emRotativo, encargos: arred(encargos), aClassificar,
        custoIA: arred(docs.reduce((a, d) => a + (Number(d.custo_usd) || 0), 0) * 10000) / 10000,
        tempoLeituraSeg: Math.round(docs.reduce((a, d) => a + (Number(d.tempo_processamento) || 0), 0)),
        alertas
    };
}

export interface Produtividade {
    mes: string;                     // YYYY-MM de referência (mês atual)
    clientesNovos: number;           // cadastrados no mês
    analisesConcluidas: number;      // concluídas no mês
    emAndamento: number;
    documentosLidos: number;         // lidos pela IA no mês
    custoIAMes: number;              // US$
    custoMedioPorCliente: number | null;   // US$, clientes com documento
    tempoMedioLeituraSeg: number | null;   // leitura da IA por cliente
    diasMedioAteConcluir: number | null;   // do cadastro até concluir
    porMes: { mes: string; concluidas: number; documentos: number; custoIA: number }[];   // últimos 6 meses
}

export function produtividade(
    linhas: LinhaPainel[],
    docs: { criado_em: string; custo_usd?: number | null }[],
    hoje = new Date()
): Produtividade {
    const mesDe = (iso: string | null | undefined) => (iso || '').slice(0, 7);
    const mes = hoje.toISOString().slice(0, 7);
    const concl = linhas.filter(l => l.status === 'concluida');
    const comDoc = linhas.filter(l => l.status !== 'novo');
    const dias = concl.filter(l => l.atualizadoEm).map(l => (Date.parse(l.atualizadoEm!) - Date.parse(l.criadoEm)) / 86400000);
    const ultimos: string[] = [];
    for (let i = 5; i >= 0; i--) { const d = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() - i, 1)); ultimos.push(d.toISOString().slice(0, 7)); }
    return {
        mes,
        clientesNovos: linhas.filter(l => mesDe(l.criadoEm) === mes).length,
        analisesConcluidas: concl.filter(l => mesDe(l.atualizadoEm) === mes).length,
        emAndamento: linhas.filter(l => l.status === 'em_revisao').length,
        documentosLidos: docs.filter(d => mesDe(d.criado_em) === mes).length,
        custoIAMes: arred(docs.filter(d => mesDe(d.criado_em) === mes).reduce((a, d) => a + (Number(d.custo_usd) || 0), 0)),
        custoMedioPorCliente: comDoc.length ? arred(comDoc.reduce((a, l) => a + l.custoIA, 0) / comDoc.length) : null,
        tempoMedioLeituraSeg: comDoc.length ? Math.round(comDoc.reduce((a, l) => a + l.tempoLeituraSeg, 0) / comDoc.length) : null,
        diasMedioAteConcluir: dias.length ? Math.round(dias.reduce((a, d) => a + d, 0) / dias.length * 10) / 10 : null,
        porMes: ultimos.map(m => ({
            mes: m,
            concluidas: concl.filter(l => mesDe(l.atualizadoEm) === m).length,
            documentos: docs.filter(d => mesDe(d.criado_em) === m).length,
            custoIA: arred(docs.filter(d => mesDe(d.criado_em) === m).reduce((a, d) => a + (Number(d.custo_usd) || 0), 0))
        }))
    };
}
