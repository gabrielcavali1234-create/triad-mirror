// Teste da fatura Itaú com o GABARITO transcrito da fatura real (sem IA, custo zero).
// Confere: (1) todas as conferências fecham com os totais impressos,
//          (2) datas de parcelas antigas vão para o ano anterior,
//          (3) uma linha faltando é apontada no cartão certo,
//          (4) a consolidação identifica que o pagamento do extrato quitou a fatura ANTERIOR.
// Rodar: npm run test:fatura
import fs from 'fs';
import path from 'path';
import { finalizarFatura, ResultadoFatura } from '../src/modules/fatura';
import { consolidar } from '../src/modules/consolidacao';
import { ResultadoExtrato } from '../src/modules/extrato';

const gabarito: ResultadoFatura = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'fatura-itau-gabarito.json'), 'utf8'));

const falhas: string[] = [];
const checar = (ok: boolean, msg: string) => { console.log(`${ok ? '✅' : '❌'} ${msg}`); if (!ok) falhas.push(msg); };

// 1) Conferência completa
const fatura = finalizarFatura(gabarito);
console.log('\n── Conferência ──');
for (const v of fatura.conferencia!.verificacoes) {
    console.log(`   ${v.bateu ? 'ok ' : 'ERR'} ${v.nome.padEnd(38)} declarado ${v.declarado.toFixed(2).padStart(9)} | calculado ${v.calculado.toFixed(2).padStart(9)}`);
}
checar(fatura.conferencia!.bateu === true, 'todas as conferências batem com os totais da fatura');
checar(fatura.conferencia!.verificacoes.length === 6, '6 conferências realizadas (2 cartões, lançamentos atuais, encargos, pagamentos, total)');

// 2) Datas
console.log('\n── Datas ──');
const datas = fatura.transacoes.filter(t => /GABRIEL CAVA|BRAZ PHONE/.test(t.estabelecimento)).map(t => t.data);
checar(datas.join(',') === '2025-10-24,2025-11-14', `parcelas de out/nov foram para 2025 (${datas.join(', ')})`);

// 3) Linha faltando
console.log('\n── Linha faltando (simulação de erro da IA) ──');
const semUmaLinha = finalizarFatura({
    ...gabarito,
    transacoes: gabarito.transacoes.filter(t => !(t.estabelecimento === 'TOTALPASSSAO PAULOBR'))
});
console.log('   ' + semUmaLinha.conferencia!.observacao);
const cartaoAdicional = semUmaLinha.conferencia!.verificacoes.find(v => v.nome.includes('ADICIONAL'))!;
checar(semUmaLinha.conferencia!.bateu === false && !cartaoAdicional.bateu && cartaoAdicional.diferenca === 219,
    'divergência de R$ 219,00 apontada no cartão do adicional');

// 4) Consolidação com um extrato que tem o pagamento de 4.213,00 em julho
console.log('\n── Consolidação ──');
const extrato: ResultadoExtrato = {
    banco: 'Itaú', relatorioFalado: '', qualidadeRuim: false,
    transacoes: [
        { data: '2026-07-05', descricao: 'SALARIO', valor: 9000, tipo: 'CREDITO', categoria: 'Salário' },
        { data: '2026-07-18', descricao: 'ITAU UNIBANCO CARTAO PAGTO', valor: 4213, tipo: 'DEBITO', categoria: 'Pagamento de fatura' }
    ]
};
const r = consolidar({ extratos: [extrato], faturas: [fatura] });
const alerta = r.lancamentos.find(l => l.id === 'extrato-0-1')!.alerta!;
console.log('   ' + alerta.mensagem);
checar(alerta.faturaRelacionada?.relacao === 'anterior', 'pagamento do extrato reconhecido como quitação da fatura ANTERIOR');
checar(r.resumo.totalGastosCartao === 5651.19, `gastos do cartão = lançamentos atuais + encargos (R$ ${r.resumo.totalGastosCartao})`);
checar(r.resumo.compromissoFuturoParcelas === 15842.80 && !r.resumo.compromissoEstimado, 'compromisso futuro usa o total impresso (R$ 15.842,80)');
checar(r.resumo.endividamentoCartao.encargos === 485.16, 'encargos do rotativo = R$ 485,16');
checar(r.resumo.endividamentoCartao.saldoFinanciado === 1924.31 && r.resumo.endividamentoCartao.emRotativo, 'saldo financiado R$ 1.924,31 e cliente em rotativo');
console.log('\n   Top categorias:', r.resumo.gastosPorCategoria.slice(0, 6).map(c => `${c.categoria} R$${c.valor}`).join(' | '));

console.log(falhas.length ? `\n❌ ${falhas.length} falha(s)` : '\n✅ Todos os checks passaram');
process.exit(falhas.length ? 1 : 0);
