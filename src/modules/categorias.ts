// ══════════════════════════════════════════════════════════════════════════
// Taxonomia ÚNICA de categorias do Mirror — usada tanto no extrato quanto na
// fatura, pra visão consolidada "pra onde vai o dinheiro" fazer sentido.
// Base: lista da TRIAD + categorias que aparecem muito em cartão de crédito.
// ══════════════════════════════════════════════════════════════════════════
export const CATEGORIAS = [
    // Gastos do dia a dia
    'Supermercado', 'Alimentação', 'Delivery', 'Transporte', 'Combustível', 'Automotivo',
    'Moradia', 'Contas de consumo', 'Telecomunicações', 'Saúde', 'Farmácia', 'Educação',
    // Estilo de vida
    'Lazer', 'Viagem', 'Vestuário', 'Compras', 'Assinaturas', 'Cuidados pessoais', 'Pets',
    // Financeiro
    'Pagamento de fatura', 'Encargos e juros', 'Tarifa bancária', 'IOF', 'Anuidade',
    'Empréstimo e financiamento', 'Investimento', 'Impostos',
    // Movimentações
    'Salário', 'Rendimento', 'Pix Recebido', 'Pix Enviado', 'Transferência', 'Saque', 'Estorno',
    'Outros'
] as const;

export type Categoria = typeof CATEGORIAS[number];

export const CATEGORIAS_TEXTO = CATEGORIAS.join(' | ');
