// ══════════════════════════════════════════════════════════════════════════
// PLANILHA DA CONSULTORIA — preenche o MODELO DO CLIENTE (templates/
// planilha-base-consultoria.xlsx) com a apuração do Mirror.
//
// Regras combinadas com a consultoria:
//  • O modelo NÃO é alterado: só escrevemos em células VAZIAS das áreas de
//    lançamento. Fórmulas, cores, formatos e as demais abas ficam intactos
//    (inclusive o que parece erro no modelo — decisão da consultoria).
//  • Extrato: o ANALISTA classifica cada lançamento (custo fixo, custo
//    variável, investimento, entrada ou fora da planilha). Nada é classificado
//    sozinho; o que estiver "a classificar" não vai para a planilha.
//  • Cartão: vai sozinho para os blocos do modelo — "Cartão parcelado"
//    (nome, prazo, valor) e "Cartão à vista do mês" — no mês em que a fatura
//    é PAGA (vencimento). As fórmulas do modelo levam esses totais para
//    custo fixo e custo variável.
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
    linhas: number;
    aClassificar: number;            // lançamentos de conta, no resumo, sem classificação
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

export async function gerarPlanilhaConsultoria(
    lancamentos: Lancamento[],
    parcelamentos: { itens: any[]; porMes: { mes: string }[]; mesFaturaAtual: string | null } | undefined,
    opcoes: { projetarParcelas?: boolean; cliente?: string } = {}
): Promise<ResultadoPlanilha> {
    const modelo = caminhoModelo();
    if (!modelo) throw new Error('Modelo da planilha da consultoria não encontrado no servidor (templates/planilha-base-consultoria.xlsx).');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(modelo);

    const res: ResultadoPlanilha = { buffer: Buffer.alloc(0), meses: [], mesesProjetados: [], linhas: 0, aClassificar: 0, agrupados: [], avisos: [] };

    const noResumo = lancamentos.filter(l => l.situacao === 'incluido');
    res.aClassificar = noResumo.filter(l => l.origem === 'extrato' && !l.classe).length;

    // Meses com dado real. O modelo tem uma aba por mês SEM ano: se o período passar
    // de 12 meses, o mesmo mês apareceria duas vezes — fica o ano mais recente.
    const mesesTodos = Array.from(new Set(noResumo.map(l => l.mesReferencia).filter(m => /^\d{4}-\d{2}$/.test(m)))).sort();
    const porAba = new Map<string, string>();
    for (const m of mesesTodos) {
        const aba = ABAS_MES[Number(m.slice(5, 7)) - 1];
        const antes = porAba.get(aba);
        if (antes && antes !== m) res.avisos.push(`${aba} aparece em ${antes.slice(0, 4)} e ${m.slice(0, 4)}: o modelo tem uma aba por mês, então ficou só ${m.slice(0, 4)}.`);
        porAba.set(aba, m);
    }

    for (const [aba, mes] of porAba) {
        const ws = wb.getWorksheet(aba);
        if (!ws) { res.avisos.push(`Aba "${aba}" não existe no modelo.`); continue; }
        const doMes = noResumo.filter(l => l.mesReferencia === mes).sort((a, b) => a.data.localeCompare(b.data));

        // ── Extrato: classificado pelo analista
        const porClasse: Record<Exclude<Classe, 'fora'>, Linha[]> = { fixo: [], variavel: [], investimento: [], entrada: [] };
        for (const l of doMes) {
            if (l.origem !== 'extrato' || !l.classe || l.classe === 'fora') continue;
            const positivo = l.classe === 'entrada' ? l.direcao === 'entrada' : l.direcao === 'saida';
            porClasse[l.classe].push({ rotulo: l.descricao, valor: positivo ? l.valor : -l.valor, nota: notaDe(l) });
        }
        escrever(ws, BLOCOS.fixo, porClasse.fixo, aba, 'Custo fixo', res);
        escrever(ws, BLOCOS.variavel, porClasse.variavel, aba, 'Custo variável', res);
        escrever(ws, BLOCOS.investimento, porClasse.investimento, aba, 'Investimentos', res);
        escrever(ws, BLOCOS.entrada, porClasse.entrada, aba, 'Entrada', res);

        // ── Cartão: fatura paga neste mês
        const cartao = doMes.filter(l => l.origem === 'fatura');
        const parcelado = cartao.filter(l => l.parcelaFim && l.direcao === 'saida');
        const vista = cartao.filter(l => !(l.parcelaFim && l.direcao === 'saida'));
        escrever(ws, BLOCOS.cartaoParcelado, parcelado.map(l => ({
            rotulo: l.descricao,
            prazo: `${l.parcela} · até ${mesCurto(l.parcelaFim!)}`,
            valor: l.valor,
            nota: notaDe(l) + `\n1ª parcela: ${mesCurto(l.parcelaInicio!)} · última: ${mesCurto(l.parcelaFim!)}`
        })), aba, 'Cartão parcelado', res);
        escrever(ws, BLOCOS.cartaoVista, vista.map(l => ({
            rotulo: l.descricao,
            valor: l.direcao === 'saida' ? l.valor : -l.valor,   // estorno abate
            nota: notaDe(l)
        })), aba, 'Cartão à vista do mês', res);

        res.meses.push(mes);
    }

    // ── Projeção: parcelas já compradas que vão cair nos meses seguintes
    if (opcoes.projetarParcelas && parcelamentos?.mesFaturaAtual && parcelamentos.itens?.length) {
        const mesAtual: string = parcelamentos.mesFaturaAtual;
        const usadas = new Set(porAba.keys());
        const ultimoReal = res.meses.slice().sort().pop() || mesAtual;
        for (let i = 1; i <= 11; i++) {
            const mes = somarMeses(mesAtual, i);
            if (mes <= ultimoReal) continue;
            // O modelo é de UM ano (abas sem ano): não projeta além de dezembro,
            // senão parcelas do ano seguinte cairiam em janeiro, fevereiro… do mesmo arquivo.
            if (mes.slice(0, 4) !== ultimoReal.slice(0, 4)) {
                res.avisos.push(`Projeção parou em dezembro/${ultimoReal.slice(0, 4)}: as parcelas de ${mes.slice(0, 4)} em diante não cabem neste modelo anual.`);
                break;
            }
            const aba = ABAS_MES[Number(mes.slice(5, 7)) - 1];
            if (usadas.has(aba)) break;                         // daria a volta no ano
            const caem = parcelamentos.itens.filter((p: any) => p.inicio <= mes && mes <= p.fim);
            if (!caem.length) break;
            const ws = wb.getWorksheet(aba);
            if (!ws) continue;
            const desloc = i;
            escrever(ws, BLOCOS.cartaoParcelado, caem.map((p: any) => ({
                rotulo: p.descricao,
                prazo: `${p.parcelaAtual + desloc}/${p.parcelaTotal} · até ${mesCurto(p.fim)}`,
                valor: p.valorParcela,
                nota: `Projeção: parcela de compra já feita (fatura de ${mesCurto(mesAtual)}).`
            })), aba, 'Cartão parcelado (projeção)', res);
            usadas.add(aba);
            res.mesesProjetados.push(mes);
        }
    }

    if (!res.meses.length) res.avisos.push('Nenhum lançamento no resumo para levar à planilha.');
    // Os resultados guardados das fórmulas são do modelo vazio: pede ao Excel /
    // LibreOffice / Google Sheets para recalcular tudo ao abrir.
    wb.calcProperties = { ...(wb.calcProperties || {}), fullCalcOnLoad: true } as any;
    res.buffer = Buffer.from(await wb.xlsx.writeBuffer());
    return res;
}
