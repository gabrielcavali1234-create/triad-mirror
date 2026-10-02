// ══════════════════════════════════════════════════════════════════════════
// Pipeline genérico de documento: lê o arquivo, recorta o PDF em pedaços,
// processa em lotes paralelos e junta os resultados. Mesma engenharia da
// analyzeFile() da TRIAD — a diferença é que a junção dos pedaços agora é
// fornecida pelo módulo (extrato junta de um jeito, fatura de outro).
// ══════════════════════════════════════════════════════════════════════════
import fs from 'fs';
import { splitPdfIntoChunks } from './pdf';
import { anexarUsage, callClaudeWithFallback, ExtracaoConfig, UsageTotal } from './ia';

export type OnProgress = (info: { chunksTotal: number; chunksCompleted: number }) => void;

export interface ModuloDocumento<T extends object> {
    config: ExtracaoConfig<T>;
    /** Junta os resultados de vários pedaços do mesmo documento num só. */
    juntarPedacos: (resultados: T[]) => T;
}

const CONCORRENCIA_MAXIMA = Number(process.env.CONCORRENCIA_POR_DOCUMENTO) || 8;

export async function analisarDocumento<T extends object>(
    modulo: ModuloDocumento<T>,
    filePath: string,
    mimeType: string,
    usageTotal: UsageTotal,
    password?: string,
    onProgress?: OnProgress
) {
    const fileBuffer = await fs.promises.readFile(filePath);

    const processarUmaVez = async (base64: string) => {
        onProgress?.({ chunksTotal: 1, chunksCompleted: 0 });
        const r = await callClaudeWithFallback(modulo.config, base64, mimeType, usageTotal);
        onProgress?.({ chunksTotal: 1, chunksCompleted: 1 });
        return anexarUsage(modulo.juntarPedacos([r]), usageTotal);
    };

    if (mimeType !== 'application/pdf') return processarUmaVez(fileBuffer.toString('base64'));

    const split = await splitPdfIntoChunks(fileBuffer, password);
    if (!split) return processarUmaVez(fileBuffer.toString('base64'));
    if (split.chunks.length === 1) return processarUmaVez(split.chunks[0]);

    const { chunks } = split;
    onProgress?.({ chunksTotal: chunks.length, chunksCompleted: 0 });

    const resultados: T[] = [];
    for (let inicio = 0; inicio < chunks.length; inicio += CONCORRENCIA_MAXIMA) {
        const lote = chunks.slice(inicio, inicio + CONCORRENCIA_MAXIMA);
        // Promise.all preserva a ordem → os pedaços chegam na ordem das páginas
        const doLote = await Promise.all(lote.map(c => callClaudeWithFallback(modulo.config, c, mimeType, usageTotal)));
        resultados.push(...doLote);
        onProgress?.({ chunksTotal: chunks.length, chunksCompleted: Math.min(inicio + lote.length, chunks.length) });
    }

    return anexarUsage(modulo.juntarPedacos(resultados), usageTotal);
}
