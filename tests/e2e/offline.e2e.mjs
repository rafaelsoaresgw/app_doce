// Teste: o app abre SEM internet depois de aberto uma vez com internet; com internet volta a pegar a versão nova.
import { chromium } from "playwright";
const APP = process.env.APP || "http://localhost:3200";
const db = { vendas: [], sessoes_venda: [], amostras_venda: [], dias: [] };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const res = [];
const ok = (n, c, x = "") => { res.push(c); console.log(`${c ? "PASSOU" : "FALHOU"} - ${n}${x ? " :: " + x : ""}`); };
let supabaseOnline = true;

const browser = await chromium.launch();
const ctx = await browser.newContext({ geolocation: { latitude: 19.35, longitude: -99.16, accuracy: 10 }, permissions: ["geolocation"], timezoneId: "America/Mexico_City", serviceWorkers: "allow" });
await ctx.route("https://mock.supabase.test/**", async (route) => {
  if (!supabaseOnline) return route.abort("internetdisconnected");
  const req = route.request(); const url = new URL(req.url()); const t = url.pathname.split("/").pop();
  const linhas = db[t] ?? (db[t] = []);
  if (req.method() === "POST") {
    const ign = (req.headers()["prefer"] || "").includes("ignore-duplicates");
    const k = url.searchParams.get("on_conflict") || "id";
    for (const r of [].concat(JSON.parse(req.postData() || "[]"))) {
      const i = linhas.findIndex((x) => x[k] === r[k]);
      if (i >= 0) { if (!ign) linhas[i] = { ...linhas[i], ...r }; } else linhas.push(r);
    }
    return route.fulfill({ status: 201, body: "" });
  }
  return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
});
await ctx.route("https://api.open-meteo.com/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"current":{"temperature_2m":20,"precipitation":0}}' }));
await ctx.route("https://nominatim.openstreetmap.org/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"address":{"suburb":"Tlalpan"}}' }));

try {
  const p = await ctx.newPage(); p.on("dialog", (d) => d.accept());
  await p.goto(APP, { waitUntil: "networkidle" });
  await p.evaluate(() => navigator.serviceWorker.ready);
  await espera(2000);
  const nCache = await p.evaluate(async () => (await (await caches.open("app-doce-v1")).keys()).length);
  ok("1. Primeira abertura com internet instala o modo offline e guarda a página", nCache > 3, `arquivos guardados=${nCache}`);

  // Fecha tudo e abre de novo SEM internet
  await p.close();
  await ctx.setOffline(true); supabaseOnline = false;
  const p2 = await ctx.newPage(); p2.on("dialog", (d) => d.accept());
  let abriu = false;
  try { await p2.goto(APP, { waitUntil: "load", timeout: 20000 }); abriu = await p2.getByText("Vendas de hoje").isVisible(); } catch (e) { console.log(String(e).slice(0, 200)); }
  ok("2. Sem internet, o app abre", abriu);

  // Usa o app offline
  await p2.locator('input[type="number"]').nth(1).fill("10");
  await p2.getByRole("button", { name: /Começar vendas/ }).click();
  await p2.getByText("Vendas em andamento").waitFor({ timeout: 10000 });
  const brownie = p2.getByRole("button", { name: /Brownie/ }).first();
  await brownie.click(); await brownie.click();
  await espera(1500);
  const txt = await brownie.innerText();
  ok("3. Sem internet: começa a venda e registra 2 brownies (2/10)", /2\s*\/\s*10/.test(txt), txt.replace(/\s+/g, " "));
  const fila = await p2.evaluate(() => JSON.parse(localStorage.getItem("outbox_v1") || "[]").map((x) => x.tabela));
  ok("4. Tudo fica guardado na fila do celular", fila.filter((t) => t === "vendas").length === 2 && fila.includes("sessoes_venda"), JSON.stringify(fila));

  // Reabre ainda offline (aba fechada pelo celular)
  await p2.reload({ waitUntil: "load" });
  await p2.getByText("Vendas em andamento").waitFor({ timeout: 10000 });
  ok("5. Recarregar sem internet mantém a venda em andamento", /2\s*\/\s*10/.test(await p2.getByRole("button", { name: /Brownie/ }).first().innerText()));

  // Volta a internet
  await ctx.setOffline(false); supabaseOnline = true;
  await p2.evaluate(() => window.dispatchEvent(new Event("online")));
  const t0 = Date.now();
  while (Date.now() - t0 < 45000 && !(db.vendas.length === 2 && db.sessoes_venda.length === 1)) await espera(500);
  ok("6. Ao voltar a internet, sessão e 2 vendas chegam ao banco", db.vendas.length === 2 && db.sessoes_venda.length === 1 && db.vendas.every((v) => v.sessao_id === db.sessoes_venda[0].id), `vendas=${db.vendas.length} sessoes=${db.sessoes_venda.length}`);

  // Publica uma "versão nova" no servidor e confirma que, com internet, ela aparece (sem prender a versão velha)
  console.log("AGUARDANDO_NOVA_VERSAO");
  const fs = await import("node:fs");
  while (!fs.existsSync("/tmp/claude-0/nova_versao_pronta")) await espera(1000);
  await p2.reload({ waitUntil: "load" });
  await espera(1500);
  const temMarca = await p2.getByText("versao-nova-teste").count();
  ok("7. Com internet, uma versão nova publicada aparece já na próxima abertura", temMarca > 0);
} catch (e) {
  ok("execução", false, String(e).slice(0, 300));
} finally {
  await browser.close();
  console.log(`\n${res.filter(Boolean).length}/${res.length} passaram`);
}
