// ══════════════════════════════════════════════════════════════════════════
// PLANO DO CLIENTE — a parte que vai para o cliente ver: quanto os hábitos
// custam, o que muda com três atitudes e onde o dinheiro pode chegar.
//
//  • BASE: números que saem da apuração (renda média, custo de vida, gasto
//    médio por categoria, juros do cartão, rotativo, parcelas).
//  • PLANO: o que o analista define (rendimento simulado, reserva, atitudes:
//    sair do rotativo + cortes por categoria). Fica salvo na análise.
//  • SIMULAÇÃO: mês a mês, "com as mudanças" × "continuando assim".
//    A tela do analista refaz a mesma conta no navegador (public/index.html,
//    função simularPlano) para os controles responderem na hora; a rota
//    /api/app/analises/:id/simulacao usa esta, para outros aplicativos.
//
// É simulação, não promessa de retorno: o rendimento é um parâmetro da
// consultoria e aparece sempre na tela.
// ══════════════════════════════════════════════════════════════════════════
import { CATEGORIAS } from './categorias';
import type { Lancamento } from './consolidacao';

export interface Corte {
    categoria: string;
    percentual: number;     // 0–100: quanto reduzir do gasto médio da categoria
    titulo: string;
    texto: string;
}

export interface PlanoConfig {
    taxaAno: number;                    // % ao ano, rendimento simulado
    reservaAtual: number;               // R$ que o cliente já tem guardado
    mesesReserva: number;               // meta: meses de custo de vida
    custoVidaMensal: number | null;     // null = usar o estimado pela análise
    sairRotativo: boolean;
    tituloRotativo: string;
    textoRotativo: string;
    cortes: Corte[];
}

export interface CategoriaMedia { categoria: string; valor: number }

export interface BasePlano {
    rendaMensal: number;
    custoVidaEstimado: number;
    mediaPorCategoria: CategoriaMedia[];   // maior → menor
    jurosMensal: number;                   // juros, mora, multa e IOF de financiamento do cartão
    saldoRotativo: number;
    emRotativo: boolean;
    proximaFatura: number;
    parcelasRestante: number;
    livreDeParcelasEm: string | null;      // YYYY-MM
    mesesConta: string[];                  // YYYY-MM dos extratos
    temFatura: boolean;
}

/** Categorias que não são custo de vida (pagamento de fatura duplica o cartão; investimento é guardar). */
const FORA_DO_CUSTO = new Set(['Pagamento de fatura', 'Investimento']);
/** Categorias em que costuma dar para cortar — viram as atitudes sugeridas. */
const AJUSTAVEIS = ['Delivery', 'Assinaturas', 'Alimentação', 'Lazer', 'Vestuário', 'Compras', 'Cuidados pessoais', 'Viagem', 'Transporte', 'Pets'];
const TITULOS: Record<string, string> = {
    'Delivery': 'Pedir menos delivery', 'Assinaturas': 'Revisar as assinaturas', 'Alimentação': 'Comer fora com menos frequência',
    'Lazer': 'Teto para o lazer', 'Vestuário': 'Teto para roupas e calçados', 'Compras': 'Teto para compras',
    'Cuidados pessoais': 'Teto para cuidados pessoais', 'Viagem': 'Planejar as viagens', 'Transporte': 'Usar menos aplicativo de transporte'
};
export const tituloDoCorte = (categoria: string) => TITULOS[categoria] || `Reduzir gastos com ${categoria.toLowerCase()}`;

const arred = (n: number) => Math.round(n * 100) / 100;
const numero = (v: any, min: number, max: number, padrao: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : padrao;
};
const texto = (v: any, max: number) => String(v ?? '').trim().slice(0, max);

interface ResumoParaPlano {
    endividamentoCartao?: { encargos?: number; saldoFinanciado?: number; emRotativo?: boolean };
    comprometidoProximaFatura?: number;
    parcelamentos?: { totalRestante?: number; livreDeParcelasEm?: string | null; porMes?: unknown[] } | null;
}

/** Números da análise que o plano usa. Média mensal: conta ÷ meses de extrato; cartão ÷ faturas. */
export function basePlano(lancamentos: Lancamento[], resumo: ResumoParaPlano): BasePlano {
    const mesesDe = (o: string) => Array.from(new Set(lancamentos.filter(l => l.origem === o).map(l => l.mesReferencia).filter(m => /^\d{4}-\d{2}$/.test(m)))).sort();
    const mesesConta = mesesDe('extrato'), mesesCartao = mesesDe('fatura');
    const nConta = mesesConta.length || 1, nCartao = mesesCartao.length || 1;
    const porCat = new Map<string, number>();
    let renda = 0;
    for (const l of lancamentos) {
        if (l.situacao !== 'incluido') continue;
        const div = l.origem === 'extrato' ? nConta : nCartao;
        if (l.direcao === 'entrada') {
            if (l.origem === 'extrato') renda += l.valor / div;
            else porCat.set(l.categoria, (porCat.get(l.categoria) || 0) - l.valor / div);   // estorno no cartão abate
            continue;
        }
        porCat.set(l.categoria, (porCat.get(l.categoria) || 0) + l.valor / div);
    }
    const mediaPorCategoria = Array.from(porCat, ([categoria, valor]) => ({ categoria, valor: arred(valor) }))
        .filter(c => c.valor > 0.5).sort((a, b) => b.valor - a.valor);
    const custo = mediaPorCategoria.filter(c => !FORA_DO_CUSTO.has(c.categoria)).reduce((a, c) => a + c.valor, 0);
    const e = resumo.endividamentoCartao || {};
    const p = resumo.parcelamentos || null;
    return {
        rendaMensal: arred(renda),
        custoVidaEstimado: arred(custo),
        mediaPorCategoria,
        jurosMensal: arred((e.encargos || 0) / nCartao),
        saldoRotativo: arred(e.saldoFinanciado || 0),
        emRotativo: !!e.emRotativo,
        proximaFatura: arred(resumo.comprometidoProximaFatura || 0),
        parcelasRestante: arred(p?.totalRestante || 0),
        livreDeParcelasEm: p?.porMes?.length ? p.livreDeParcelasEm || null : null,
        mesesConta,
        temFatura: mesesCartao.length > 0
    };
}

