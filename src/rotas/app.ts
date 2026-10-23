// ══════════════════════════════════════════════════════════════════════════
// Rotas da APLICAÇÃO (analistas logados): /api/auth/*, /api/app/*, /api/admin/*
// As rotas antigas /api/mirror/* (página /teste) continuam funcionando.
// ══════════════════════════════════════════════════════════════════════════
import fs from 'fs';
import path from 'path';
import express, { Request, Response } from 'express';
import multer from 'multer';
import { chaveAdminConfere, criarAnalista, entrar, ErroLogin, exigirLogin, renovar } from '../core/auth';
import { Ajuste, Analise, Cliente, Documento, MODO_DEV, repo } from '../core/repositorio';
import { buildUserFriendlyError, jobs, novoJobId } from '../core/jobs';
import { analisarDocumento, ModuloDocumento } from '../core/pipeline';
import { novoUsageTotal } from '../core/ia';
import { buscarResultadoCacheado, hashArquivo, salvarResultadoCache } from '../core/supabase';
import { moduloExtrato } from '../modules/extrato';
import { finalizarFatura, moduloFatura } from '../modules/fatura';
import { AjusteLancamento, consolidar } from '../modules/consolidacao';
import { gerarExcel } from '../modules/excel';
import { gerarPlanilhaConsultoria, listarGrupos } from '../modules/planilha';
import { evolucaoMensal, linhaDoPainel, produtividade } from '../modules/painel';
import { CATEGORIAS, SUBCATEGORIAS } from '../modules/categorias';
import { basePlano, normalizarPlano, planoPadrao, simular } from '../modules/plano';
import { montarFoto } from '../modules/app-cliente';
import crypto from 'crypto';

const router = express.Router();

const uploadDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
    storage: multer.diskStorage({
        destination: (_r, _f, cb) => cb(null, uploadDir),
        filename: (_r, f, cb) => cb(null, Date.now() + '-' + f.originalname.replace(/[^\w.\-]/g, '_'))
    }),
    limits: { fileSize: 100 * 1024 * 1024 }
});

const MODULOS: Record<string, ModuloDocumento<any>> = { extrato: moduloExtrato, fatura: moduloFatura };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pid = (req: Request): string => String(req.params.id || '');
const apagar = (p?: string) => { if (p) { try { fs.unlinkSync(p); } catch { /* já foi */ } } };

/** Envolve rota async: erro vira 500 com mensagem amigável. */
const rota = (fn: (req: Request, res: Response) => Promise<any>) => (req: Request, res: Response) => {
    fn(req, res).catch((e: any) => {
        console.error('[App] Erro:', e?.message || e);
        if (e instanceof ErroLogin) return res.status(e.status).json({ error: e.message });
        res.status(500).json({ error: 'Algo deu errado no servidor. Tente de novo.', details: e?.message });
    });
};

function semRepo(res: Response) {
    return res.status(503).json({ error: 'Banco de dados não configurado no servidor (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).' });
}

// ─── Login ───────────────────────────────────────────────────────────────
router.post('/api/auth/login', rota(async (req, res) => {
    const { email, senha } = req.body || {};
    res.json(await entrar(email, senha));
}));

router.post('/api/auth/renovar', rota(async (req, res) => {
    res.json(await renovar(String(req.body?.renovacao || '')));
}));

router.post('/api/admin/analistas', rota(async (req, res) => {
    if (!chaveAdminConfere(String(req.get('x-mirror-key') || ''))) return res.status(401).json({ error: 'Chave de administrador inválida.' });
    const { email, senha, nome } = req.body || {};
    res.status(201).json(await criarAnalista(email, senha, nome));
}));

