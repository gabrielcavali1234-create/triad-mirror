// ══════════════════════════════════════════════════════════════════════════
// APP DO CLIENTE — o resumo que o cliente vê no celular (link pessoal).
//
// É uma FOTO da análise, tirada quando a consultora clica em "Publicar para o
// cliente": o cliente nunca vê a análise pela metade. A foto guarda só o que
// as 4 telas mostram (Hoje, Parcelas, Plano, Futuro) — nada de lançamentos,
// CPF, e-mail ou documentos.
// ══════════════════════════════════════════════════════════════════════════
import { Lancamento, somarMeses } from './consolidacao';
import { BasePlano, PlanoConfig, simular } from './plano';
import { Ficha } from './ficha';

const arred = (n: number) => Math.round(n * 100) / 100;

/** Categorias que não são "gasto de vida" para o cliente ver na tela Hoje. */
const FORA_DO_HOJE = new Set(['Pagamento de fatura', 'Transferência', 'Investimento', 'Salário', 'Rendimento', 'Pix Recebido', 'Estorno']);

const NOME_OBJETIVO: Record<string, string> = {
    reserva: 'Reserva de emergência', dividas: 'Sair das dívidas', viagem: 'Viagem', carro: 'Carro',
    casa: 'Casa própria', aposentadoria: 'Aposentadoria', outro: 'Objetivo'
};

/** Um mês da vida do cliente, do jeito que ele entende: entrou, gastou, sobrou. */
export interface MesCliente {
    mes: string;                        // YYYY-MM
    entrou: number;
    gastou: number;                     // conta + cartão (sem transferências, investimentos e pagamento de fatura já detalhada)
    sobra: number;
    juros: number;                      // juros, IOF e encargos do cartão
    categorias: Record<string, number>; // gasto por categoria (top 10)
    comFatura: boolean;                 // tem a fatura do mês detalhada (só se compara categoria entre meses do mesmo tipo)
    rendaEstimada?: boolean;            // sem extrato: entrou = renda declarada
    semRenda?: boolean;                 // sem extrato e sem renda na ficha: só mostra o que gastou
}

export type TipoEvento = 'conquista' | 'alerta' | 'atencao';
export interface EventoCliente { tipo: TipoEvento; titulo: string; texto: string; mes: string }

export interface NotaSaude {
    valor: number;                      // 0 a 100
    rotulo: string;                     // Ótima / Boa / Atenção / Delicada
    anterior: number | null;            // nota da publicação anterior
    pilares: { nome: string; pontos: number; status: 'ok' | 'atencao' | 'ruim'; texto: string }[];
}

export interface HistoricoPublicacao { data: string; nota: number; sobra: number; juros: number; rotativo: boolean; metasConcluidas: string[] }

