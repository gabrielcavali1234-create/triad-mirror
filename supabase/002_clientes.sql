-- ══════════════════════════════════════════════════════════════════════════
-- TRIAD Mirror — 002: perfil de clientes + vínculo com analistas
-- Rodar DEPOIS do schema.sql. Pode rodar mais de uma vez sem quebrar.
-- Supabase → SQL Editor → New query → colar tudo → Run.
-- ══════════════════════════════════════════════════════════════════════════

-- Perfil do cliente da consultoria
create table if not exists mirror_clientes (
    id              uuid primary key default gen_random_uuid(),
    org_id          text,
    nome            text not null,
    cpf             text,
    telefone        text,
    email           text,
    renda_declarada numeric(14, 2),
    objetivo        text,                       -- ex: "sair do rotativo", "montar reserva"
    observacao      text,
    criado_por      uuid,                       -- id do analista (Supabase Auth)
    criado_por_nome text,
    criado_em       timestamptz not null default now(),
    atualizado_em   timestamptz not null default now()
);
create index if not exists mirror_clientes_org_idx on mirror_clientes (org_id, nome);

-- Cada análise pertence a um cliente
alter table mirror_analises add column if not exists cliente_id uuid references mirror_clientes (id) on delete cascade;
alter table mirror_analises add column if not exists analista_id uuid;
alter table mirror_analises alter column cliente_nome drop not null;
create index if not exists mirror_analises_cliente_idx on mirror_analises (cliente_id, criado_em desc);

-- Quem mexeu no lançamento (id do analista)
alter table mirror_ajustes add column if not exists atualizado_por_id uuid;

-- Ao mexer numa análise, o cliente aparece como "atualizado" na lista
create or replace function mirror_tocar_cliente() returns trigger language plpgsql as $$
begin
    if new.cliente_id is not null then
        update mirror_clientes set atualizado_em = now() where id = new.cliente_id;
    end if;
    return new;
end $$;

drop trigger if exists mirror_analises_toca_cliente on mirror_analises;
create trigger mirror_analises_toca_cliente after insert or update on mirror_analises
    for each row execute function mirror_tocar_cliente();

-- Mesmo padrão de segurança: RLS ligado, sem políticas (só o servidor acessa)
alter table mirror_clientes enable row level security;
