// ══════════════════════════════════════════════════════════════════════════
// Supabase + cache de arquivos duplicados — herdado da TRIAD.
// Diferença: o cache agora considera o TIPO do documento (o mesmo PDF lido
// como "extrato" e como "fatura" gera resultados diferentes) e usa tabelas
// próprias do Mirror (prefixo mirror_), pra não misturar com os dados da TRIAD
// caso os dois produtos compartilhem o mesmo projeto Supabase no início.
// ══════════════════════════════════════════════════════════════════════════
import crypto from 'crypto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

export const supabaseAdmin: SupabaseClient | null =
    process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
        ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
            // Servidor: nunca guardar sessão no cliente compartilhado (senão um login
            // trocaria a credencial usada por todas as consultas ao banco).
            auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
        })
        : null;

/** Cliente descartável, só para operações de login (signIn / refresh). */
export function clienteAuthDescartavel(): SupabaseClient | null {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });
}

if (!supabaseAdmin) {
    console.warn('[Supabase] SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausentes — cache de duplicados e gravação de custo desativados.');
}

export const TABELA_CACHE = 'mirror_extraction_cache';
export const TABELA_EXTRACOES = 'mirror_extractions';

export function hashArquivo(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

export async function buscarResultadoCacheado(fileHash: string, tipoDocumento: string, userId?: string, orgId?: string): Promise<any | null> {
    if (!supabaseAdmin || (!userId && !orgId)) return null;
    try {
        let query = supabaseAdmin.from(TABELA_CACHE).select('resultado, created_at')
            .eq('file_hash', fileHash)
            .eq('tipo_documento', tipoDocumento);
        query = orgId ? query.eq('org_id', orgId) : query.eq('user_id', userId!);
        const { data, error } = await query.order('created_at', { ascending: false }).limit(1).maybeSingle();
        if (error) { console.warn('[Cache] Erro ao consultar:', error.message); return null; }
        return data?.resultado || null;
    } catch (e: any) {
        console.warn('[Cache] Falha ao consultar:', e.message);
        return null;
    }
}

export async function salvarResultadoCache(fileHash: string, tipoDocumento: string, userId: string, orgId: string | undefined, resultado: any): Promise<void> {
    if (!supabaseAdmin) return;
    try {
        await supabaseAdmin.from(TABELA_CACHE).insert({
            file_hash: fileHash,
            tipo_documento: tipoDocumento,
            org_id: orgId || null,
            user_id: userId,
            resultado
        });
    } catch (e: any) {
        console.warn('[Cache] Falha ao salvar (não afeta a análise):', e.message);
    }
}
