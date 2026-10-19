// Chamadas externas com tempo máximo, para nunca travar o registro de vendas ou a coleta.

export async function fetchJsonComTimeout(url: string, ms: number, init?: RequestInit) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}
