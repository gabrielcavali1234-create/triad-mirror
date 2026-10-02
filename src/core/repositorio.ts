// ══════════════════════════════════════════════════════════════════════════
// Repositório — tudo que a aplicação lê e grava no banco.
//  • RepoSupabase : produção (projeto Supabase próprio do Mirror)
//  • RepoMemoria  : modo de desenvolvimento (MIRROR_MODO_DEV=1, sem Supabase),
//                   usado nos testes locais; os dados somem ao reiniciar.
// As rotas só conhecem a interface Repositorio, nunca o banco direto.
// ══════════════════════════════════════════════════════════════════════════
import crypto from 'crypto';
import { supabaseAdmin } from './supabase';

export interface Usuario {
    id: string | null;
    email: string;
    nome: string;
    admin?: boolean;
}

export interface Cliente {
    id: string;
    nome: string;
    cpf?: string | null;
    telefone?: string | null;
    email?: string | null;
    renda_declarada?: number | null;
    objetivo?: string | null;
    observacao?: string | null;
    criado_por?: string | null;
    criado_por_nome?: string | null;
    criado_em: string;
    atualizado_em: string;
}

export interface Analise {
    id: string;
    cliente_id: string;
    status: 'aberta' | 'concluida' | 'arquivada';
    analista?: string | null;
    criado_em: string;
    atualizado_em: string;
}

export interface Documento {
    id: string;
    analise_id: string;
    tipo: 'extrato' | 'fatura';
    nome_arquivo?: string | null;
    banco?: string | null;
    resultado: any;
    qualidade_ruim: boolean;
    custo_usd?: number;
    criado_em: string;
}

export interface Ajuste {
    documento_id: string;
    lancamento_ref: number;
    categoria?: string | null;
    subcategoria?: string | null;
    observacao?: string | null;
    situacao?: 'incluido' | 'excluido' | 'entre_contas' | null;
    classe?: 'fixo' | 'variavel' | 'investimento' | 'entrada' | 'fora' | null;
    atualizado_por?: string | null;
    atualizado_por_id?: string | null;
}

export interface DocumentoResumo {
    tipo: 'extrato' | 'fatura';
    banco?: string | null;
    qualidade_ruim: boolean;
    em_rotativo: boolean;
    criado_em: string;
}

export interface ClienteResumo extends Cliente {
    analise?: { id: string; status: string; atualizado_em: string } | null;
    documentos: DocumentoResumo[];
}

export type DadosCliente = Partial<Pick<Cliente, 'nome' | 'cpf' | 'telefone' | 'email' | 'renda_declarada' | 'objetivo' | 'observacao'>>;

export interface NovoDocumento {
    analise_id: string;
    tipo: 'extrato' | 'fatura';
    nome_arquivo?: string;
    file_hash?: string;
    resultado: any;
    custo_usd?: number;
    tokens_input?: number;
    tokens_output?: number;
    tokens_cache_write?: number;
    tokens_cache_read?: number;
    modelo_usado?: string;
    tempo_processamento?: number;
}

export interface Repositorio {
    readonly modo: 'supabase' | 'memoria';
    listarClientes(): Promise<ClienteResumo[]>;
    criarCliente(dados: DadosCliente, por: Usuario): Promise<Cliente>;
    obterCliente(id: string): Promise<Cliente | null>;
    atualizarCliente(id: string, dados: DadosCliente): Promise<Cliente | null>;
    analiseAtual(clienteId: string, por: Usuario): Promise<Analise>;
    obterAnalise(id: string): Promise<Analise | null>;
    atualizarAnalise(id: string, dados: { status: Analise['status'] }): Promise<void>;
    listarDocumentos(analiseId: string): Promise<Documento[]>;
    obterDocumento(id: string): Promise<Documento | null>;
    inserirDocumento(d: NovoDocumento): Promise<Documento>;
    excluirDocumento(id: string): Promise<void>;
    listarAjustes(documentoIds: string[]): Promise<Ajuste[]>;
    salvarAjustes(salvar: Ajuste[], remover: { documento_id: string; lancamento_ref: number }[]): Promise<void>;
}

const CAMPOS_CLIENTE = ['nome', 'cpf', 'telefone', 'email', 'renda_declarada', 'objetivo', 'observacao'] as const;

