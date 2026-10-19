// ══════════════════════════════════════════════════════════════════════════
// Inserir linhas numa aba do modelo da consultoria SEM quebrar nada.
//
// A rotina pronta do ExcelJS (spliceRows) move valores, mas não ajusta as
// fórmulas, perde comentários e bagunça células mescladas. Aqui a inserção é
// feita no "modelo" da aba, como o Excel faz:
//  • linhas a partir de `antes` descem `n` posições (valores, estilos,
//    comentários, alturas);
//  • fórmulas da própria aba e de OUTRAS abas que apontam para ela
//    (ex.: "Balanço Anual" → Agosto!B31) são reescritas;
//  • intervalos que atravessam o ponto de inserção crescem (SUM(R4:R27) →
//    SUM(R4:R37)), igual ao Excel;
//  • células mescladas e formatação condicional acompanham;
//  • as linhas novas copiam o estilo da linha de cima (bordas, fonte, formato).
// ══════════════════════════════════════════════════════════════════════════
import ExcelJS from 'exceljs';

// Referência de célula, com nome de aba opcional: B31, $B$31, Agosto!B31, 'Janeiro 2027'!B31
const REF = /(?<![\w$.])(?:('(?:[^']|'')+'|[A-Za-zÀ-ÿ_][\wÀ-ÿ.]*)!)?(\$?)([A-Z]{1,3})(\$?)(\d+)(?![\w(!])/g;

const desaspar = (s: string) => s.startsWith("'") ? s.slice(1, -1).replace(/''/g, "'") : s;

/**
 * Reescreve as referências de uma fórmula.
 * `daPropriaAba`: a fórmula está na aba que recebeu as linhas (referência sem
 * nome de aba também conta).
 */
export function deslocarFormula(formula: string, aba: string, antes: number, n: number, daPropriaAba: boolean): string {
    return formula.replace(REF, (inteiro, folha: string | undefined, d1: string, col: string, d2: string, lin: string) => {
        const alvo = folha ? desaspar(folha) : null;
        const ehDaAba = alvo ? alvo === aba : daPropriaAba;
        const linha = Number(lin);
        if (!ehDaAba || linha < antes) return inteiro;
        return `${folha ? folha + '!' : ''}${d1}${col}${d2}${linha + n}`;
    });
}

const deslocarEndereco = (end: string, antes: number, n: number) =>
    end.replace(/([A-Z]{1,3})(\d+)/g, (_, c, l) => `${c}${Number(l) >= antes ? Number(l) + n : l}`);

/** Insere `n` linhas vazias ANTES da linha `antes` (estilo copiado da linha de cima). */
export function inserirLinhas(wb: ExcelJS.Workbook, ws: ExcelJS.Worksheet, antes: number, n: number): void {
    if (n <= 0) return;
    const aba = ws.name;
    const m: any = ws.model;

    const linhaModelo = (m.rows || []).find((r: any) => r.number === antes - 1);
    const linhas = (m.rows || []).map((r: any) => {
        if (r.number < antes) {
            return { ...r, cells: (r.cells || []).map((c: any) => c.formula ? { ...c, formula: deslocarFormula(c.formula, aba, antes, n, true) } : c) };
        }
        const num = r.number + n;
        return {
            ...r, number: num,
            cells: (r.cells || []).map((c: any) => ({
                ...c,
                address: deslocarEndereco(c.address, antes, n),
                ...(c.formula ? { formula: deslocarFormula(c.formula, aba, antes, n, true) } : {})
            }))
        };
    });
    // linhas novas: só estilo (bordas, fonte, formato de número), sem valores
    const novas = Array.from({ length: n }, (_, i) => {
        const num = antes + i;
        return {
            number: num,
            height: linhaModelo?.height,
            style: linhaModelo?.style || {},
            cells: (linhaModelo?.cells || []).map((c: any) => ({
                address: c.address.replace(/\d+$/, String(num)),
                type: ExcelJS.ValueType.Null,
                style: c.style
            }))
        };
    });
    m.rows = [...linhas, ...novas].sort((a: any, b: any) => a.number - b.number);

    // o ExcelJS lê as mescladas de "mergeCells" ao reconstruir a aba (e não limpa as antigas)
    m.mergeCells = (m.merges || []).map((r: string) => deslocarEndereco(r, antes, n));
    (ws as any)._merges = {};
    m.conditionalFormattings = (m.conditionalFormattings || []).map((cf: any) => ({ ...cf, ref: deslocarEndereco(cf.ref, antes, n) }));
    ws.model = m;

    // Outras abas que apontam para esta (ex.: Balanço Anual → Agosto!B31)
    wb.eachSheet(outra => {
        if (outra === ws) return;
        outra.eachRow(row => row.eachCell(cell => {
            const v: any = cell.value;
            if (!v || typeof v !== 'object' || !v.formula || !v.formula.includes('!')) return;
            const nova = deslocarFormula(v.formula, aba, antes, n, false);
            if (nova !== v.formula) cell.value = { formula: nova } as any;
        }));
    });
}
