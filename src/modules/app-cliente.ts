// ══════════════════════════════════════════════════════════════════════════
// APP DO CLIENTE — o resumo que o cliente vê no celular (link pessoal).
//
// É uma FOTO da análise, tirada quando a consultora clica em "Publicar para o
// cliente": o cliente nunca vê a análise pela metade. A foto guarda só o que
// as 4 telas mostram (Hoje, Parcelas, Plano, Futuro) — nada de lançamentos,
// CPF, e-mail ou documentos.
// ══════════════════════════════════════════════════════════════════════════
import { somarMeses } from './consolidacao';
import { BasePlano, PlanoConfig, simular } from './plano';
import { Ficha } from './ficha';

const arred = (n: number) => Math.round(n * 100) / 100;

/** Categorias que não são "gasto de vida" para o cliente ver na tela Hoje. */
const FORA_DO_HOJE = new Set(['Pagamento de fatura', 'Transferência', 'Investimento', 'Salário', 'Rendimento', 'Pix Recebido', 'Estorno']);

const NOME_OBJETIVO: Record<string, string> = {
    reserva: 'Reserva de emergência', dividas: 'Sair das dívidas', viagem: 'Viagem', carro: 'Carro',
    casa: 'Casa própria', aposentadoria: 'Aposentadoria', outro: 'Objetivo'
};

export interface FotoCliente {
    versao: 1;
    publicadoEm: string;
    nome: string;                       // primeiro nome
    consultora: string | null;
    periodo: { de: string | null; ate: string | null };    // YYYY-MM dos extratos/faturas
    hoje: {
        renda: number; custoVida: number; sobra: number;
        juros: number;                  // juros do cartão no mês (0 = não mostra o alerta)
        categorias: { nome: string; valor: number }[];
    };
    parcelas: {
        proxima: { mes: string; valor: number } | null;
        porMes: { mes: string; valor: number; terminam: number }[];
        pico: { mes: string; valor: number } | null;
        alivio: { mes: string; valor: number } | null;
        livreEm: string | null;
        totalRestante: number;
        itens: { descricao: string; parcela: string; fim: string; valor: number }[];
    };
    plano: {
        economiaMensal: number;
        atitudes: { titulo: string; texto: string; ganho: number }[];
        datas: { titulo: string; quando: string | null }[];      // YYYY-MM ou null (= já tem / sem data)
    };
    futuro: {
        taxaAno: number;
        horizontes: { rotulo: string; mes: string; comPlano: number; continuando: number }[];
        metas: { titulo: string; valor: number; atual: number; prazo: string | null; previsao: string | null }[];
    };
}

/** Mês do plano (1 = mês que vem) em YYYY-MM, a partir da data de publicação. */
const mesDoPlano = (hoje: string, n: number) => somarMeses(hoje.slice(0, 7), n);
const mesesAte = (hoje: string, mes: string) => {
    const [a, b] = [hoje.slice(0, 7), mes].map(k => Number(k.slice(0, 4)) * 12 + Number(k.slice(5, 7)) - 1);
    return b - a;
};