function limparDadosCliente(d: DadosCliente): DadosCliente {
    const out: any = {};
    for (const c of CAMPOS_CLIENTE) {
        if (!(c in d)) continue;
        const v = (d as any)[c];
        if (c === 'renda_declarada') {
            const n = v === '' || v == null ? null : Number(v);
            out[c] = n == null || Number.isNaN(n) ? null : n;
        } else {
            out[c] = v == null ? null : String(v).trim().slice(0, c === 'observacao' || c === 'objetivo' ? 2000 : 200) || null;
        }
    }
    return out;
}

const emRotativo = (resultado: any) => !!resultado && (Number(resultado.saldoFinanciado) > 0 ||
    (Array.isArray(resultado.transacoes) && resultado.transacoes.some((t: any) => t.tipo === 'encargo')));

// ─── Supabase ────────────────────────────────────────────────────────────
class RepoSupabase implements Repositorio {
    readonly modo = 'supabase' as const;
    private get db() { return supabaseAdmin!; }

    private falhar(error: any, contexto: string): never {
        throw new Error(`[Banco] ${contexto}: ${error?.message || error}`);
    }

    async listarClientes(): Promise<ClienteResumo[]> {
        const { data: clientes, error } = await this.db.from('mirror_clientes').select('*').order('atualizado_em', { ascending: false }).limit(500);
        if (error) this.falhar(error, 'listar clientes');
        const ids = (clientes || []).map((c: any) => c.id);
        if (!ids.length) return [];
        const { data: analises, error: e2 } = await this.db.from('mirror_analises')
            .select('id, cliente_id, status, atualizado_em').in('cliente_id', ids).neq('status', 'arquivada')
            .order('criado_em', { ascending: false });
        if (e2) this.falhar(e2, 'listar análises');
        const atual = new Map<string, any>();
        for (const a of analises || []) if (!atual.has(a.cliente_id)) atual.set(a.cliente_id, a);
        const analiseIds = Array.from(atual.values()).map(a => a.id);
        let docs: any[] = [];
        if (analiseIds.length) {
            const { data, error: e3 } = await this.db.from('mirror_documentos')
                .select('analise_id, tipo, banco, qualidade_ruim, criado_em, saldo_financiado:resultado->saldoFinanciado')
                .in('analise_id', analiseIds);
            if (e3) this.falhar(e3, 'listar documentos');
            docs = data || [];
        }
        return (clientes || []).map((c: any) => {
            const a = atual.get(c.id);
            return {
                ...c,
                analise: a ? { id: a.id, status: a.status, atualizado_em: a.atualizado_em } : null,
                documentos: a ? docs.filter(d => d.analise_id === a.id).map(d => ({
                    tipo: d.tipo, banco: d.banco, qualidade_ruim: d.qualidade_ruim, criado_em: d.criado_em,
                    em_rotativo: Number(d.saldo_financiado) > 0
                })) : []
            };
        });
    }

    async criarCliente(dados: DadosCliente, por: Usuario): Promise<Cliente> {
        const { data, error } = await this.db.from('mirror_clientes')
            .insert({ ...limparDadosCliente(dados), criado_por: por.id, criado_por_nome: por.nome }).select('*').single();
        if (error) this.falhar(error, 'criar cliente');
        return data as Cliente;
    }

    async obterCliente(id: string): Promise<Cliente | null> {
        const { data, error } = await this.db.from('mirror_clientes').select('*').eq('id', id).maybeSingle();
        if (error) this.falhar(error, 'obter cliente');
        return data as Cliente | null;
    }

    async atualizarCliente(id: string, dados: DadosCliente): Promise<Cliente | null> {
        const { data, error } = await this.db.from('mirror_clientes')
            .update({ ...limparDadosCliente(dados), atualizado_em: new Date().toISOString() }).eq('id', id).select('*').maybeSingle();
        if (error) this.falhar(error, 'atualizar cliente');
        return data as Cliente | null;
    }

    async analiseAtual(clienteId: string, por: Usuario): Promise<Analise> {
        const { data, error } = await this.db.from('mirror_analises').select('*')
            .eq('cliente_id', clienteId).neq('status', 'arquivada').order('criado_em', { ascending: false }).limit(1).maybeSingle();
        if (error) this.falhar(error, 'obter análise');
        if (data) return data as Analise;
        const { data: nova, error: e2 } = await this.db.from('mirror_analises')
            .insert({ cliente_id: clienteId, analista: por.nome, analista_id: por.id }).select('*').single();
        if (e2) this.falhar(e2, 'criar análise');
        return nova as Analise;
    }

