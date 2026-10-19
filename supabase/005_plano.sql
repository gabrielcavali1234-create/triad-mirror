-- ══════════════════════════════════════════════════════════════════════════
-- TRIAD Mirror — 005: plano do cliente (simulação "e se você mudar?")
-- Guarda na análise o que o analista definiu: rendimento simulado, reserva,
-- custo de vida e as atitudes (sair do rotativo + cortes por categoria).
-- Rodar DEPOIS do 004. Pode rodar mais de uma vez sem quebrar.
-- ══════════════════════════════════════════════════════════════════════════
alter table mirror_analises add column if not exists plano jsonb;
