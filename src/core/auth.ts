// ══════════════════════════════════════════════════════════════════════════
// Login dos analistas — Supabase Auth (e-mail + senha).
//  • Analistas são criados pelo administrador (rota /api/admin/analistas,
//    protegida pela MIRROR_ACCESS_KEY, ou no painel do Supabase).
//  • O navegador recebe um token de acesso (1h) + token de renovação; o
//    servidor confere o token a cada chamada (com cache curto).
//  • A MIRROR_ACCESS_KEY continua valendo como acesso de administrador
//    (página /teste, scripts).
// Modo de desenvolvimento (MIRROR_MODO_DEV=1, sem Supabase): qualquer e-mail
// entra com a senha igual à MIRROR_ACCESS_KEY. Só para testes locais.
// ══════════════════════════════════════════════════════════════════════════
import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { clienteAuthDescartavel, supabaseAdmin } from './supabase';
import { MODO_DEV, Usuario } from './repositorio';

const CHAVE_ADMIN = process.env.MIRROR_ACCESS_KEY || '';

export function chaveAdminConfere(recebida: string): boolean {
    if (!CHAVE_ADMIN || !recebida) return false;
    const a = crypto.createHash('sha256').update(recebida).digest();
    const b = crypto.createHash('sha256').update(CHAVE_ADMIN).digest();
    return crypto.timingSafeEqual(a, b);
}

const nomeDe = (u: any): string =>
    (u?.user_metadata?.nome || u?.user_metadata?.name || '').toString().trim() ||
    (u?.email ? String(u.email).split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()) : 'Analista');

export interface Sessao {
    token: string;
    renovacao: string;
    expiraEm: number;          // epoch em segundos
    usuario: Usuario;
}

// ─── Modo de desenvolvimento ─────────────────────────────────────────────
const sessoesDev = new Map<string, { usuario: Usuario; expiraEm: number }>();
function sessaoDev(email: string): Sessao {
    const token = 'dev.' + crypto.randomBytes(24).toString('hex');
    const renovacao = 'devr.' + crypto.randomBytes(24).toString('hex');
    const usuario: Usuario = { id: crypto.createHash('md5').update(email).digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*/, '$1-$2-$3-$4-$5'), email, nome: nomeDe({ email }) };
    const expiraEm = Math.floor(Date.now() / 1000) + 3600;
    sessoesDev.set(token, { usuario, expiraEm });
    sessoesDev.set(renovacao, { usuario, expiraEm: expiraEm + 86400 * 7 });
    return { token, renovacao, expiraEm, usuario };
}

// ─── Login / renovação ───────────────────────────────────────────────────
export class ErroLogin extends Error { constructor(msg: string, public status = 401) { super(msg); } }

export async function entrar(email: string, senha: string): Promise<Sessao> {
    email = String(email || '').trim().toLowerCase();
    if (!email || !senha) throw new ErroLogin('Informe e-mail e senha.', 400);

    const sb = clienteAuthDescartavel();
    if (!sb) {
        if (MODO_DEV && chaveAdminConfere(String(senha))) return sessaoDev(email);
        throw new ErroLogin(MODO_DEV ? 'E-mail ou senha incorretos.' : 'Login indisponível: Supabase não configurado no servidor.', MODO_DEV ? 401 : 503);
    }
    const { data, error } = await sb.auth.signInWithPassword({ email, password: String(senha) });
    if (error || !data.session) throw new ErroLogin('E-mail ou senha incorretos.');
    return {
        token: data.session.access_token,
        renovacao: data.session.refresh_token,
        expiraEm: data.session.expires_at || Math.floor(Date.now() / 1000) + 3600,
        usuario: { id: data.user.id, email: data.user.email || email, nome: nomeDe(data.user) }
    };
}

export async function renovar(renovacao: string): Promise<Sessao> {
    if (!renovacao) throw new ErroLogin('Sessão expirada. Entre de novo.');
    const sb = clienteAuthDescartavel();
    if (!sb) {
        const s = sessoesDev.get(renovacao);
        if (!MODO_DEV || !s || s.expiraEm < Date.now() / 1000) throw new ErroLogin('Sessão expirada. Entre de novo.');
        return sessaoDev(s.usuario.email);
    }
    const { data, error } = await sb.auth.refreshSession({ refresh_token: renovacao });
    if (error || !data.session || !data.user) throw new ErroLogin('Sessão expirada. Entre de novo.');
    return {
        token: data.session.access_token,
        renovacao: data.session.refresh_token,
        expiraEm: data.session.expires_at || Math.floor(Date.now() / 1000) + 3600,
        usuario: { id: data.user.id, email: data.user.email || '', nome: nomeDe(data.user) }
    };
}

// ─── Conferência do token a cada chamada (cache de 60s) ──────────────────
const cache = new Map<string, { usuario: Usuario; ate: number }>();
setInterval(() => { const agora = Date.now(); for (const [k, v] of cache) if (v.ate < agora) cache.delete(k); }, 5 * 60 * 1000).unref();

async function usuarioDoToken(token: string): Promise<Usuario | null> {
    const c = cache.get(token);
    if (c && c.ate > Date.now()) return c.usuario;
    let usuario: Usuario | null = null;
    if (supabaseAdmin) {
        const { data, error } = await supabaseAdmin.auth.getUser(token);
        if (!error && data.user) usuario = { id: data.user.id, email: data.user.email || '', nome: nomeDe(data.user) };
    } else if (MODO_DEV) {
        const s = sessoesDev.get(token);
        if (s && s.expiraEm > Date.now() / 1000 && token.startsWith('dev.')) usuario = s.usuario;
    }
    if (usuario) cache.set(token, { usuario, ate: Date.now() + 60_000 });
    return usuario;
}

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express { interface Request { usuario?: Usuario } }
}

/** Exige analista logado (Bearer) ou a chave de administrador (x-mirror-key). */
export async function exigirLogin(req: Request, res: Response, next: NextFunction) {
    try {
        const chave = String(req.get('x-mirror-key') || '');
        if (chave && chaveAdminConfere(chave)) {
            req.usuario = { id: null, email: 'admin', nome: 'Administrador', admin: true };
            return next();
        }
        const auth = String(req.get('authorization') || '');
        const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
        const usuario = token ? await usuarioDoToken(token) : null;
        if (!usuario) return res.status(401).json({ error: 'Sessão expirada. Entre de novo.', codigo: 'SESSAO' });
        req.usuario = usuario;
        next();
    } catch (e: any) {
        console.error('[Auth] Erro ao conferir sessão:', e.message);
        res.status(503).json({ error: 'Não foi possível conferir o login agora. Tente de novo em instantes.' });
    }
}

/** Cria um analista (só administrador). */
export async function criarAnalista(email: string, senha: string, nome: string): Promise<{ id: string; email: string }> {
    if (!supabaseAdmin) throw new ErroLogin('Supabase não configurado no servidor.', 503);
    email = String(email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ErroLogin('E-mail inválido.', 400);
    if (String(senha || '').length < 8) throw new ErroLogin('A senha precisa ter pelo menos 8 caracteres.', 400);
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
        email, password: String(senha), email_confirm: true, user_metadata: { nome: String(nome || '').trim() || undefined }
    });
    if (error || !data.user) throw new ErroLogin(error?.message || 'Não foi possível criar o analista.', 400);
    return { id: data.user.id, email: data.user.email || email };
}