// Daqui pra baixo, tudo exige login
// ─── App do cliente: rota PÚBLICA (link pessoal, sem login) ──────────────
// Fica antes do exigirLogin. Devolve só a foto publicada pela consultora.
const acessosPublicos = new Map<string, { n: number; desde: number }>();
const TOKEN_OK = /^[A-Za-z0-9_-]{20,64}$/;
router.get('/api/publico/app/:token', rota(async (req, res) => {
    const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    const agora = Date.now(), a = acessosPublicos.get(ip);
    if (a && agora - a.desde < 60_000) { if (++a.n > 60) return res.status(429).json({ error: 'Muitas tentativas. Espere um minuto.' }); }
    else acessosPublicos.set(ip, { n: 1, desde: agora });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex');
    const token = String(req.params.token || '');
    if (!repo || !TOKEN_OK.test(token)) return res.status(404).json({ error: 'Link inválido.' });
    const c = await repo.obterClientePorToken(token);
    if (!c || !c.app_ativo || !c.app_snapshot) return res.status(404).json({ error: 'Este link não está ativo. Fale com a sua consultora.' });
    res.json({ foto: c.app_snapshot });
}));

// Página do app e o manifesto (ícone / "Adicionar à tela inicial") de cada link
const paginaApp = path.join(process.cwd(), 'public', 'cliente.html');
router.get('/c/:token', (req, res) => {
    res.setHeader('X-Robots-Tag', 'noindex');
    if (!fs.existsSync(paginaApp)) return res.status(404).send('App indisponível.');
    res.sendFile(paginaApp);
});
router.get('/c/:token/manifest.webmanifest', (req, res) => {
    const token = String(req.params.token || '');
    if (!TOKEN_OK.test(token)) return res.status(404).end();
    res.type('application/manifest+json').send(JSON.stringify({
        name: 'Dees — minha vida financeira', short_name: 'Dees', start_url: `/c/${token}`, scope: `/c/${token}`,
        display: 'standalone', background_color: '#ffffff', theme_color: '#0F5A3F', lang: 'pt-BR',
        icons: [{ src: '/img/app-192.png', sizes: '192x192', type: 'image/png' }, { src: '/img/app-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }]
    }));
});

router.use('/api/app', exigirLogin);

router.get('/api/app/me', (req, res) => res.json({ usuario: req.usuario, banco: repo?.modo || null }));

router.get('/api/app/categorias', (_req, res) => res.json({ categorias: CATEGORIAS, subcategorias: SUBCATEGORIAS }));

// ─── Clientes ────────────────────────────────────────────────────────────
router.get('/api/app/clientes', rota(async (_req, res) => {
    if (!repo) return semRepo(res);
    res.json({ clientes: await repo.listarClientes() });
}));

// ─── App do cliente: o que a consultora faz ─────────────────────────────
const novoToken = () => crypto.randomBytes(18).toString('base64url');
const estadoApp = (c: Cliente) => ({ token: c.app_token || null, ativo: !!c.app_ativo, publicadoEm: c.app_publicado_em || null, temFoto: !!c.app_snapshot });

router.get('/api/app/clientes/:id/app', rota(async (req, res) => {
    if (!repo) return semRepo(res);
    const c = UUID.test(pid(req)) ? await repo.obterCliente(pid(req)) : null;
    if (!c) return res.status(404).json({ error: 'Cliente não encontrado.' });
    res.json(estadoApp(c));
}));

/** Tira a foto da análise atual e publica (cria o link na primeira vez). */
router.post('/api/app/clientes/:id/app/publicar', rota(async (req, res) => {
    if (!repo) return semRepo(res);
    const c = UUID.test(pid(req)) ? await repo.obterCliente(pid(req)) : null;
    if (!c) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const analise = await repo.analiseAtual(c.id, req.usuario!);
    const { docs, apuracao } = await montarApuracao(analise.id);
    if (!docs.length) return res.status(400).json({ error: 'Envie pelo menos um extrato ou fatura antes de publicar para o cliente.' });
    const { base, config } = planoDaAnalise(analise, apuracao, c);
    const foto = montarFoto({
        cliente: c, consultora: req.usuario?.nome || analise.analista || null, base, plano: config,
        parcelamentos: (apuracao.resumo as any).parcelamentos,
        mesesAnalise: Array.from(new Set(apuracao.lancamentos.map(l => l.mesReferencia)))
    });
    const salvo = await repo.salvarApp(c.id, { app_token: c.app_token || novoToken(), app_ativo: true, app_snapshot: foto, app_publicado_em: foto.publicadoEm });
    res.json(estadoApp(salvo!));
}));

/** Novo link: o antigo para de funcionar na hora. */
router.post('/api/app/clientes/:id/app/novo-link', rota(async (req, res) => {
    if (!repo) return semRepo(res);
    const c = UUID.test(pid(req)) ? await repo.obterCliente(pid(req)) : null;
    if (!c) return res.status(404).json({ error: 'Cliente não encontrado.' });
    res.json(estadoApp((await repo.salvarApp(c.id, { app_token: novoToken() }))!));
}));

router.post('/api/app/clientes/:id/app/ativo', rota(async (req, res) => {
    if (!repo) return semRepo(res);
    const c = UUID.test(pid(req)) ? await repo.obterCliente(pid(req)) : null;
    if (!c) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const ativo = !!req.body?.ativo;
    if (ativo && !c.app_snapshot) return res.status(400).json({ error: 'Publique para o cliente antes de ativar o link.' });
    res.json(estadoApp((await repo.salvarApp(c.id, { app_ativo: ativo }))!));
}));

// ─── Painel: carteira + produtividade ────────────────────────────────────
router.get('/api/app/painel', rota(async (_req, res) => {
    if (!repo) return semRepo(res);
    const clientes = await repo.listarClientes();
    const todosDocs: { criado_em: string; custo_usd?: number | null }[] = [];
    const linhas = await Promise.all(clientes.map(async c => {
        const extra = { cpf: c.cpf || null, email: c.email || null };
        if (!c.analise || !c.documentos?.length) return { ...linhaDoPainel(c, c.analise || null, [], null), ...extra };
        const { docs, apuracao } = await montarApuracao(c.analise.id);
        todosDocs.push(...docs);
        return { ...linhaDoPainel(c, c.analise, docs, apuracao), ...extra };
    }));
    res.json({ linhas, produtividade: produtividade(linhas, todosDocs) });
}));

router.post('/api/app/clientes', rota(async (req, res) => {
    if (!repo) return semRepo(res);
    const nome = String(req.body?.nome || '').trim();
    if (!nome) return res.status(400).json({ error: 'Informe o nome do cliente.' });
    const cliente = await repo.criarCliente({ ...req.body, nome }, req.usuario!);
    res.status(201).json({ cliente });
}));

router.patch('/api/app/clientes/:id', rota(async (req, res) => {
    if (!repo) return semRepo(res);
    if (!UUID.test(pid(req))) return res.status(404).json({ error: 'Cliente não encontrado.' });
    if ('nome' in (req.body || {}) && !String(req.body.nome || '').trim()) return res.status(400).json({ error: 'O nome não pode ficar vazio.' });
    const cliente = await repo.atualizarCliente(pid(req), req.body || {});
    if (!cliente) return res.status(404).json({ error: 'Cliente não encontrado.' });
    res.json({ cliente });
}));

// ─── Apuração (cliente + análise + documentos + ajustes, já consolidado) ─
async function montarApuracao(analiseId: string) {
    const docs = await repo!.listarDocumentos(analiseId);
    const ajustesRows = await repo!.listarAjustes(docs.map(d => d.id));
    const ajustes: Record<string, AjusteLancamento> = {};
    for (const a of ajustesRows) ajustes[`${a.documento_id}:${a.lancamento_ref}`] = a;
    const extratos = docs.filter(d => d.tipo === 'extrato');
    const faturas = docs.filter(d => d.tipo === 'fatura');
    const entrada = {
        extratos: extratos.map(d => d.resultado),
        faturas: faturas.map(d => d.resultado),
        idsDocumentos: { extratos: extratos.map(d => d.id), faturas: faturas.map(d => d.id) },
        ajustes
    };
    return { docs, entrada, apuracao: consolidar(entrada) };
}

/** Base da análise + plano salvo pelo analista (ou o sugerido, se ainda não salvou). */
function planoDaAnalise(analise: Analise, apuracao: ReturnType<typeof consolidar>, cliente?: Cliente | null) {
    const base = basePlano(apuracao.lancamentos, apuracao.resumo);
    return { base, config: analise.plano ? normalizarPlano(analise.plano) : planoPadrao(base, cliente?.ficha?.reservaAtual), salvo: !!analise.plano };
}

const resumoDocumento = (d: Documento) => {
    const r = d.resultado || {};
    return {
        id: d.id, tipo: d.tipo, nome_arquivo: d.nome_arquivo, banco: d.banco || r.banco, criado_em: d.criado_em,
        qualidade_ruim: d.qualidade_ruim, motivo_qualidade_ruim: r.motivoQualidadeRuim || null,
        titular: r.titular || null, relatorio: r.relatorioFalado || '',
        lancamentos: Array.isArray(r.transacoes) ? r.transacoes.length : 0,
        // só fatura
        vencimento: r.vencimento || null, valor_total: r.valorTotal ?? null, cartoes: r.cartoes || [],
        produto: r.produto || null, conferencia: r.conferencia || null,
        saldo_financiado: r.saldoFinanciado ?? null, encargos: r.encargosTotal ?? null,
        limite_disponivel: r.limiteDisponivel ?? null, proxima_fatura: r.proximaFatura ?? null,
        total_proximas_faturas: r.totalProximasFaturas ?? null, pagamento_minimo: r.pagamentoMinimo ?? null
    };
};

router.get('/api/app/clientes/:id', rota(async (req, res) => {
    if (!repo) return semRepo(res);
    if (!UUID.test(pid(req))) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const cliente = await repo.obterCliente(pid(req));
    if (!cliente) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const analise = await repo.analiseAtual(cliente.id, req.usuario!);
    const { docs, apuracao } = await montarApuracao(analise.id);
    res.json({ cliente, analise, documentos: docs.map(resumoDocumento), apuracao, plano: planoDaAnalise(analise, apuracao, cliente), evolucao: evolucaoMensal(apuracao.lancamentos) });
}));

// ─── Documentos ──────────────────────────────────────────────────────────
router.post('/api/app/clientes/:id/documentos', upload.single('file'), rota(async (req, res) => {
    const filePath = req.file?.path;
    if (!repo) { apagar(filePath); return semRepo(res); }
    if (!req.file || !filePath) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    const tipo = String(req.body?.tipoDocumento || '').toLowerCase();
    const modulo = MODULOS[tipo];
    if (!modulo) { apagar(filePath); return res.status(400).json({ error: 'Escolha se o documento é extrato bancário ou fatura de cartão.' }); }
    const cliente = UUID.test(pid(req)) ? await repo.obterCliente(pid(req)) : null;
    if (!cliente) { apagar(filePath); return res.status(404).json({ error: 'Cliente não encontrado.' }); }

    const analise = await repo.analiseAtual(cliente.id, req.usuario!);
    const { mimetype, originalname } = req.file;
    const password = req.body?.password ? String(req.body.password) : undefined;
    const jobId = novoJobId();
    const startedAt = Date.now();
    const usuario = req.usuario!;
    jobs.set(jobId, { status: 'processing', tipoDocumento: tipo, startedAt });
    console.log(`[App] Job ${jobId} (${tipo}) — cliente ${cliente.id} — ${originalname}`);

    (async () => {
        try {
            const fileHash = hashArquivo(await fs.promises.readFile(filePath));
            const cacheado = password ? null : await buscarResultadoCacheado(fileHash, tipo, usuario.id || 'admin');
            const usage = novoUsageTotal();
            const result: any = cacheado
                ? { ...cacheado, _custoUSDTotal: 0 }
                : await analisarDocumento(modulo, filePath, mimetype, usage, password, (progress) => {
                    const atual = jobs.get(jobId);
                    if (atual?.status === 'processing') jobs.set(jobId, { ...atual, progress });
                });
            if (!cacheado && !result.qualidadeRuim && result.transacoes?.length) {
                const { _tokensInput, _tokensOutput, _tokensCacheWrite, _tokensCacheRead, _custoUSD, _custoUSDTentativasFalhas, _custoUSDTotal, _modelo, ...limpo } = result;
                await salvarResultadoCache(fileHash, tipo, usuario.id || 'admin', undefined, limpo);
            }
            const { _tokensInput, _tokensOutput, _tokensCacheWrite, _tokensCacheRead, _custoUSD, _custoUSDTentativasFalhas, _custoUSDTotal, _modelo, ...resultado } = result;
            const tempo = (Date.now() - startedAt) / 1000;
            const doc = await repo!.inserirDocumento({
                analise_id: analise.id, tipo: tipo as any, nome_arquivo: originalname, file_hash: fileHash, resultado,
                custo_usd: _custoUSDTotal || 0, tokens_input: _tokensInput || 0, tokens_output: _tokensOutput || 0,
                tokens_cache_write: _tokensCacheWrite || 0, tokens_cache_read: _tokensCacheRead || 0,
                modelo_usado: _modelo || (cacheado ? 'cache' : ''), tempo_processamento: Math.round(tempo * 10) / 10
            });
            jobs.set(jobId, { status: 'completed', tipoDocumento: tipo, result: { documentoId: doc.id, qualidadeRuim: doc.qualidade_ruim }, startedAt, completedAt: Date.now() });
            console.log(`[App] Job ${jobId} salvo como documento ${doc.id} em ${tempo.toFixed(1)}s — custo $${(_custoUSDTotal || 0).toFixed(4)}`);
        } catch (error: any) {
            const ehSenha = error?.code === 'PDF_PASSWORD_REQUIRED' || error?.code === 'PDF_PASSWORD_INCORRECT';
            if (!ehSenha) console.error(`[App] Job ${jobId} falhou:`, error?.message);
            jobs.set(jobId, { status: 'error', tipoDocumento: tipo, error: buildUserFriendlyError(error), errorCode: error?.code || null, startedAt, completedAt: Date.now() });
        } finally {
            apagar(filePath);
        }
    })();

    res.status(202).json({ jobId });
}));

// SÓ NO MODO DE DESENVOLVIMENTO (MIRROR_MODO_DEV=1): importa um resultado pronto,
// sem chamar a IA — usado nos testes locais. Em produção esta rota não existe.
if (MODO_DEV) {
    router.post('/api/app/clientes/:id/documentos-json', rota(async (req, res) => {
        if (!repo) return semRepo(res);
        const tipo = String(req.body?.tipo || '');
        if (!['extrato', 'fatura'].includes(tipo) || !Array.isArray(req.body?.resultado?.transacoes)) return res.status(400).json({ error: 'tipo e resultado.transacoes são obrigatórios.' });
        const cliente = await repo.obterCliente(pid(req));
        if (!cliente) return res.status(404).json({ error: 'Cliente não encontrado.' });
        const analise = await repo.analiseAtual(cliente.id, req.usuario!);
        const resultado = tipo === 'fatura' ? finalizarFatura(req.body.resultado) : req.body.resultado;
        const doc = await repo.inserirDocumento({ analise_id: analise.id, tipo: tipo as any, nome_arquivo: req.body.nome || 'importado.json', resultado,
            custo_usd: Number(req.body.custo_usd) || 0, tempo_processamento: Number(req.body.tempo) || 0 });
        res.status(201).json({ documentoId: doc.id });
    }));
}

router.get('/api/app/jobs/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Processamento não encontrado (pode ter expirado).' });
    const { resultCompleto, ...seguro } = job as any;
    res.json(seguro);
});