    async obterAnalise(id: string): Promise<Analise | null> {
        const { data, error } = await this.db.from('mirror_analises').select('*').eq('id', id).maybeSingle();
        if (error) this.falhar(error, 'obter análise');
        return data as Analise | null;
    }

    async atualizarAnalise(id: string, dados: { status: Analise['status'] }): Promise<void> {
        const { error } = await this.db.from('mirror_analises').update({ status: dados.status, atualizado_em: new Date().toISOString() }).eq('id', id);
        if (error) this.falhar(error, 'atualizar análise');
    }

    async listarDocumentos(analiseId: string): Promise<Documento[]> {
        const { data, error } = await this.db.from('mirror_documentos')
            .select('id, analise_id, tipo, nome_arquivo, banco, resultado, qualidade_ruim, custo_usd, criado_em')
            .eq('analise_id', analiseId).order('criado_em', { ascending: true });
        if (error) this.falhar(error, 'listar documentos');
        return (data || []) as Documento[];
    }

    async obterDocumento(id: string): Promise<Documento | null> {
        const { data, error } = await this.db.from('mirror_documentos')
            .select('id, analise_id, tipo, nome_arquivo, banco, resultado, qualidade_ruim, custo_usd, criado_em').eq('id', id).maybeSingle();
        if (error) this.falhar(error, 'obter documento');
        return data as Documento | null;
    }

    async inserirDocumento(d: NovoDocumento): Promise<Documento> {
        const { data, error } = await this.db.from('mirror_documentos').insert({
            ...d,
            banco: d.resultado?.banco || null,
            qualidade_ruim: !!d.resultado?.qualidadeRuim
        }).select('id, analise_id, tipo, nome_arquivo, banco, resultado, qualidade_ruim, custo_usd, criado_em').single();
        if (error) this.falhar(error, 'salvar documento');
        return data as Documento;
    }

    async excluirDocumento(id: string): Promise<void> {
        const { error } = await this.db.from('mirror_documentos').delete().eq('id', id);
        if (error) this.falhar(error, 'excluir documento');
    }

    async listarAjustes(documentoIds: string[]): Promise<Ajuste[]> {
        if (!documentoIds.length) return [];
        const { data, error } = await this.db.from('mirror_ajustes').select('*').in('documento_id', documentoIds);
        if (error) this.falhar(error, 'listar ajustes');
        return (data || []) as Ajuste[];
    }

    async salvarAjustes(salvar: Ajuste[], remover: { documento_id: string; lancamento_ref: number }[]): Promise<void> {
        if (salvar.length) {
            const { error } = await this.db.from('mirror_ajustes')
                .upsert(salvar.map(a => ({ ...a, atualizado_em: new Date().toISOString() })), { onConflict: 'documento_id,lancamento_ref' });
            if (error) this.falhar(error, 'salvar ajustes');
        }
        for (const r of remover) {
            const { error } = await this.db.from('mirror_ajustes').delete()
                .eq('documento_id', r.documento_id).eq('lancamento_ref', r.lancamento_ref);
            if (error) this.falhar(error, 'remover ajuste');
        }
    }
}

// ─── Memória (modo de desenvolvimento / testes) ──────────────────────────
class RepoMemoria implements Repositorio {
    readonly modo = 'memoria' as const;
    private clientes = new Map<string, Cliente>();
    private analises = new Map<string, Analise>();
    private documentos = new Map<string, Documento>();
    private ajustes = new Map<string, Ajuste>();
    private agora() { return new Date().toISOString(); }
    private tocarCliente(clienteId: string) {
        const c = this.clientes.get(clienteId); if (c) c.atualizado_em = this.agora();
    }

