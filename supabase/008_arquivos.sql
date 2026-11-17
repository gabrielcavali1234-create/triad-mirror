-- ══════════════════════════════════════════════════════════════════════════
-- 008 — Documentos do cliente
--  • mirror_arquivos: arquivos guardados no perfil (contrato, comprovante,
--    planilha…). A IA não lê; ficam só armazenados.
--  • mirror_documentos ganha o caminho do PDF/foto original do extrato/fatura,
--    para visualizar e baixar depois (vale para os envios daqui em diante).
--  • Bucket privado "mirror-arquivos" no Storage: só o servidor (chave secreta)
--    lê e grava. Nada público.
-- Rode uma vez no projeto triad-mirror. Pode rodar de novo sem problema.
-- ══════════════════════════════════════════════════════════════════════════

alter table public.mirror_documentos
    add column if not exists arquivo_caminho text,
    add column if not exists arquivo_mime text,
    add column if not exists arquivo_tamanho bigint;

create table if not exists public.mirror_arquivos (
    id              uuid primary key default gen_random_uuid(),
    cliente_id      uuid not null references public.mirror_clientes(id) on delete cascade,
    nome            text not null,
    categoria       text not null default 'outros',
    anotacao        text,
    nome_original   text,
    mime            text,
    tamanho         bigint,
    caminho         text not null,
    enviado_por     text,
    enviado_por_id  text,
    criado_em       timestamptz not null default now(),
    atualizado_em   timestamptz not null default now()
);
create index if not exists mirror_arquivos_cliente_idx on public.mirror_arquivos (cliente_id, criado_em desc);
alter table public.mirror_arquivos enable row level security;   -- sem políticas: só a chave secreta do servidor acessa

insert into storage.buckets (id, name, public, file_size_limit)
values ('mirror-arquivos', 'mirror-arquivos', false, 52428800)
on conflict (id) do update set public = false;
