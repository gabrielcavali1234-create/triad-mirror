-- ══════════════════════════════════════════════════════════════════════════
-- TRIAD Mirror — schema do banco (projeto Supabase PRÓPRIO do Mirror)
-- Como usar: Supabase → SQL Editor → New query → colar tudo → Run.
-- Pode rodar mais de uma vez sem quebrar (usa IF NOT EXISTS).
--
-- Segurança: RLS ligado em todas as tabelas e NENHUMA política criada.
-- Resultado: só o servidor do Mirror (com a service_role / secret key) lê e
-- grava. O navegador nunca acessa o banco direto — dados financeiros de
-- clientes não ficam expostos pela chave pública (anon).
-- ══════════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

-- 1) Análise: uma "pasta" por cliente/apuração --------------------------------
create table if not exists mirror_analises (
    id              uuid primary key default gen_random_uuid(),
    org_id          text,                       -- empresa de consultoria (multi-cliente no futuro)
    cliente_nome    text not null,
    cliente_doc     text,                       -- CPF opcional
    analista        text,
    status          text not null default 'aberta' check (status in ('aberta', 'concluida', 'arquivada')),
    observacao      text,
    criado_em       timestamptz not null default now(),
    atualizado_em   timestamptz not null default now()
);
create index if not exists mirror_analises_org_idx on mirror_analises (org_id, criado_em desc);

-- 2) Documentos analisados (extratos e faturas) + custo de IA de cada um ------
create table if not exists mirror_documentos (
    id                  uuid primary key default gen_random_uuid(),
    analise_id          uuid not null references mirror_analises (id) on delete cascade,
    tipo                text not null check (tipo in ('extrato', 'fatura')),
    nome_arquivo        text,
    file_hash           text,
    banco               text,
    resultado           jsonb not null,         -- saída completa da extração (transações, conferência…)
    qualidade_ruim      boolean not null default false,
    -- custo real da IA (base para definir o preço do produto)
    custo_usd           numeric(12, 6) not null default 0,
    tokens_input        integer not null default 0,
    tokens_output       integer not null default 0,
    tokens_cache_write  integer not null default 0,
    tokens_cache_read   integer not null default 0,
    modelo_usado        text,
    tempo_processamento numeric(8, 1),
    criado_em           timestamptz not null default now()
);
create index if not exists mirror_documentos_analise_idx on mirror_documentos (analise_id, criado_em);

-- 3) Ajustes do analista em cada lançamento ----------------------------------
-- O resultado da IA nunca é alterado: os ajustes ficam aqui, por cima dele.
-- lancamento_ref = posição do lançamento dentro do documento (estável).
create table if not exists mirror_ajustes (
    documento_id    uuid not null references mirror_documentos (id) on delete cascade,
    lancamento_ref  integer not null,
    categoria       text,                       -- null = mantém a da IA
    subcategoria    text,
    observacao      text,
    situacao        text check (situacao in ('incluido', 'excluido', 'entre_contas')),  -- null = padrão do sistema
    atualizado_por  text,
    atualizado_em   timestamptz not null default now(),
    primary key (documento_id, lancamento_ref)
);

-- 4) Cache de arquivo duplicado (mesmo PDF enviado de novo = custo zero) ------
create table if not exists mirror_extraction_cache (
    id              uuid primary key default gen_random_uuid(),
    file_hash       text not null,
    tipo_documento  text not null,
    org_id          text,
    user_id         text,
    resultado       jsonb not null,
    created_at      timestamptz not null default now()
);
create index if not exists mirror_cache_lookup_idx on mirror_extraction_cache (file_hash, tipo_documento, created_at desc);

-- Atualiza "atualizado_em" da análise sempre que algo dentro dela muda --------
create or replace function mirror_tocar_analise() returns trigger language plpgsql as $$
declare v_analise uuid;
begin
    if tg_table_name = 'mirror_documentos' then
        v_analise := coalesce(new.analise_id, old.analise_id);
    else
        select analise_id into v_analise from mirror_documentos where id = coalesce(new.documento_id, old.documento_id);
    end if;
    update mirror_analises set atualizado_em = now() where id = v_analise;
    return coalesce(new, old);
end $$;

drop trigger if exists mirror_documentos_toca on mirror_documentos;
create trigger mirror_documentos_toca after insert or update or delete on mirror_documentos
    for each row execute function mirror_tocar_analise();

drop trigger if exists mirror_ajustes_toca on mirror_ajustes;
create trigger mirror_ajustes_toca after insert or update or delete on mirror_ajustes
    for each row execute function mirror_tocar_analise();

-- RLS ligado, sem políticas: acesso só pelo servidor (service_role) ----------
alter table mirror_analises          enable row level security;
alter table mirror_documentos        enable row level security;
alter table mirror_ajustes           enable row level security;
alter table mirror_extraction_cache  enable row level security;
