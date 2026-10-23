// Teste da API da aplicação (login, clientes, documentos, ajustes, Excel) em
// MODO DE DESENVOLVIMENTO — banco em memória, sem IA, custo zero.
// Rodar: npm run test:app   (sobe o servidor sozinho numa porta livre)
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const PORTA = 3991;
const BASE = `http://127.0.0.1:${PORTA}`;
const CHAVE = 'chave-de-teste-123';
const falhas: string[] = [];
const ok = (cond: any, msg: string) => { console.log(`${cond ? '✅' : '❌'} ${msg}`); if (!cond) falhas.push(msg); };

async function api(metodo: string, rota: string, corpo?: any, token?: string) {
    const r = await fetch(BASE + rota, {
        method: metodo,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: corpo ? JSON.stringify(corpo) : undefined
    });
    const tipo = r.headers.get('content-type') || '';
    return { status: r.status, corpo: tipo.includes('json') ? await r.json() : await r.arrayBuffer(), headers: r.headers };
}

async function main() {
    const srv = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
        env: { ...process.env, PORT: String(PORTA), MIRROR_MODO_DEV: '1', MIRROR_ACCESS_KEY: CHAVE, SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', ANTHROPIC_API_KEY: '' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    srv.stdout.on('data', d => { log += d; });
    srv.stderr.on('data', d => { log += d; });
    try {
        for (let i = 0; i < 60 && !log.includes('rodando na porta'); i++) await new Promise(r => setTimeout(r, 250));
        ok(log.includes('rodando na porta'), 'servidor subiu em modo de desenvolvimento');

        // Login
        ok((await api('POST', '/api/auth/login', { email: 'ana@consultoria.com', senha: 'errada' })).status === 401, 'senha errada é recusada');
        const login = await api('POST', '/api/auth/login', { email: 'ana.paula@consultoria.com', senha: CHAVE });
        ok(login.status === 200 && login.corpo.token, 'login funciona');
        const T = login.corpo.token;
        ok(login.corpo.usuario.nome === 'Ana Paula', `nome do analista vem do e-mail (${login.corpo.usuario.nome})`);
        ok((await api('GET', '/api/app/clientes')).status === 401, 'sem login não lista clientes');
        const ren = await api('POST', '/api/auth/renovar', { renovacao: login.corpo.renovacao });
        ok(ren.status === 200 && ren.corpo.token && ren.corpo.token !== T, 'renovação de sessão funciona');

        // Cliente
        ok((await api('POST', '/api/app/clientes', { nome: '  ' }, T)).status === 400, 'cliente sem nome é recusado');
        const c = await api('POST', '/api/app/clientes', { nome: 'Maria Aparecida Souza', cpf: '000.000.000-00', objetivo: 'Sair do rotativo', renda_declarada: '9000' }, T);
        ok(c.status === 201 && c.corpo.cliente.criado_por_nome === 'Ana Paula', 'cliente criado com o analista responsável');
        const cid = c.corpo.cliente.id;
        ok(c.corpo.cliente.renda_declarada === 9000, 'renda declarada salva como número');

        // Documentos (importação sem IA)
        const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'extratos-exemplo.json'), 'utf8'));
        const fatura = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'fatura-itau-gabarito.json'), 'utf8'));
        for (const [tipo, resultado, nome] of [['extrato', fx.itau, 'extrato-itau.pdf'], ['extrato', fx.nubank, 'extrato-nubank.pdf'], ['fatura', fatura, 'fatura-itau.pdf']] as const) {
            const d = await api('POST', `/api/app/clientes/${cid}/documentos-json`, { tipo, resultado, nome }, T);
            ok(d.status === 201, `documento importado: ${nome}`);
        }

        // Apuração
        const ap = await api('GET', `/api/app/clientes/${cid}`, undefined, T);
        ok(ap.status === 200, 'perfil do cliente abre');
        const L = ap.corpo.apuracao.lancamentos as any[];
        ok(ap.corpo.documentos.length === 3 && L.length === 14 + 4 + 47, `todos os lançamentos (${L.length})`);
        ok(L.every(l => /^[0-9a-f-]{36}:\d+$/.test(l.id)), 'ids estáveis no formato documento:posição');
        const pix = L.filter(l => l.alerta?.tipo === 'possivel_entre_contas');
        ok(pix.length === 2, `transferência entre contas detectada nos dois bancos (${pix.length})`);
        const pagto = L.find(l => /CARTAO PAGTO/.test(l.descricao));
        ok(pagto?.alerta?.faturaRelacionada?.relacao === 'anterior' && pagto.situacao === 'incluido', 'pagamento de fatura no extrato: incluído com aviso (regra combinada)');
        ok(L.find(l => /ESCOLA/.test(l.descricao))?.subcategoria === 'Escola', 'subcategoria chega na apuração');
        const saidas0 = ap.corpo.apuracao.resumo.totalSaidas;

        // Ajustes
        const aid = ap.corpo.analise.id;
        const aj = await api('PUT', `/api/app/analises/${aid}/ajustes`, { ajustes: [
            ...pix.map(l => ({ id: l.id, situacao: 'entre_contas' })),
            { id: pagto.id, situacao: 'excluido', observacao: 'Fatura anterior; detalhes não estão nesta análise' },
            { id: L.find(l => /PADARIA/.test(l.descricao)).id, categoria: 'Alimentação', subcategoria: 'Cafeteria' }
        ] }, T);
        ok(aj.status === 200, 'ajustes salvos');
        const L2 = aj.corpo.apuracao.lancamentos as any[];
        ok(L2.filter(l => l.situacao === 'entre_contas').length === 2, 'duas transferências marcadas como entre contas');
        const esperado = Math.round((saidas0 - 1500 - 4213) * 100) / 100;
        ok(aj.corpo.apuracao.resumo.totalSaidas === esperado, `saídas recalculadas (${saidas0} → ${aj.corpo.apuracao.resumo.totalSaidas})`);
        ok(L2.find(l => /PADARIA/.test(l.descricao))?.subcategoria === 'Cafeteria', 'troca de subcategoria');
        ok(L2.find(l => l.id === pagto.id)?.observacao?.startsWith('Fatura anterior'), 'observação salva');
        ok((await api('PUT', `/api/app/analises/${aid}/ajustes`, { ajustes: [{ id: pagto.id + '9', situacao: 'excluido' }] }, T)).status === 400, 'lançamento inexistente é recusado');
        ok((await api('PUT', `/api/app/analises/${aid}/ajustes`, { ajustes: [{ id: pagto.id, situacao: 'xpto' }] }, T)).status === 400, 'situação inválida é recusada');

        // Reverter ajuste (tudo vazio = volta ao que a IA leu)
        const rv = await api('PUT', `/api/app/analises/${aid}/ajustes`, { ajustes: [{ id: L.find(l => /PADARIA/.test(l.descricao)).id }] }, T);
        ok(rv.corpo.apuracao.lancamentos.find((l: any) => /PADARIA/.test(l.descricao)).subcategoria === 'Padaria', 'ajuste revertido volta para a subcategoria da IA');

        // Persistência: reabrir
        const ap2 = await api('GET', `/api/app/clientes/${cid}`, undefined, T);
        ok(ap2.corpo.apuracao.resumo.totalSaidas === esperado, 'ajustes continuam lá ao reabrir o cliente');

        // Lista de clientes
        const lista = await api('GET', '/api/app/clientes', undefined, T);
        const item = lista.corpo.clientes.find((x: any) => x.id === cid);
        ok(item?.documentos.length === 3 && item.documentos.some((d: any) => d.em_rotativo), 'lista de clientes mostra documentos e alerta de rotativo');

        // Excel
        const x = await api('GET', `/api/app/analises/${aid}/excel`, undefined, T);
        ok(x.status === 200 && (x.corpo as ArrayBuffer).byteLength > 10000, `Excel gerado (${((x.corpo as ArrayBuffer).byteLength / 1024).toFixed(0)} KB)`);
        const saida = process.argv[2];
        if (saida) fs.writeFileSync(saida, Buffer.from(x.corpo as ArrayBuffer));

        // Classificação para a planilha da consultoria
        const L3 = (await api('GET', `/api/app/clientes/${cid}`, undefined, T)).corpo.apuracao.lancamentos as any[];
        ok(L3.filter((l: any) => l.origem === 'extrato').every((l: any) => l.classe === null), 'tudo começa "a classificar" (decisão da consultoria)');
        const sal = L3.find((l: any) => /SALARIO/.test(l.descricao) && l.data.startsWith('2026-08'));
        const esc = L3.find((l: any) => /ESCOLA/.test(l.descricao) && l.data.startsWith('2026-08'));
        const cl = await api('PUT', `/api/app/analises/${aid}/ajustes`, { ajustes: [{ id: sal.id, classe: 'entrada' }, { id: esc.id, classe: 'fixo' }] }, T);
        ok(cl.status === 200 && cl.corpo.apuracao.lancamentos.find((l: any) => l.id === esc.id).classe === 'fixo', 'classificação salva');
        ok((await api('PUT', `/api/app/analises/${aid}/ajustes`, { ajustes: [{ id: esc.id, classe: 'luxo' }] }, T)).status === 400, 'classificação inválida é recusada');
        // Cartão: à vista e parcelas começam "a classificar"; parcela só aceita fixo ou variável
        const vistaC = L3.filter((l: any) => l.origem === 'fatura' && l.situacao === 'incluido' && !l.parcelaCartao);
        const parcC = L3.filter((l: any) => l.parcelaCartao && l.situacao === 'incluido');
        ok(vistaC.length > 0 && vistaC.every((l: any) => l.classe === null), `compras à vista do cartão começam "a classificar" (${vistaC.length})`);
        ok(parcC.length > 3 && parcC.every((l: any) => l.origem === 'fatura' && l.parcelaFim && l.classe === null), `parcelas do cartão começam "a classificar" (${parcC.length})`);
        const parcV = parcC[0], parcPend = parcC[1], parcInval = parcC[2], parcFixas = parcC.slice(3);
        const clC = await api('PUT', `/api/app/analises/${aid}/ajustes`, { ajustes: [
            { id: vistaC[0].id, classe: 'cartao_vista' }, { id: vistaC[1].id, classe: 'fixo' },
            { id: parcV.id, classe: 'variavel' }, { id: parcInval.id, classe: 'cartao_vista' },
            ...parcFixas.map((l: any) => ({ id: l.id, classe: 'fixo' }))
        ] }, T);
        const LC = clC.corpo.apuracao.lancamentos as any[];
        const classeDe = (id: string) => LC.find((l: any) => l.id === id).classe;
        ok(clC.status === 200 && classeDe(vistaC[0].id) === 'cartao_vista' && classeDe(vistaC[1].id) === 'fixo', 'compra do cartão classificada pelo analista (à vista do mês / custo fixo)');
        ok(classeDe(parcV.id) === 'variavel' && parcFixas.every((l: any) => classeDe(l.id) === 'fixo'), 'parcela classificada pelo analista como custo fixo ou variável');
        ok(classeDe(parcInval.id) === null && classeDe(parcPend.id) === null, 'parcela não aceita outra classe e continua "a classificar"');
        const pl = await api('GET', `/api/app/analises/${aid}/planilha`, undefined, T);
        const resumoPl = JSON.parse(decodeURIComponent(pl.headers.get('x-mirror-resumo') || '{}'));
        ok(pl.status === 200 && (pl.corpo as ArrayBuffer).byteLength > 20000, `planilha da consultoria gerada (${((pl.corpo as ArrayBuffer).byteLength / 1024).toFixed(0)} KB)`);
        ok(resumoPl.meses?.includes('2026-08') && resumoPl.aClassificar > 0 && resumoPl.aClassificarCartao === vistaC.length - 2 + 2, `resumo da planilha: meses ${resumoPl.meses}, ${resumoPl.aClassificar} da conta e ${resumoPl.aClassificarCartao} do cartão a classificar (à vista e parcelas)`);
        const itensProj = (clC.corpo.apuracao.resumo.parcelamentos.itens as any[]).filter(i => ['fixo', 'variavel'].includes(classeDe(i.id)));
        const fimEsperado = itensProj.reduce((m: string, i: any) => (i.fim > m ? i.fim : m), '');
        ok(!!fimEsperado && resumoPl.mesesProjetados?.at(-1) === fimEsperado, `só parcelas classificadas são projetadas, até a última (${resumoPl.mesesProjetados?.at(-1)})`);
        // Confere na planilha: variável no "Cartão à vista do mês" (coluna M), fixa em "Cartão parcelado" (coluna P), pendente fora
        const ExcelJS = (await import('exceljs')).default;
        const wbPl = new ExcelJS.Workbook();
        await wbPl.xlsx.load(Buffer.from(pl.corpo as ArrayBuffer) as any);
        const MESES_ABA = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
        const abaDe = (l: any) => wbPl.getWorksheet(MESES_ABA[Number(l.mesReferencia.slice(5, 7)) - 1])!;
        const coluna = (ws: any, col: string) => { const v: string[] = []; ws.getColumn(col).eachCell((c: any) => v.push(String(c.value ?? ''))); return v; };
        const nome = (l: any) => l.descricao.replace(/\s+—\s+[^—]+$/, '').trim();
        const wsV = abaDe(parcV);
        ok(coluna(wsV, 'M').some(v => v === `${nome(parcV)} (${parcV.parcela})`), `parcela variável no bloco "Cartão à vista do mês" (${nome(parcV)} ${parcV.parcela})`);
        ok(!coluna(wsV, 'P').includes(nome(parcV)), 'parcela variável não aparece em "Cartão parcelado"');
        ok(coluna(abaDe(parcFixas[0]), 'P').includes(nome(parcFixas[0])), `parcela fixa no bloco "Cartão parcelado" (${nome(parcFixas[0])})`);
        const wsP = abaDe(parcPend), pend = nome(parcPend);
        ok(!coluna(wsP, 'P').includes(pend) && !coluna(wsP, 'M').some(v => v.startsWith(pend + ' (')), `parcela "a classificar" fica fora da planilha (${pend})`);
        if (process.argv[3]) fs.writeFileSync(process.argv[3], Buffer.from(pl.corpo as ArrayBuffer));

        // Ficha do cliente (entrevista guiada): só o nome é obrigatório
        const fNova = await api('POST', '/api/app/clientes', { nome: 'Cliente Só Nome' }, T);
        ok(fNova.status === 201 && fNova.corpo.cliente.ficha == null, 'cliente com só o nome é aceito');
        const fc = await api('POST', '/api/app/clientes', { nome: 'Roberto Nunes', renda_declarada: 12500, ficha: {
            nascimento: '1979-08-21', profissao: 'Engenheiro', formaRenda: 'empresario', dependentes: 2, reservaAtual: '8.000,50',
            dividas: [{ tipo: 'veiculo', saldo: 32000, parcela: 1450, parcelasRestantes: 26 }, { tipo: 'agiota', saldo: 1 }],
            objetivos: [{ tipo: 'reserva', descricao: 'Reserva', valor: 60000, prazo: '2029-12' }, { tipo: 'viagem', valor: -5, prazo: '2027-13' },
                { tipo: 'carro' }, { tipo: 'casa' }], lgpd: true } }, T);
        const FI = fc.corpo.cliente?.ficha;
        ok(fc.status === 201 && FI.reservaAtual === 8000.5 && FI.formaRenda === 'empresario' && FI.dependentes === 2 && FI.nascimento === '1979-08-21', 'ficha salva (reserva em formato brasileiro, forma de renda, dependentes, nascimento)');
        ok(FI.dividas.length === 1 && FI.objetivos.length === 3 && FI.objetivos[1].valor === null && FI.objetivos[1].prazo === null && FI.lgpd && !!FI.lgpdEm, 'ficha validada: tipo inválido descartado, no máximo 3 objetivos, valor/prazo inválidos viram vazio, data da autorização LGPD');
        const fe = await api('PATCH', `/api/app/clientes/${fc.corpo.cliente.id}`, { ficha: { ...FI, nascimento: '2999-01-01', semDividas: true, dividas: [] } }, T);
        ok(fe.status === 200 && fe.corpo.cliente.ficha.nascimento === null && fe.corpo.cliente.ficha.semDividas === true && fe.corpo.cliente.nome === 'Roberto Nunes', 'ficha editada (nascimento no futuro recusado, "nenhuma dívida")');
        const fp = await api('GET', `/api/app/clientes/${fc.corpo.cliente.id}`, undefined, T);
        ok(fp.corpo.plano.config.reservaAtual === 8000.5, 'reserva da ficha entra no plano sugerido');

        // Plano do cliente (simulação "e se você mudar?")
        const cp = await api('GET', `/api/app/clientes/${cid}`, undefined, T);
        const PB = cp.corpo.plano?.base, PC = cp.corpo.plano?.config;
        ok(PB && PB.emRotativo && Math.abs(PB.jurosMensal - 485.16) < 0.01 && Math.abs(PB.saldoRotativo - 1924.31) < 0.01, `base do plano: juros ${PB?.jurosMensal}/mês, rotativo ${PB?.saldoRotativo}`);
        ok(PB.rendaMensal > 0 && PB.custoVidaEstimado > 0 && PB.mediaPorCategoria.every((c: any, k: number, a: any[]) => !k || a[k - 1].valor >= c.valor), `renda média ${PB.rendaMensal} e custo de vida ${PB.custoVidaEstimado}, categorias da maior para a menor`);
        ok(cp.corpo.plano.salvo === false && PC.sairRotativo && PC.cortes.length === 2 && PC.cortes.every((c: any) => c.percentual === 30), `plano sugerido: sair do rotativo + ${PC.cortes.map((c: any) => c.categoria).join(', ')}`);
        const aidP = cp.corpo.analise.id;
        ok((await api('PATCH', `/api/app/analises/${aidP}`, {}, T)).status === 400, 'atualizar análise sem nada é recusado');
        const sp = await api('PATCH', `/api/app/analises/${aidP}`, { plano: { taxaAno: 99, reservaAtual: -5, mesesReserva: 6, sairRotativo: true,
            cortes: [{ categoria: 'Assinaturas', percentual: 150, titulo: '' }, { categoria: 'Inventada', percentual: 10 }, { categoria: 'Assinaturas', percentual: 10 }] } }, T);
        const SP = sp.corpo.plano;
        ok(sp.status === 200 && SP.taxaAno === 30 && SP.reservaAtual === 0 && SP.cortes.length === 1 && SP.cortes[0].percentual === 100 && SP.cortes[0].titulo === 'Revisar as assinaturas',
            'plano salvo e validado (limites, categoria inexistente e repetida descartadas, título padrão)');
        const si = await api('GET', `/api/app/analises/${aidP}/simulacao?meses=120`, undefined, T);
        const SI = si.corpo.simulacao, assin = PB.mediaPorCategoria.find((c: any) => c.categoria === 'Assinaturas').valor;
        ok(si.status === 200 && si.corpo.salvo === true && SI.pontos.length === 121 && Math.abs(SI.economiaMensal - (485.16 + assin)) < 0.02, `simulação: ${SI.economiaMensal}/mês (juros + 100% das assinaturas)`);
        ok(SI.mesQuitaRotativo === Math.ceil(1924.31 / SI.economiaMensal) && SI.pontos[120].comMudancas > 0 && SI.pontos[120].jurosPagos === Math.round(485.16 * 120 * 100) / 100, `rotativo quitado no mês ${SI.mesQuitaRotativo}; juros em 10 anos sem mudar: ${SI.pontos[120].jurosPagos}`);
        const vf = SI.pontos[120].comMudancas, i = Math.pow(1.3, 1 / 12) - 1;
        ok(SI.pontos[2].comMudancas < SI.pontos[3].comMudancas && vf < SI.economiaMensal * (Math.pow(1 + i, 120) - 1) / i, 'investimento cresce mês a mês e fica abaixo de investir desde o 1º mês (rotativo vem antes)');
        const zp = await api('PATCH', `/api/app/analises/${aidP}`, { plano: null }, T);
        ok(zp.status === 200 && (await api('GET', `/api/app/clientes/${cid}`, undefined, T)).corpo.plano.salvo === false, 'plano volta ao sugerido');

        // Painel da carteira
        const pn = await api('GET', '/api/app/painel', undefined, T);
        const lp = pn.corpo.linhas?.find((x: any) => x.clienteId === cid);
        ok(pn.status === 200 && lp && lp.status === 'em_revisao' && lp.emRotativo && lp.renda === 9000, `painel: cliente em revisão, rotativo, renda declarada (${lp?.renda})`);
        ok(lp.pctRendaEmParcelas > 0 && lp.meses.length >= 2 && lp.alertas.includes('Rotativo no cartão'), `painel: ${Math.round(lp.pctRendaEmParcelas)}% da renda em parcelas, ${lp.meses.length} meses`);
        ok(pn.corpo.produtividade && typeof pn.corpo.produtividade.documentosLidos === 'number' && pn.corpo.produtividade.porMes.length === 6, 'painel: produtividade com os últimos 6 meses');
        const cli = await api('GET', `/api/app/clientes/${cid}`, undefined, T);
        ok(Array.isArray(cli.corpo.evolucao) && cli.corpo.evolucao.some((m: any) => m.temFatura && m.parcelas > 0), 'evolução mês a mês com parcelas do cartão');

        // Concluir análise
        ok((await api('PATCH', `/api/app/analises/${aid}`, { status: 'concluida' }, T)).status === 200, 'análise concluída');

        // Excluir documento
        const docNu = ap2.corpo.documentos.find((d: any) => d.banco === 'Nubank');
        ok((await api('DELETE', `/api/app/documentos/${docNu.id}`, undefined, T)).status === 200, 'documento excluído');

        // Rota de API inexistente devolve JSON
        const nx = await api('GET', '/api/app/naoexiste', undefined, T);
        ok(nx.status === 404 && typeof nx.corpo === 'object', 'rota inexistente responde 404 em JSON');
    } finally {
        srv.kill();
        if (falhas.length) console.log('\n--- log do servidor ---\n' + log.slice(-3000));
    }
    console.log(falhas.length ? `\n❌ ${falhas.length} falha(s)` : '\n✅ Todos os checks passaram');
    process.exit(falhas.length ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
