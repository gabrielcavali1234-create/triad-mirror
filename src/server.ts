// ══════════════════════════════════════════════════════════════════════════
// TRIAD Mirror — servidor
// Rotas:
//   POST /api/mirror/analyze-async   (multipart: file, tipoDocumento=extrato|fatura, password?, userId?, orgId?)
//   GET  /api/mirror/status/:jobId
//   POST /api/mirror/consolidar      (json: { extratos, faturas, exclusoes?, inclusoes? })
//   POST /api/mirror/save-cost       (json: { jobId, extractionId })
// ══════════════════════════════════════════════════════════════════════════
import './env'; // precisa ser o primeiro import
import fs from 'fs';
import path from 'path';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { novoUsageTotal } from './core/ia';
import { analisarDocumento, ModuloDocumento } from './core/pipeline';
import { buscarResultadoCacheado, hashArquivo, salvarResultadoCache, supabaseAdmin, TABELA_EXTRACOES } from './core/supabase';
import { buildUserFriendlyError, jobs, novoJobId, sanitizarResultado } from './core/jobs';
import { moduloExtrato } from './modules/extrato';
import { moduloFatura } from './modules/fatura';
import { consolidar } from './modules/consolidacao';

const app = express();
const port = process.env.PORT || 3002; // 3001 é a TRIAD — assim os dois rodam na mesma VPS

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const uploadDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
    storage: multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, uploadDir),
        filename: (_req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
    }),
    limits: { fileSize: 100 * 1024 * 1024 }
});

console.log('Starting TRIAD Mirror server');
console.log('ANTHROPIC_API_KEY present:', !!process.env.ANTHROPIC_API_KEY);

const MODULOS: Record<string, ModuloDocumento<any>> = {
    extrato: moduloExtrato,
    fatura: moduloFatura
};

const apagar = (p?: string) => { if (p) { try { fs.unlinkSync(p); } catch { /* já foi */ } } };
const logErro = (e: any) => fs.appendFileSync('error_log.txt', new Date().toISOString() + ': ' + (e?.stack || e?.message) + '\n');

// ─── Análise assíncrona (extrato ou fatura) ───────────────────────────────
app.post('/api/mirror/analyze-async', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });

    const tipoDocumento = String(req.body?.tipoDocumento || '').toLowerCase();
    const modulo = MODULOS[tipoDocumento];
    if (!modulo) {
        apagar(req.file.path);
        return res.status(400).json({ error: 'tipoDocumento deve ser "extrato" ou "fatura".' });
    }

    const { path: filePath, mimetype: mimeType, originalname } = req.file;
    const password = req.body?.password as string | undefined;
    const userId = req.body?.userId as string | undefined;
    const orgId = req.body?.orgId as string | undefined;
    const jobId = novoJobId();
    const startedAt = Date.now();

    jobs.set(jobId, { status: 'processing', tipoDocumento, startedAt });
    console.log(`[Fila] Job ${jobId} (${tipoDocumento}) — ${originalname}`);

    (async () => {
        try {
            const fileHash = hashArquivo(await fs.promises.readFile(filePath));
            const cacheado = password ? null : await buscarResultadoCacheado(fileHash, tipoDocumento, userId, orgId);

            let result: any;
            if (cacheado) {
                result = { ...cacheado, _custoUSDTotal: 0, _reaproveitado: true };
                console.log(`[Cache] Job ${jobId} — arquivo idêntico já analisado, custo $0.`);
            } else {
                result = await analisarDocumento(modulo, filePath, mimeType, novoUsageTotal(), password, (progress) => {
                    const atual = jobs.get(jobId);
                    if (atual?.status === 'processing') jobs.set(jobId, { ...atual, progress });
                });
                if (!result.qualidadeRuim && result.transacoes?.length > 0 && userId) {
                    await salvarResultadoCache(fileHash, tipoDocumento, userId, orgId, sanitizarResultado(result));
                }
            }

            const completedAt = Date.now();
            const processingTime = cacheado ? '0.1' : ((completedAt - startedAt) / 1000).toFixed(1);
            const resultCompleto = { ...result, tipoDocumento, processingTime };
            jobs.set(jobId, { status: 'completed', tipoDocumento, result: sanitizarResultado(resultCompleto), resultCompleto, startedAt, completedAt });
            console.log(`[Fila] Job ${jobId} concluído em ${processingTime}s — custo: $${(result._custoUSDTotal || 0).toFixed(4)} | modelo(s): ${result._modelo || 'cache'}`);
        } catch (error: any) {
            const ehSenha = error?.code === 'PDF_PASSWORD_REQUIRED' || error?.code === 'PDF_PASSWORD_INCORRECT';
            if (!ehSenha) { console.error(`[Fila] Job ${jobId} falhou:`, error.message); logErro(error); }
            jobs.set(jobId, { status: 'error', tipoDocumento, error: buildUserFriendlyError(error), errorCode: error?.code || null, startedAt });
        } finally {
            apagar(filePath);
        }
    })();

    res.status(202).json({ jobId });
});

