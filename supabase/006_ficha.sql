-- ══════════════════════════════════════════════════════════════════════════
-- TRIAD Mirror — 006: ficha do cliente (entrevista guiada)
-- Nascimento, profissão, forma de renda, dependentes, reserva atual, dívidas
-- fora do cartão, objetivos com valor e prazo e a autorização LGPD.
-- Rodar DEPOIS do 005. Pode rodar mais de uma vez sem quebrar.
-- ══════════════════════════════════════════════════════════════════════════
alter table mirror_clientes add column if not exists ficha jsonb;
