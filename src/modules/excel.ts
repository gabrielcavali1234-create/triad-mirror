// ══════════════════════════════════════════════════════════════════════════
// EXPORTAÇÃO PARA EXCEL — gera um .xlsx com:
//   • Resumo          — indicadores + gastos por categoria
//   • Lançamentos     — visão consolidada (extratos + faturas), com a coluna
//                       "No resumo" refletindo o que o analista incluiu/excluiu
//   • Fatura N …      — resumo da fatura, conferência e todos os lançamentos
//   • Extrato N …     — todos os lançamentos, com entradas e saídas separadas
// Valores saem como NÚMERO (formato R$) e datas como DATA, para o analista
// conseguir filtrar, somar e montar tabela dinâmica direto no Excel.
// ══════════════════════════════════════════════════════════════════════════
import ExcelJS from 'exceljs';
import { consolidar, EntradaConsolidacao, Lancamento, Situacao } from './consolidacao';
import { ResultadoExtrato } from './extrato';
import { ResultadoFatura, TIPOS_DEBITO_FATURA } from './fatura';

const PRETO = 'FF111111';
const AMARELO = 'FFFFD23F';
const CINZA = 'FFF6F5F0';
const FMT_BRL = '"R$" #,##0.00;[Red]-"R$" #,##0.00';
const FMT_DATA = 'dd/mm/yyyy';
const FMT_PCT = '0.0%';

function paraData(iso?: string): Date | string {
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || '';
    const [a, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(a, m - 1, d));
}

/** Nome de aba válido no Excel: até 31 caracteres, sem []:*?/\ e sem repetir. */
function nomeAba(base: string, usados: Set<string>): string {
    let nome = base.replace(/[\[\]:*?/\\]/g, ' ').trim().slice(0, 31);
    let n = 2;
    while (usados.has(nome.toLowerCase())) nome = `${base.slice(0, 27)} (${n++})`;
    usados.add(nome.toLowerCase());
    return nome;
}

function titulo(ws: ExcelJS.Worksheet, texto: string, colunas: number) {
    const linha = ws.addRow([texto]);
    ws.mergeCells(linha.number, 1, linha.number, colunas);
    linha.height = 26;
    linha.getCell(1).font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
    linha.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PRETO } };
    linha.getCell(1).alignment = { vertical: 'middle', indent: 1 };
}

function cabecalho(ws: ExcelJS.Worksheet, nomes: string[]): ExcelJS.Row {
    const linha = ws.addRow(nomes);
    linha.eachCell(c => {
        c.font = { bold: true, color: { argb: PRETO } };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: AMARELO } };
        c.border = { bottom: { style: 'medium', color: { argb: PRETO } } };
        c.alignment = { vertical: 'middle', wrapText: true };
    });
    linha.height = 20;
    return linha;
}

/** Bloco "rótulo | valor" (ex: dados da fatura). */
function blocoInfo(ws: ExcelJS.Worksheet, itens: [string, any, string?][]) {
    for (const [rotulo, valor, formato] of itens) {
        if (valor === undefined || valor === null || valor === '') continue;
        const l = ws.addRow([rotulo, valor]);
        l.getCell(1).font = { bold: true };
        l.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CINZA } };
        if (formato) l.getCell(2).numFmt = formato;
        l.getCell(2).alignment = { horizontal: 'left' };
    }
}

/** Linha de TOTAL com fórmula SUM (e o resultado já calculado, para quem abrir sem recalcular). */
function linhaTotal(ws: ExcelJS.Worksheet, primeira: number, ultima: number, colunasSoma: number[], valores: number[], rotuloCol = 1) {
    const linha = ws.addRow([]);
    linha.getCell(rotuloCol).value = 'TOTAL';
    colunasSoma.forEach((col, i) => {
        const letra = ws.getColumn(col).letter;
        linha.getCell(col).value = ultima >= primeira
            ? { formula: `SUM(${letra}${primeira}:${letra}${ultima})`, result: valores[i] }
            : 0;
        linha.getCell(col).numFmt = FMT_BRL;
    });
    linha.eachCell(c => {
        c.font = { bold: true };
        c.border = { top: { style: 'medium', color: { argb: PRETO } } };
    });
}

