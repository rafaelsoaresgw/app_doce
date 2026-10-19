-- Coleta ML v2
-- 1) limpa duplicatas existentes e impede novas
-- 2) cria sessões de venda e amostras periódicas (incluindo intervalos sem venda)
-- 3) cria uma view pronta para futuros modelos de ML

begin;

-- Mantém apenas o registro mais antigo de cada cliente_id duplicado.
delete from public.vendas v
using public.vendas antigo
where v.cliente_id = antigo.cliente_id
  and v.id > antigo.id;

-- client_id passa a ser a chave idempotente da venda.
create unique index if not exists vendas_cliente_id_uidx
  on public.vendas (cliente_id);

-- Corrige campos derivados seguros no resumo diário sem reescrever a quantidade de vendas histórica.
update public.dias
set
  dia_semana = case extract(dow from data)
    when 0 then 'Domingo'
    when 1 then 'Segunda'
    when 2 then 'Terça'
    when 3 then 'Quarta'
    when 4 then 'Quinta'
    when 5 then 'Sexta'
    when 6 then 'Sábado'
  end,
  sobrou_brow = greatest(coalesce(levou_brow, 0) - coalesce(vendeu_brow, 0), 0),
  sobrou_brig = greatest(coalesce(levou_brig, 0) - coalesce(vendeu_brig, 0), 0);

alter table public.vendas
  add column if not exists sessao_id text,
  add column if not exists vendido_em timestamptz;

update public.vendas
set vendido_em = criado_em
where vendido_em is null;

create table if not exists public.sessoes_venda (
  id text primary key,
  data date not null,
  inicio timestamptz not null,
  fim timestamptz,
  status text not null default 'ativa' check (status in ('ativa', 'encerrada')),
  levou_brow integer not null default 0 check (levou_brow >= 0),
  levou_brig integer not null default 0 check (levou_brig >= 0),
  preco_brow numeric not null default 0 check (preco_brow >= 0),
  preco_brig numeric not null default 0 check (preco_brig >= 0),
  criado_em timestamptz not null default now()
);

create table if not exists public.amostras_venda (
  id text primary key,
  sessao_id text not null references public.sessoes_venda(id) on delete cascade,
  coletado_em timestamptz not null,
  data date not null,
  hora text not null,
  lat double precision,
  lon double precision,
  precisao double precision,
  bairro text,
  tipo_area text,
  temperatura double precision,
  chuva double precision,
  local_aproximado boolean not null default false,
  estoque_brow integer not null default 0 check (estoque_brow >= 0),
  estoque_brig integer not null default 0 check (estoque_brig >= 0),
  vendidos_brow integer not null default 0 check (vendidos_brow >= 0),
  vendidos_brig integer not null default 0 check (vendidos_brig >= 0),
  motivo text not null check (motivo in ('inicio', 'intervalo', 'manual', 'fim')),
  criado_em timestamptz not null default now()
);

create index if not exists amostras_venda_sessao_tempo_idx
  on public.amostras_venda (sessao_id, coletado_em);
create index if not exists amostras_venda_data_idx
  on public.amostras_venda (data);
create index if not exists vendas_sessao_idx
  on public.vendas (sessao_id);

create or replace view public.auditoria_dias_vendas_v1 as
with eventos as (
  select
    data,
    count(*) filter (where produto = 'brownie') as brownies_eventos,
    count(*) filter (where produto = 'brigadeiro') as brigadeiros_eventos
  from public.vendas
  group by data
)
select
  d.data,
  d.vendeu_brow as brownies_resumo,
  coalesce(e.brownies_eventos, 0) as brownies_eventos,
  coalesce(e.brownies_eventos, 0) - coalesce(d.vendeu_brow, 0) as delta_brownies,
  d.vendeu_brig as brigadeiros_resumo,
  coalesce(e.brigadeiros_eventos, 0) as brigadeiros_eventos,
  coalesce(e.brigadeiros_eventos, 0) - coalesce(d.vendeu_brig, 0) as delta_brigadeiros
from public.dias d
left join eventos e on e.data = d.data
order by d.data desc;

create or replace view public.ml_intervalos_v1 as
with ordenadas as (
  select
    a.*,
    lead(a.coletado_em) over (partition by a.sessao_id order by a.coletado_em) as proxima_coleta
  from public.amostras_venda a
), intervalos as (
  select
    o.*,
    extract(epoch from (o.proxima_coleta - o.coletado_em)) / 60.0 as minutos_intervalo
  from ordenadas o
  where o.proxima_coleta is not null
)
select
  i.id,
  i.sessao_id,
  i.coletado_em,
  i.data,
  i.hora,
  extract(isodow from i.data)::int as dia_semana_num,
  i.lat,
  i.lon,
  round(i.lat::numeric, 3) as grid_lat,
  round(i.lon::numeric, 3) as grid_lon,
  i.bairro,
  i.tipo_area,
  i.temperatura,
  i.chuva,
  i.estoque_brow,
  i.estoque_brig,
  i.vendidos_brow,
  i.vendidos_brig,
  i.motivo,
  i.minutos_intervalo,
  vendas.vendas_brow_intervalo,
  vendas.vendas_brig_intervalo,
  case when i.minutos_intervalo > 0
    then vendas.vendas_brow_intervalo * 60.0 / i.minutos_intervalo
    else null end as brownies_por_hora_alvo
from intervalos i
left join lateral (
  select
    count(*) filter (where v.produto = 'brownie')::int as vendas_brow_intervalo,
    count(*) filter (where v.produto = 'brigadeiro')::int as vendas_brig_intervalo
  from public.vendas v
  where v.sessao_id = i.sessao_id
    and v.vendido_em >= i.coletado_em
    and v.vendido_em < i.proxima_coleta
) vendas on true
where i.minutos_intervalo between 1 and 30;

commit;
