// Rodar: node --experimental-strip-types --test tests/outbox.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { enfileirar, listar, migrarFilasAntigas, sincronizar, temDeletePendente, type ItemOutbox } from "../app/lib/outbox.ts";

function memoria() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } };
}
const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("venda registrada durante um envio lento não é perdida (bug da fila antiga)", async () => {
  const s = memoria();
  let online = false;
  enfileirar(s, "vendas", "cliente_id", { cliente_id: "A" });
  const envio = sincronizar(s, async () => { await espera(50); return { error: online ? null : "offline" }; });
  await espera(10);
  enfileirar(s, "vendas", "cliente_id", { cliente_id: "B" });
  await envio;
  assert.deepEqual(listar(s).map((x) => x.payload.cliente_id).sort(), ["A", "B"]);
  online = true;
  await sincronizar(s, async () => ({ error: online ? null : "offline" }));
  assert.equal(listar(s).length, 0);
});

test("item enfileirado durante o envio também é enviado na mesma rodada", async () => {
  const s = memoria();
  const enviados: string[] = [];
  enfileirar(s, "vendas", "cliente_id", { cliente_id: "A" });
  const envio = sincronizar(s, async (i) => { enviados.push(String(i.payload.cliente_id)); await espera(20); return { error: null }; });
  await espera(5);
  enfileirar(s, "vendas", "cliente_id", { cliente_id: "B" });
  await envio;
  assert.deepEqual(enviados, ["A", "B"]);
  assert.equal(listar(s).length, 0);
});

test("contexto que chega durante o envio da versão anterior é reenviado", async () => {
  const s = memoria();
  const enviados: Array<Record<string, unknown>> = [];
  enfileirar(s, "vendas", "cliente_id", { cliente_id: "A", produto: "brownie" });
  const envio = sincronizar(s, async (i) => { enviados.push({ ...i.payload }); await espera(20); return { error: null }; });
  await espera(5);
  enfileirar(s, "vendas", "cliente_id", { cliente_id: "A", lat: 19.3 });
  await envio;
  assert.equal(enviados.length, 2);
  assert.deepEqual(enviados[1], { cliente_id: "A", produto: "brownie", lat: 19.3 });
  assert.equal(listar(s).length, 0);
});

test("desfazer com o upsert ainda em voo: o DELETE é enviado depois", async () => {
  const s = memoria();
  const ops: string[] = [];
  enfileirar(s, "vendas", "cliente_id", { cliente_id: "A", produto: "brownie" });
  const envio = sincronizar(s, async (i) => { ops.push(i.op); await espera(20); return { error: null }; });
  await espera(5);
  enfileirar(s, "vendas", "cliente_id", { cliente_id: "A" }, "delete");
  assert.equal(temDeletePendente(s, "vendas", "A"), true);
  await envio;
  assert.deepEqual(ops, ["upsert", "delete"]);
  assert.equal(listar(s).length, 0);
});

test("sessão é enviada antes das amostras; se ela falhar, amostras esperam", async () => {
  const s = memoria();
  const ordem: string[] = [];
  enfileirar(s, "amostras_venda", "id", { id: "am1", sessao_id: "s1" });
  enfileirar(s, "sessoes_venda", "id", { id: "s1" });
  await sincronizar(s, async (i: ItemOutbox) => { ordem.push(i.tabela); return { error: "offline" }; });
  assert.deepEqual(ordem, ["sessoes_venda"]);
  assert.equal(listar(s).length, 2);
  ordem.length = 0;
  await sincronizar(s, async (i: ItemOutbox) => { ordem.push(i.tabela); return { error: null }; });
  assert.deepEqual(ordem, ["sessoes_venda", "amostras_venda"]);
});

test("encerrar duas vezes é idempotente (mesma chave, último estado vence)", async () => {
  const s = memoria();
  enfileirar(s, "sessoes_venda", "id", { id: "s1", status: "ativa" });
  enfileirar(s, "sessoes_venda", "id", { id: "s1", status: "encerrada", fim: "t1" });
  enfileirar(s, "sessoes_venda", "id", { id: "s1", status: "encerrada", fim: "t1" });
  assert.equal(listar(s).length, 1);
  assert.equal(listar(s)[0].payload.status, "encerrada");
});

test("envio que lança exceção não apaga o item", async () => {
  const s = memoria();
  enfileirar(s, "vendas", "cliente_id", { cliente_id: "A" });
  await sincronizar(s, async () => { throw new Error("rede"); });
  assert.equal(listar(s).length, 1);
  assert.equal(listar(s)[0].tentativas, 1);
});

test("chamadas simultâneas compartilham o mesmo envio (sem duplicar)", async () => {
  const s = memoria();
  let n = 0;
  enfileirar(s, "vendas", "cliente_id", { cliente_id: "A" });
  const enviar = async () => { n++; await espera(10); return { error: null }; };
  await Promise.all([sincronizar(s, enviar), sincronizar(s, enviar), sincronizar(s, enviar)]);
  assert.equal(n, 1);
});

test("filas da versão anterior são migradas sem perda", () => {
  const s = memoria();
  s.setItem("fila", JSON.stringify([{ cliente_id: "v1", produto: "brownie" }]));
  s.setItem("filaColeta", JSON.stringify([{ tabela: "amostras_venda", payload: { id: "a1" } }, { tabela: "sessoes_venda", payload: { id: "s1" } }]));
  migrarFilasAntigas(s);
  assert.deepEqual(listar(s).map((x) => x.chave).sort(), ["amostras_venda:a1", "sessoes_venda:s1", "vendas:v1"]);
  assert.equal(s.getItem("fila"), "[]");
  migrarFilasAntigas(s); // rodar de novo não duplica
  assert.equal(listar(s).length, 3);
});

test("localStorage corrompido não quebra a fila", () => {
  const s = memoria();
  s.setItem("outbox_v1", "{lixo");
  assert.deepEqual(listar(s), []);
  enfileirar(s, "vendas", "cliente_id", { cliente_id: "A" });
  assert.equal(listar(s).length, 1);
});