    async listarClientes(): Promise<ClienteResumo[]> {
        return Array.from(this.clientes.values()).sort((a, b) => b.atualizado_em.localeCompare(a.atualizado_em)).map(c => {
            const a = Array.from(this.analises.values()).filter(x => x.cliente_id === c.id && x.status !== 'arquivada')
                .sort((x, y) => y.criado_em.localeCompare(x.criado_em))[0];
            return {
                ...c,
                analise: a ? { id: a.id, status: a.status, atualizado_em: a.atualizado_em } : null,
                documentos: a ? Array.from(this.documentos.values()).filter(d => d.analise_id === a.id).map(d => ({
                    tipo: d.tipo, banco: d.banco, qualidade_ruim: d.qualidade_ruim, criado_em: d.criado_em, em_rotativo: emRotativo(d.resultado)
                })) : []
            };
        });
    }
    async criarCliente(dados: DadosCliente, por: Usuario): Promise<Cliente> {
        const c: Cliente = { id: crypto.randomUUID(), nome: '', ...limparDadosCliente(dados), criado_por: por.id, criado_por_nome: por.nome, criado_em: this.agora(), atualizado_em: this.agora() } as Cliente;
        this.clientes.set(c.id, c); return c;
    }
    async obterCliente(id: string) { return this.clientes.get(id) || null; }
    async atualizarCliente(id: string, dados: DadosCliente) {
        const c = this.clientes.get(id); if (!c) return null;
        Object.assign(c, limparDadosCliente(dados), { atualizado_em: this.agora() }); return c;
    }
    async analiseAtual(clienteId: string, por: Usuario): Promise<Analise> {
        const a = Array.from(this.analises.values()).filter(x => x.cliente_id === clienteId && x.status !== 'arquivada')
            .sort((x, y) => y.criado_em.localeCompare(x.criado_em))[0];
        if (a) return a;
        const nova: Analise = { id: crypto.randomUUID(), cliente_id: clienteId, status: 'aberta', analista: por.nome, criado_em: this.agora(), atualizado_em: this.agora() };
        this.analises.set(nova.id, nova); this.tocarCliente(clienteId); return nova;
    }
    async obterAnalise(id: string) { return this.analises.get(id) || null; }
    async atualizarAnalise(id: string, dados: { status: Analise['status'] }) {
        const a = this.analises.get(id); if (a) { a.status = dados.status; a.atualizado_em = this.agora(); this.tocarCliente(a.cliente_id); }
    }
    async listarDocumentos(analiseId: string) {
        return Array.from(this.documentos.values()).filter(d => d.analise_id === analiseId).sort((a, b) => a.criado_em.localeCompare(b.criado_em));
    }
    async obterDocumento(id: string) { return this.documentos.get(id) || null; }
    async inserirDocumento(d: NovoDocumento): Promise<Documento> {
        const doc: Documento = {
            id: crypto.randomUUID(), analise_id: d.analise_id, tipo: d.tipo, nome_arquivo: d.nome_arquivo || null,
            banco: d.resultado?.banco || null, resultado: d.resultado, qualidade_ruim: !!d.resultado?.qualidadeRuim,
            custo_usd: d.custo_usd || 0, criado_em: this.agora()
        };
        this.documentos.set(doc.id, doc);
        const a = this.analises.get(d.analise_id); if (a) { a.atualizado_em = this.agora(); this.tocarCliente(a.cliente_id); }
        return doc;
    }
    async excluirDocumento(id: string) {
        this.documentos.delete(id);
        for (const k of Array.from(this.ajustes.keys())) if (k.startsWith(id + ':')) this.ajustes.delete(k);
    }
    async listarAjustes(documentoIds: string[]) {
        const s = new Set(documentoIds);
        return Array.from(this.ajustes.values()).filter(a => s.has(a.documento_id));
    }
    async salvarAjustes(salvar: Ajuste[], remover: { documento_id: string; lancamento_ref: number }[]) {
        for (const a of salvar) this.ajustes.set(`${a.documento_id}:${a.lancamento_ref}`, { ...a });
        for (const r of remover) this.ajustes.delete(`${r.documento_id}:${r.lancamento_ref}`);
    }
}

export const MODO_DEV = process.env.MIRROR_MODO_DEV === '1';

export const repo: Repositorio | null = supabaseAdmin ? new RepoSupabase() : MODO_DEV ? new RepoMemoria() : null;

if (!repo) console.warn('[Repositório] Sem Supabase e sem MIRROR_MODO_DEV=1 — a aplicação (login/clientes) fica indisponível.');
else console.log(`[Repositório] Usando ${repo.modo === 'supabase' ? 'Supabase' : 'MEMÓRIA (modo de desenvolvimento — dados somem ao reiniciar)'}.`);
