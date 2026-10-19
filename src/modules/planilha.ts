// ══════════════════════════════════════════════════════════════════════════
// PLANILHA DA CONSULTORIA — preenche o MODELO DO CLIENTE (templates/
// planilha-base-consultoria.xlsx) com a apuração do Mirror.
//
// Regras combinadas com a consultoria:
//  • O modelo NÃO é alterado: só escrevemos em células VAZIAS das áreas de
//    lançamento. Fórmulas, cores, formatos e as demais abas ficam intactos
//    (inclusive o que parece erro no modelo — decisão da consultoria).
//  • O ANALISTA classifica cada lançamento da conta E cada compra à vista do
//    cartão (custo fixo, custo variável, investimento, entrada, cartão à vista
//    do mês ou fora da planilha). Nada é classificado sozinho; o que estiver
//    "a classificar" não vai para a planilha.
//  • Parcelas do cartão: o ANALISTA diz se são custo FIXO ou VARIÁVEL.
//    Fixo → "Cartão parcelado" (nome, prazo, valor), que o modelo soma em
//    "Cart. Cred. Fixo". Variável → "Cartão à vista do mês" (nome com a
//    parcela), que o modelo soma em "Cart. Cred. A vista" (custo variável);
//    assim a "Fatura paga" do mês continua completa. Entram no mês em que a
//    fatura é PAGA (vencimento) e são projetadas, no mesmo bloco, em todos os
//    meses seguintes até a última parcela. Sem escolha: ficam "a classificar"
//    e não entram (nem na projeção).
//  • O modelo tem abas Janeiro…Dezembro sem ano: elas ficam para o ano mais
//    recente com dado real. Meses de outros anos ganham abas novas, cópias
//    fiéis da aba do modelo ("Janeiro 2027"…), na ordem do calendário.
//  • TODOS os lançamentos aparecem, um por linha. Se o bloco do mês não
//    tiver linhas suficientes, a aba ganha linhas extras (inseridas no meio
//    dos blocos, com as fórmulas do modelo e do "Balanço Anual" ajustadas).
//  • Opcional: lançamentos com o MESMO nome, no mesmo mês e bloco, viram uma
//    linha só com a soma (ex.: "UBER *TRIP (10x)"); o comentário da célula
//    lista cada lançamento. O analista escolhe quais nomes juntar.
//  • Lançamentos ignorados ou "entre contas" não entram.
// ══════════════════════════════════════════════════════════════════════════
import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import { Classe, Lancamento, somarMeses } from './consolidacao';
import { inserirLinhas } from './planilha-linhas';

const ABAS_MES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const MES_CURTO = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const mesCurto = (k: string) => `${MES_CURTO[Number(k.slice(5, 7)) - 1]}/${k.slice(2, 4)}`;
const arred = (n: number) => Math.round(n * 100) / 100;

/** Áreas de lançamento do modelo (linhas inclusive). */
const BLOCOS = {
    fixo: { rotulo: 'A', valor: 'B', de: 3, ate: 30 },
    variavel: { rotulo: 'D', valor: 'E', de: 3, ate: 30 },
    investimento: { rotulo: 'G', valor: 'H', de: 3, ate: 30 },
    entrada: { rotulo: 'J', valor: 'K', de: 3, ate: 30 },
    cartaoVista: { rotulo: 'M', valor: 'N', de: 12, ate: 29 },
    cartaoParcelado: { rotulo: 'P', prazo: 'Q', valor: 'R', de: 4, ate: 27 }
} as const;

export function caminhoModelo(): string | null {
    const candidatos = [
        process.env.MIRROR_MODELO_PLANILHA,
        path.join(process.cwd(), 'templates', 'planilha-base-consultoria.xlsx'),
        path.join(__dirname, '..', '..', 'templates', 'planilha-base-consultoria.xlsx')
    ].filter(Boolean) as string[];
    return candidatos.find(p => fs.existsSync(p)) || null;
}

type ChaveBloco = keyof typeof BLOCOS;
type BlocoDef = { rotulo: string; valor: string; prazo?: string; de: number; ate: number };

/** Onde as linhas extras entram: antes da linha 27, que está DENTRO de todos os blocos do modelo. */
const LINHA_INSERCAO = 27;