app.get('/api/mirror/status/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job não encontrado.' });
    const { resultCompleto, ...jobSeguro } = job;
    res.json(jobSeguro);
});

// ─── Consolidação (sem IA, custo zero — chamar de novo a cada ajuste do analista) ──
app.post('/api/mirror/consolidar', (req, res) => {
    try {
        const { extratos = [], faturas = [], exclusoes = [], inclusoes = [] } = req.body || {};
        if (!Array.isArray(extratos) || !Array.isArray(faturas)) {
            return res.status(400).json({ error: '"extratos" e "faturas" devem ser listas.' });
        }
        if (extratos.length === 0 && faturas.length === 0) {
            return res.status(400).json({ error: 'Envie ao menos um extrato ou uma fatura.' });
        }
        res.json(consolidar({ extratos, faturas, exclusoes, inclusoes }));
    } catch (error: any) {
        console.error('[Consolidar] Erro:', error);
        res.status(500).json({ error: 'Falha ao consolidar.', details: error.message });
    }
});

// ─── Gravação de custo (mesma lógica da TRIAD, tabela própria do Mirror) ──
app.post('/api/mirror/save-cost', async (req, res) => {
    try {
        const { jobId, extractionId } = req.body || {};
        if (!jobId || !extractionId) return res.status(400).json({ error: 'jobId e extractionId são obrigatórios.' });
        if (!supabaseAdmin) return res.status(500).json({ error: 'Gravação de custo indisponível: Supabase não configurado.' });

        const job = jobs.get(jobId);
        if (!job?.resultCompleto) return res.status(404).json({ error: 'Dados de custo não encontrados para este job (pode ter expirado).' });
        const r = job.resultCompleto;

        const { data: existente, error: fetchError } = await supabaseAdmin
            .from(TABELA_EXTRACOES)
            .select('tokens_input, tokens_output, tokens_cache_write, tokens_cache_read, custo_usd, modelo_usado')
            .eq('id', extractionId).single();
        if (fetchError) throw fetchError;

        const modelos = Array.from(new Set([
            ...(existente?.modelo_usado || '').split('+'),
            ...(r._modelo || '').split('+')
        ].filter(Boolean))).join('+');

        const { error: updateError } = await supabaseAdmin.from(TABELA_EXTRACOES).update({
            tipo_documento: job.tipoDocumento,
            tokens_input: (existente?.tokens_input || 0) + (r._tokensInput || 0),
            tokens_output: (existente?.tokens_output || 0) + (r._tokensOutput || 0),
            tokens_cache_write: (existente?.tokens_cache_write || 0) + (r._tokensCacheWrite || 0),
            tokens_cache_read: (existente?.tokens_cache_read || 0) + (r._tokensCacheRead || 0),
            custo_usd: (existente?.custo_usd || 0) + (r._custoUSDTotal || 0),
            modelo_usado: modelos
        }).eq('id', extractionId);
        if (updateError) throw updateError;

        res.json({ ok: true });
    } catch (error: any) {
        console.error('[save-cost] Erro:', error.message);
        res.status(500).json({ error: 'Falha ao gravar custo.', details: error.message });
    }
});

process.on('uncaughtException', (err) => { console.error('CRITICAL uncaughtException:', err); logErro(err); });
process.on('unhandledRejection', (reason) => console.error('CRITICAL unhandledRejection:', reason));

// ─── Frontend estático (mesmo esquema da TRIAD) ───────────────────────────
const distPath = path.join(process.cwd(), 'dist');
const indexPath = path.join(distPath, 'index.html');
if (fs.existsSync(indexPath)) {
    console.log('[Servidor] Servindo frontend de /dist');
    app.use(express.static(distPath, { dotfiles: 'allow' }));
    app.get(/(.*)/, (_req, res) => res.sendFile(indexPath, { dotfiles: 'allow' }));
} else {
    console.log('[Servidor] /dist não encontrado — rodando só como API');
}

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('Express error handler:', err);
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Arquivo excede o limite de 100MB.' });
    res.status(err.status || 500).json({ error: 'Erro interno no servidor.', details: err.message });
});

app.listen(port, () => console.log(`✅ TRIAD Mirror rodando na porta ${port}`));