router.delete('/api/app/documentos/:id', rota(async (req, res) => {
    if (!repo) return semRepo(res);
    const doc = UUID.test(pid(req)) ? await repo.obterDocumento(pid(req)) : null;
    if (!doc) return res.status(404).json({ error: 'Documento não encontrado.' });
    await repo.excluirDocumento(doc.id);
    res.json({ ok: true });
}));

// ─── Ajustes do analista ─────────────────────────────────────────────────
const SITUACOES = new Set(['incluido', 'excluido', 'entre_contas']);
const CLASSES = new Set(['fixo', 'variavel', 'investimento', 'entrada', 'cartao_vista', 'fora']);

router.put('/api/app/analises/:id/ajustes', rota(async (req, res) => {
    if (!repo) return semRepo(res);
    const analise = UUID.test(pid(req)) ? await repo.obterAnalise(pid(req)) : null;
    if (!analise) return res.status(404).json({ error: 'Análise não encontrada.' });
    const lista = Array.isArray(req.body?.ajustes) ? req.body.ajustes : null;
    if (!lista || !lista.length) return res.status(400).json({ error: 'Nenhum ajuste enviado.' });
    if (lista.length > 2000) return res.status(400).json({ error: 'Ajustes demais de uma vez.' });

    const docs = await repo.listarDocumentos(analise.id);
    const docIds = new Set(docs.map(d => d.id));
    const qtdPorDoc = new Map(docs.map(d => [d.id, Array.isArray(d.resultado?.transacoes) ? d.resultado.transacoes.length : 0]));
    const salvar: Ajuste[] = [];
    const remover: { documento_id: string; lancamento_ref: number }[] = [];
    const texto = (v: any, max: number) => v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, max);

    for (const a of lista) {
        const [docId, refTxt] = String(a?.id || '').split(':');
        const ref = Number(refTxt);
        if (!docIds.has(docId) || !Number.isInteger(ref) || ref < 0 || ref >= (qtdPorDoc.get(docId) || 0)) {
            return res.status(400).json({ error: `Lançamento inválido: ${a?.id}` });
        }
        if (a.situacao != null && !SITUACOES.has(a.situacao)) return res.status(400).json({ error: `Situação inválida: ${a.situacao}` });
        if (a.classe != null && !CLASSES.has(a.classe)) return res.status(400).json({ error: `Classificação inválida: ${a.classe}` });
        const linha: Ajuste = {
            documento_id: docId, lancamento_ref: ref,
            categoria: texto(a.categoria, 80), subcategoria: texto(a.subcategoria, 80),
            observacao: texto(a.observacao, 1000), situacao: a.situacao || null, classe: a.classe || null,
            atualizado_por: req.usuario!.nome, atualizado_por_id: req.usuario!.id
        };
        if (!linha.categoria && !linha.subcategoria && !linha.observacao && !linha.situacao && !linha.classe) remover.push({ documento_id: docId, lancamento_ref: ref });
        else salvar.push(linha);
    }
    await repo.salvarAjustes(salvar, remover);
    const { apuracao } = await montarApuracao(analise.id);
    res.json({ apuracao, plano: planoDaAnalise(analise, apuracao, await repo.obterCliente(analise.cliente_id)), salvoEm: new Date().toISOString() });
}));