interface Linha { rotulo: string; prazo?: string; valor: number; nota?: string; data?: string; grupo?: string }

export interface ResultadoPlanilha {
    buffer: Buffer;
    meses: string[];                 // YYYY-MM preenchidos com dados reais
    mesesProjetados: string[];       // YYYY-MM com parcelas projetadas
    abasCriadas: string[];           // abas de outros anos criadas a partir do modelo
    linhas: number;
    aClassificar: number;            // lançamentos de conta, no resumo, sem classificação
    aClassificarCartao: number;      // compras do cartão (à vista e parcelas), no resumo, sem classificação
    linhasExtras: { aba: string; quantidade: number }[];               // abas que ganharam linhas
    juntados: { aba: string; bloco: string; rotulo: string; quantidade: number; total: number }[];
    agrupados: { aba: string; bloco: string; quantidade: number }[];  // "Outros" (só se algo falhar)
    avisos: string[];
}

export interface OpcoesPlanilha {
    projetarParcelas?: boolean;
    cliente?: string;
    /** juntar lançamentos com o mesmo nome (no mesmo mês e bloco) numa linha só */
    juntar?: boolean;
    /** nomes (chave de grupo) que o analista NÃO quer juntar */
    naoJuntar?: string[];
}

const NOME_BLOCO: Record<ChaveBloco, string> = {
    fixo: 'Custo fixo', variavel: 'Custo variável', investimento: 'Investimentos', entrada: 'Entrada',
    cartaoVista: 'Cartão à vista do mês', cartaoParcelado: 'Cartão parcelado'
};
const BLOCO_DA_CLASSE: Record<Exclude<Classe, 'fora'>, ChaveBloco> = {
    fixo: 'fixo', variavel: 'variavel', investimento: 'investimento', entrada: 'entrada', cartao_vista: 'cartaoVista'
};

const vazia = (v: ExcelJS.CellValue) => v === null || v === undefined || v === '';
const brl = (n: number) => 'R$ ' + n.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');

/** Linhas livres de um bloco (as duas células vazias; ex.: B10 com fórmula fica de fora). */
function linhasLivres(ws: ExcelJS.Worksheet, colunas: string[], de: number, ate: number): number[] {
    const livres: number[] = [];
    for (let r = de; r <= ate; r++) {
        if (colunas.every(c => vazia(ws.getCell(`${c}${r}`).value))) livres.push(r);
    }
    return livres;
}
const colunasDo = (b: BlocoDef) => [b.rotulo, b.valor, ...(b.prazo ? [b.prazo] : [])];

/** Escreve as linhas no bloco. O excedente só vira "Outros" se, por algum motivo, faltar linha. */
function escrever(ws: ExcelJS.Worksheet, bloco: BlocoDef, linhas: Linha[], aba: string, nomeBloco: string, res: ResultadoPlanilha) {
    if (!linhas.length) return;
    const livres = linhasLivres(ws, colunasDo(bloco), bloco.de, bloco.ate);
    if (!livres.length) { res.avisos.push(`${aba}: não há linha livre no bloco "${nomeBloco}" (${linhas.length} lançamento(s) não entraram).`); return; }
    let usar = linhas;
    if (linhas.length > livres.length) {
        const cabem = livres.length - 1;
        const resto = linhas.slice(cabem);
        usar = [...linhas.slice(0, cabem), {
            rotulo: `Outros (${resto.length} lançamentos)`,
            valor: arred(resto.reduce((a, l) => a + l.valor, 0)),
            nota: resto.map(l => `${l.rotulo}: ${brl(l.valor)}`).join('\n').slice(0, 2000)
        }];
        res.agrupados.push({ aba, bloco: nomeBloco, quantidade: resto.length });
    }
    usar.forEach((l, i) => {
        const r = livres[i];
        const cRot = ws.getCell(`${bloco.rotulo}${r}`);
        cRot.value = l.rotulo.slice(0, 120);
        if (bloco.prazo && l.prazo) ws.getCell(`${bloco.prazo}${r}`).value = l.prazo;
        ws.getCell(`${bloco.valor}${r}`).value = arred(l.valor);
        if (l.nota) cRot.note = { texts: [{ text: l.nota }] } as any;
        res.linhas++;
    });
}

