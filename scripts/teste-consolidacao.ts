// Teste rápido da consolidação com dados fictícios (não chama a IA, custo zero).
// Rodar: npm run test:consolidacao
import { consolidar } from '../src/modules/consolidacao';
import { conferirFatura, ResultadoFatura } from '../src/modules/fatura';
import { ResultadoExtrato } from '../src/modules/extrato';

const extrato: ResultadoExtrato = {
    banco: 'Itaú', titular: 'MARIA SILVA', relatorioFalado: '', qualidadeRuim: false,
    transacoes: [
        { data: '2026-09-05', descricao: 'SALARIO EMPRESA X', valor: 8000, tipo: 'CREDITO', categoria: 'Salário' },
        { data: '2026-09-10', descricao: 'PGTO FATURA CARTAO ITAU', valor: 1530.4, tipo: 'DEBITO', categoria: 'Pagamento de fatura' },
        { data: '2026-09-12', descricao: 'PIX TRANSF JOAO 12/09', valor: 300, tipo: 'DEBITO', categoria: 'Pix Enviado' },
        { data: '2026-09-15', descricao: 'ENEL SP', valor: 210.55, tipo: 'DEBITO', categoria: 'Contas de consumo' }
    ]
};

const fatura: ResultadoFatura = {
    banco: 'Itaú', vencimento: '2026-09-10', valorTotal: 1530.4,
    saldoFaturaAnterior: 1200, pagamentosEfetuados: 1200,
    cartoes: [{ final: '1234', portador: 'MARIA SILVA' }],
    relatorioFalado: '', qualidadeRuim: false,
    transacoes: [
        { data: '2026-08-12', estabelecimento: 'PAGAMENTO EFETUADO', valor: 1200, tipo: 'pagamento', categoria: 'Pagamento de fatura' },
        { data: '2026-08-14', estabelecimento: 'SUPERMERCADO BOM', valor: 650.2, tipo: 'compra', categoria: 'Supermercado' },
        { data: '2026-06-20', estabelecimento: 'MAGAZINE LUIZA', valor: 300, tipo: 'compra', categoria: 'Compras', parcelaAtual: 3, parcelaTotal: 10 },
        { data: '2026-08-20', estabelecimento: 'NETFLIX', valor: 55.9, tipo: 'compra', categoria: 'Assinaturas' },
        { data: '2026-08-22', estabelecimento: 'AMAZON US', valor: 500, tipo: 'compra', categoria: 'Compras', internacional: true, moedaOriginal: 'USD', valorMoedaOriginal: 92.5, cotacao: 5.4 },
        { data: '2026-08-22', estabelecimento: 'REPASSE DE IOF', valor: 17.3, tipo: 'iof', categoria: 'IOF' },
        { data: '2026-08-25', estabelecimento: 'ESTORNO SUPERMERCADO BOM', valor: 50, tipo: 'estorno', categoria: 'Supermercado' },
        { data: '2026-09-01', estabelecimento: 'ANUIDADE DIFERENCIADA', valor: 57, tipo: 'anuidade', categoria: 'Anuidade' }
    ]
};
fatura.conferencia = conferirFatura(fatura);

const r1 = consolidar({ extratos: [extrato], faturas: [fatura] });
console.log('── Padrão (analista ainda não mexeu) ──');
console.log(JSON.stringify(r1.resumo, null, 2));
console.log('Conferência fatura:', r1.conferenciaFaturas[0]);
console.log('Alerta no pagamento:', r1.lancamentos.find(l => l.id === 'extrato-0-1')?.alerta?.mensagem);

const r2 = consolidar({ extratos: [extrato], faturas: [fatura], exclusoes: ['extrato-0-1'] });
console.log('\n── Analista excluiu o pagamento de fatura do extrato ──');
console.log('totalSaidas:', r1.resumo.totalSaidas, '→', r2.resumo.totalSaidas);

const falhas: string[] = [];
if (!fatura.conferencia.bateu) falhas.push('conferência da fatura deveria bater');
if (r1.resumo.pagamentosDeFaturaNoExtrato.aindaIncluidosNoResumo !== 1) falhas.push('pagamento deveria continuar incluído por padrão');
if (r2.resumo.totalSaidas !== Math.round((r1.resumo.totalSaidas - 1530.4) * 100) / 100) falhas.push('exclusão deveria abater 1530.40');
console.log(falhas.length ? `\n❌ ${falhas.join('; ')}` : '\n✅ Todos os checks passaram');
process.exit(falhas.length ? 1 : 0);
