-- ══════════════════════════════════════════════════════════════════════════
-- TRIAD Mirror — 003: classificação do lançamento para a planilha da consultoria
-- (custo fixo / custo variável / investimento / entrada / fora da planilha)
-- Rodar DEPOIS do 002. Pode rodar mais de uma vez sem quebrar.
-- ══════════════════════════════════════════════════════════════════════════
alter table mirror_ajustes add column if not exists classe text;

alter table mirror_ajustes drop constraint if exists mirror_ajustes_classe_check;
alter table mirror_ajustes add constraint mirror_ajustes_classe_check
    check (classe is null or classe in ('fixo', 'variavel', 'investimento', 'entrada', 'fora'));
