// Roda a extração REAL (chama a IA) numa fatura em PDF e compara com um gabarito.
// Uso: npx tsx scripts/extrair-fatura.ts caminho/fatura.pdf [caminho/gabarito.json]
// Precisa de ANTHROPIC_API_KEY no .env. Custa uma chamada de IA (~US$ 0,10–0,30 por fatura).
import '../src/env';
import fs from 'fs';
import path from 'path';
import { novoUsageTotal } from '../src/core/ia';
import { analisarDocumento } from '../src/core/pipeline';
import { moduloFatura, ResultadoFatura, TransacaoFatura } from '../src/modules/fatura';

async function main() {
    const [pdf, gabaritoPath] = process.argv.slice(2);
    if (!pdf) { console.error('Uso: npx tsx scripts/extrair-fatura.ts fatura.pdf [gabarito.json]'); process.exit(1); }

    const usage = novoUsageTotal();
    const r: any = await analisarDocumento(moduloFatura, pdf, 'application/pdf', usage);
    const saida = pdf.replace(/\.pdf$/i, '') + '.extraido.json';
    fs.writeFileSync(saida, JSON.stringify(r, null, 2));

    console.log(`\nCusto: US$ ${r._custoUSDTotal.toFixed(4)} | modelo: ${r._modelo} | ${r.transacoes.length} lançamentos`);
    console.log(`Resultado salvo em ${saida}\n`);
    console.log('── Conferência contra os totais impressos ──');
    for (const v of r.conferencia.verificacoes) {
        console.log(`  ${v.bateu ? 'ok ' : 'ERR'} ${v.nome.padEnd(38)} declarado ${v.declarado.toFixed(2).padStart(9)} | calculado ${v.calculado.toFixed(2).padStart(9)}`);
    }
    console.log('  ' + r.conferencia.observacao);

    if (!gabaritoPath) return;
    const gab: ResultadoFatura = JSON.parse(fs.readFileSync(path.resolve(gabaritoPath), 'utf8'));
    const chave = (t: TransacaoFatura) => `${t.secao}|${t.tipo}|${t.valor.toFixed(2)}`;
    const restantes = new Map<string, number>();
    for (const t of gab.transacoes) restantes.set(chave(t), (restantes.get(chave(t)) || 0) + 1);

    const sobrando: TransacaoFatura[] = [];
    for (const t of r.transacoes as TransacaoFatura[]) {
        const n = restantes.get(chave(t)) || 0;
        if (n > 0) restantes.set(chave(t), n - 1); else sobrando.push(t);
    }
    const faltando = [...restantes.entries()].filter(([, n]) => n > 0);

    console.log('\n── Comparação com o gabarito (seção | tipo | valor) ──');
    console.log(`  Lançamentos: extraídos ${r.transacoes.length} | gabarito ${gab.transacoes.length}`);
    faltando.forEach(([k, n]) => console.log(`  FALTOU   ${k}${n > 1 ? ` (x${n})` : ''}`));
    sobrando.forEach(t => console.log(`  SOBROU   ${chave(t)}  ${t.estabelecimento}`));

    // Campos comparáveis mesmo com nomes anonimizados no gabarito
    const comparaveis: (keyof TransacaoFatura)[] = ['data', 'parcelaAtual', 'parcelaTotal', 'categoria'];
    let divergenciasCampo = 0;
    const usados = new Set<number>();
    for (const g of gab.transacoes) {
        const i = (r.transacoes as TransacaoFatura[]).findIndex((t, idx) => !usados.has(idx) && chave(t) === chave(g) && t.data === g.data);
        if (i < 0) continue;
        usados.add(i);
        const t = r.transacoes[i];
        for (const c of comparaveis) {
            if ((g[c] ?? null) !== (t[c] ?? null)) {
                divergenciasCampo++;
                console.log(`  CAMPO    ${g.estabelecimento} — ${c}: esperado "${g[c] ?? ''}", veio "${t[c] ?? ''}"`);
            }
        }
    }
    const ok = faltando.length === 0 && sobrando.length === 0;
    console.log(`\n${ok ? '✅' : '❌'} Lançamentos ${ok ? 'idênticos ao gabarito' : 'divergentes'} | ${divergenciasCampo} divergência(s) de data/parcela/categoria (categoria é opinativa, avalie caso a caso)`);
}

main().catch(e => { console.error(e); process.exit(1); });
