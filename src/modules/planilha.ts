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
//  • Parcelas do cartão vão SOZINHAS para "Cartão parcelado" (nome, prazo,
//    valor) no mês em que a fatura é PAGA (vencimento), e são projetadas em
//    todos os meses seguintes até a última parcela. As fórmulas do modelo levam
//    esses totais para custo fixo e custo variável.
//  • O modelo tem abas Janeiro…Dezembro sem ano: elas ficam para o ano mais
//    recente com dado real. Meses de outros anos ganham abas novas, cópias
//    fiéis da aba do modelo ("Janeiro 2027"…), na ordem do calendário.
//  • Um lançamento por linha. Se não couber, a última linha livre vira
//    "Outros (n lançamentos)" com a soma do restante.
//  • Lançamentos ignorados ou "entre contas" não entram.
// ══════════════════════════════════════════════════════════════════════════
import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import { Classe, Lancamento, somarMeses } from './consolidacao';

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

interface Linha { rotulo: string; prazo?: string; valor: number; nota?: string }

export interface ResultadoPlanilha {
    buffer: Buffer;
    meses: string[];                 // YYYY-MM preenchidos com dados reais
    mesesProjetados: string[];       // YYYY-MM com parcelas projetadas
    abasCriadas: string[];           // abas de outros anos criadas a partir do modelo
    linhas: number;
    aClassificar: number;            // lançamentos de conta, no resumo, sem classificação
    aClassificarCartao: number;      // compras à vista do cartão, no resumo, sem classificação
    agrupados: { aba: string; bloco: string; quantidade: number }[];
    avisos: string[];
}

const vazia = (v: ExcelJS.CellValue) => v === null || v === undefined || v === '';

/** Linhas livres de um bloco (as duas células vazias; ex.: B10 com fórmula fica de fora). */
function linhasLivres(ws: ExcelJS.Worksheet, colunas: string[], de: number, ate: number): number[] {
    const livres: number[] = [];
    for (let r = de; r <= ate; r++) {
        if (colunas.every(c => vazia(ws.getCell(`${c}${r}`).value))) livres.push(r);
    }
    return livres;
}