const dataBR = (iso: string) => /^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : iso;
const diaMes = (iso: string) => /^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : iso;

function notaDe(l: Lancamento): string {
    const portador = l.origem === 'fatura' ? (l.descricao.match(/\s+—\s+([^—]+)$/)?.[1] || '') : '';
    return [
        `Data: ${dataBR(l.data)}`,
        portador ? `Cartão de: ${portador}` : '',
        `Origem: ${l.origem === 'extrato' ? 'Conta ' + (l.banco || '') : l.documento}`,
        `Categoria: ${l.categoria}${l.subcategoria ? ' › ' + l.subcategoria : ''}`,
        l.observacao ? `Observação: ${l.observacao}` : ''
    ].filter(Boolean).join('\n');
}

// ─── Juntar lançamentos com o mesmo nome ─────────────────────────────────
/** Nome sem o portador do cartão ("UBER *TRIP — FULANO" → "UBER *TRIP"). */
export const nomeDoLancamento = (l: Pick<Lancamento, 'descricao' | 'origem'>) =>
    (l.origem === 'fatura' ? l.descricao.replace(/\s+—\s+[^—]+$/, '') : l.descricao).trim();

/**
 * Chave para reconhecer "o mesmo nome": maiúsculas, sem acento, sem números
 * (número de loja, de pedido) e sem pontuação. "MINI EXTRA-2044" e
 * "MINI EXTRA-2051" viram "MINI EXTRA"; "UBER *TRIP" e "UBER* TRIP" viram "UBER TRIP".
 */