function larguras(ws: ExcelJS.Worksheet, ls: number[]) {
    ls.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
}

const arred = (n: number) => Math.round(n * 100) / 100;

export type EntradaExcel = EntradaConsolidacao & { cliente?: string; analista?: string };

const NOME_SITUACAO: Record<Situacao, string> = { incluido: 'No resumo', excluido: 'Ignorado', entre_contas: 'Entre contas' };


// ─── Abas ────────────────────────────────────────────────────────────────

function abaResumo(wb: ExcelJS.Workbook, r: ReturnType<typeof consolidar>, entrada: EntradaExcel) {
    const ws = wb.addWorksheet('Resumo', { views: [{ showGridLines: false }], pageSetup: { fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 } });
    larguras(ws, [48, 20, 14]);
    titulo(ws, 'TRIAD Mirror — Resumo da análise', 3);
    ws.addRow([]);
    const s = r.resumo, e = s.endividamentoCartao;
    const geradoEm = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
    blocoInfo(ws, [
        ['Cliente', entrada.cliente],
        ['Analista', entrada.analista],
        ['Gerado em (horário de Brasília)', geradoEm],
        ['Documentos', `${entrada.extratos.length} extrato(s) e ${entrada.faturas.length} fatura(s)`],
    ]);
    ws.addRow([]);
    cabecalho(ws, ['Indicador', 'Valor']);
    blocoInfo(ws, [
        ['Entradas (extratos)', s.totalEntradas, FMT_BRL],
        ['Saídas totais (extrato + cartão)', s.totalSaidas, FMT_BRL],
        ['Saldo do período', s.saldo, FMT_BRL],
        ['Saídas pelos extratos', s.totalSaidasExtrato, FMT_BRL],
        ['Gastos líquidos no cartão', s.totalGastosCartao, FMT_BRL],
        ['Comprometido na próxima fatura (parcelas)', s.comprometidoProximaFatura, FMT_BRL],
        [s.compromissoEstimado ? 'Parcelas futuras (estimado)' : 'Parcelas futuras (todas as faturas)', s.compromissoFuturoParcelas, FMT_BRL],
        ['Saldo financiado no cartão (rotativo)', e.saldoFinanciado, FMT_BRL],
        ['Encargos do cartão (juros, mora, multa, IOF)', e.encargos, FMT_BRL],
        ['Parcelas de financiamento de fatura', e.parcelasDeFinanciamento, FMT_BRL],
        ['Pagamento mínimo das faturas', e.pagamentoMinimo, FMT_BRL],
        ['Cliente no rotativo?', e.emRotativo ? 'Sim' : 'Não'],
        ['Pagamentos de fatura no extrato (revisar)', s.pagamentosDeFaturaNoExtrato.quantidade
            ? `${s.pagamentosDeFaturaNoExtrato.quantidade} lançamento(s), ${s.pagamentosDeFaturaNoExtrato.aindaIncluidosNoResumo} ainda no resumo`
            : 'Nenhum'],
    ]);

    ws.addRow([]);
    cabecalho(ws, ['Gastos por categoria', 'Valor', '% das saídas']);
    const primeira = ws.rowCount + 1;
    for (const c of s.gastosPorCategoria) {
        const l = ws.addRow([c.categoria, c.valor, c.percentual / 100]);
        l.getCell(2).numFmt = FMT_BRL;
        l.getCell(3).numFmt = FMT_PCT;
    }
    linhaTotal(ws, primeira, ws.rowCount, [2], [arred(s.gastosPorCategoria.reduce((a, c) => a + c.valor, 0))]);

    // Detalhe por subcategoria (segunda camada)
    const porSub = new Map<string, number>();
    for (const l of r.lancamentos) {
        if (!l.incluidoNoResumo || (l.origem === 'extrato' && l.direcao === 'entrada')) continue;
        const chave = `${l.categoria} › ${l.subcategoria || 'Sem subcategoria'}`;
        porSub.set(chave, (porSub.get(chave) || 0) + (l.direcao === 'saida' ? l.valor : -l.valor));
    }
    const subs = Array.from(porSub.entries()).filter(([, v]) => Math.abs(v) >= 0.01).sort((a, b) => b[1] - a[1]);
    if (subs.length) {
        ws.addRow([]);
        cabecalho(ws, ['Gastos por subcategoria', 'Valor', '% das saídas']);
        const p2 = ws.rowCount + 1;
        for (const [nome, v] of subs) {
            const l = ws.addRow([nome, arred(v), s.totalSaidas > 0 ? v / s.totalSaidas : 0]);
            l.getCell(2).numFmt = FMT_BRL;
            l.getCell(3).numFmt = FMT_PCT;
        }
        linhaTotal(ws, p2, ws.rowCount, [2], [arred(subs.reduce((a, [, v]) => a + v, 0))]);
    }
}

