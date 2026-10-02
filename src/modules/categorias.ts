// ══════════════════════════════════════════════════════════════════════════
// Taxonomia do Mirror em DUAS CAMADAS:
//   • CATEGORIA     — a lista atual (visão do resumo, "pra onde vai o dinheiro")
//   • SUBCATEGORIA  — o detalhe que o analista usa na conversa com o cliente
//                     (ex: Educação › Escola, Saúde › Plano de saúde)
// Usada no extrato e na fatura, para a visão consolidada fazer sentido.
// ══════════════════════════════════════════════════════════════════════════
export const SUBCATEGORIAS: Record<string, string[]> = {
    // Gastos do dia a dia
    'Supermercado': ['Supermercado', 'Atacadista', 'Hortifruti', 'Açougue', 'Mercado online'],
    'Alimentação': ['Restaurante', 'Lanchonete', 'Padaria', 'Cafeteria', 'Bar', 'Fast food'],
    'Delivery': ['iFood', 'Rappi', 'Outros apps de entrega'],
    'Transporte': ['Aplicativo (Uber/99)', 'Ônibus e metrô', 'Estacionamento', 'Pedágio', 'Táxi'],
    'Combustível': ['Gasolina', 'Etanol', 'Diesel', 'GNV', 'Recarga elétrica'],
    'Automotivo': ['Manutenção', 'Peças', 'Seguro do carro', 'IPVA e licenciamento', 'Multas', 'Lava-rápido', 'Guincho'],
    'Moradia': ['Aluguel', 'Condomínio', 'Financiamento imobiliário', 'IPTU', 'Reforma e manutenção', 'Móveis e decoração'],
    'Contas de consumo': ['Energia', 'Água', 'Gás'],
    'Telecomunicações': ['Celular', 'Internet', 'TV por assinatura', 'Telefone fixo'],
    'Saúde': ['Plano de saúde', 'Consulta', 'Exames', 'Dentista', 'Terapia', 'Hospital', 'Ótica', 'Academia e esporte'],
    'Farmácia': ['Medicamentos', 'Higiene e beleza (farmácia)'],
    'Educação': ['Escola', 'Faculdade', 'Pós-graduação', 'Curso', 'Idiomas', 'Material escolar', 'Transporte escolar'],
    // Estilo de vida
    'Lazer': ['Cinema e shows', 'Viagem curta', 'Clube', 'Jogos', 'Eventos', 'Academia e esporte'],
    'Viagem': ['Passagem aérea', 'Hotel e hospedagem', 'Aluguel de carro', 'Passeios'],
    'Vestuário': ['Roupas', 'Calçados', 'Acessórios'],
    'Compras': ['Marketplace', 'Eletrônicos', 'Casa e utilidades', 'Presentes', 'Loja de departamento'],
    'Assinaturas': ['Streaming de vídeo', 'Streaming de música', 'Software e apps', 'Nuvem e armazenamento', 'Clube de assinatura', 'Hospedagem de site'],
    'Cuidados pessoais': ['Salão e barbearia', 'Estética', 'Cosméticos'],
    'Pets': ['Pet shop', 'Veterinário', 'Ração'],
    // Financeiro
    'Pagamento de fatura': ['Fatura de cartão'],
    'Encargos e juros': ['Juros do rotativo', 'Juros de mora', 'Multa por atraso', 'Juros de cheque especial'],
    'Tarifa bancária': ['Pacote de serviços', 'Tarifa avulsa', 'Seguro do cartão', 'Serviço de aviso'],
    'IOF': ['IOF compra internacional', 'IOF financiamento', 'IOF conta'],
    'Anuidade': ['Anuidade do titular', 'Anuidade do adicional'],
    'Empréstimo e financiamento': ['Parcelamento de fatura', 'Empréstimo pessoal', 'Consignado', 'Financiamento de veículo', 'Crédito estudantil'],
    'Investimento': ['Aplicação', 'Resgate', 'Previdência', 'Poupança', 'Corretora'],
    'Impostos': ['Imposto de renda', 'Taxas do governo', 'Contribuições (INSS, MEI)'],
    // Movimentações
    'Salário': ['Salário', 'Adiantamento', '13º salário', 'Férias', 'Pró-labore'],
    'Rendimento': ['Rendimento de aplicação', 'Juros recebidos', 'Dividendos'],
    'Pix Recebido': ['De terceiros', 'De familiares', 'Venda / serviço prestado'],
    'Pix Enviado': ['Para terceiros', 'Para familiares', 'Pagamento de serviço'],
    'Transferência': ['Entre contas próprias', 'TED/DOC para terceiros', 'TED/DOC recebido'],
    'Saque': ['Caixa eletrônico', 'Saque no crédito'],
    'Estorno': ['Estorno de compra', 'Cashback', 'Reembolso'],
    'Outros': ['Não identificado']
};

export const CATEGORIAS = Object.keys(SUBCATEGORIAS);
export type Categoria = string;

export const CATEGORIAS_TEXTO = CATEGORIAS.join(' | ');

/** Lista "Categoria: sub1, sub2…" para o prompt da IA. */
export const SUBCATEGORIAS_TEXTO = CATEGORIAS
    .map(c => `   - ${c}: ${SUBCATEGORIAS[c].join(', ')}`)
    .join('\n');

/** Regra comum aos prompts de extrato e fatura. */
export const REGRA_SUBCATEGORIA = `SUBCATEGORIA (segunda camada, mais detalhada): escolha UMA subcategoria da lista da categoria escolhida. Se nenhuma servir, use a mais próxima; se não houver como saber, deixe vazio (o analista completa).
${SUBCATEGORIAS_TEXTO}`;