export function chaveDeGrupo(nome: string): string {
    return nome.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
        .replace(/\d+/g, ' ').replace(/[^A-Z]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Bloco da planilha onde o lançamento entra (null = não entra). */
function blocoDe(l: Lancamento): ChaveBloco | null {
    if (l.situacao !== 'incluido') return null;
    if (!l.classe || l.classe === 'fora') return null;
    if (l.parcelaCartao) return l.classe === 'fixo' || l.classe === 'variavel' ? blocoDaParcela(l.classe) : null;
    return BLOCO_DA_CLASSE[l.classe];
}

/** Parcela de cartão: fixo → "Cartão parcelado" (custo fixo); variável → "Cartão à vista do mês" (custo variável). */
const blocoDaParcela = (classe: 'fixo' | 'variavel'): ChaveBloco => classe === 'fixo' ? 'cartaoParcelado' : 'cartaoVista';

/** Linha de uma parcela: no bloco parcelado o prazo tem coluna própria; no à vista vai junto do nome. */
function linhaDeParcela(bloco: ChaveBloco, nome: string, parcela: string, fim: string, valor: number, nota: string): Linha {
    const prazo = `${parcela} · até ${mesCurto(fim)}`;
    return bloco === 'cartaoParcelado'
        ? { rotulo: nome, prazo, valor, nota }
        : { rotulo: `${nome} (${parcela})`, valor, nota: nota + '\nParcela classificada como custo variável.' };
}

function linhaDe(l: Lancamento): Linha {
    // entrada soma o que entrou; os blocos de gasto somam o que saiu (estorno / devolução abate)
    const positivo = l.classe === 'entrada' ? l.direcao === 'entrada' : l.direcao === 'saida';
    const nome = nomeDoLancamento(l);
    return { rotulo: nome, valor: positivo ? l.valor : -l.valor, nota: notaDe(l), data: l.data, grupo: chaveDeGrupo(nome) || undefined };
}

function juntarLinhas(linhas: Linha[], naoJuntar: Set<string>, aba: string, nomeBloco: string, res: ResultadoPlanilha): Linha[] {
    const porGrupo = new Map<string, Linha[]>();
    for (const l of linhas) if (l.grupo && !naoJuntar.has(l.grupo)) {
        if (!porGrupo.has(l.grupo)) porGrupo.set(l.grupo, []);
        porGrupo.get(l.grupo)!.push(l);
    }
    const saida: Linha[] = [];
    const feitos = new Set<string>();
    for (const l of linhas) {
        const g = l.grupo && porGrupo.get(l.grupo);
        if (!g || g.length < 2) { saida.push(l); continue; }
        if (feitos.has(l.grupo!)) continue;
        feitos.add(l.grupo!);
        const total = arred(g.reduce((a, x) => a + x.valor, 0));
        // nome mais frequente entre os originais (sem portador) para o rótulo
        const nomes = g.map(x => x.rotulo);
        const nome = nomes.slice().sort((a, b) => nomes.filter(x => x === b).length - nomes.filter(x => x === a).length)[0];
        saida.push({
            // contagem na frente: a coluna do modelo é estreita e corta o fim do texto
            rotulo: `${g.length}x ${nome}`,
            valor: total,
            data: l.data,
            nota: [`${g.length} lançamentos somados nesta linha:`,
                ...g.map(x => `${diaMes(x.data || '')}  ${brl(x.valor)}  ${x.rotulo}`),
                `Total: ${brl(total)}`].join('\n').slice(0, 3000)
        });
        res.juntados.push({ aba, bloco: nomeBloco, rotulo: nome, quantidade: g.length, total });
    }
    return saida;
}

export interface GrupoPlanilha {
    chave: string;
    nome: string;
    quantidade: number;
    total: number;
    meses: string[];
    itens: { id: string; data: string; descricao: string; valor: number; mes: string; bloco: string }[];
}

/** Grupos que PODEM ser juntados (mesmo nome, mesmo mês, mesmo bloco, 2+ lançamentos) — para o analista escolher. */
export function listarGrupos(lancamentos: Lancamento[]): GrupoPlanilha[] {
    const porChave = new Map<string, Lancamento[]>();
    for (const l of lancamentos) {
        const b = blocoDe(l);
        if (!b || b === 'cartaoParcelado' || l.parcelaCartao) continue;   // parcela: sempre uma linha, com o prazo
        const chave = chaveDeGrupo(nomeDoLancamento(l));
        if (!chave) continue;
        const k = `${chave}|${l.mesReferencia}|${b}`;
        if (!porChave.has(k)) porChave.set(k, []);
        porChave.get(k)!.push(l);
    }
    const grupos = new Map<string, GrupoPlanilha>();
    for (const [k, ls] of porChave) {
        if (ls.length < 2) continue;
        const chave = k.split('|')[0];
        const g = grupos.get(chave) || { chave, nome: nomeDoLancamento(ls[0]), quantidade: 0, total: 0, meses: [], itens: [] };
        for (const l of ls) {
            const v = linhaDe(l).valor;
            g.itens.push({ id: l.id, data: l.data, descricao: l.descricao, valor: v, mes: l.mesReferencia, bloco: NOME_BLOCO[blocoDe(l)!] });
            g.quantidade++; g.total = arred(g.total + v);
        }
        if (!g.meses.includes(ls[0].mesReferencia)) g.meses.push(ls[0].mesReferencia);
        grupos.set(chave, g);
    }
    return Array.from(grupos.values()).map(g => ({ ...g, meses: g.meses.sort() })).sort((a, b) => b.quantidade - a.quantidade || b.total - a.total);
}

/** Nome da aba de um mês: o ano-base usa as abas do modelo ("Agosto"); os outros anos ganham abas novas ("Janeiro 2027"). */
const nomeAbaDe = (mes: string, anoBase: string) => {
    const nome = ABAS_MES[Number(mes.slice(5, 7)) - 1];
    return mes.slice(0, 4) === anoBase ? nome : `${nome} ${mes.slice(0, 4)}`;
};

export async function gerarPlanilhaConsultoria(
    lancamentos: Lancamento[],
    parcelamentos: { itens: any[]; porMes: { mes: string }[]; mesFaturaAtual: string | null } | undefined,
    opcoes: OpcoesPlanilha = {}
): Promise<ResultadoPlanilha> {
    const modelo = caminhoModelo();
    if (!modelo) throw new Error('Modelo da planilha da consultoria não encontrado no servidor (templates/planilha-base-consultoria.xlsx).');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(modelo);
    // Cópia limpa do modelo: é dela que saem as abas novas dos outros anos.
    const limpo = new ExcelJS.Workbook();
    await limpo.xlsx.readFile(modelo);

    const res: ResultadoPlanilha = {
        buffer: Buffer.alloc(0), meses: [], mesesProjetados: [], abasCriadas: [], linhas: 0, aClassificar: 0, aClassificarCartao: 0,
        linhasExtras: [], juntados: [], agrupados: [], avisos: []
    };

    const noResumo = lancamentos.filter(l => l.situacao === 'incluido');
    const pendentes = noResumo.filter(l => !l.classe);
    res.aClassificar = pendentes.filter(l => l.origem === 'extrato').length;
    res.aClassificarCartao = pendentes.filter(l => l.origem === 'fatura').length;

    const mesesReais = Array.from(new Set(noResumo.map(l => l.mesReferencia).filter(m => /^\d{4}-\d{2}$/.test(m)))).sort();
    const anoBase = (mesesReais[mesesReais.length - 1] || parcelamentos?.mesFaturaAtual || new Date().toISOString()).slice(0, 4);

    /** Aba do mês; se for de outro ano e ainda não existir, cria uma cópia fiel da aba do modelo. */
    const abaDoMes = (mes: string): { ws: ExcelJS.Worksheet; nome: string } | null => {
        const nome = nomeAbaDe(mes, anoBase);
        const existente = wb.getWorksheet(nome);
        if (existente) return { ws: existente, nome };
        const origem = limpo.getWorksheet(ABAS_MES[Number(mes.slice(5, 7)) - 1]);
        if (!origem) { res.avisos.push(`Aba "${ABAS_MES[Number(mes.slice(5, 7)) - 1]}" não existe no modelo.`); return null; }
        const ws = wb.addWorksheet(nome);
        const copia = structuredClone(origem.model) as any;
        copia.views = (copia.views || []).map((v: any) => ({ ...v, tabSelected: false }));
        copia.mergeCells = copia.merges;   // o ExcelJS reconstrói as mescladas a partir de "mergeCells"
        ws.model = { ...copia, name: nome, id: ws.id, orderNo: (ws as any).orderNo };
        res.abasCriadas.push(nome);
        return { ws, nome };
    };

    // ── 1) Junta tudo o que vai para cada aba, bloco por bloco
    const fila = new Map<string, { ws: ExcelJS.Worksheet; blocos: Partial<Record<ChaveBloco, Linha[]>> }>();
    const enfileirar = (mes: string, bloco: ChaveBloco, linhas: Linha[]) => {
        if (!linhas.length) return;
        const aba = abaDoMes(mes);
        if (!aba) return;
        if (!fila.has(aba.nome)) fila.set(aba.nome, { ws: aba.ws, blocos: {} });
        const f = fila.get(aba.nome)!;
        (f.blocos[bloco] ||= []).push(...linhas);
    };

    for (const mes of mesesReais) {
        const doMes = noResumo.filter(l => l.mesReferencia === mes).sort((a, b) => a.data.localeCompare(b.data));
        const porBloco: Partial<Record<ChaveBloco, Linha[]>> = {};
        for (const l of doMes) {
            const b = blocoDe(l);
            if (!b) continue;
            const linha: Linha = l.parcelaCartao ? linhaDeParcela(b, nomeDoLancamento(l), l.parcela!, l.parcelaFim!, l.valor,
                notaDe(l) + `\n1ª parcela: ${mesCurto(l.parcelaInicio!)} · última: ${mesCurto(l.parcelaFim!)}`) : linhaDe(l);
            (porBloco[b] ||= []).push(linha);
        }
        for (const [b, ls] of Object.entries(porBloco)) enfileirar(mes, b as ChaveBloco, ls!);
        res.meses.push(mes);
    }

    // Projeção: cada parcela já comprada vai para TODOS os meses seguintes até a última.
    // Vai para o mesmo bloco que o analista escolheu (fixo ou variável); sem escolha, não projeta.
    if (opcoes.projetarParcelas !== false && parcelamentos?.itens?.length) {
        const classeDe = new Map(lancamentos.map(l => [l.id, l.classe]));
        const porMes = new Map<string, Partial<Record<ChaveBloco, Linha[]>>>();
        for (const p of parcelamentos.itens) {
            const classe = classeDe.get(p.id);
            if (classe !== 'fixo' && classe !== 'variavel') continue;
            const bloco = blocoDaParcela(classe);
            const mesDaFatura = somarMeses(p.inicio, p.parcelaAtual - 1);   // fatura de onde a parcela foi lida
            for (let k = 1; ; k++) {
                const mes = somarMeses(mesDaFatura, k);
                if (mes > p.fim || k > 600) break;
                const doMes = porMes.get(mes) || {};
                porMes.set(mes, doMes);
                (doMes[bloco] ||= []).push(linhaDeParcela(bloco, p.descricao, `${p.parcelaAtual + k}/${p.parcelaTotal}`, p.fim, p.valorParcela,
                    `Projeção: parcela de compra já feita (lida na fatura de ${mesCurto(mesDaFatura)}).\n1ª parcela: ${mesCurto(p.inicio)} · última: ${mesCurto(p.fim)}`));
            }
        }
        for (const mes of Array.from(porMes.keys()).sort()) {
            for (const [b, ls] of Object.entries(porMes.get(mes)!)) enfileirar(mes, b as ChaveBloco, ls!);
            res.mesesProjetados.push(mes);
        }
    }

    // ── 2) Por aba: junta nomes iguais, abre as linhas que faltarem e escreve
    const naoJuntar = new Set(opcoes.naoJuntar || []);
    for (const [nome, { ws, blocos }] of fila) {
        if (opcoes.juntar) {
            for (const b of Object.keys(blocos) as ChaveBloco[]) {
                if (b !== 'cartaoParcelado') blocos[b] = juntarLinhas(blocos[b]!, naoJuntar, nome, NOME_BLOCO[b], res);
            }
        }
        let extra = 0;
        for (const b of Object.keys(blocos) as ChaveBloco[]) {
            const def = BLOCOS[b] as BlocoDef;
            const livres = linhasLivres(ws, colunasDo(def), def.de, def.ate).length;
            extra = Math.max(extra, blocos[b]!.length - livres);
        }
        if (extra > 0) {
            inserirLinhas(wb, ws, LINHA_INSERCAO, extra);
            res.linhasExtras.push({ aba: nome, quantidade: extra });
        }
        for (const b of Object.keys(BLOCOS) as ChaveBloco[]) {
            const ls = blocos[b];
            if (!ls?.length) continue;
            const def = { ...(BLOCOS[b] as BlocoDef), ate: BLOCOS[b].ate + Math.max(0, extra) };
            escrever(ws, def, ls, nome, NOME_BLOCO[b], res);
        }
    }

    // ── Ordem das abas: as do modelo que não são de mês ficam na frente; depois os
    // meses em ordem cronológica (ex.: … Dezembro, Janeiro 2027, Fevereiro 2027).
    if (res.abasCriadas.length) {
        const chave = (nome: string): number | null => {
            const m = nome.match(/^(\S+)(?: (\d{4}))?$/);
            const i = m ? ABAS_MES.indexOf(m[1]) : -1;
            return i < 0 ? null : Number(m![2] || anoBase) * 12 + i;
        };
        const todas = wb.worksheets.slice();
        const fixas = todas.filter(ws => chave(ws.name) === null);
        const meses = todas.filter(ws => chave(ws.name) !== null).sort((a, b) => chave(a.name)! - chave(b.name)!);
        [...fixas, ...meses].forEach((ws, i) => { (ws as any).orderNo = i; });
        res.avisos.push(`Abas novas criadas a partir do modelo: ${res.abasCriadas.join(', ')}. A aba "Balanço Anual" continua somando só as 12 abas originais.`);
    }

    if (!res.meses.length) res.avisos.push('Nenhum lançamento no resumo para levar à planilha.');
    // Os resultados guardados das fórmulas são do modelo vazio: pede ao Excel /
    // LibreOffice / Google Sheets para recalcular tudo ao abrir.
    wb.calcProperties = { ...(wb.calcProperties || {}), fullCalcOnLoad: true } as any;
    res.buffer = Buffer.from(await wb.xlsx.writeBuffer());
    return res;
}
