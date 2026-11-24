// Fatura no formato do C6 Bank (dados fictícios, valores reais de um caso que divergia):
//  • a anuidade aparece no "Resumo da fatura" e de novo na lista do cartão;
//  • "Pagamento CDB" vem em verde na lista, mas não entra no subtotal do cartão;
//  • "Saldo obrigações futuras" não é só parcelas.
// O sistema precisa limpar isso sozinho e a conferência fechar.
import { finalizarFatura, ResultadoFatura } from '../src/modules/fatura';

const c = (final: string, estabelecimento: string, valor: number, extra: any = {}) =>
    ({ data: '2026-10-15', tipo: 'compra', secao: 'compras', valor, portador: 'CLIENTE TESTE', categoria: 'Outros', cartaoFinal: final, estabelecimento, ...extra });
const f: ResultadoFatura = {
    banco: 'C6 Bank', produto: 'C6 Carbon', titular: 'CLIENTE TESTE', vencimento: '2026-11-10',
    cartoes: [{ portador: 'CLIENTE TESTE', adicional: false }, { final: '1111', portador: 'CLIENTE TESTE', subtotal: 290.62, adicional: false }, { final: '2222', portador: 'CLIENTE TESTE', subtotal: 1631.47, adicional: false }],
    transacoes: [
        { data: '2026-11-03', tipo: 'anuidade', secao: 'compras', valor: 98, portador: 'CLIENTE TESTE', categoria: 'Anuidade', parcelaAtual: 10, parcelaTotal: 12, estabelecimento: 'Anuidade diferenciada - Parcela 10/12' },
        c('1111', 'CERTISI', 8.32, { parcelaAtual: 9, parcelaTotal: 12 }), c('1111', 'AMAZON MARKETPLACE', 55.53, { parcelaAtual: 6, parcelaTotal: 6 }),
        c('1111', 'Pagamento CDB', 177.19, { categoria: 'Investimento' }), c('1111', 'MERCADO', 58.98), c('1111', 'LANCHONETE', 9.99), c('1111', 'LOJA', 49.9), c('1111', 'MARKETPLACE', 9.9),
        { ...c('1111', 'Anuidade Diferenciada', 98, { parcelaAtual: 10, parcelaTotal: 12 }), tipo: 'anuidade', categoria: 'Anuidade' },
        ...[86.83, 158, 20.46, 55.26, 29.9, 59, 53.9, 59, 147.99, 39.78, 25.18, 24.99, 39.9, 147.7, 19.59, 26, 467.05, 34.54, 129.9, 6.5].map((v, i) => c('2222', 'COMPRA ' + i, v))
    ] as any,
    valorTotal: 1921.79, pagamentosEfetuados: 0.3, saldoFaturaAnterior: 0, encargosTotal: 0, totalLancamentosAtuais: 1922.09, totalProximasFaturas: 1545.45,
    qualidadeRuim: false, relatorioFalado: ''
} as any;

const r = finalizarFatura(f);
const falhas: string[] = [];
if (r.conferencia?.bateu !== true) falhas.push('conferência não fechou: ' + r.conferencia?.observacao);
if (r.transacoes.length !== 27) falhas.push(`esperava 27 lançamentos, ficaram ${r.transacoes.length}`);
if (r.transacoes.some(t => /CDB/.test(t.estabelecimento))) falhas.push('Pagamento CDB não saiu');
if (r.transacoes.filter(t => t.tipo === 'anuidade').length !== 1) falhas.push('anuidade continua duplicada');
if ((r.conferencia?.ajustes || []).length !== 3) falhas.push('esperava 3 ajustes explicados');
if (falhas.length) { console.error('❌ Fatura C6:\n - ' + falhas.join('\n - ')); process.exit(1); }
console.log('✅ Fatura C6: anuidade duplicada e linha informativa removidas; conferência fecha em R$ 1.921,79.');
