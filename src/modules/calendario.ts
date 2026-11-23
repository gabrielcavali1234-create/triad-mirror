// ══════════════════════════════════════════════════════════════════════════
// Calendário financeiro: o mês dia a dia — quando o dinheiro entra, quando
// cada conta sai e quanto sobra na conta em cada dia.
//   • Contas e entradas que se repetem saem do extrato (mesma descrição, mesmo
//     dia e valor parecido) e as faturas, dos cartões (dia do vencimento).
//   • Só DIAS ÚTEIS: conta que cai em sábado, domingo ou feriado vai para o
//     próximo dia útil; entrada (salário) vem no dia útil anterior.
//   • A consultora ajusta tudo na ficha (ficha.calendario): muda dia/valor,
//     desliga um item, inclui contas que o extrato não mostra (IPVA, IPTU…).
// ══════════════════════════════════════════════════════════════════════════
import { Lancamento, somarMeses } from './consolidacao';

const arred = (n: number) => Math.round(n * 100) / 100;
const z2 = (n: number) => String(n).padStart(2, '0');
const iso = (a: number, m: number, d: number) => `${a}-${z2(m)}-${z2(d)}`;
const diasNoMes = (a: number, m: number) => new Date(Date.UTC(a, m, 0)).getUTCDate();
const diaSemana = (s: string) => new Date(s + 'T12:00:00Z').getUTCDay();   // 0 = domingo
const somarDias = (s: string, n: number) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// ── Feriados ─────────────────────────────────────────────────────────────
/** Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher). */
function pascoa(a: number): string {
    const A = a % 19, B = Math.floor(a / 100), C = a % 100, D = Math.floor(B / 4), E = B % 4, F = Math.floor((B + 8) / 25);
    const G = Math.floor((B - F + 1) / 3), H = (19 * A + B - D - G + 15) % 30, I = Math.floor(C / 4), K = C % 4;
    const L = (32 + 2 * E + 2 * I - H - K) % 7, M = Math.floor((A + 11 * H + 22 * L) / 451);
    const mes = Math.floor((H + L - 7 * M + 114) / 31), dia = ((H + L - 7 * M + 114) % 31) + 1;
    return iso(a, mes, dia);
}

/** Dias sem expediente bancário no ano: feriados nacionais + Carnaval, Sexta-feira Santa,
 *  Corpus Christi e 31/12. Com a cidade de São Paulo (ou estado SP), entram os locais. */
