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
    // ── perfil do cliente
    cidade: string;
    obsRenda: string;                  // observações do passo "Renda e família"
    obsDinheiro: string;               // observações do passo "Dinheiro hoje"
    notas: Nota[];                     // anotações da consultora (aparecem na linha do tempo)
    proximoContato: { data: string | null; motivo: string };
    atas: Ata[];                       // atas de reunião com o cliente
}

export interface Nota { texto: string; em: string; autor: string }

export const FORMATOS_REUNIAO = ['online', 'presencial', 'whatsapp', 'telefone'] as const;
export interface Combinado { texto: string; responsavel: string; prazo: string | null; feito: boolean; feitoEm: string | null }
export interface Ata {
    id: string;
    numero: number;
    titulo: string;
    data: string;                       // YYYY-MM-DD
    hora: string;                       // HH:MM ou ''
    duracao: number | null;             // minutos
    formato: typeof FORMATOS_REUNIAO[number] | null;
    participantes: string;
    temas: string[];
    assuntos: string[];
    combinados: Combinado[];
    proxima: { data: string | null; hora: string };
    observacoes: string;
    nota: number | null;                // nota de saúde financeira no dia
    autor: string;
    criadoEm: string;
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
    const notas: Nota[] = (Array.isArray(v?.notas) ? v.notas : []).flatMap((n: any) => {
        const t = texto(n?.texto, 1000);
        const em = typeof n?.em === 'string' && !Number.isNaN(Date.parse(n.em)) ? n.em : agora.toISOString();
        return t ? [{ texto: t, em, autor: texto(n?.autor, 80) }] : [];
    }).slice(-100);
    const dataOk = (x: any) => /^\d{4}-\d{2}-\d{2}$/.test(String(x || '')) ? String(x) : null;
    const horaOk = (x: any) => /^\d{2}:\d{2}$/.test(String(x || '')) ? String(x) : '';
    const atas: Ata[] = (Array.isArray(v?.atas) ? v.atas : []).flatMap((a: any, i: number) => {
        const data = dataOk(a?.data);
        if (!data) return [];
        const nota = Number(a?.nota);
        return [{
            id: texto(a?.id, 40) || ('ata-' + Date.now().toString(36) + i),
            numero: inteiro(a?.numero, 9999) || i + 1,
            titulo: texto(a?.titulo, 120) || 'Reunião',
            data, hora: horaOk(a?.hora), duracao: inteiro(a?.duracao, 1440),
            formato: umDe(FORMATOS_REUNIAO, a?.formato),
            participantes: texto(a?.participantes, 300),
            temas: (Array.isArray(a?.temas) ? a.temas : []).map((t: any) => texto(t, 40)).filter(Boolean).slice(0, 15),
            assuntos: (Array.isArray(a?.assuntos) ? a.assuntos : []).map((t: any) => texto(t, 2000)).filter(Boolean).slice(0, 30),
            combinados: (Array.isArray(a?.combinados) ? a.combinados : []).flatMap((c: any) => {
                const t = texto(c?.texto, 300);
                return t ? [{ texto: t, responsavel: texto(c?.responsavel, 80), prazo: dataOk(c?.prazo), feito: !!c?.feito, feitoEm: c?.feito ? (dataOk(c?.feitoEm) || agora.toISOString().slice(0, 10)) : null }] : [];
            }).slice(0, 30),
            proxima: { data: dataOk(a?.proxima?.data), hora: horaOk(a?.proxima?.hora) },
            observacoes: texto(a?.observacoes, 2000),
            nota: Number.isFinite(nota) && a?.nota !== null && a?.nota !== '' ? Math.max(0, Math.min(100, Math.round(nota))) : null,
            autor: texto(a?.autor, 80),
            criadoEm: typeof a?.criadoEm === 'string' && !Number.isNaN(Date.parse(a.criadoEm)) ? a.criadoEm : agora.toISOString()
        }];
    }).slice(-300);
    const pcData = /^\d{4}-\d{2}-\d{2}$/.test(String(v?.proximoContato?.data || '')) ? String(v.proximoContato.data) : null;
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
        lgpdEm: lgpd ? (typeof v?.lgpdEm === 'string' && !Number.isNaN(Date.parse(v.lgpdEm)) ? v.lgpdEm : agora.toISOString()) : null,
        cidade: texto(v?.cidade, 80),
        obsRenda: texto(v?.obsRenda, 2000),
        obsDinheiro: texto(v?.obsDinheiro, 2000),
        notas,
        proximoContato: { data: pcData, motivo: texto(v?.proximoContato?.motivo, 200) },
        atas
    };
}