function abaLancamentos(wb: ExcelJS.Workbook, r: ReturnType<typeof consolidar>) {
    const ws = wb.addWorksheet('Lançamentos', { views: [{ state: 'frozen', ySplit: 1 }], pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 } });
    larguras(ws, [12, 46, 18, 26, 10, 24, 24, 9, 15, 15, 14, 40, 56]);
    cabecalho(ws, ['Data', 'Descrição', 'Origem', 'Documento', 'Direção', 'Categoria', 'Subcategoria', 'Parcela', 'Valor', 'Valor (com sinal)', 'Situação', 'Observação do analista', 'Alerta']);
    for (const l of r.lancamentos) {
        const linha = ws.addRow([
            paraData(l.data), l.descricao, l.origem === 'extrato' ? 'Conta bancária' : 'Cartão de crédito', l.documento,
            l.direcao === 'entrada' ? 'Entrada' : 'Saída', l.categoria, l.subcategoria || '', l.parcela || '',
            l.valor, l.direcao === 'entrada' ? l.valor : -l.valor, NOME_SITUACAO[l.situacao], l.observacao || '', l.alerta?.mensagem || ''
        ]);
        linha.getCell(1).numFmt = FMT_DATA;
        linha.getCell(9).numFmt = FMT_BRL;
        linha.getCell(10).numFmt = FMT_BRL;
        [12, 13].forEach(c => { linha.getCell(c).alignment = { wrapText: true, vertical: 'top' }; });
        if (!l.incluidoNoResumo) linha.eachCell(c => { c.font = { color: { argb: 'FF9A9A91' }, italic: true }; });
        if (l.situacao === 'entre_contas') linha.getCell(11).font = { color: { argb: 'FF1E4A8A' }, bold: true };
        if (l.observacao) linha.getCell(12).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF7D6' } };
        if (l.alerta) linha.getCell(13).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF7D6' } };
    }
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, ws.rowCount), column: 13 } };
}

type InfoLanc = (i: number) => Lancamento | undefined;

