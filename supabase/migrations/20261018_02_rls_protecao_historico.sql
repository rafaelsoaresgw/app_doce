-- Aplicado em produção em 18/10/2026 pelo SQL Editor.
-- Restringe o que a chave pública (anon) pode apagar/alterar. INSERT e SELECT continuam iguais.

begin;
drop policy if exists "permitir apagar vendas" on public.vendas;
create policy "apagar_venda_recente" on public.vendas
  for delete to anon using (criado_em > now() - interval '24 hours');

drop policy if exists "anon_update_sessoes" on public.sessoes_venda;
create policy "atualizar_sessao_recente" on public.sessoes_venda
  for update to anon using (criado_em > now() - interval '7 days') with check (true);

drop policy if exists "anon_update_amostras" on public.amostras_venda;
create policy "atualizar_amostra_recente" on public.amostras_venda
  for update to anon using (criado_em > now() - interval '7 days') with check (true);

drop policy if exists "atualizar dias" on public.dias;
create policy "atualizar_dia_recente" on public.dias
  for update to anon using (data >= current_date - 7) with check (data >= current_date - 7);
commit;

-- Observação: vendas NÃO tem política de UPDATE. O app envia cada venda uma vez
-- (upsert com ignoreDuplicates). Não criar UPDATE sem rever app/lib/outbox.ts.

-- REVERTER (volta ao estado anterior):
-- begin;
-- drop policy if exists "apagar_venda_recente" on public.vendas;
-- create policy "permitir apagar vendas" on public.vendas for delete to anon using (true);
-- drop policy if exists "atualizar_sessao_recente" on public.sessoes_venda;
-- create policy "anon_update_sessoes" on public.sessoes_venda for update to anon using (true) with check (true);
-- drop policy if exists "atualizar_amostra_recente" on public.amostras_venda;
-- create policy "anon_update_amostras" on public.amostras_venda for update to anon using (true) with check (true);
-- drop policy if exists "atualizar_dia_recente" on public.dias;
-- create policy "atualizar dias" on public.dias for update to anon using (true) with check (true);
-- commit;