router.patch('/api/app/analises/:id', rota(async (req, res) => {
    if (!repo) return semRepo(res);
    const temStatus = req.body?.status !== undefined, temPlano = req.body?.plano !== undefined;
    const status = String(req.body?.status || '');
    if (!temStatus && !temPlano) return res.status(400).json({ error: 'Nada para atualizar.' });
    if (temStatus && !['aberta', 'concluida'].includes(status)) return res.status(400).json({ error: 'Situação da análise inválida.' });
    const analise = UUID.test(pid(req)) ? await repo.obterAnalise(pid(req)) : null;
    if (!analise) return res.status(404).json({ error: 'Análise não encontrada.' });
    // plano: null volta para o sugerido; senão é validado campo a campo
    const plano = temPlano ? (req.body.plano === null ? null : normalizarPlano(req.body.plano)) : undefined;
    await repo.atualizarAnalise(analise.id, { status: temStatus ? status as any : undefined, plano: plano as any });
    res.json({ ok: true, status: temStatus ? status : analise.status, plano });
}));

// ─── Plano do cliente: base + plano + simulação (para outros aplicativos) ─
router.get('/api/app/analises/:id/simulacao', rota(async (req, res) => {
    if (!repo) return semRepo(res);
    const analise = UUID.test(pid(req)) ? await repo.obterAnalise(pid(req)) : null;
    if (!analise) return res.status(404).json({ error: 'Análise não encontrada.' });
    const { apuracao } = await montarApuracao(analise.id);
    const plano = planoDaAnalise(analise, apuracao, await repo.obterCliente(analise.cliente_id));
    const meses = Math.round(Math.min(480, Math.max(12, Number(req.query.meses) || 240)));
    res.json({ ...plano, simulacao: simular(plano.base, plano.config, meses) });
}));

