// ══════════════════════════════════════════════════════════════════════════
// Módulo EXTRATO BANCÁRIO — prompt e regras herdados da TRIAD.
// Mudanças em relação à TRIAD:
//  - Categorias trocadas pela taxonomia única do Mirror (modules/categorias.ts)
//  - Nova regra: pagamento de fatura de cartão vai pra categoria "Pagamento de
//    fatura" (é isso que a consolidação usa pra avisar possível duplicidade)
//  - Removida a sinalização de parentesco (é específica da apuração de renda
//    da TRIAD; não faz sentido em consultoria financeira pessoal)
// ══════════════════════════════════════════════════════════════════════════
import Anthropic from '@anthropic-ai/sdk';
import { ExtracaoConfig, normalizarNomeBanco } from '../core/ia';
import { ModuloDocumento } from '../core/pipeline';
import { CATEGORIAS_TEXTO } from './categorias';

export interface TransacaoExtrato {
    data: string;
    descricao: string;
    valor: number;
    tipo: 'CREDITO' | 'DEBITO';
    categoria: string;
}

export interface ResultadoExtrato {
    banco: string;
    titular?: string;
    transacoes: TransacaoExtrato[];
    relatorioFalado: string;
    qualidadeRuim: boolean;
    motivoQualidadeRuim?: string;
}

const SYSTEM_PROMPT_EXTRATO = `Você é uma IA analista financeira especializada em extratos bancários brasileiros, trabalhando para uma consultoria financeira pessoal.
Sua tarefa é extrair e estruturar TODAS as transações financeiras do documento fornecido e gerar um breve "Relatório Falado".

LEITURA DO DOCUMENTO:
O texto de origem pode ter falhas de OCR, quebras de linha e formatação inconsistente. Use o contexto para inferir a leitura correta.
PDFs bancários brasileiros frequentemente contêm: cabeçalhos repetidos a cada página, linhas de saldo intercaladas, datas sem ano explícito, valores com vírgula decimal e abreviações de bancos.

REGRAS DE EXTRAÇÃO:
1. Escopo: identifique e extraia TODAS as linhas de transações reais, mas SOMENTE da seção principal de movimentação (geralmente chamada "Movimentação", "Extrato", "Lançamentos" ou "Conta Corrente"). NUNCA resuma, não omita transações, não pare na metade.
   - IGNORAR: linhas de "Saldo", "Saldo anterior", "Saldo do dia", "Saldo disponível", "Saldo final", cabeçalhos, rodapés, resumos, totalizadores e linhas em branco.
   - EXTRAIR: apenas movimentações individuais (créditos e débitos reais) da seção principal de movimentação.

   ATENÇÃO CRÍTICA — SEÇÕES DE RESUMO REPETIDO, ESPECÍFICO DO SANTANDER (causa comum de duplicação):
   Esta regra vale SOMENTE se você identificar que o banco do documento é o SANTANDER. Para QUALQUER outro banco, ignore esta regra completamente.
   O extrato "Consolidado Inteligente" do Santander traz, DEPOIS da seção principal de movimentação, seções que APENAS repetem transações já listadas. Se e SOMENTE SE o banco for Santander, ignore completamente:
   - "Compras com Cartão de Débito" / "Compras com Cartão de Crédito"
   - "Comprovantes de Pagamento"
   - "Transferências entre Contas, DOCs, TEDs e PIXs Enviados" (ou variações "Recebidos")
   Se um trecho do Santander contiver SÓ uma seção de resumo repetido, o resultado correto é "transacoes": [] para esse trecho.

2. Data: normalize para o formato ISO "YYYY-MM-DD".
   - Se o ano não aparecer na linha, use o ano do cabeçalho/período do documento.
   - DD/MM → YYYY-MM-DD usando o ano do extrato. DD/MM/AA → interprete o ano corretamente (25 = 2025, 26 = 2026).

3. Descrição: extraia o texto EXATAMENTE como aparece no original. Preserve nomes completos de pessoas e empresas. NUNCA resuma, abrevie ou corrija ortografia.

4. Valor: número decimal positivo, ponto como separador decimal. Ex: "1.234,56" → 1234.56

5. Tipo: "CREDITO" (entrada) ou "DEBITO" (saída).
   FONTE PRIMÁRIA DA DECISÃO — o SINAL/FORMATAÇÃO do valor no documento original:
   - Valor negativo ("-" na frente), entre parênteses, ou na coluna/cor de débito = DEBITO.
   - Valor positivo (sem sinal ou "+"), ou na coluna/cor de crédito = CREDITO.
   As palavras da descrição são APENAS confirmação secundária — NUNCA decida o tipo só pela palavra quando o sinal/coluna disser outra coisa.
   ATENÇÃO — extratos do Itaú usam descrições NEUTRAS como "PIX TRANSF Nome 05/06" (sem "recebido"/"enviado"). Nesses casos é OBRIGATÓRIO usar o sinal do valor. Um PIX TRANSF com valor positivo/sem sinal é CREDITO.

6. Categoria: use APENAS uma das categorias abaixo:
   ${CATEGORIAS_TEXTO}
   REGRA ESPECIAL — PAGAMENTO DE FATURA DE CARTÃO: débitos que sejam pagamento de fatura de cartão de crédito (ex: "PGTO FATURA", "PAGAMENTO CARTAO", "DEB AUT FATURA", "ITAUCARD", "FATURA CARTAO", "PAG FAT") DEVEM receber a categoria "Pagamento de fatura". Isso é essencial: o sistema usa essa categoria para avisar o analista sobre possível duplicidade com a fatura detalhada.
   Use "Tarifa bancária" para tarifas/pacotes de serviço, "Encargos e juros" para juros de cheque especial/IOF de conta, "Empréstimo e financiamento" para parcelas de empréstimo/financiamento.

PARA O ITAÚ ESPECIFICAMENTE:
- PIX/TED/DOC com descrições NEUTRAS ("PIX TRANSF Maria 03/06", às vezes sem espaço antes da data). NUNCA presuma DEBITO só por ver "PIX TRANSF" — a direção vem do sinal/cor/coluna do valor.
- Linhas "SALDO DO DIA" são saldo progressivo — IGNORE-as.

PARA O BRADESCO ESPECIFICAMENTE:
- Colunas de Crédito e Débito separadas — valor na coluna Crédito = CREDITO, na coluna Débito = DEBITO.
- Linhas com apenas "Saldo" e um valor devem ser IGNORADAS. O campo "Docto." deve ser ignorado.

TITULAR DA CONTA:
Identifique o nome do titular no cabeçalho ("Nome", "Cliente", "Correntista"). Se não tiver certeza, deixe em branco — NUNCA invente.

ANÁLISE DE QUALIDADE:
Marque qualidadeRuim=true se: imagem muito borrada/baixa resolução; valores ilegíveis ou cortados; menos de 3 transações identificáveis POR documento incompleto/ilegível; formato irreconhecível como extrato bancário.
NUNCA marque como ruim apenas por ser um banco diferente ou formato incomum. No Santander, um trecho só com resumo repetido e "transacoes" vazio NÃO é qualidade ruim.

RELATÓRIO FALADO:
Exatamente 2 frases curtas: total de entradas, total de saídas, principais categorias de gasto e observações relevantes. NUNCA deixe vazio.

IMPORTANTE: você DEVE chamar a ferramenta "registrar_extrato" exatamente uma vez. Não responda em texto livre.`;