export function feriadosDoAno(ano: number, cidade?: string): Map<string, string> {
    const f = new Map<string, string>();
    const fixos: [number, number, string][] = [
        [1, 1, 'Confraternização Universal'], [4, 21, 'Tiradentes'], [5, 1, 'Dia do Trabalho'], [9, 7, 'Independência'],
        [10, 12, 'Nossa Senhora Aparecida'], [11, 2, 'Finados'], [11, 15, 'Proclamação da República'],
        [11, 20, 'Consciência Negra'], [12, 25, 'Natal'], [12, 31, 'Sem expediente bancário']
    ];
    for (const [m, d, n] of fixos) f.set(iso(ano, m, d), n);
    const p = pascoa(ano);
    f.set(somarDias(p, -48), 'Carnaval'); f.set(somarDias(p, -47), 'Carnaval');
    f.set(somarDias(p, -2), 'Sexta-feira Santa'); f.set(somarDias(p, 60), 'Corpus Christi');
    const c = String(cidade || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    if (/\bsao paulo\b/.test(c) && !/\b(sao paulo de|sp\s*-\s*interior)\b/.test(c)) f.set(iso(ano, 1, 25), 'Aniversário de São Paulo');
    if (/\bsao paulo\b|[\/\-,\s]sp\s*$/.test(c)) f.set(iso(ano, 7, 9), 'Revolução Constitucionalista');
    return f;
}

export class DiasUteis {
    private cache = new Map<number, Map<string, string>>();
    constructor(private cidade?: string) {}
    feriado(d: string): string | null {
        const a = Number(d.slice(0, 4));
        if (!this.cache.has(a)) this.cache.set(a, feriadosDoAno(a, this.cidade));
        return this.cache.get(a)!.get(d) || null;
    }
    util(d: string): boolean { const w = diaSemana(d); return w !== 0 && w !== 6 && !this.feriado(d); }
    proximo(d: string): string { while (!this.util(d)) d = somarDias(d, 1); return d; }
    anterior(d: string): string { while (!this.util(d)) d = somarDias(d, -1); return d; }
    /** n-ésimo dia útil do mês (YYYY-MM). */
    enesimo(mes: string, n: number): string {
        let d = mes + '-01', k = 0;
        for (;;) { if (this.util(d)) { k++; if (k >= n) return d; } const nd = somarDias(d, 1); if (nd.slice(0, 7) !== mes) return this.anterior(d); d = nd; }
    }
    /** Em que dia útil do mês cai a data (1 = primeiro); 0 se não é dia útil. */
    indice(d: string): number {
        if (!this.util(d)) return 0;
        let k = 0; for (let x = d.slice(0, 8) + '01'; x <= d; x = somarDias(x, 1)) if (this.util(x)) k++;
        return k;
    }
}

// ── Itens do calendário ──────────────────────────────────────────────────
export type Regra = { tipo: 'dia'; dia: number } | { tipo: 'util'; n: number };
export interface ItemCalendario {
    id: string;
    titulo: string;
    tipo: 'entrada' | 'saida';
    valor: number;
    regra: Regra;
    freq: 'mensal' | 'anual' | 'unica';
    mes?: number;                       // anual: mês do ano (1-12)
    data?: string;                      // única: YYYY-MM-DD
    origem: 'extrato' | 'cartao' | 'manual';
    categoria?: string;
    valoresPorMes?: Record<string, number>;   // cartão: valor previsto de cada fatura
    estimado?: boolean;
    ativo: boolean;
    detalhe?: string;                   // de onde veio ("visto em 3 meses no extrato")
}

export interface ConfigCalendario {
    saldoInicial: number | null;
    ajustes: Record<string, { valor?: number; regra?: Regra; ativo?: boolean; titulo?: string }>;
    extras: ItemCalendario[];
}

const CATEG_VARIAVEIS = new Set(['Supermercado', 'Alimentação', 'Delivery', 'Transporte', 'Combustível', 'Lazer', 'Viagem', 'Vestuário', 'Compras',
    'Cuidados pessoais', 'Pets', 'Farmácia', 'Saque', 'Pix Enviado', 'Pix Recebido', 'Transferência', 'Estorno', 'Encargos e juros', 'IOF', 'Investimento', 'Outros']);
const CATEG_FIXAS = new Set(['Moradia', 'Contas de consumo', 'Telecomunicações', 'Saúde', 'Educação', 'Assinaturas', 'Empréstimo e financiamento', 'Impostos', 'Automotivo', 'Tarifa bancária']);
const CATEG_RENDA = new Set(['Salário', 'Rendimento']);

const chaveDesc = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/\d{1,2}\/\d{1,2}(\/\d{2,4})?/g, ' ').replace(/[^A-Z ]+/g, ' ')
    .replace(/\b(PIX|TED|DOC|QRS|QR|TRANSF|TRANSFERENCIA|PAGTO|PAGAMENTO|PGTO|DEB|DEBITO|AUT|AUTOMATICO|CRED|CREDITO|BOLETO|ENVIADO|RECEBIDO|COMPRA|CARTAO)\b/g, ' ')
    .replace(/\s+/g, ' ').trim().split(' ').slice(0, 3).join(' ');
