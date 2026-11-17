// ══════════════════════════════════════════════════════════════════════════
// Armazenamento de arquivos (contratos, comprovantes, PDFs originais).
// Produção: bucket PRIVADO "mirror-arquivos" no Supabase Storage — só o
// servidor, com a chave secreta, lê e grava. Modo de desenvolvimento: memória.
// ══════════════════════════════════════════════════════════════════════════
import { supabaseAdmin } from './supabase';

const BUCKET = 'mirror-arquivos';
const memoria = new Map<string, { buf: Buffer; mime: string }>();
const usarMemoria = !supabaseAdmin;   // mesmo critério do repositório (sem Supabase = modo de desenvolvimento)

/** Nome seguro para o caminho no storage (sem acentos, espaços ou barras). */
export function nomeSeguro(nome: string): string {
    const limpo = String(nome || 'arquivo').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.\-]+/g, '_').replace(/_+/g, '_');
    return limpo.slice(-120) || 'arquivo';
}

export async function guardarArquivo(caminho: string, buf: Buffer, mime: string): Promise<void> {
    if (usarMemoria) { memoria.set(caminho, { buf, mime }); return; }
    const { error } = await supabaseAdmin!.storage.from(BUCKET).upload(caminho, buf, { contentType: mime || 'application/octet-stream', upsert: false });
    if (error) throw new Error('Não foi possível guardar o arquivo: ' + error.message);
}

export async function lerArquivo(caminho: string): Promise<{ buf: Buffer; mime: string } | null> {
    if (usarMemoria) return memoria.get(caminho) || null;
    const { data, error } = await supabaseAdmin!.storage.from(BUCKET).download(caminho);
    if (error || !data) return null;
    return { buf: Buffer.from(await data.arrayBuffer()), mime: data.type || 'application/octet-stream' };
}

export async function apagarArquivo(caminho: string | null | undefined): Promise<void> {
    if (!caminho) return;
    if (usarMemoria) { memoria.delete(caminho); return; }
    const { error } = await supabaseAdmin!.storage.from(BUCKET).remove([caminho]);
    if (error) console.error('[Armazenamento] Não apagou', caminho, error.message);
}