export function montarFoto(entrada: {
    cliente: { nome: string; ficha?: Ficha | null };
    consultora?: string | null;
    base: BasePlano;
    plano: PlanoConfig;
    parcelamentos: { itens: any[]; porMes: { mes: string; valor: number; terminam: any[] }[]; mesMaisApertado: string | null; livreDeParcelasEm: string | null; totalRestante: number } | undefined;
    mesesAnalise: string[];
    agora?: Date;
}): FotoCliente {
    const { base, plano } = entrada;
    const agora = (entrada.agora || new Date()).toISOString();
    const p = entrada.parcelamentos;
    const pm = p?.porMes || [];

    // ── Futuro: até a última parcela e até o prazo de cada meta (máx. 30 anos)
    const objetivos = (entrada.cliente.ficha?.objetivos || []).filter(o => o && o.tipo);
    const prazos = [p?.livreDeParcelasEm, ...objetivos.map(o => o.prazo)].filter((m): m is string => !!m && /^\d{4}-\d{2}$/.test(m));
    const horizonteMax = Math.min(360, Math.max(24, ...prazos.map(m => mesesAte(agora, m))));
    const sim = simular(base, plano, horizonteMax);
    const ponto = (n: number) => sim.pontos[Math.max(0, Math.min(n, sim.pontos.length - 1))];
    const primeiroMes = (valor: number) => { const i = sim.pontos.findIndex(x => x.mes > 0 && x.comMudancas >= valor); return i > 0 ? mesDoPlano(agora, sim.pontos[i].mes) : null; };

    const horizontes: FotoCliente['futuro']['horizontes'] = [];
    const addH = (rotulo: string, n: number) => {
        if (n <= 0 || horizontes.some(h => h.mes === mesDoPlano(agora, n))) return;
        const pt = ponto(n);
        horizontes.push({ rotulo, mes: mesDoPlano(agora, n), comPlano: arred(pt.comMudancas), continuando: arred(pt.continuandoAssim) });
    };
    addH('6 meses', 6);
    if (p?.livreDeParcelasEm) addH('fim das parcelas', mesesAte(agora, p.livreDeParcelasEm));
    const CURTO: Record<string, string> = { reserva: 'Reserva', dividas: 'Dívidas', casa: 'Casa', aposentadoria: 'Aposentar' };
    for (const o of objetivos) if (o.prazo) addH(CURTO[o.tipo] || (o.tipo === 'outro' && o.descricao ? o.descricao.slice(0, 14) : NOME_OBJETIVO[o.tipo]) || 'meta', mesesAte(agora, o.prazo));
    horizontes.sort((a, b) => a.mes.localeCompare(b.mes));

    const metas: FotoCliente['futuro']['metas'] = [];
    for (const o of objetivos) {
        const titulo = o.tipo === 'outro' && o.descricao ? o.descricao : NOME_OBJETIVO[o.tipo] || 'Objetivo';
        if (o.tipo === 'reserva') {
            const valor = o.valor || sim.metaReserva;
            metas.push({ titulo, valor: arred(valor), atual: arred(plano.reservaAtual), prazo: o.prazo,
                previsao: plano.reservaAtual >= valor ? agora.slice(0, 7) : primeiroMes(valor) });
        } else if (o.tipo === 'dividas') {
            if (base.emRotativo) metas.push({ titulo, valor: arred(base.saldoRotativo), atual: 0, prazo: o.prazo,
                previsao: plano.sairRotativo && sim.mesQuitaRotativo ? mesDoPlano(agora, sim.mesQuitaRotativo) : null });
        } else if (o.valor) {
            metas.push({ titulo, valor: arred(o.valor), atual: 0, prazo: o.prazo, previsao: primeiroMes(o.valor) });
        }
    }
    // Sem reserva na ficha: mostra a reserva de emergência do plano mesmo assim
    if (!metas.some(m => m.titulo === NOME_OBJETIVO.reserva) && sim.metaReserva > 0) {
        metas.unshift({ titulo: NOME_OBJETIVO.reserva, valor: arred(sim.metaReserva), atual: arred(plano.reservaAtual), prazo: null,
            previsao: sim.mesReservaCompleta === 0 ? agora.slice(0, 7) : sim.mesReservaCompleta ? mesDoPlano(agora, sim.mesReservaCompleta) : null });
    }

    // ── Plano
    const atitudes: FotoCliente['plano']['atitudes'] = [];
    if (plano.sairRotativo && base.emRotativo && sim.ganhos.rotativo > 0)
        atitudes.push({ titulo: plano.tituloRotativo || 'Sair do rotativo', texto: plano.textoRotativo || 'Pagar a fatura inteira todo mês.', ganho: arred(sim.ganhos.rotativo) });
    for (const c of plano.cortes) {
        const g = sim.ganhos.cortes.find(x => x.categoria === c.categoria)?.valor || 0;
        if (g > 0) atitudes.push({ titulo: c.titulo, texto: c.texto || `Gastar ${c.percentual}% a menos com ${c.categoria.toLowerCase()} por mês.`, ganho: arred(g) });
    }
    const datas: FotoCliente['plano']['datas'] = [];
    if (base.emRotativo && plano.sairRotativo) datas.push({ titulo: 'Fora do rotativo', quando: sim.mesQuitaRotativo ? mesDoPlano(agora, sim.mesQuitaRotativo) : null });
    if (p?.livreDeParcelasEm) datas.push({ titulo: 'Sem parcelas', quando: p.livreDeParcelasEm });
    datas.push({ titulo: `Reserva de ${plano.mesesReserva} meses`, quando: sim.mesReservaCompleta === 0 ? agora.slice(0, 7) : sim.mesReservaCompleta ? mesDoPlano(agora, sim.mesReservaCompleta) : null });

    // ── Parcelas
    const prox = pm[1] || null;
    const alivio = prox ? pm.slice(2).find(m => m.valor <= prox.valor / 2) || null : null;
    const pico = p?.mesMaisApertado ? pm.find(m => m.mes === p.mesMaisApertado) || null : null;
    const itens = (p?.itens || []).filter((i: any) => i.restantes > 0)
        .sort((a: any, b: any) => a.fim.localeCompare(b.fim) || b.valorParcela - a.valorParcela).slice(0, 12)
        .map((i: any) => ({ descricao: String(i.descricao || '').slice(0, 40), parcela: `${i.parcelaAtual}/${i.parcelaTotal}`, fim: i.fim, valor: arred(i.valorParcela) }));

    const meses = entrada.mesesAnalise.filter(m => /^\d{4}-\d{2}$/.test(m)).sort();
    return {
        versao: 1,
        publicadoEm: agora,
        nome: (entrada.cliente.nome || '').trim().split(/\s+/)[0] || 'Cliente',
        consultora: entrada.consultora || null,
        periodo: { de: meses[0] || null, ate: meses[meses.length - 1] || null },
        hoje: {
            renda: arred(base.rendaMensal), custoVida: arred(base.custoVidaEstimado), sobra: arred(base.rendaMensal - base.custoVidaEstimado),
            juros: base.emRotativo ? arred(base.jurosMensal) : 0,
            categorias: base.mediaPorCategoria.filter(c => !FORA_DO_HOJE.has(c.categoria) && c.valor > 0).slice(0, 6).map(c => ({ nome: c.categoria, valor: arred(c.valor) }))
        },
        parcelas: {
            proxima: prox ? { mes: prox.mes, valor: arred(prox.valor) } : null,
            porMes: pm.map(m => ({ mes: m.mes, valor: arred(m.valor), terminam: (m.terminam || []).length })),
            pico: pico ? { mes: pico.mes, valor: arred(pico.valor) } : null,
            alivio: alivio ? { mes: alivio.mes, valor: arred(alivio.valor) } : null,
            livreEm: p?.livreDeParcelasEm || null,
            totalRestante: arred(p?.totalRestante || 0),
            itens
        },
        plano: { economiaMensal: arred(sim.economiaMensal), atitudes, datas },
        futuro: { taxaAno: plano.taxaAno, horizontes, metas }
    };
}
