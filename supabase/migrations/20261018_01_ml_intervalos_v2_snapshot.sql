-- Snapshot da view ml_intervalos_v2 como estava em produção em 18/10/2026
-- (criada manualmente no SQL Editor; não existia no repositório).
-- Atenção (diagnóstico de 18/10): conta só vendas a até 250 m da amostra inicial do
-- intervalo. Como muitas vendas acontecem segundos antes da amostra seguinte, já no
-- ponto novo, essas vendas são descartadas. Não usar como rótulo de ML sem revisão.

create or replace view public.ml_intervalos_v2 as
WITH ordenadas AS (
         SELECT a.id,
            a.sessao_id,
            a.coletado_em,
            a.data,
            a.hora,
            a.lat,
            a.lon,
            a.precisao,
            a.bairro,
            a.tipo_area,
            a.temperatura,
            a.chuva,
            a.local_aproximado,
            a.estoque_brow,
            a.estoque_brig,
            a.vendidos_brow,
            a.vendidos_brig,
            a.motivo,
            a.criado_em,
            lead(a.coletado_em) OVER (PARTITION BY a.sessao_id ORDER BY a.coletado_em) AS proxima_coleta,
            lead(a.lat) OVER (PARTITION BY a.sessao_id ORDER BY a.coletado_em) AS proxima_lat,
            lead(a.lon) OVER (PARTITION BY a.sessao_id ORDER BY a.coletado_em) AS proxima_lon
           FROM amostras_venda a
        ), intervalos AS (
         SELECT o.id,
            o.sessao_id,
            o.coletado_em,
            o.data,
            o.hora,
            o.lat,
            o.lon,
            o.precisao,
            o.bairro,
            o.tipo_area,
            o.temperatura,
            o.chuva,
            o.local_aproximado,
            o.estoque_brow,
            o.estoque_brig,
            o.vendidos_brow,
            o.vendidos_brig,
            o.motivo,
            o.criado_em,
            o.proxima_coleta,
            o.proxima_lat,
            o.proxima_lon,
            EXTRACT(epoch FROM o.proxima_coleta - o.coletado_em) / 60.0 AS minutos_intervalo,
                CASE
                    WHEN o.lat IS NULL OR o.lon IS NULL OR o.proxima_lat IS NULL OR o.proxima_lon IS NULL THEN NULL::double precision
                    ELSE (2 * 6371000)::double precision * asin(sqrt(power(sin(radians(o.proxima_lat - o.lat) / 2::double precision), 2::double precision) + cos(radians(o.lat)) * cos(radians(o.proxima_lat)) * power(sin(radians(o.proxima_lon - o.lon) / 2::double precision), 2::double precision)))
                END AS movimento_m
           FROM ordenadas o
          WHERE o.proxima_coleta IS NOT NULL
        )
 SELECT i.id,
    i.sessao_id,
    i.coletado_em,
    i.data,
    i.hora,
    EXTRACT(isodow FROM i.data)::integer AS dia_semana_num,
    i.lat,
    i.lon,
    round(i.lat::numeric, 3) AS grid_lat,
    round(i.lon::numeric, 3) AS grid_lon,
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
    i.movimento_m,
    vendas.vendas_brow_intervalo,
    vendas.vendas_brig_intervalo,
        CASE
            WHEN i.minutos_intervalo > 0::numeric THEN vendas.vendas_brow_intervalo::numeric * 60.0 / i.minutos_intervalo
            ELSE NULL::numeric
        END AS brownies_por_hora_alvo
   FROM intervalos i
     LEFT JOIN LATERAL ( SELECT count(*) FILTER (WHERE v.produto = 'brownie'::text)::integer AS vendas_brow_intervalo,
            count(*) FILTER (WHERE v.produto = 'brigadeiro'::text)::integer AS vendas_brig_intervalo
           FROM vendas v
          WHERE v.sessao_id = i.sessao_id AND v.vendido_em >= i.coletado_em AND v.vendido_em < i.proxima_coleta AND (i.lat IS NOT NULL AND i.lon IS NOT NULL AND v.lat IS NOT NULL AND v.lon IS NOT NULL AND ((2 * 6371000)::double precision * asin(sqrt(power(sin(radians(v.lat - i.lat) / 2::double precision), 2::double precision) + cos(radians(i.lat)) * cos(radians(v.lat)) * power(sin(radians(v.lon - i.lon) / 2::double precision), 2::double precision)))) <= 250::double precision OR (i.lat IS NULL OR i.lon IS NULL OR v.lat IS NULL OR v.lon IS NULL) AND i.bairro IS NOT NULL AND v.bairro = i.bairro)) vendas ON true
  WHERE i.minutos_intervalo >= 1::numeric AND i.minutos_intervalo <= 30::numeric;