const mediana = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const nomeBonito = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim().replace(/(^|\s)\S/g, c => c.toUpperCase()).slice(0, 40);
const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/** Descobre o que se repete no extrato e o vencimento de cada cartão. */
export function detectarItens(lancamentos: Lancamento[], faturas: any[], du: DiasUteis): { itens: ItemCalendario[]; diaADia: number } {
    const doExtrato = lancamentos.filter(l => l.origem === 'extrato' && l.situacao === 'incluido' && l.categoria !== 'Pagamento de fatura' && l.alerta?.tipo !== 'possivel_duplicidade_fatura');
    const mesesExtrato = Array.from(new Set(doExtrato.map(l => l.data.slice(0, 7)))).sort();
    const nMeses = Math.max(1, mesesExtrato.length);
    const grupos = new Map<string, Lancamento[]>();
    for (const l of doExtrato) { const k = l.direcao + '|' + chaveDesc(l.descricao); if (!grupos.has(k)) grupos.set(k, []); grupos.get(k)!.push(l); }

    const itens: ItemCalendario[] = [];
    const usados = new Set<Lancamento>();
    for (const [k, ls] of grupos) {
        const dir = ls[0].direcao, cat = ls[0].categoria;
        if (CATEG_VARIAVEIS.has(cat)) continue;
        const porMes = new Map<string, Lancamento>();
        for (const l of ls) { const m = l.data.slice(0, 7), a = porMes.get(m); if (!a || l.valor > a.valor) porMes.set(m, l); }
        const occ = [...porMes.values()], dias = occ.map(l => Number(l.data.slice(8, 10))), vals = occ.map(l => l.valor);
        const repete = occ.length >= 2 && Math.max(...dias) - Math.min(...dias) <= 5 && Math.max(...vals) <= Math.min(...vals) * 1.6;
        const tipico = dir === 'entrada' ? CATEG_RENDA.has(cat) : CATEG_FIXAS.has(cat);
        if (!repete && !(tipico && (occ.length >= 2 || nMeses === 1))) continue;
        // salário no "n-ésimo dia útil": todas as datas caem no mesmo índice
        const idx = occ.map(l => du.indice(l.data.slice(0, 10)));
        const regra: Regra = dir === 'entrada' && occ.length >= 2 && idx[0] > 0 && idx[0] <= 10 && idx.every(i => i === idx[0]) && new Set(dias).size > 1
            ? { tipo: 'util', n: idx[0] } : { tipo: 'dia', dia: Math.round(mediana(dias)) };
        itens.push({
            id: 'ext-' + slug(dir + '-' + k.split('|')[1]), titulo: nomeBonito(k.split('|')[1] || ls[0].descricao), tipo: dir, valor: arred(mediana(vals)),
            regra, freq: 'mensal', origem: 'extrato', categoria: cat, ativo: true,
            detalhe: occ.length >= 2 ? `visto em ${occ.length} meses no extrato` : 'visto no extrato'
        });
        ls.forEach(l => usados.add(l));
    }
    // o que não se repete e é gasto do dia a dia vira um valor por dia (média do mês)
    const resto = doExtrato.filter(l => l.direcao === 'saida' && !usados.has(l) && l.situacao === 'incluido');
    const diaADia = arred(resto.reduce((s, l) => s + l.valor, 0) / nMeses / 30);

    // cartões: o vencimento de cada um, com o valor previsto de cada fatura
    const ultima = new Map<string, number>();
    faturas.forEach((f, i) => {
        if (!/^\d{4}-\d{2}-\d{2}/.test(f?.vencimento || '')) return;
        const ch = `${f.banco || ''}|${f.produto || ''}`, a = ultima.get(ch);
        if (a === undefined || faturas[a].vencimento < f.vencimento) ultima.set(ch, i);
    });
    for (const [ch, i] of ultima) {
        const f = faturas[i], M = f.vencimento.slice(0, 7);
        const daFatura = lancamentos.filter(l => l.origem === 'fatura' && l.documentoIndice === i && l.situacao === 'incluido' && l.direcao === 'saida');
        const avista = arred(daFatura.filter(l => !l.parcelaCartao).reduce((s, l) => s + l.valor, 0));
        const parcelas = daFatura.filter(l => l.parcelaCartao);
        const valoresPorMes: Record<string, number> = { [M]: arred(Number(f.valorTotal) || avista + parcelas.reduce((s, l) => s + l.valor, 0)) };
        for (let k = 1; k <= 24; k++) {
            const m = somarMeses(M, k);
            valoresPorMes[m] = arred(avista + parcelas.filter(l => (l.parcelasRestantes || 0) >= k).reduce((s, l) => s + l.valor, 0));
        }
        const prod = String(f.produto || '').trim(), banco = String(f.banco || '').trim();
        const nome = (prod && banco && prod.toLowerCase().includes(banco.toLowerCase()) ? prod : [banco, prod].filter(Boolean).join(' ')) || 'Cartão';
        const fech = /^\d{4}-\d{2}-\d{2}/.test(f.proximoFechamento || '') ? Number(f.proximoFechamento.slice(8, 10)) : null;
        itens.push({
            id: 'cartao-' + slug(ch), titulo: 'Fatura ' + nome.replace(/\s+/g, ' '), tipo: 'saida', valor: valoresPorMes[somarMeses(M, 1)] ?? valoresPorMes[M],
            regra: { tipo: 'dia', dia: Number(f.vencimento.slice(8, 10)) }, freq: 'mensal', origem: 'cartao', categoria: 'Cartão de crédito',
            valoresPorMes, estimado: true, ativo: true,
            detalhe: `vence todo dia ${Number(f.vencimento.slice(8, 10))}` + (fech ? ` · fecha dia ${fech} (melhor dia de compra: ${fech === 31 ? 1 : fech + 1})` : '') + ' · valor = parcelas do mês + média das compras à vista'
        });
    }
    return { itens, diaADia };
}