/** Plano sugerido enquanto o analista não salva um: sair do rotativo + as 2 categorias ajustáveis mais caras, com 30%. */
export function planoPadrao(base: BasePlano): PlanoConfig {
    const sugeridas = base.mediaPorCategoria.filter(c => AJUSTAVEIS.includes(c.categoria)).slice(0, 2);
    return {
        taxaAno: 10, reservaAtual: 0, mesesReserva: 6, custoVidaMensal: null,
        sairRotativo: base.emRotativo,
        tituloRotativo: 'Sair do rotativo',
        textoRotativo: 'Pagar a fatura inteira todo mês. O que já está na próxima fatura vem antes de qualquer compra nova.',
        cortes: sugeridas.map(c => ({ categoria: c.categoria, percentual: 30, titulo: tituloDoCorte(c.categoria), texto: '' }))
    };
}

/** Valida o que veio da tela. Nunca confia no corpo da requisição. */
export function normalizarPlano(v: any): PlanoConfig {
    const cats = new Set(CATEGORIAS);
    const vistos = new Set<string>();
    const cortes: Corte[] = (Array.isArray(v?.cortes) ? v.cortes : []).flatMap((c: any) => {
        const categoria = String(c?.categoria || '');
        if (!cats.has(categoria) || vistos.has(categoria)) return [];
        vistos.add(categoria);
        return [{ categoria, percentual: Math.round(numero(c?.percentual, 0, 100, 30)), titulo: texto(c?.titulo, 120) || tituloDoCorte(categoria), texto: texto(c?.texto, 400) }];
    }).slice(0, 5);
    const custo = v?.custoVidaMensal;
    return {
        taxaAno: arred(numero(v?.taxaAno, 0, 30, 10)),
        reservaAtual: arred(numero(v?.reservaAtual, 0, 1e9, 0)),
        mesesReserva: Math.round(numero(v?.mesesReserva, 1, 24, 6)),
        custoVidaMensal: custo === null || custo === undefined || custo === '' ? null : arred(numero(custo, 0, 1e8, 0)),
        sairRotativo: !!v?.sairRotativo,
        tituloRotativo: texto(v?.tituloRotativo, 120) || 'Sair do rotativo',
        textoRotativo: texto(v?.textoRotativo, 400),
        cortes
    };
}

export interface PontoSimulacao { mes: number; comMudancas: number; continuandoAssim: number; jurosPagos: number }
export interface Simulacao {
    economiaMensal: number;
    ganhos: { rotativo: number; cortes: { categoria: string; valor: number }[] };
    metaReserva: number;
    mesQuitaRotativo: number | null;     // 1 = primeiro mês do plano
    mesReservaCompleta: number | null;
    pontos: PontoSimulacao[];            // mês 0 = hoje
}

/**
 * Mês a mês. Com as mudanças: a economia quita primeiro o rotativo e depois é
 * investida; a reserva atual também rende. Continuando assim: a reserva rende,
 * menos os juros do cartão pagos até ali (conservador: juros fixos por mês;
 * no rotativo a dívida costuma crescer).
 */
export function simular(base: BasePlano, plano: PlanoConfig, meses = 240): Simulacao {
    const i = Math.pow(1 + plano.taxaAno / 100, 1 / 12) - 1;
    const rot = plano.sairRotativo && base.emRotativo;
    const media = new Map(base.mediaPorCategoria.map(c => [c.categoria, c.valor]));
    const cortes = plano.cortes.map(c => ({ categoria: c.categoria, valor: arred((media.get(c.categoria) || 0) * c.percentual / 100) }));
    const ganhoRot = rot ? base.jurosMensal : 0;
    const economia = ganhoRot + cortes.reduce((a, c) => a + c.valor, 0);
    const custoVida = plano.custoVidaMensal ?? base.custoVidaEstimado;
    const meta = arred(custoVida * plano.mesesReserva);

    let divida = rot ? base.saldoRotativo : 0, com = plano.reservaAtual, reserva = plano.reservaAtual, juros = 0;
    let mesQuita: number | null = rot ? (divida > 0 ? null : 1) : null, mesReserva: number | null = plano.reservaAtual >= meta && meta > 0 ? 0 : null;
    const pontos: PontoSimulacao[] = [{ mes: 0, comMudancas: com, continuandoAssim: reserva, jurosPagos: 0 }];
    for (let m = 1; m <= meses; m++) {
        let livre = economia;
        if (divida > 0) {
            const pago = Math.min(divida, livre);
            divida -= pago; livre -= pago;
            if (divida <= 0.005 && mesQuita === null) mesQuita = m;
        }
        com = com * (1 + i) + livre;
        juros += base.jurosMensal;
        reserva = reserva * (1 + i);
        if (mesReserva === null && meta > 0 && com >= meta) mesReserva = m;
        pontos.push({ mes: m, comMudancas: arred(com), continuandoAssim: arred(reserva - juros), jurosPagos: arred(juros) });
    }
    return { economiaMensal: arred(economia), ganhos: { rotativo: arred(ganhoRot), cortes }, metaReserva: meta, mesQuitaRotativo: mesQuita, mesReservaCompleta: mesReserva, pontos };
}
