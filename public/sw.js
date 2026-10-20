// Service worker do app-doce: permite ABRIR o app sem internet.
//
// Regras (para nunca prender a pessoa numa versão velha, como já aconteceu):
// - Página: rede primeiro. Com internet, sempre a versão nova. Sem resposta em 4 s,
//   usa a última cópia guardada.
// - Arquivos /_next/static/: têm hash no nome (nunca mudam), então podem vir da cópia.
// - Nada de outros domínios (Supabase, clima, mapa) passa por aqui.

const CACHE = "app-doce-v1";
const PAGINA = "/";
const ESPERA_REDE_MS = 4000;

function extrairAssets(html) {
  const urls = new Set();
  for (const m of html.matchAll(/\/_next\/static\/[^"'\\\s)]+/g)) urls.add(m[0]);
  for (const m of html.matchAll(/["(]static\/(?:chunks|css|media)\/[^"'\\\s)]+/g)) urls.add("/_next/" + m[0].slice(1));
  return [...urls];
}

async function guardarPagina(resposta) {
  if (!resposta || !resposta.ok || resposta.redirected || resposta.type !== "basic") return;
  const cache = await caches.open(CACHE);
  const html = await resposta.clone().text();
  await cache.put(PAGINA, resposta.clone());
  await Promise.all(
    extrairAssets(html).map(async (u) => {
      if (await cache.match(u)) return;
      try { await cache.add(u); } catch { /* segue */ }
    }),
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    try { await guardarPagina(await fetch(PAGINA, { cache: "no-store" })); } catch { /* offline na instalação */ }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const nome of await caches.keys()) if (nome !== CACHE) await caches.delete(nome);
    await self.clients.claim();
  })());
});

function comPrazo(promessa, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("prazo")), ms);
    promessa.then((r) => { clearTimeout(t); resolve(r); }, (e) => { clearTimeout(t); reject(e); });
  });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === "navigate") {
    event.respondWith((async () => {
      const daRede = fetch(req, { cache: "no-store" });
      try {
        const r = await comPrazo(daRede, ESPERA_REDE_MS);
        if (url.pathname === PAGINA) event.waitUntil(guardarPagina(r.clone()));
        return r;
      } catch {
        const copia = await caches.match(PAGINA);
        if (copia) {
          // Se a rede responder depois, atualiza a cópia para a próxima vez.
          event.waitUntil(daRede.then((r) => guardarPagina(r)).catch(() => {}));
          return copia;
        }
        return daRede; // sem cópia: deixa o navegador mostrar o erro normal
      }
    })());
    return;
  }

  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const copia = await cache.match(req);
      if (copia) return copia;
      const r = await fetch(req);
      if (r.ok) event.waitUntil(cache.put(req, r.clone()));
      return r;
    })());
    return;
  }

  // Outros arquivos do próprio site (ícone etc.): rede, com a cópia como reserva.
  event.respondWith((async () => {
    try {
      const r = await fetch(req);
      if (r.ok) { const cache = await caches.open(CACHE); event.waitUntil(cache.put(req, r.clone())); }
      return r;
    } catch {
      const copia = await caches.match(req);
      if (copia) return copia;
      throw new Error("offline");
    }
  })());
});
