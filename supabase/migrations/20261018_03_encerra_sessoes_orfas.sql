-- Executado em produção em 18/10/2026 (registro histórico; não reexecutar).
-- 9 sessões ficaram 'ativa' porque a saída foi concluída na versão antiga do app
-- (alias git-main apontando para o deploy de 13/09) ou a aba foi fechada.
-- fim = última atividade real da sessão (amostra ou venda vinculada). Nenhuma venda
-- sem sessão foi associada a sessões. Para ML, tratar estes dias como duvidosos:
-- 2026-09-29, 10-01, 10-02, 10-04, 10-06, 10-10, 10-11, 10-13, 10-15.

update sessoes_venda s
set status = 'encerrada',
    fim = greatest(
      s.inicio,
      (select max(a.coletado_em) from amostras_venda a where a.sessao_id = s.id),
      (select max(v.vendido_em)  from vendas v        where v.sessao_id = s.id))
where s.status = 'ativa' and s.data < date '2026-10-18'
  and s.id in (
    'sessao-923d041e-c249-41de-85db-cc88c0ca59cf','sessao-c257fcd6-284a-420f-94f2-1f09b0aaa5fc',
    'sessao-502eee97-0785-4b94-874c-9179d9aca2b3','sessao-97a90107-f357-452b-b83b-369c73622e52',
    'sessao-45e8a80f-7c77-41e9-9258-042ea88c41dd','sessao-3e6515eb-6439-44c8-80a9-b2e2371e973f',
    'sessao-934ea945-43e9-477c-a4c3-b4f2dab74b9c','sessao-275fafb0-0ada-4d5d-a2c7-cc0c22778f29',
    'sessao-bfd46a1c-b2f3-4ba2-bc0a-e59674d80115');
