-- ══════════════════════════════════════════════════════════════════════════
-- TRIAD Mirror — 007: app do cliente (link pessoal no celular)
-- A consultora publica uma "foto" da análise; o cliente vê pelo link.
-- Rodar DEPOIS do 006. Pode rodar mais de uma vez sem quebrar.
-- ══════════════════════════════════════════════════════════════════════════
alter table mirror_clientes add column if not exists app_token text;
alter table mirror_clientes add column if not exists app_ativo boolean not null default false;
alter table mirror_clientes add column if not exists app_snapshot jsonb;
alter table mirror_clientes add column if not exists app_publicado_em timestamptz;

create unique index if not exists mirror_clientes_app_token_idx on mirror_clientes (app_token) where app_token is not null;