function abaFatura(wb: ExcelJS.Workbook, f: ResultadoFatura, nome: string, info: InfoLanc) {
    const ws = wb.addWorksheet(nome, { views: [{ showGridLines: false }], pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 } });
    larguras(ws, [13, 40, 26, 9, 9, 13, 24, 14, 18, 8, 12, 10, 9, 15, 24, 14, 36]);
    titulo(ws, `Fatura ${f.banco}${f.produto ? ' — ' + f.produto : ''}`, 17);
    ws.addRow([]);
    // Bloco de dados: rótulo ocupa A:B (largo), valor fica em C.
    const infos: [string, any, string?][] = [
        ['Titular', f.titular],
        ['Bandeira', f.bandeira],
        ['Emissão', paraData(f.emissao), FMT_DATA],
        ['Vencimento', paraData(f.vencimento), FMT_DATA],
        ['Total desta fatura', f.valorTotal, FMT_BRL],
        ['Pagamento mínimo', f.pagamentoMinimo, FMT_BRL],
        ['Total da fatura anterior', f.saldoFaturaAnterior, FMT_BRL],
        ['Pagamentos efetuados', f.pagamentosEfetuados, FMT_BRL],
        ['Saldo financiado', f.saldoFinanciado, FMT_BRL],
        ['Encargos', f.encargosTotal, FMT_BRL],
        ['Lançamentos atuais', f.totalLancamentosAtuais, FMT_BRL],
        ['Limite total', f.limiteTotal, FMT_BRL],
        ['Limite disponível', f.limiteDisponivel, FMT_BRL],
        ['Próxima fatura (parcelas)', f.proximaFatura, FMT_BRL],
        ['Total para próximas faturas', f.totalProximasFaturas, FMT_BRL],
    ];
    for (const [rotulo, valor, formato] of infos) {
        if (valor === undefined || valor === null || valor === '') continue;
        const l = ws.addRow([rotulo, '', valor]);
        ws.mergeCells(l.number, 1, l.number, 2);
        l.getCell(1).font = { bold: true };
        l.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CINZA } };
        if (formato) l.getCell(3).numFmt = formato;
        l.getCell(3).alignment = { horizontal: 'left' };
    }

    // Conferência: Verificação (A:B) | Declarado (C) | Calculado (D:E) | Diferença (F) | Situação (G)
    const c = f.conferencia;
    if (c?.verificacoes?.length) {
        ws.addRow([]);
        const h = cabecalho(ws, ['Conferência', '', 'Declarado', 'Calculado', '', 'Diferença', 'Situação']);
        ws.mergeCells(h.number, 1, h.number, 2);
        ws.mergeCells(h.number, 4, h.number, 5);
        for (const v of c.verificacoes) {
            const l = ws.addRow([v.nome, '', v.declarado, v.calculado, '', v.diferenca, v.bateu ? 'Bateu ✓' : 'DIVERGENTE']);
            ws.mergeCells(l.number, 1, l.number, 2);
            ws.mergeCells(l.number, 4, l.number, 5);
            [3, 4, 6].forEach(i => { l.getCell(i).numFmt = FMT_BRL; });
            l.getCell(7).font = { bold: true, color: { argb: v.bateu ? 'FF1F8A4C' : 'FFC0392B' } };
        }
    }

    ws.addRow([]);
    cabecalho(ws, ['Data', 'Estabelecimento', 'Portador', 'Cartão', 'Parcela', 'Tipo', 'Categoria', 'Ramo', 'Cidade', 'Moeda', 'Valor orig.', 'US$', 'Cotação', 'Valor R$', 'Subcategoria', 'Situação', 'Observação do analista']);
    const primeira = ws.rowCount + 1;
    let soma = 0;
    f.transacoes.forEach((t, i) => {
        // Valor com sinal: o que aumenta a fatura é positivo; estorno e pagamento, negativos.
        const v = TIPOS_DEBITO_FATURA.includes(t.tipo) ? t.valor : -t.valor;
        if (t.tipo !== 'pagamento') soma += v;
        const lc = info(i);
        const l = ws.addRow([
            paraData(t.data), t.estabelecimento, t.portador || '', t.cartaoFinal || '',
            t.parcelaAtual ? `${t.parcelaAtual}/${t.parcelaTotal}` : '', t.tipo, lc?.categoria || t.categoria,
            t.ramo || '', t.cidadePais || '', t.moedaOriginal || '', t.valorMoedaOriginal ?? '',
            t.valorDolar ?? '', t.cotacao ?? '', v,
            lc?.subcategoria || t.subcategoria || '', lc ? NOME_SITUACAO[lc.situacao] : '', lc?.observacao || ''
        ]);
        l.getCell(1).numFmt = FMT_DATA;
        l.getCell(14).numFmt = FMT_BRL;
        if (t.cotacao) l.getCell(13).numFmt = '0.00';
        l.getCell(17).alignment = { wrapText: true, vertical: 'top' };
    });
    const ultima = ws.rowCount;
    // Total de GASTOS da fatura: soma tudo menos o pagamento da fatura anterior
    // (que não é gasto). Bate com "lançamentos atuais + encargos".
    const tot = ws.addRow([]);
    tot.getCell(1).value = 'TOTAL DE GASTOS (sem pagamentos)';
    tot.getCell(14).value = ultima >= primeira
        ? { formula: `SUMIF(F${primeira}:F${ultima},"<>pagamento",N${primeira}:N${ultima})`, result: arred(soma) }
        : 0;
    tot.getCell(14).numFmt = FMT_BRL;
    tot.eachCell(c => { c.font = { bold: true }; c.border = { top: { style: 'medium', color: { argb: PRETO } } }; });
    ws.autoFilter = { from: { row: primeira - 1, column: 1 }, to: { row: ultima, column: 17 } };
}

