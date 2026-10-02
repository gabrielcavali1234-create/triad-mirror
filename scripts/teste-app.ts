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
