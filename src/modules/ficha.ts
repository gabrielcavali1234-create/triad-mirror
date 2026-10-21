// ══════════════════════════════════════════════════════════════════════════
// FICHA DO CLIENTE — o que a "entrevista guiada" coleta além dos campos
// básicos do perfil (nome, CPF, telefone, e-mail, renda, objetivo, observação).
// Só o nome é obrigatório; tudo aqui é opcional.
//
// Usos: a reserva atual entra no plano sugerido (modules/plano.ts); os
// objetivos com valor e prazo dizem quanto guardar por mês.
// ══════════════════════════════════════════════════════════════════════════

export const FORMAS_RENDA = ['clt', 'autonomo', 'empresario', 'aposentado', 'outro'] as const;
export const TIPOS_DIVIDA = ['emprestimo', 'veiculo', 'imobiliario', 'consignado', 'cheque_especial', 'outro'] as const;
export const TIPOS_OBJETIVO = ['reserva', 'dividas', 'viagem', 'carro', 'casa', 'aposentadoria', 'outro'] as const;

export interface Divida {
    tipo: typeof TIPOS_DIVIDA[number];
    saldo: number | null;              // quanto falta pagar
    parcela: number | null;
    parcelasRestantes: number | null;
}

export interface Objetivo {
    tipo: typeof TIPOS_OBJETIVO[number];
    descricao: string;
    valor: number | null;
    prazo: string | null;              // YYYY-MM
}

export interface Ficha {
    nascimento: string | null;         // YYYY-MM-DD
    profissao: string;
    formaRenda: typeof FORMAS_RENDA[number] | null;
    dependentes: number | null;        // pessoas que dependem da renda, além do cliente
    outrasRendas: number | null;
    reservaAtual: number | null;
    semDividas: boolean;               // marcou "nenhuma" (diferente de não ter respondido)
    dividas: Divida[];
    objetivos: Objetivo[];
    lgpd: boolean;                     // cliente autorizou o uso dos dados para a análise
    lgpdEm: string | null;             // quando autorizou
}

const texto = (v: any, max: number) => String(v ?? '').trim().slice(0, max);
const dinheiro = (v: any): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : Number(String(v).replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
    return Number.isFinite(n) && n >= 0 ? Math.round(Math.min(n, 1e10) * 100) / 100 : null;
};
const inteiro = (v: any, max: number): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : null;
};
const umDe = <T extends readonly string[]>(lista: T, v: any): T[number] | null => (lista as readonly string[]).includes(v) ? v : null;

/** Valida o que veio da tela. Campo inválido vira vazio; nunca recusa a ficha inteira. */
export function normalizarFicha(v: any, agora = new Date()): Ficha {
    const nasc = /^\d{4}-\d{2}-\d{2}$/.test(String(v?.nascimento || '')) ? String(v.nascimento) : null;
    const nascOk = nasc && nasc >= '1900-01-01' && nasc <= agora.toISOString().slice(0, 10) ? nasc : null;
    const dividas: Divida[] = (Array.isArray(v?.dividas) ? v.dividas : []).flatMap((d: any) => {
        const tipo = umDe(TIPOS_DIVIDA, d?.tipo);
        return tipo ? [{ tipo, saldo: dinheiro(d?.saldo), parcela: dinheiro(d?.parcela), parcelasRestantes: inteiro(d?.parcelasRestantes, 600) }] : [];
    }).slice(0, 8);
    const objetivos: Objetivo[] = (Array.isArray(v?.objetivos) ? v.objetivos : []).flatMap((o: any) => {
        const tipo = umDe(TIPOS_OBJETIVO, o?.tipo);
        if (!tipo) return [];
        const prazo = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(o?.prazo || '')) ? String(o.prazo) : null;
        return [{ tipo, descricao: texto(o?.descricao, 120), valor: dinheiro(o?.valor), prazo }];
    }).slice(0, 3);
    const lgpd = !!v?.lgpd;
    return {
        nascimento: nascOk,
        profissao: texto(v?.profissao, 120),
        formaRenda: umDe(FORMAS_RENDA, v?.formaRenda),
        dependentes: inteiro(v?.dependentes, 20),
        outrasRendas: dinheiro(v?.outrasRendas),
        reservaAtual: dinheiro(v?.reservaAtual),
        semDividas: !!v?.semDividas && !dividas.length,
        dividas,
        objetivos,
        lgpd,
        lgpdEm: lgpd ? (typeof v?.lgpdEm === 'string' && !Number.isNaN(Date.parse(v.lgpdEm)) ? v.lgpdEm : agora.toISOString()) : null
    };
}