function abaExtrato(wb: ExcelJS.Workbook, e: ResultadoExtrato, nome: string, info: InfoLanc) {
    const ws = wb.addWorksheet(nome, { views: [{ showGridLines: false }], pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 } });
    larguras(ws, [13, 56, 11, 26, 15, 15, 15, 24, 14, 36]);
    titulo(ws, `Extrato ${e.banco}`, 10);
    ws.addRow([]);
    blocoInfo(ws, [['Titular', e.titular], ['Lançamentos', e.transacoes.length]]);
    ws.addRow([]);
    cabecalho(ws, ['Data', 'Descrição', 'Tipo', 'Categoria', 'Entrada', 'Saída', 'Valor (com sinal)', 'Subcategoria', 'Situação', 'Observação do analista']);
    const primeira = ws.rowCount + 1;
    let ent = 0, sai = 0;
    e.transacoes.forEach((t, i) => {
        const credito = t.tipo === 'CREDITO';
        credito ? ent += t.valor : sai += t.valor;
        const lc = info(i);
        const l = ws.addRow([paraData(t.data), t.descricao, credito ? 'Entrada' : 'Saída', lc?.categoria || t.categoria,
            credito ? t.valor : null, credito ? null : t.valor, credito ? t.valor : -t.valor,
            lc?.subcategoria || t.subcategoria || '', lc ? NOME_SITUACAO[lc.situacao] : '', lc?.observacao || '']);
        l.getCell(1).numFmt = FMT_DATA;
        [5, 6, 7].forEach(c => { l.getCell(c).numFmt = FMT_BRL; });
        l.getCell(10).alignment = { wrapText: true, vertical: 'top' };
    });
    const ultima = ws.rowCount;
    linhaTotal(ws, primeira, ultima, [5, 6, 7], [arred(ent), arred(sai), arred(ent - sai)]);
    ws.autoFilter = { from: { row: primeira - 1, column: 1 }, to: { row: ultima, column: 10 } };
}

// ─── Entrada principal ───────────────────────────────────────────────────

export async function gerarExcel(entrada: EntradaExcel): Promise<Buffer> {
    const extratos = entrada.extratos || [];
    const faturas = entrada.faturas || [];
    const r = consolidar({ ...entrada, extratos, faturas });

    const wb = new ExcelJS.Workbook();
    wb.creator = 'TRIAD Mirror';
    wb.created = new Date();
    const usados = new Set<string>();

    abaResumo(wb, r, { ...entrada, extratos, faturas });
    usados.add('resumo');
    abaLancamentos(wb, r);
    usados.add('lançamentos');

    const porId = new Map(r.lancamentos.map(l => [l.id, l]));
    const idDe = (tipo: 'extrato' | 'fatura', di: number, i: number) => {
        const ids = tipo === 'extrato' ? entrada.idsDocumentos?.extratos : entrada.idsDocumentos?.faturas;
        return ids?.[di] ? `${ids[di]}:${i}` : `${tipo}-${di}-${i}`;
    };
    faturas.forEach((f, di) => {
        const venc = f.vencimento ? ` ${f.vencimento.slice(5, 7)}-${f.vencimento.slice(0, 4)}` : '';
        abaFatura(wb, f, nomeAba(`Fatura ${di + 1} ${f.banco || ''}${venc}`, usados), i => porId.get(idDe('fatura', di, i)));
    });
    extratos.forEach((e, di) => abaExtrato(wb, e, nomeAba(`Extrato ${di + 1} ${e.banco || ''}`, usados), i => porId.get(idDe('extrato', di, i))));

    return Buffer.from(await wb.xlsx.writeBuffer());
}