router.get('/api/app/analises/:id/excel', rota(async (req, res) => {
    if (!repo) return semRepo(res);
    const analise = UUID.test(pid(req)) ? await repo.obterAnalise(pid(req)) : null;
    if (!analise) return res.status(404).json({ error: 'Análise não encontrada.' });
    const cliente = await repo.obterCliente(analise.cliente_id);
    const { docs, entrada } = await montarApuracao(analise.id);
    if (!docs.length) return res.status(400).json({ error: 'Esta análise ainda não tem documentos.' });
    const buffer = await gerarExcel({ ...entrada, cliente: cliente?.nome, analista: req.usuario?.nome });
    const nome = `Mirror - ${(cliente?.nome || 'cliente').replace(/[^\p{L}\p{N}\- ]/gu, '').trim()} - ${new Date().toISOString().slice(0, 10)}.xlsx`;
    const nomeAscii = nome.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '_');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${nomeAscii}"; filename*=UTF-8''${encodeURIComponent(nome)}`);
    res.send(buffer);
}));

// ─── Planilha da consultoria (modelo do cliente preenchido) ─────────────
// Lançamentos com o mesmo nome que podem virar uma linha só (o analista escolhe)
router.get('/api/app/analises/:id/planilha/grupos', rota(async (req, res) => {
    if (!repo) return semRepo(res);
    const analise = UUID.test(pid(req)) ? await repo.obterAnalise(pid(req)) : null;
    if (!analise) return res.status(404).json({ error: 'Análise não encontrada.' });
    const { apuracao } = await montarApuracao(analise.id);
    res.json({ grupos: listarGrupos(apuracao.lancamentos) });
}));