/** Aplica os ajustes da consultora e soma as contas que ela incluiu. */
export function aplicarConfig(itens: ItemCalendario[], cfg: ConfigCalendario | null | undefined): ItemCalendario[] {
    const aj = cfg?.ajustes || {};
    const out = itens.map(it => {
        const a = aj[it.id]; if (!a) return it;
        const n = { ...it, ...(a.titulo ? { titulo: a.titulo } : {}), ...(a.regra ? { regra: a.regra } : {}), ...(a.ativo === false ? { ativo: false } : {}) };
        if (a.valor != null) { n.valor = a.valor; n.valoresPorMes = undefined; n.estimado = false; }
        return n;
    });
    return [...out, ...(cfg?.extras || []).map(e => ({ ...e, origem: 'manual' as const }))];
}

// ── Projeção ─────────────────────────────────────────────────────────────
export interface EventoDia { id: string; titulo: string; tipo: 'entrada' | 'saida'; valor: number; original?: string; estimado?: boolean; origem: string }
export interface DiaCal { data: string; util: boolean; feriado: string | null; eventos: EventoDia[]; saldo: number }
export interface MesCal { mes: string; dias: DiaCal[]; entra: number; sai: number; diaADia: number; menor: { data: string; saldo: number } | null; negativos: number }

function dataNoMes(it: ItemCalendario, mes: string, du: DiasUteis): { data: string; original?: string } | null {
    const [a, m] = mes.split('-').map(Number);
    if (it.freq === 'anual' && it.mes !== m) return null;
    if (it.freq === 'unica' && (!it.data || it.data.slice(0, 7) !== mes)) return null;
    if (it.regra.tipo === 'util') return { data: du.enesimo(mes, it.regra.n) };
    const dia = it.freq === 'unica' && it.data ? Number(it.data.slice(8, 10)) : it.regra.dia;
    const d = iso(a, m, Math.min(dia, diasNoMes(a, m)));
    if (du.util(d)) return { data: d };
    let nd = it.tipo === 'entrada' ? du.anterior(d) : du.proximo(d);
    if (nd.slice(0, 7) !== mes) nd = it.tipo === 'entrada' ? du.proximo(d) : du.anterior(d);   // não troca de mês
    return { data: nd, original: d };
}

export function projetar(itens: ItemCalendario[], opts: { inicio: string; meses: number; saldoInicial: number; diaADia: number; cidade?: string; hoje?: string }): MesCal[] {
    const du = new DiasUteis(opts.cidade), out: MesCal[] = [];
    let saldo = opts.saldoInicial;
    const hoje = opts.hoje || '';
    for (let k = 0; k < opts.meses; k++) {
        const mes = somarMeses(opts.inicio, k), [a, m] = mes.split('-').map(Number), n = diasNoMes(a, m);
        const porDia = new Map<string, EventoDia[]>();
        for (const it of itens) {
            if (!it.ativo) continue;
            const q = dataNoMes(it, mes, du); if (!q) continue;
            const valor = it.valoresPorMes?.[mes] ?? it.valor;
            if (!(valor > 0)) continue;
            const ev: EventoDia = { id: it.id, titulo: it.titulo, tipo: it.tipo, valor: arred(valor), origem: it.origem, ...(q.original ? { original: q.original } : {}), ...(it.estimado ? { estimado: true } : {}) };
            if (!porDia.has(q.data)) porDia.set(q.data, []); porDia.get(q.data)!.push(ev);
        }
        const dias: DiaCal[] = []; let entra = 0, sai = 0, menor: MesCal['menor'] = null, negativos = 0;
        for (let d = 1; d <= n; d++) {
            const data = iso(a, m, d), evs = (porDia.get(data) || []).sort((x, y) => (x.tipo === 'entrada' ? -1 : 1) - (y.tipo === 'entrada' ? -1 : 1) || y.valor - x.valor);
            const conta = !hoje || data >= hoje;     // dias que já passaram não mexem no saldo
            if (conta) {
                for (const e of evs) { if (e.tipo === 'entrada') { saldo += e.valor; entra += e.valor; } else { saldo -= e.valor; sai += e.valor; } }
                saldo -= opts.diaADia;
            }
            saldo = arred(saldo);
            if (conta) { if (!menor || saldo < menor.saldo) menor = { data, saldo }; if (saldo < 0) negativos++; }
            dias.push({ data, util: du.util(data), feriado: du.feriado(data), eventos: evs, saldo });
        }
        out.push({ mes, dias, entra: arred(entra), sai: arred(sai), diaADia: opts.diaADia, menor, negativos });
    }
    return out;
}

