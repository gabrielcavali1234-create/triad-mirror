// ══════════════════════════════════════════════════════════════════════════
// Núcleo de IA — herdado da TRIAD (server_index.ts), generalizado para servir
// qualquer tipo de documento (extrato, fatura, ...). Cada módulo passa o seu
// próprio prompt + ferramenta; o resto (fallback de modelo, limitador global,
// custo) é o mesmo motor que já roda em produção na TRIAD.
// ══════════════════════════════════════════════════════════════════════════
import Anthropic from '@anthropic-ai/sdk';

export const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export const MODELS_TO_TRY = [
    'claude-sonnet-5',
    'claude-sonnet-4-6',
    'claude-haiku-4-5-20251001'
];

// ─── Preços (idêntico à TRIAD) ────────────────────────────────────────────
const SONNET_5_INTRO_CUTOFF = new Date('2026-09-01T00:00:00Z');

interface PrecoModelo {
    input: number;
    output: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
    cacheRead: number;
}

export function getPrecoModelo(modelName: string, atDate: Date = new Date()): PrecoModelo {
    const base: Record<string, { input: number; output: number }> = {
        'claude-sonnet-5': atDate < SONNET_5_INTRO_CUTOFF
            ? { input: 2.00, output: 10.00 }
            : { input: 3.00, output: 15.00 },
        'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
        'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00 }
    };
    const p = base[modelName] || { input: 3.00, output: 15.00 };
    return {
        input: p.input,
        output: p.output,
        cacheWrite5m: p.input * 1.25,
        cacheWrite1h: p.input * 2.00,
        cacheRead: p.input * 0.1
    };
}

export function calcularCustoChamada(modelName: string, usage: any): number {
    const precos = getPrecoModelo(modelName);
    const inputTokens = usage?.input_tokens || 0;
    const outputTokens = usage?.output_tokens || 0;
    const cacheReadTokens = usage?.cache_read_input_tokens || 0;
    const cache5m = usage?.cache_creation?.ephemeral_5m_input_tokens ?? 0;
    const cache1h = usage?.cache_creation?.ephemeral_1h_input_tokens ?? (usage?.cache_creation_input_tokens || 0);

    return (
        (inputTokens / 1_000_000) * precos.input +
        (outputTokens / 1_000_000) * precos.output +
        (cache5m / 1_000_000) * precos.cacheWrite5m +
        (cache1h / 1_000_000) * precos.cacheWrite1h +
        (cacheReadTokens / 1_000_000) * precos.cacheRead
    );
}

// ─── Uso acumulado por job ────────────────────────────────────────────────
export interface UsageTotal {
    tokensInput: number;
    tokensOutput: number;
    tokensCacheWrite: number;
    tokensCacheRead: number;
    custoUSD: number;
    custoUSDTentativasFalhas: number;
    modelosUsados: Set<string>;
}

export function novoUsageTotal(): UsageTotal {
    return {
        tokensInput: 0, tokensOutput: 0, tokensCacheWrite: 0, tokensCacheRead: 0,
        custoUSD: 0, custoUSDTentativasFalhas: 0, modelosUsados: new Set()
    };
}

function somarTokens(usageTotal: UsageTotal, usage: any, modelName: string) {
    usageTotal.tokensInput += usage?.input_tokens || 0;
    usageTotal.tokensOutput += usage?.output_tokens || 0;
    usageTotal.tokensCacheWrite += usage?.cache_creation_input_tokens || 0;
    usageTotal.tokensCacheRead += usage?.cache_read_input_tokens || 0;
    usageTotal.modelosUsados.add(modelName);
}

export function anexarUsage<T extends object>(result: T, usageTotal: UsageTotal) {
    return {
        ...result,
        _tokensInput: usageTotal.tokensInput,
        _tokensOutput: usageTotal.tokensOutput,
        _tokensCacheWrite: usageTotal.tokensCacheWrite,
        _tokensCacheRead: usageTotal.tokensCacheRead,
        _custoUSD: usageTotal.custoUSD,
        _custoUSDTentativasFalhas: usageTotal.custoUSDTentativasFalhas,
        _custoUSDTotal: usageTotal.custoUSD + usageTotal.custoUSDTentativasFalhas,
        _modelo: Array.from(usageTotal.modelosUsados).join('+')
    };
}

// ─── Limitador global de chamadas simultâneas (idêntico à TRIAD) ──────────
// Ajuste via LIMITE_CHAMADAS_SIMULTANEAS conforme o tier no Console da Anthropic.
// ATENÇÃO: se o Mirror rodar na MESMA conta Anthropic da TRIAD, os dois
// servidores dividem o mesmo limite de taxa — some os dois limites ao ajustar.
const LIMITE_CHAMADAS_SIMULTANEAS = Number(process.env.LIMITE_CHAMADAS_SIMULTANEAS) || 3;

