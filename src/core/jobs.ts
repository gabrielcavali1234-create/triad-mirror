// ══════════════════════════════════════════════════════════════════════════
// Fila de jobs em memória + mensagens de erro amigáveis — herdado da TRIAD.
// ══════════════════════════════════════════════════════════════════════════
export interface Job {
    status: 'processing' | 'completed' | 'error';
    tipoDocumento: string;
    result?: any;
    resultCompleto?: any;   // com campos de custo — nunca vai pro frontend
    error?: string;
    errorCode?: string | null;
    startedAt?: number;
    completedAt?: number;
    progress?: { chunksTotal: number; chunksCompleted: number };
}

export const jobs = new Map<string, Job>();

export function novoJobId(): string {
    return Date.now().toString() + Math.random().toString(36).substring(7);
}

// Limpa jobs concluídos há mais de 2h
setInterval(() => {
    const agora = Date.now();
    for (const [id, job] of jobs.entries()) {
        if (job.completedAt && agora - job.completedAt > 2 * 60 * 60 * 1000) jobs.delete(id);
    }
}, 15 * 60 * 1000).unref();

export const CAMPOS_CUSTO = [
    '_tokensInput', '_tokensOutput', '_tokensCacheWrite', '_tokensCacheRead',
    '_custoUSD', '_custoUSDTentativasFalhas', '_custoUSDTotal', '_modelo'
];

export function sanitizarResultado(result: any): any {
    const limpo = { ...result };
    for (const campo of CAMPOS_CUSTO) delete limpo[campo];
    return limpo;
}

export function buildUserFriendlyError(error: any): string {
    if (error?.code === 'PDF_PASSWORD_REQUIRED') return 'Este PDF está protegido por senha. Informe a senha para continuar.';
    if (error?.code === 'PDF_PASSWORD_INCORRECT') return 'Senha incorreta para este PDF.';
    if (error?.status === 413) return 'Arquivo muito grande para ser processado.';
    if (error?.status === 429) return 'Cota de uso da IA excedida (Erro 429). Verifique o plano no Console da Anthropic.';
    if (error?.status === 529) return 'A API da IA está temporariamente sobrecarregada. Tente novamente em alguns instantes.';
    if (error?.status === 401) return 'Chave de API da Anthropic inválida ou ausente. Verifique a variável ANTHROPIC_API_KEY.';
    return 'Falha na análise do servidor. ' + (error?.message || 'Erro desconhecido.');
}
