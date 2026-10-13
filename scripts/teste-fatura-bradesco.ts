// Teste da fatura BRADESCO com o GABARITO transcrito da fatura real (sem IA, custo zero).
// Confere: (1) as conferências fecham com os totais impressos — inclusive com DOIS
//              cartões do MESMO titular (separados pelo final);
//          (2) datas de parcelas de nov/dez vão para o ano anterior;
//          (3) uma linha faltando é apontada no cartão certo (pelo final);
//          (4) parcelas e compromisso futuro na consolidação.
// Rodar: npm run test:bradesco
import fs from 'fs';
import path from 'path';
import { finalizarFatura, ResultadoFatura } from '../src/modules/fatura';
import { consolidar } from '../src/modules/consolidacao';

const gabarito: ResultadoFatura = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'fatura-bradesco-gabarito.json'), 'utf8'));
const falhas: string[] = [];
const checar = (ok: boolean, msg: string) => { console.log(`${ok ? '✅' : '❌'} ${msg}`); if (!ok) falhas.push(msg); };

const fatura = finalizarFatura(gabarito);
console.log('\n── Conferência ──');
for (const v of fatura.conferencia!.verificacoes)
    console.log(`   ${v.bateu ? 'ok ' : 'ERR'} ${v.nome.padEnd(42)} declarado ${v.declarado.toFixed(2).padStart(9)} | calculado ${v.calculado.toFixed(2).padStart(9)}`);
checar(fatura.conferencia!.bateu === true, 'todas as conferências batem com os totais da fatura');
checar(fatura.conferencia!.verificacoes.length === 6, '6 conferências (2 cartões, compras/débitos, pagamentos, total, parcelas futuras)');
checar(fatura.conferencia!.verificacoes.some(v => v.nome.includes('final 4163')), 'cartões do mesmo titular aparecem separados pelo final');

console.log('\n── Datas ──');
const dd = fatura.transacoes.find(t => t.estabelecimento === 'DD PAULISTA SHOPPING')!.data;
const ec = fatura.transacoes.find(t => t.estabelecimento === 'EC *AVENIDARIO')!.data;
checar(dd === '2025-11-28' && ec === '2026-01-24', `nov/25 corrigido, jan/26 mantido (${dd}, ${ec})`);

console.log('\n── Linha faltando (simulação de erro da IA) ──');
const sem = finalizarFatura({ ...gabarito, transacoes: gabarito.transacoes.filter(t => t.estabelecimento !== 'MMOPTICS') });
console.log('   ' + sem.conferencia!.observacao);
const v4163 = sem.conferencia!.verificacoes.find(v => v.nome.includes('4163'))!;
const v9635 = sem.conferencia!.verificacoes.find(v => v.nome.includes('9635'))!;
checar(!v4163.bateu && v4163.diferenca === 379.31 && v9635.bateu, 'divergência de R$ 379,31 apontada no cartão final 4163 (e só nele)');

console.log('\n── Parcela grudada no nome ──');
const turk = fatura.transacoes.find(t => t.estabelecimento.startsWith('TURKISH'))!;
checar(turk.parcelaAtual === 3 && turk.parcelaTotal === 5, `TURKISH AIRL5010340003/05 → parcela ${turk.parcelaAtual}/${turk.parcelaTotal}`);

console.log('\n── Consolidação ──');
const r = consolidar({ extratos: [], faturas: [fatura] });
checar(r.resumo.totalGastosCartao === 6784.41, `gastos do cartão = R$ ${r.resumo.totalGastosCartao}`);
checar(r.resumo.compromissoFuturoParcelas === 8758.23, `compromisso futuro = R$ ${r.resumo.compromissoFuturoParcelas} (impresso: 8.758,23)`);
const pm = r.resumo.parcelamentos;
console.log('   Calendário:', pm.porMes.map((m: any) => `${m.mes} R$${m.valor}`).join(' | '));
checar(pm.porMes[0].mes === '2026-05' && pm.porMes.at(-1)!.mes === '2027-02', `parcelas de mai/26 até fev/27 (MMOPTICS 3/12 termina em fev/27)`);
checar(r.lancamentos.filter(l => l.parceladoAutomatico).length === 13, '13 parcelas vão sozinhas para "Cartão parcelado"');

console.log(falhas.length ? `\n❌ ${falhas.length} falha(s)` : '\n✅ Todos os checks passaram');
process.exit(falhas.length ? 1 : 0);
