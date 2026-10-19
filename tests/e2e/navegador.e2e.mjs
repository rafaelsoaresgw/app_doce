// Teste ponta a ponta do app real (next dev) com Supabase, clima e Nominatim simulados.
import { chromium } from "playwright";

const APP = "http://localhost:3100";
const db = { vendas: [], sessoes_venda: [], amostras_venda: [], dias: [], ml_intervalos_v2: [] };
let supabaseOnline = true;
let atrasoUpsertVendas = 0;
const resultados = [];
const ok = (nome, cond, extra = "") => { resultados.push({ nome, ok: !!cond, extra }); console.log(`${cond ? "PASSOU" : "FALHOU"} - ${nome}${extra ? " :: " + extra : ""}`); };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

function filtrar(linhas, params) {
  let out = linhas;
  for (const [k, v] of params) {
    if (["select", "order", "limit", "on_conflict", "columns"].includes(k)) continue;
    const [op, ...rest] = v.split("."); const val = rest.join(".");
    if (op === "eq") out = out.filter((r) => String(r[k]) === val);
    else if (op === "neq") out = out.filter((r) => String(r[k]) !== val);
    else if (op === "gt") out = out.filter((r) => Number(r[k]) > Number(val));
    else if (op === "not") out = out.filter((r) => r[k] != null);
  }
  const limit = params.get("limit");
  return limit ? out.slice(0, Number(limit)) : out;
}

async function instalarMocks(ctx) {
  await ctx.route("https://mock.supabase.test/**", async (route) => {
    if (!supabaseOnline) return route.abort("internetdisconnected");
    const req = route.request();
    const url = new URL(req.url());
    const tabela = url.pathname.split("/").pop();
    const linhas = db[tabela] ?? (db[tabela] = []);
    if (req.method() === "GET" || req.method() === "HEAD") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(filtrar(linhas, url.searchParams)) });
    }
    if (req.method() === "POST") {
      if (tabela === "vendas" && atrasoUpsertVendas) await espera(atrasoUpsertVendas);
      if (!supabaseOnline) return route.abort("internetdisconnected");
      const chave = url.searchParams.get("on_conflict") || "id";
      const corpo = JSON.parse(req.postData() || "[]");
      for (const r of Array.isArray(corpo) ? corpo : [corpo]) {
        if (tabela === "amostras_venda" && !db.sessoes_venda.some((s) => s.id === r.sessao_id)) {
          return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "23503", message: "fk" }) });
        }
        const i = linhas.findIndex((x) => x[chave] === r[chave]);
        if (i >= 0) linhas[i] = { ...linhas[i], ...r }; else linhas.push({ ...r, _criado: Date.now() });
      }
      return route.fulfill({ status: 201, contentType: "application/json", body: "" });
    }
    if (req.method() === "DELETE") {
      const restantes = filtrar(linhas, url.searchParams);
      db[tabela] = linhas.filter((x) => !restantes.includes(x));
      return route.fulfill({ status: 204, body: "" });
    }
    return route.fulfill({ status: 200, body: "[]" });
  });
  await ctx.route("https://api.open-meteo.com/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ current: { temperature_2m: 21, precipitation: 0 } }) }));
  await ctx.route("https://nominatim.openstreetmap.org/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ address: { suburb: "Coyoacán", road: "Av. Teste" }, category: "place", type: "residential" }) }));
  await ctx.route("https://fonts.googleapis.com/**", (r) => r.fulfill({ status: 200, body: "" }));
}

const browser = await chromium.launch();
const novoContexto = async () => {
  const ctx = await browser.newContext({ geolocation: { latitude: 19.35, longitude: -99.16, accuracy: 10 }, permissions: ["geolocation"], timezoneId: "America/Mexico_City" });
  await instalarMocks(ctx);
  return ctx;
};
const botao = (p, txt) => p.getByRole("button", { name: txt });
const brownie = (p) => p.getByRole("button", { name: /Brownie/ }).first();
const contador = async (p) => (await brownie(p).innerText()).match(/(\d+)\s*\/\s*(\d+)/)?.slice(1).map(Number);
const vendasDb = () => db.vendas.filter((v) => v.produto === "brownie");
const aguardar = async (cond, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (cond()) return true; await espera(200); } return false; };

