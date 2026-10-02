// Gera um Excel de exemplo com o gabarito da fatura real + um extrato fictício.
// Rodar: npx tsx scripts/teste-excel.ts [saida.xlsx]
import fs from 'fs';
import path from 'path';
import { finalizarFatura, ResultadoFatura } from '../src/modules/fatura';
import { ResultadoExtrato } from '../src/modules/extrato';
import { gerarExcel } from '../src/modules/excel';

async function main() {
    const saida = process.argv[2] || 'mirror-exemplo.xlsx';
    const gabarito: ResultadoFatura = JSON.parse(
        fs.readFileSync(path.join(__dirname, 'fixtures', 'fatura-itau-gabarito.json'), 'utf8'));
    const fatura = finalizarFatura(gabarito);
    const extrato: ResultadoExtrato = {
        banco: 'Itaú', titular: 'TITULAR', relatorioFalado: '', qualidadeRuim: false,
        transacoes: [
            { data: '2026-07-05', descricao: 'SALARIO EMPRESA X', valor: 9000, tipo: 'CREDITO', categoria: 'Salário' },
            { data: '2026-07-10', descricao: 'ENEL SP', valor: 210.55, tipo: 'DEBITO', categoria: 'Contas de consumo' },
            { data: '2026-07-18', descricao: 'ITAU UNIBANCO CARTAO PAGTO', valor: 4213, tipo: 'DEBITO', categoria: 'Pagamento de fatura' },
            { data: '2026-07-20', descricao: 'PIX TRANSF JOAO 20/07', valor: 350, tipo: 'DEBITO', categoria: 'Pix Enviado' }
        ]
    };
    // Analista excluiu o pagamento de fatura do extrato (id extrato-0-2)
    const buf = await gerarExcel({ extratos: [extrato], faturas: [fatura], exclusoes: ['extrato-0-2'] });
    fs.writeFileSync(saida, buf);
    console.log(`Excel gerado: ${saida} (${(buf.length / 1024).toFixed(1)} KB)`);
}
main().catch(e => { console.error(e); process.exit(1); });