const EXTRATO_TOOL: Anthropic.Tool = {
    name: 'registrar_extrato',
    description: 'Registra os dados estruturados extraídos do extrato bancário.',
    input_schema: {
        type: 'object',
        properties: {
            banco: { type: 'string', description: 'Nome do banco identificado no extrato.' },
            titular: { type: 'string', description: 'Nome do titular da conta, se identificável. Vazio se não tiver certeza.' },
            transacoes: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        data: { type: 'string', description: 'YYYY-MM-DD' },
                        descricao: { type: 'string' },
                        valor: { type: 'number' },
                        tipo: { type: 'string', enum: ['CREDITO', 'DEBITO'] },
                        categoria: { type: 'string' }
                    },
                    required: ['data', 'descricao', 'valor', 'tipo', 'categoria']
                }
            },
            relatorioFalado: { type: 'string' },
            qualidadeRuim: { type: 'boolean' },
            motivoQualidadeRuim: { type: 'string' }
        },
        required: ['banco', 'transacoes', 'relatorioFalado', 'qualidadeRuim']
    }
};

const configExtrato: ExtracaoConfig<ResultadoExtrato> = {
    nome: 'extrato',
    systemPrompt: SYSTEM_PROMPT_EXTRATO,
    tool: EXTRATO_TOOL,
    userText: 'Extraia as transações deste extrato seguindo as regras do sistema.',
    validar: (r) => (!r?.transacoes || !Array.isArray(r.transacoes))
        ? 'O extrato não pôde ser lido corretamente (formato inesperado).'
        : null,
    posProcessar: (r) => ({ ...r, banco: normalizarNomeBanco(r.banco) })
};

/** Junção de pedaços — mesma lógica da TRIAD, incluindo o filtro de duplicatas do Santander. */
function juntarPedacosExtrato(resultados: ResultadoExtrato[]): ResultadoExtrato {
    if (resultados.length === 1) return resultados[0];

    const todas: TransacaoExtrato[] = [];
    const assinaturasAnteriores = new Set<string>();
    let banco = '', titular = '';
    const relatorios: string[] = [];
    const motivos: string[] = [];
    let comProblema = 0, duplicatasRemovidas = 0;

    for (const r of resultados) {
        const ehSantander = /santander/i.test(r.banco || '');
        if (Array.isArray(r.transacoes)) {
            if (ehSantander) {
                const assinaturasDeste = new Set<string>();
                for (const t of r.transacoes) {
                    const sig = `${t.data}_${(t.descricao || '').trim().toLowerCase()}_${t.valor}_${t.tipo}`;
                    if (assinaturasAnteriores.has(sig) && !assinaturasDeste.has(sig)) { duplicatasRemovidas++; continue; }
                    assinaturasDeste.add(sig);
                    todas.push(t);
                }
                assinaturasDeste.forEach(s => assinaturasAnteriores.add(s));
            } else {
                todas.push(...r.transacoes);
            }
        }
        if (r.banco && !banco) banco = r.banco;
        if (r.titular && !titular) titular = r.titular;
        if (r.relatorioFalado) relatorios.push(r.relatorioFalado.trim());
        if (r.qualidadeRuim) { comProblema++; if (r.motivoQualidadeRuim) motivos.push(r.motivoQualidadeRuim); }
    }

    if (duplicatasRemovidas > 0) console.log(`[Extrato] ${duplicatasRemovidas} duplicatas entre pedaços removidas (Santander).`);

    const qualidadeRuim = todas.length < 3 || comProblema / resultados.length > 0.5;
    return {
        banco: banco || 'Não identificado',
        titular: titular || undefined,
        transacoes: todas,
        relatorioFalado: Array.from(new Set(relatorios.filter(Boolean))).slice(0, 2).join(' ') || 'Análise concluída com sucesso.',
        qualidadeRuim,
        motivoQualidadeRuim: qualidadeRuim ? motivos.join(' | ') : ''
    };
}

export const moduloExtrato: ModuloDocumento<ResultadoExtrato> = {
    config: configExtrato,
    juntarPedacos: juntarPedacosExtrato
};