export interface FotoCliente {
    versao: 1 | 2;
    // ── v2 (tela Hoje completa)
    meses?: MesCliente[];
    nota?: NotaSaude;
    eventos?: EventoCliente[];
    historico?: HistoricoPublicacao[];
    contato?: { whatsapp: string | null };                    // WhatsApp da consultora (botão no menu do app)
    proximaReuniao?: { data: string; hora: string } | null;   // próximo contato marcado no sistema
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

/** Próximo contato marcado na ficha (só se ainda não passou); o horário vem da ata que combinou a data. */
function proximaReuniaoDe(ficha: Ficha | null | undefined, agoraIso: string): { data: string; hora: string } | null {
    const data = ficha?.proximoContato?.data;
    if (!data || data < agoraIso.slice(0, 10)) return null;
    const ata = (ficha?.atas || []).find(a => a.proxima?.data === data && a.proxima?.hora);
    return { data, hora: ata?.proxima?.hora || '' };
}

/** Mês do plano (1 = mês que vem) em YYYY-MM, a partir da data de publicação. */
const mesDoPlano = (hoje: string, n: number) => somarMeses(hoje.slice(0, 7), n);
const mesesAte = (hoje: string, mes: string) => {
    const [a, b] = [hoje.slice(0, 7), mes].map(k => Number(k.slice(0, 4)) * 12 + Number(k.slice(5, 7)) - 1);
    return b - a;
};

export function montarFoto(entrada: {
    cliente: { nome: string; ficha?: Ficha | null; renda_declarada?: number | null };
    consultora?: string | null;
    base: BasePlano;
    plano: PlanoConfig;
    parcelamentos: { itens: any[]; porMes: { mes: string; valor: number; terminam: any[] }[]; mesMaisApertado: string | null; livreDeParcelasEm: string | null; totalRestante: number } | undefined;
    mesesAnalise: string[];
    lancamentos?: Lancamento[];
    anterior?: FotoCliente | null;      // publicação anterior (para conquistas e histórico)
    whatsappConsultora?: string | null;
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
        .sort((a: any, b: any) => a.fim.localeCompare(b.fim) || b.valorParcela - a.valorParcela).slice(0, 60)
        .map((i: any) => ({ descricao: String(i.descricao || '').slice(0, 40), parcela: `${i.parcelaAtual}/${i.parcelaTotal}`, fim: i.fim, valor: arred(i.valorParcela) }));

    const mesesAn = entrada.mesesAnalise.filter(m => /^\d{4}-\d{2}$/.test(m)).sort();
    // ── v2: mês a mês, nota, linha do tempo e histórico
    const rendaInformada = Number(entrada.cliente.renda_declarada) > 0 ? Number(entrada.cliente.renda_declarada) : base.rendaMensal;
    const meses = entrada.lancamentos ? mesesDoCliente(entrada.lancamentos, rendaInformada) : [];
    const atual = meses[meses.length - 1] || null;
    const anterior = entrada.anterior || null;
    const notaAnterior = anterior?.historico?.length ? anterior.historico[anterior.historico.length - 1].nota : null;
    const nota = notaSaude({ base, plano, atual, proximaParcela: pm[1]?.valor ?? pm[0]?.valor ?? 0, anterior: notaAnterior });
    const metasConcluidas = metas.filter(m => m.atual >= m.valor && m.valor > 0).map(m => m.titulo);
    const agoraHist: HistoricoPublicacao = { data: agora, nota: nota.valor, sobra: arred(atual?.sobra ?? base.rendaMensal - base.custoVidaEstimado),
        juros: arred(atual?.juros ?? 0), rotativo: !!base.emRotativo, metasConcluidas };
    const eventos = linhaDoTempo({ meses, pm, picoMes: p?.mesMaisApertado || null, agora, ultimo: anterior?.historico?.[anterior.historico.length - 1] || null,
        atualHist: agoraHist, eventosAnteriores: anterior?.eventos || [] });
    // "Sair das dívidas" concluída quando saiu do rotativo
    if (!base.emRotativo && anterior?.historico?.some(h => h.rotativo)) {
        const m = metas.find(x => x.titulo === NOME_OBJETIVO.dividas); if (m) m.atual = m.valor;
    }

    return {
        versao: 2,
        meses, nota, eventos,
        historico: [...(anterior?.historico || []), agoraHist].slice(-24),
        contato: { whatsapp: (String(entrada.whatsappConsultora || '').replace(/\D/g, '').slice(0, 15)) || anterior?.contato?.whatsapp || null },
        proximaReuniao: proximaReuniaoDe(entrada.cliente.ficha, agora),
        publicadoEm: agora,
        nome: (entrada.cliente.nome || '').trim().split(/\s+/)[0] || 'Cliente',
        consultora: entrada.consultora || null,
        periodo: { de: mesesAn[0] || null, ate: mesesAn[mesesAn.length - 1] || null },
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

// ─── Mês a mês do cliente ───────────────────────────────────────────────
const NAO_E_GASTO = new Set(['Transferência', 'Investimento', 'Estorno']);
const NAO_E_RENDA = new Set(['Transferência', 'Investimento', 'Estorno']);
const JUROS = /Encargos|IOF/i;     // juros, mora, multa e IOF (anuidade e tarifa não são juros)

/**
 * Entrou, gastou e sobrou por mês. Onde houver fatura do mês, o "Pagamento de
 * fatura" do extrato sai e entra o detalhe da fatura (por categoria); onde
 * não houver, o pagamento aparece como "Cartão de crédito".
 */
export function mesesDoCliente(lancamentos: Lancamento[], rendaDeclarada = 0): MesCliente[] {
    const inc = lancamentos.filter(l => l.situacao === 'incluido' && /^\d{4}-\d{2}$/.test(l.mesReferencia));
    const mesesExtrato = new Set(inc.filter(l => l.origem === 'extrato').map(l => l.mesReferencia));
    const mesesFatura = new Set(inc.filter(l => l.origem === 'fatura').map(l => l.mesReferencia));
    const semExtrato = mesesExtrato.size === 0;
    const base = Array.from(semExtrato ? mesesFatura : mesesExtrato).sort().slice(-12);
    return base.map(mes => {
        let entrou = 0, gastou = 0, juros = 0;
        const cat: Record<string, number> = {};
        const soma = (c: string, v: number) => { cat[c] = (cat[c] || 0) + v; gastou += v; };
        for (const l of inc) {
            if (l.mesReferencia !== mes) continue;
            if (l.origem === 'extrato') {
                if (l.direcao === 'entrada') { if (!NAO_E_RENDA.has(l.categoria)) entrou += l.valor; continue; }
                if (NAO_E_GASTO.has(l.categoria)) continue;
                if (l.categoria === 'Pagamento de fatura') { if (!mesesFatura.has(mes)) soma('Cartão de crédito', l.valor); continue; }
                soma(l.categoria, l.valor);
            } else {
                const v = l.direcao === 'saida' ? l.valor : -l.valor;
                soma(l.categoria, v);
                if (JUROS.test(l.categoria)) juros += v;
            }
        }
        if (semExtrato) entrou = rendaDeclarada;
        const top = Object.entries(cat).filter(([, v]) => v > 0.5).sort((a, b) => b[1] - a[1]).slice(0, 10);
        return {
            mes, entrou: arred(entrou), gastou: arred(gastou), sobra: arred(entrou - gastou), juros: arred(Math.max(0, juros)),
            categorias: Object.fromEntries(top.map(([k, v]) => [k, arred(v)])),
            comFatura: mesesFatura.has(mes),
            ...(semExtrato ? (rendaDeclarada > 0 ? { rendaEstimada: true } : { semRenda: true }) : {})
        };
    });
}

// ─── Nota de saúde financeira (0 a 100, 4 pilares de 25) ────────────────
const limitar = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const statusDe = (pontos: number): 'ok' | 'atencao' | 'ruim' => pontos >= 18 ? 'ok' : pontos >= 8 ? 'atencao' : 'ruim';
const pct = (v: number) => Math.round(v * 100);

/**
 * Regra da nota (cada pilar vale até 25 pontos):
 *  • Sobra do mês: 15% da renda ou mais = 25; zero ou negativa = 0; no meio, proporcional.
 *  • Juros: nenhum juro do cartão = 25; até 1% da renda = 12; acima = 0.
 *  • Parcelas: próxima fatura com até 10% da renda em parcelas = 25; 50% ou mais = 0.
 *  • Reserva: proporcional aos meses de custo de vida guardados (meta do plano = 25).
 */
export function notaSaude(e: { base: BasePlano; plano: PlanoConfig; atual: MesCliente | null; proximaParcela: number; anterior: number | null }): NotaSaude {
    const renda = e.atual?.entrou || e.base.rendaMensal || 0;
    const sobra = e.atual ? e.atual.sobra : e.base.rendaMensal - e.base.custoVidaEstimado;
    const juros = e.atual ? e.atual.juros : (e.base.emRotativo ? e.base.jurosMensal : 0);
    const custo = e.base.custoVidaEstimado || 1;
    const pSobra = renda > 0 ? limitar((sobra / renda) / 0.15, 0, 1) * 25 : 0;
    const pJuros = juros <= 0.5 ? 25 : renda > 0 && juros / renda <= 0.01 ? 12 : 0;
    const fracParc = renda > 0 ? e.proximaParcela / renda : 1;
    const pParc = limitar((0.5 - fracParc) / 0.4, 0, 1) * 25;
    const mesesGuardados = e.plano.reservaAtual / custo;
    const pRes = limitar(mesesGuardados / (e.plano.mesesReserva || 6), 0, 1) * 25;
    const valor = Math.round(pSobra + pJuros + pParc + pRes);
    const fmt = (n: number) => n.toFixed(1).replace('.', ',').replace(',0', '');
    return {
        valor,
        rotulo: valor >= 80 ? 'Ótima' : valor >= 60 ? 'Boa' : valor >= 40 ? 'Atenção' : 'Delicada',
        anterior: e.anterior,
        pilares: [
            { nome: 'Sobra', pontos: Math.round(pSobra), status: statusDe(pSobra), texto: sobra >= 0 ? `${pct(renda ? sobra / renda : 0)}% da renda sobra no mês` : 'O mês fecha no vermelho' },
            { nome: 'Juros', pontos: Math.round(pJuros), status: statusDe(pJuros), texto: juros <= 0.5 ? 'Sem juros do cartão' : `R$ ${Math.round(juros).toLocaleString('pt-BR')} de juros no mês` },
            { nome: 'Parcelas', pontos: Math.round(pParc), status: statusDe(pParc), texto: e.proximaParcela ? `${pct(fracParc)}% da renda na próxima fatura` : 'Sem parcelas pela frente' },
            { nome: 'Reserva', pontos: Math.round(pRes), status: statusDe(pRes), texto: `${fmt(mesesGuardados)} de ${e.plano.mesesReserva || 6} meses guardados` }
        ]
    };
}

// ─── Linha do tempo: conquistas e alertas ────────────────────────────────
const brl0 = (n: number) => 'R$ ' + Math.round(Math.abs(n)).toLocaleString('pt-BR');
const NOMES_MES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const nomeMes = (k: string) => NOMES_MES[Number(k.slice(5, 7)) - 1] || k;

export function linhaDoTempo(e: {
    meses: MesCliente[];
    pm: { mes: string; valor: number; terminam: any[] }[];
    picoMes: string | null;
    agora: string;
    ultimo: HistoricoPublicacao | null;
    atualHist: HistoricoPublicacao;
    eventosAnteriores: EventoCliente[];
}): EventoCliente[] {
    const novos: EventoCliente[] = [];
    const mesHoje = e.agora.slice(0, 7);
    const ms = e.meses, atual = ms[ms.length - 1];

    // comparando com a publicação anterior
    if (e.ultimo) {
        if (e.ultimo.rotativo && !e.atualHist.rotativo) novos.push({ tipo: 'conquista', titulo: 'Você saiu do rotativo!', texto: 'Nenhum real de juros por deixar a fatura para depois.', mes: mesHoje });
        const d = e.atualHist.nota - e.ultimo.nota;
        if (d >= 5) novos.push({ tipo: 'conquista', titulo: `Sua nota subiu ${d} pontos`, texto: `De ${e.ultimo.nota} para ${e.atualHist.nota}.`, mes: mesHoje });
        if (d <= -5) novos.push({ tipo: 'atencao', titulo: `Sua nota caiu ${-d} pontos`, texto: `De ${e.ultimo.nota} para ${e.atualHist.nota}. Vale conversar com a sua consultora.`, mes: mesHoje });
        for (const m of e.atualHist.metasConcluidas) if (!e.ultimo.metasConcluidas.includes(m))
            novos.push({ tipo: 'conquista', titulo: `Objetivo alcançado: ${m}`, texto: 'Parabéns pela disciplina!', mes: mesHoje });
    }

    // mês a mês
    for (let i = 1; i < ms.length; i++) {
        const a = ms[i - 1], b = ms[i];
        if (a.juros > 0.5 && b.juros <= 0.5) novos.push({ tipo: 'conquista', titulo: 'Mês sem juros do cartão', texto: `Em ${nomeMes(b.mes)} a fatura veio sem juros.`, mes: b.mes });
        if (!a.semRenda && !b.semRenda && a.sobra < 0 && b.sobra > 0) novos.push({ tipo: 'conquista', titulo: 'Voltou a sobrar dinheiro', texto: `Sobraram ${brl0(b.sobra)} em ${nomeMes(b.mes)}.`, mes: b.mes });
    }
    if (atual) {
        if (atual.juros > 0.5) novos.push({ tipo: 'alerta', titulo: `${brl0(atual.juros)} foram para juros do cartão`, texto: 'Pagar a fatura inteira evita esse custo.', mes: atual.mes });
        if (!atual.semRenda && atual.sobra < 0) novos.push({ tipo: 'alerta', titulo: `O mês fechou com ${brl0(atual.sobra)} a menos`, texto: 'Gastou mais do que entrou.', mes: atual.mes });
        // categorias que mudaram muito contra o MÊS PASSADO (só se os dois meses forem do mesmo tipo)
        const pa = ms.length > 1 ? ms[ms.length - 2] : null;
        if (pa && pa.comFatura === atual.comFatura) {
            const mudancas = Object.entries(atual.categorias).map(([c, v]) => {
                const antes = pa.categorias[c] || 0;
                return { c, v, antes, d: antes > 0 ? (v - antes) / antes : 0 };
            }).filter(x => x.antes >= 100 && Math.abs(x.v - x.antes) >= 100 && Math.abs(x.d) >= 0.3).sort((x, y) => Math.abs(y.v - y.antes) - Math.abs(x.v - x.antes)).slice(0, 2);
            for (const x of mudancas) novos.push(x.d > 0
                ? { tipo: 'atencao', titulo: `Gasto com ${x.c.toLowerCase()} subiu ${Math.round(x.d * 100)}%`, texto: `${brl0(x.v)} em ${nomeMes(atual.mes)}, contra ${brl0(x.antes)} em ${nomeMes(pa.mes)}.`, mes: atual.mes }
                : { tipo: 'conquista', titulo: `Gasto com ${x.c.toLowerCase()} caiu ${Math.round(-x.d * 100)}%`, texto: `${brl0(x.v)} em ${nomeMes(atual.mes)}, contra ${brl0(x.antes)} em ${nomeMes(pa.mes)}.`, mes: atual.mes });
        }
    }
    // parcelas
    const prox = e.pm[1], depois = e.pm[2];
    if (prox && prox.mes >= mesHoje && prox.terminam?.length) novos.push({ tipo: 'conquista', titulo: `${prox.terminam.length} parcela${prox.terminam.length > 1 ? 's terminam' : ' termina'} em ${nomeMes(prox.mes)}`,
        texto: depois ? `A fatura de ${nomeMes(depois.mes)} vem ${brl0(prox.valor - depois.valor)} menor.` : 'Depois disso, sem parcelas.', mes: prox.mes });
    if (e.picoMes && e.picoMes >= mesHoje && e.pm.slice(1, 4).some(m => m.mes === e.picoMes)) {
        const v = e.pm.find(m => m.mes === e.picoMes)!.valor;
        novos.push({ tipo: 'atencao', titulo: `${nomeMes(e.picoMes)[0].toUpperCase() + nomeMes(e.picoMes).slice(1)} é o mês mais apertado`, texto: `${brl0(v)} já comprometidos em parcelas.`, mes: e.picoMes });
    }

    // junta com os anteriores (sem repetir) e ordena do mais recente
    const chave = (x: EventoCliente) => `${x.titulo}|${x.mes}`;
    const vistos = new Set<string>();
    // das publicações anteriores ficam só as conquistas (alertas valem para o momento em que saíram)
    return [...novos, ...e.eventosAnteriores.filter(x => x.tipo === 'conquista' && x.mes < mesHoje)].filter(x => { const k = chave(x); if (vistos.has(k)) return false; vistos.add(k); return true; })
        .sort((a, b) => b.mes.localeCompare(a.mes)).slice(0, 10);
}
