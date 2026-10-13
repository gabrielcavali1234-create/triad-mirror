-- ══════════════════════════════════════════════════════════════════════════
-- TRIAD Mirror — 004: nova classificação "Cartão à vista do mês"
-- (o analista agora classifica também as compras à vista da fatura)
-- Rodar DEPOIS do 003. Pode rodar mais de uma vez sem quebrar.
-- ══════════════════════════════════════════════════════════════════════════
alter table mirror_ajustes add column if not exists classe text;

alter table mirror_ajustes drop constraint if exists mirror_ajustes_classe_check;
alter table mirror_ajustes add constraint mirror_ajustes_classe_check
    check (classe is null or classe in ('fixo', 'variavel', 'investimento', 'entrada', 'cartao_vista', 'fora'));