let chamadasEmAndamento = 0;
const filaDeEsperaGlobal: Array<() => void> = [];

function aguardarVagaGlobal(): Promise<void> {
    if (chamadasEmAndamento < LIMITE_CHAMADAS_SIMULTANEAS) {
        chamadasEmAndamento++;
        return Promise.resolve();
    }
    return new Promise<void>(resolve => {
        filaDeEsperaGlobal.push(() => {
            chamadasEmAndamento++;
            resolve();
        });
    });
}

function liberarVagaGlobal(): void {
    chamadasEmAndamento--;
    const proximo = filaDeEsperaGlobal.shift();
    if (proximo) proximo();
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function buildContentBlock(base64Data: string, mimeType: string): any {
    if (mimeType === 'application/pdf') {
        return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Data } };
    }
    const supportedImageTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    const finalMime = supportedImageTypes.includes(mimeType) ? mimeType : 'image/jpeg';
    return { type: 'image', source: { type: 'base64', media_type: finalMime, data: base64Data } };
}

// ─── Configuração que cada módulo (extrato, fatura...) fornece ────────────
export interface ExtracaoConfig<T> {
    nome: string;                       // usado só nos logs
    systemPrompt: string;
    tool: Anthropic.Tool;
    userText: string;
    maxTokens?: number;
    /** Retorna mensagem de erro se o resultado vier malformado, ou null se ok. */
    validar: (result: any) => string | null;
    /** Ajustes finais no resultado (ex: normalizar nome do banco). */
    posProcessar?: (result: T) => T;
}

export async function callClaudeWithFallback<T>(
    config: ExtracaoConfig<T>,
    base64Data: string,
    mimeType: string,
    usageTotal: UsageTotal
): Promise<T> {
    let lastError: any = null;

    for (let i = 0; i < MODELS_TO_TRY.length; i++) {
        const modelName = MODELS_TO_TRY[i];
        await aguardarVagaGlobal();
        try {
            console.log(`[IA:${config.nome}] Tentativa ${i + 1}/${MODELS_TO_TRY.length} com modelo: ${modelName}`);
            const startTime = Date.now();

            const stream = anthropic.messages.stream({
                model: modelName,
                max_tokens: config.maxTokens ?? 30000,
                system: [
                    { type: 'text', text: config.systemPrompt, cache_control: { type: 'ephemeral', ttl: '1h' } as any }
                ],
                tools: [config.tool],
                tool_choice: { type: 'tool', name: config.tool.name },
                messages: [{
                    role: 'user',
                    content: [buildContentBlock(base64Data, mimeType), { type: 'text', text: config.userText }]
                }]
            } as any);
            const response = await stream.finalMessage();

            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            const custoDestaChamada = calcularCustoChamada(modelName, response.usage);
            const toolUse: any = response.content.find((b: any) => b.type === 'tool_use');

            const erroValidacao = !toolUse
                ? 'O modelo não retornou dados estruturados (sem tool_use).'
                : config.validar(toolUse.input);

            if (erroValidacao) {
                console.error(`[IA:${config.nome}] DIAGNÓSTICO — stop_reason: ${response.stop_reason} | tokens de saída: ${response.usage?.output_tokens}`);
                usageTotal.custoUSDTentativasFalhas += custoDestaChamada;
                somarTokens(usageTotal, response.usage, modelName);
                throw new Error(erroValidacao);
            }

            somarTokens(usageTotal, response.usage, modelName);
            usageTotal.custoUSD += custoDestaChamada;

            let result = toolUse.input as T;
            if (config.posProcessar) result = config.posProcessar(result);

            console.log(`[IA:${config.nome}] Sucesso com ${modelName} em ${elapsed}s. Custo desta chamada: $${custoDestaChamada.toFixed(4)}`);
            return result;

        } catch (error: any) {
            lastError = error;
            const status = error?.status;
            const mensagemErro = error?.message || '';
            console.error(`[IA:${config.nome}] Falha com ${modelName} (status ${status}):`, mensagemErro);

            if (/maximum of 100 pdf pages/i.test(mensagemErro)) {
                throw new Error('Este documento não pôde ser dividido automaticamente em pedaços menores e ultrapassa o limite de 100 páginas por envio. Entre em contato com o suporte levando esse arquivo específico.');
            }
            if (status === 429 || status === 529) await sleep(1500);
        } finally {
            liberarVagaGlobal();
        }
    }

    throw lastError || new Error('Falha desconhecida ao processar com a IA.');
}

export function normalizarNomeBanco(banco?: string): string {
    if (!banco) return '';
    return banco.toLowerCase().split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
