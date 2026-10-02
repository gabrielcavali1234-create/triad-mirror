// Gera a planilha da consultoria com dados de exemplo (sem IA) e confere se o
// modelo foi preenchido sem alterar nada do que já existia.
// Rodar: npx tsx scripts/teste-planilha.ts [saida.xlsx]
import fs from 'fs';
import path from 'path';
import { consolidar } from '../src/modules/consolidacao';
import { finalizarFatura } from '../src/modules/fatura';
import { gerarPlanilhaConsultoria } from '../src/modules/planilha';

async function main() {
    const saida = process.argv[2] || 'consultoria-exemplo.xlsx';
    const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'extratos-exemplo.json'), 'utf8'));
    const fatura = finalizarFatura(JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'fatura-itau-gabarito.json'), 'utf8')));
    const ids = { extratos: ['ext-itau', 'ext-nu'], faturas: ['fat-itau'] };
    // Classificação que um analista faria (o resto fica "a classificar")
    const regras: [RegExp, string][] = [
        [/SALARIO/, 'entrada'], [/ENEL|ESCOLA/, 'fixo'], [/AUTO POSTO|PADARIA|SUPERMERCADO|FARMACIA|RECEITA/, 'variavel'],
        [/CARTAO PAGTO/, 'fora']
    ];
    const ajustes: Record<string, any> = {};
    [fx.itau, fx.nubank].forEach((e: any, di: number) => e.transacoes.forEach((t: any, i: number) => {
        const r = regras.find(([re]) => re.test(t.descricao));
        if (r) ajustes[`${ids.extratos[di]}:${i}`] = { classe: r[1] };
        if (/MARIA/.test(t.descricao)) ajustes[`${ids.extratos[di]}:${i}`] = { situacao: 'entre_contas' };
    }));
    const ap = consolidar({ extratos: [fx.itau, fx.nubank], faturas: [fatura], idsDocumentos: ids, ajustes });
    const r = await gerarPlanilhaConsultoria(ap.lancamentos, ap.resumo.parcelamentos, { projetarParcelas: true });
    fs.writeFileSync(saida, r.buffer);
    console.log(JSON.stringify({ meses: r.meses, projetados: r.mesesProjetados, linhas: r.linhas, aClassificar: r.aClassificar, agrupados: r.agrupados, avisos: r.avisos }, null, 1));
}
main().catch(e => { console.error(e); process.exit(1); });