/** Escreve as linhas no bloco; o excedente vira "Outros (n lançamentos)". */
function escrever(ws: ExcelJS.Worksheet, bloco: { rotulo: string; valor: string; prazo?: string; de: number; ate: number },
    linhas: Linha[], aba: string, nomeBloco: string, res: ResultadoPlanilha) {
    if (!linhas.length) return;
    const cols = [bloco.rotulo, bloco.valor, ...(bloco.prazo ? [bloco.prazo] : [])];
    const livres = linhasLivres(ws, cols, bloco.de, bloco.ate);
    if (!livres.length) { res.avisos.push(`${aba}: não há linha livre no bloco "${nomeBloco}" (${linhas.length} lançamento(s) não entraram).`); return; }
    let usar = linhas;
    if (linhas.length > livres.length) {
        const cabem = livres.length - 1;
        const resto = linhas.slice(cabem);
        usar = [...linhas.slice(0, cabem), {
            rotulo: `Outros (${resto.length} lançamentos)`,
            valor: arred(resto.reduce((a, l) => a + l.valor, 0)),
            nota: resto.map(l => `${l.rotulo}: R$ ${l.valor.toFixed(2).replace('.', ',')}`).join('\n').slice(0, 2000)
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

function notaDe(l: Lancamento): string {
    return [
        `Data: ${dataBR(l.data)}`,
        `Origem: ${l.origem === 'extrato' ? 'Conta ' + (l.banco || '') : l.documento}`,
        `Categoria: ${l.categoria}${l.subcategoria ? ' › ' + l.subcategoria : ''}`,
        l.observacao ? `Observação: ${l.observacao}` : ''
    ].filter(Boolean).join('\n');
}

/** Nome da aba de um mês: o ano-base usa as abas do modelo ("Agosto"); os outros anos ganham abas novas ("Janeiro 2027"). */
const nomeAbaDe = (mes: string, anoBase: string) => {
    const nome = ABAS_MES[Number(mes.slice(5, 7)) - 1];
    return mes.slice(0, 4) === anoBase ? nome : `${nome} ${mes.slice(0, 4)}`;
};

export async function gerarPlanilhaConsultoria(
    lancamentos: Lancamento[],
    parcelamentos: { itens: any[]; porMes: { mes: string }[]; mesFaturaAtual: string | null } | undefined,
    opcoes: { projetarParcelas?: boolean; cliente?: string } = {}
): Promise<ResultadoPlanilha> {
    const modelo = caminhoModelo();
    if (!modelo) throw new Error('Modelo da planilha da consultoria não encontrado no servidor (templates/planilha-base-consultoria.xlsx).');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(modelo);
    // Cópia limpa do modelo: é dela que saem as abas novas dos outros anos.
    const limpo = new ExcelJS.Workbook();
    await limpo.xlsx.readFile(modelo);

    const res: ResultadoPlanilha = { buffer: Buffer.alloc(0), meses: [], mesesProjetados: [], abasCriadas: [], linhas: 0, aClassificar: 0, aClassificarCartao: 0, agrupados: [], avisos: [] };

    const noResumo = lancamentos.filter(l => l.situacao === 'incluido');
    const pendentes = noResumo.filter(l => !l.parceladoAutomatico && !l.classe);
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
        ws.model = { ...copia, name: nome, id: ws.id, orderNo: (ws as any).orderNo };
        res.abasCriadas.push(nome);
        return { ws, nome };
    };

    // ── Meses com dado real
    for (const mes of mesesReais) {
        const aba = abaDoMes(mes);
        if (!aba) continue;
        const { ws, nome } = aba;
        const doMes = noResumo.filter(l => l.mesReferencia === mes).sort((a, b) => a.data.localeCompare(b.data));

        // Extrato e compras à vista do cartão: onde o ANALISTA mandou
        const porClasse: Record<Exclude<Classe, 'fora'>, Linha[]> = { fixo: [], variavel: [], investimento: [], entrada: [], cartao_vista: [] };
        for (const l of doMes) {
            if (l.parceladoAutomatico || !l.classe || l.classe === 'fora') continue;
            // entrada soma o que entrou; os blocos de gasto somam o que saiu (estorno / devolução abate)
            const positivo = l.classe === 'entrada' ? l.direcao === 'entrada' : l.direcao === 'saida';
            porClasse[l.classe].push({ rotulo: l.descricao, valor: positivo ? l.valor : -l.valor, nota: notaDe(l) });
        }
        escrever(ws, BLOCOS.fixo, porClasse.fixo, nome, 'Custo fixo', res);
        escrever(ws, BLOCOS.variavel, porClasse.variavel, nome, 'Custo variável', res);
        escrever(ws, BLOCOS.investimento, porClasse.investimento, nome, 'Investimentos', res);
        escrever(ws, BLOCOS.entrada, porClasse.entrada, nome, 'Entrada', res);
        escrever(ws, BLOCOS.cartaoVista, porClasse.cartao_vista, nome, 'Cartão à vista do mês', res);

        // Parcelas da fatura paga neste mês: automático
        escrever(ws, BLOCOS.cartaoParcelado, doMes.filter(l => l.parceladoAutomatico).map(l => ({
            rotulo: l.descricao,
            prazo: `${l.parcela} · até ${mesCurto(l.parcelaFim!)}`,
            valor: l.valor,
            nota: notaDe(l) + `\n1ª parcela: ${mesCurto(l.parcelaInicio!)} · última: ${mesCurto(l.parcelaFim!)}`
        })), nome, 'Cartão parcelado', res);

        res.meses.push(mes);
    }

    // ── Projeção: cada parcela já comprada vai para TODOS os meses seguintes até a
    // última — criando as abas dos anos seguintes quando passar de dezembro.
    if (opcoes.projetarParcelas !== false && parcelamentos?.itens?.length) {
        const porMes = new Map<string, Linha[]>();
        for (const p of parcelamentos.itens) {
            const mesDaFatura = somarMeses(p.inicio, p.parcelaAtual - 1);   // fatura de onde a parcela foi lida
            for (let k = 1; ; k++) {
                const mes = somarMeses(mesDaFatura, k);
                if (mes > p.fim || k > 600) break;
                if (!porMes.has(mes)) porMes.set(mes, []);
                porMes.get(mes)!.push({
                    rotulo: p.descricao,
                    prazo: `${p.parcelaAtual + k}/${p.parcelaTotal} · até ${mesCurto(p.fim)}`,
                    valor: p.valorParcela,
                    nota: `Projeção: parcela de compra já feita (lida na fatura de ${mesCurto(mesDaFatura)}).\n1ª parcela: ${mesCurto(p.inicio)} · última: ${mesCurto(p.fim)}`
                });
            }
        }
        for (const mes of Array.from(porMes.keys()).sort()) {
            const aba = abaDoMes(mes);
            if (!aba) continue;
            escrever(aba.ws, BLOCOS.cartaoParcelado, porMes.get(mes)!, aba.nome, 'Cartão parcelado (projeção)', res);
            res.mesesProjetados.push(mes);
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