try {
  const ctx = await novoContexto();
  const p = await ctx.newPage();
  p.on("dialog", (d) => d.accept());
  await p.goto(APP, { waitUntil: "networkidle", timeout: 120000 });

  // 1. Início de sessão
  const inp = p.locator('input[type="number"]').nth(1);
  await inp.fill("10");
  await botao(p, /Começar vendas/).click();
  await p.getByText("Vendas em andamento").waitFor();
  await aguardar(() => db.sessoes_venda.length === 1 && db.amostras_venda.length === 1);
  ok("1. Começar vendas cria 1 sessão ativa e a amostra de início", db.sessoes_venda.length === 1 && db.sessoes_venda[0].status === "ativa" && db.amostras_venda[0]?.motivo === "inicio");
  const sid = db.sessoes_venda[0].id;

  // 2. Registro de vendas
  for (let i = 0; i < 3; i++) await brownie(p).click();
  await aguardar(() => vendasDb().length === 3);
  ok("2. 3 vendas chegam ao banco com sessao_id, GPS e bairro", vendasDb().length === 3 && vendasDb().every((v) => v.sessao_id === sid && v.lat && v.bairro === "Coyoacán"), `banco=${vendasDb().length}`);

  // 3. Recarregar a página
  await p.reload({ waitUntil: "networkidle" });
  await p.getByText("Vendas em andamento").waitFor();
  ok("3. Após recarregar, a sessão continua e o contador mostra 3/10", JSON.stringify(await contador(p)) === "[3,10]", JSON.stringify(await contador(p)));

  // 4. Queda de conexão
  supabaseOnline = false;
  await brownie(p).click(); await brownie(p).click();
  await p.getByText(/venda\(s\) pendente/).waitFor({ timeout: 20000 });
  ok("4a. Sem internet: contador 5/10 e aviso de pendentes", JSON.stringify(await contador(p)) === "[5,10]");
  await p.reload({ waitUntil: "domcontentloaded" });
  await p.getByText("Vendas em andamento").waitFor();
  const outbox = await p.evaluate(() => JSON.parse(localStorage.getItem("outbox_v1") || "[]").filter((x) => x.tabela === "vendas").length);
  ok("4b. Recarregar offline mantém as 2 vendas na fila do aparelho", outbox === 2, `fila=${outbox}`);
  supabaseOnline = true;
  await p.evaluate(() => window.dispatchEvent(new Event("online")));
  await aguardar(() => vendasDb().length === 5);
  ok("4c. Ao voltar a internet, as 2 vendas chegam (total 5, sem duplicar)", vendasDb().length === 5 && new Set(vendasDb().map((v) => v.cliente_id)).size === 5, `banco=${vendasDb().length}`);

  // 5. Desfazer com rede lenta (upsert ainda em voo)
  atrasoUpsertVendas = 3000;
  await brownie(p).click();
  await espera(300);
  await p.getByRole("button", { name: /Desfazer/ }).click();
  atrasoUpsertVendas = 0;
  await espera(8000);
  ok("5. Desfazer durante envio lento: a venda desfeita não fica no banco", vendasDb().length === 5, `banco=${vendasDb().length}`);
  await p.reload({ waitUntil: "networkidle" });
  ok("5b. Após recarregar, a venda desfeita não volta ao contador", JSON.stringify(await contador(p)) === "[5,10]", JSON.stringify(await contador(p)));

  // 6. Duas abas
  const p2 = await ctx.newPage(); p2.on("dialog", (d) => d.accept());
  await p2.goto(APP, { waitUntil: "networkidle" });
  await p2.getByText("Vendas em andamento").waitFor();
  await brownie(p2).click();
  await brownie(p).click();
  await aguardar(() => vendasDb().length === 7);
  ok("6. Duas abas: mesma sessão, vendas das duas chegam sem duplicar", vendasDb().length === 7 && db.sessoes_venda.length === 1 && vendasDb().every((v) => v.sessao_id === sid), `banco=${vendasDb().length} sessoes=${db.sessoes_venda.length}`);
  await p2.close();

  // 7. Armazenamento local perdido -> recupera do banco
  const ctxB = await novoContexto();
  const pB = await ctxB.newPage(); pB.on("dialog", (d) => d.accept());
  await pB.goto(APP, { waitUntil: "networkidle" });
  await pB.getByText("Vendas em andamento").waitFor({ timeout: 15000 }).catch(() => {});
  const recuperou = await pB.getByText("Vendas em andamento").isVisible();
  await espera(1500);
  ok("7. Outro navegador / localStorage limpo: recupera a sessão ativa do banco", recuperou && JSON.stringify(await contador(pB)) === "[7,10]" && db.sessoes_venda.length === 1, JSON.stringify(await contador(pB)));
  await ctxB.close();

  // 8. Encerramento
  await p.reload({ waitUntil: "networkidle" });
  await botao(p, /Finalizar vendas/).click();
  await p.getByText("Resumo das vendas").waitFor({ timeout: 30000 });
  await aguardar(() => db.sessoes_venda[0].status === "encerrada" && db.dias.length === 1);
  const fimAm = db.amostras_venda.filter((a) => a.motivo === "fim");
  ok("8. Finalizar: sessão encerrada com fim, amostra de fim e resumo do dia = 7", db.sessoes_venda[0].status === "encerrada" && db.sessoes_venda[0].fim && fimAm.length === 1 && db.dias[0]?.vendeu_brow === 7, `dias=${JSON.stringify(db.dias[0]?.vendeu_brow)} fim=${fimAm.length}`);
  ok("8b. Contadores das amostras batem com eventos (nunca acima)", db.amostras_venda.every((a) => a.vendidos_brow <= 7) && fimAm[0]?.vendidos_brow === 7, db.amostras_venda.map((a) => a.motivo + ":" + a.vendidos_brow).join(","));

  // 9. Sessão de dia anterior esquecida aberta
  const ctxC = await novoContexto();
  const pC = await ctxC.newPage();
  await pC.goto(APP, { waitUntil: "networkidle" });
  db.sessoes_venda.push({ id: "sessao-ontem", data: "2026-10-01", inicio: "2026-10-01T21:00:00.000Z", fim: null, status: "ativa", levou_brow: 30, levou_brig: 0 });
  await pC.evaluate(() => {
    localStorage.setItem("sessaoVenda", JSON.stringify({ id: "sessao-ontem", data: "2026-10-01", inicio: "2026-10-01T21:00:00.000Z", levouBrow: 30, levouBrig: 0, precoBrow: 40, precoBrig: 20, browniesInicio: 0, brigadeirosInicio: 0 }));
    localStorage.setItem("ultimaAmostraEm", String(Date.parse("2026-10-01T23:30:00.000Z")));
  });
  await pC.reload({ waitUntil: "networkidle" });
  await aguardar(() => db.sessoes_venda.find((s) => s.id === "sessao-ontem").status === "encerrada");
  const ontem = db.sessoes_venda.find((s) => s.id === "sessao-ontem");
  ok("9. Sessão de outro dia é encerrada com fim = última atividade (23:30), não agora", ontem.status === "encerrada" && ontem.fim === "2026-10-01T23:30:00.000Z", ontem.fim);
  await ctxC.close();
  await ctx.close();
} catch (e) {
  ok("execução sem erro", false, String(e).slice(0, 300));
} finally {
  await browser.close();
  const f = resultados.filter((r) => !r.ok).length;
  console.log(`\n${resultados.length - f}/${resultados.length} passaram`);
}