export function normalizarConfig(v: any): ConfigCalendario {
    const num = (x: any) => { const n = Number(x); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; };
    const regra = (r: any): Regra | undefined => r?.tipo === 'util' && Number(r.n) >= 1 && Number(r.n) <= 23 ? { tipo: 'util', n: Math.round(r.n) }
        : r?.tipo === 'dia' && Number(r.dia) >= 1 && Number(r.dia) <= 31 ? { tipo: 'dia', dia: Math.round(r.dia) } : undefined;
    const ajustes: ConfigCalendario['ajustes'] = {};
    for (const [k, a] of Object.entries(v?.ajustes || {}).slice(0, 200) as [string, any][]) {
        if (!/^[\w-]{1,80}$/.test(k)) continue;
        const r = regra(a?.regra), val = a?.valor == null || a.valor === '' ? null : num(a.valor);
        ajustes[k] = { ...(r ? { regra: r } : {}), ...(val != null && val >= 0 ? { valor: val } : {}), ...(a?.ativo === false ? { ativo: false } : {}), ...(a?.titulo ? { titulo: String(a.titulo).trim().slice(0, 60) } : {}) };
    }
    const extras: ItemCalendario[] = (Array.isArray(v?.extras) ? v.extras : []).slice(0, 100).flatMap((e: any) => {
        const r = regra(e?.regra), val = num(e?.valor), titulo = String(e?.titulo || '').trim().slice(0, 60);
        const freq = ['mensal', 'anual', 'unica'].includes(e?.freq) ? e.freq : 'mensal';
        if (!r || val == null || val <= 0 || !titulo) return [];
        const data = /^\d{4}-\d{2}-\d{2}$/.test(String(e?.data || '')) ? String(e.data) : undefined;
        if (freq === 'unica' && !data) return [];
        return [{ id: /^man-[\w-]{1,40}$/.test(String(e?.id || '')) ? String(e.id) : 'man-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            titulo, tipo: e?.tipo === 'entrada' ? 'entrada' : 'saida', valor: val, regra: r, freq,
            ...(freq === 'anual' ? { mes: Math.min(12, Math.max(1, Math.round(Number(e?.mes) || 1))) } : {}), ...(data ? { data } : {}),
            origem: 'manual', ativo: e?.ativo !== false } as ItemCalendario];
    });
    const s = v?.saldoInicial == null || v.saldoInicial === '' ? null : num(v.saldoInicial);
    return { saldoInicial: s, ajustes, extras };
}

/** Tudo junto: itens (detectados + ajustes) e os meses projetados a partir do mês de hoje. */
export function montarCalendario(entrada: { lancamentos: Lancamento[]; faturas: any[]; ficha?: any; hoje?: string; meses?: number }) {
    const hoje = entrada.hoje || new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
    const cidade = entrada.ficha?.cidade || '';
    const du = new DiasUteis(cidade);
    const cfg = normalizarConfig(entrada.ficha?.calendario);
    const { itens: detectados, diaADia } = detectarItens(entrada.lancamentos, entrada.faturas, du);
    const itens = aplicarConfig(detectados, cfg);
    const inicio = hoje.slice(0, 7);
    const ateDezDoAnoQueVem = 12 - Number(inicio.slice(5, 7)) + 1 + 12;
    const meses = projetar(itens, { inicio, meses: entrada.meses || ateDezDoAnoQueVem, saldoInicial: cfg.saldoInicial ?? 0, diaADia, cidade, hoje });
    return { hoje, cidade, saldoInicial: cfg.saldoInicial, diaADia, itens, meses };
}