router.get('/api/app/analises/:id/planilha', rota(async (req, res) => {
    if (!repo) return semRepo(res);
    const analise = UUID.test(pid(req)) ? await repo.obterAnalise(pid(req)) : null;
    if (!analise) return res.status(404).json({ error: 'Análise não encontrada.' });
    const cliente = await repo.obterCliente(analise.cliente_id);
    const { docs, apuracao } = await montarApuracao(analise.id);
    if (!docs.length) return res.status(400).json({ error: 'Esta análise ainda não tem documentos.' });
    const r = await gerarPlanilhaConsultoria(apuracao.lancamentos, apuracao.resumo.parcelamentos, {
        projetarParcelas: req.query.projetar !== '0', cliente: cliente?.nome,
        juntar: req.query.juntar === '1',
        naoJuntar: String(req.query.separar || '').split('|').map(x => x.trim()).filter(Boolean)
    });
    const nome = `Consultoria - ${(cliente?.nome || 'cliente').replace(/[^\p{L}\p{N}\- ]/gu, '').trim()} - ${new Date().toISOString().slice(0, 10)}.xlsx`;
    const nomeAscii = nome.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, '_');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${nomeAscii}"; filename*=UTF-8''${encodeURIComponent(nome)}`);
    res.setHeader('X-Mirror-Resumo', encodeURIComponent(JSON.stringify({
        meses: r.meses, mesesProjetados: r.mesesProjetados, linhas: r.linhas, aClassificar: r.aClassificar, aClassificarCartao: r.aClassificarCartao, abasCriadas: r.abasCriadas, linhasExtras: r.linhasExtras, juntados: r.juntados.length, agrupados: r.agrupados, avisos: r.avisos
    })));
    res.setHeader('Access-Control-Expose-Headers', 'X-Mirror-Resumo, Content-Disposition');
    res.send(r.buffer);
}));

export default router;
