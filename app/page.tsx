"use client";

import { useState, useEffect } from "react";

type Venda = {
  produto: string;
  hora: string;
  lat: number | null;
  lon: number | null;
  bairro: string | null;
  temperatura: number | null;
  chuva: number | null;
};

export default function Home() {
  const [vendas, setVendas] = useState<Venda[]>([]);
  const [levouBrig, setLevouBrig] = useState(0);
  const [levouBrow, setLevouBrow] = useState(0);
  const [carregado, setCarregado] = useState(false);
  const [mostrarBalanco, setMostrarBalanco] = useState(false);

  useEffect(() => {
    const salvo = localStorage.getItem("estado");
    if (salvo) {
      const e = JSON.parse(salvo);
      setVendas(e.vendas || []);
      setLevouBrig(e.levouBrig || 0);
      setLevouBrow(e.levouBrow || 0);
    }
    setCarregado(true);
  }, []);

  useEffect(() => {
    if (carregado) {
      localStorage.setItem("estado", JSON.stringify({ vendas, levouBrig, levouBrow }));
    }
  }, [vendas, levouBrig, levouBrow, carregado]);

  async function buscarClima(lat: number, lon: number) {
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,precipitation`;
      const r = await fetch(url);
      const d = await r.json();
      return { temperatura: d.current.temperature_2m, chuva: d.current.precipitation };
    } catch {
      return { temperatura: null, chuva: null };
    }
  }

  async function buscarBairro(lat: number, lon: number) {
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=16`;
      const r = await fetch(url, { headers: { "Accept-Language": "pt" } });
      const d = await r.json();
      const e = d.address || {};
      return e.suburb || e.borough || e.neighbourhood || e.city || null;
    } catch {
      return null;
    }
  }

  function pegarLocalizacao(): Promise<{ lat: number | null; lon: number | null }> {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve({ lat: null, lon: null });
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
        () => resolve({ lat: null, lon: null })
      );
    });
  }

  async function registrar(produto: string) {
    const agora = new Date();
    const hora = agora.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    const { lat, lon } = await pegarLocalizacao();
    const clima = lat && lon ? await buscarClima(lat, lon) : { temperatura: null, chuva: null };
    const bairro = lat && lon ? await buscarBairro(lat, lon) : null;
    setVendas((atual) => [...atual, { produto, hora, lat, lon, bairro, ...clima }]);
  }

  const brigadeiros = vendas.filter((v) => v.produto === "brigadeiro").length;
  const brownies = vendas.filter((v) => v.produto === "brownie").length;

  function encerrarDia() {
    const historico = JSON.parse(localStorage.getItem("historico") || "[]");
    historico.push({
      data: new Date().toISOString(),
      levouBrig, levouBrow,
      vendeuBrig: brigadeiros, vendeuBrow: brownies,
      vendas,
    });
    localStorage.setItem("historico", JSON.stringify(historico));
    setVendas([]);
    setLevouBrig(0);
    setLevouBrow(0);
    setMostrarBalanco(false);
  }

  if (mostrarBalanco) {
    return (
      <main className="min-h-screen bg-neutral-950 text-white flex flex-col items-center justify-center gap-6 p-6">
        <h1 className="text-3xl font-bold">Balanço do dia</h1>
        <div className="w-full max-w-sm bg-neutral-900 rounded-2xl p-6 space-y-4 text-lg">
          <div className="flex justify-between"><span>🍫 Brigadeiros</span><span>{brigadeiros} / {levouBrig} vendidos</span></div>
          <div className="flex justify-between text-neutral-400"><span>Sobraram</span><span>{levouBrig - brigadeiros}</span></div>
          <hr className="border-neutral-700" />
          <div className="flex justify-between"><span>🍰 Brownies</span><span>{brownies} / {levouBrow} vendidos</span></div>
          <div className="flex justify-between text-neutral-400"><span>Sobraram</span><span>{levouBrow - brownies}</span></div>
          <hr className="border-neutral-700" />
          <div className="flex justify-between text-xl font-bold text-amber-400"><span>Total vendido</span><span>{vendas.length} doces</span></div>
        </div>
        <button onClick={encerrarDia} className="w-full max-w-sm bg-green-700 active:bg-green-800 rounded-2xl py-5 text-xl font-bold">
          ✓ Confirmar e começar novo dia
        </button>
        <button onClick={() => setMostrarBalanco(false)} className="text-neutral-400 underline">
          Voltar
        </button>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-neutral-950 text-white flex flex-col items-center gap-6 p-6">
      <h1 className="text-3xl font-bold mt-4">Vendas de hoje</h1>

      <div className="w-full max-w-sm bg-neutral-900 rounded-2xl p-4">
        <p className="text-center text-neutral-400 mb-3">Quanto levei hoje?</p>
        <div className="flex justify-between items-center mb-2">
          <span>🍫 Brigadeiros</span>
          <div className="flex items-center gap-3">
            <button onClick={() => setLevouBrig(Math.max(0, levouBrig - 5))} className="bg-neutral-700 w-10 h-10 rounded-full text-xl">−</button>
            <span className="w-10 text-center text-xl font-bold">{levouBrig}</span>
            <button onClick={() => setLevouBrig(levouBrig + 5)} className="bg-neutral-700 w-10 h-10 rounded-full text-xl">+</button>
          </div>
        </div>
        <div className="flex justify-between items-center">
          <span>🍰 Brownies</span>
          <div className="flex items-center gap-3">
            <button onClick={() => setLevouBrow(Math.max(0, levouBrow - 5))} className="bg-neutral-700 w-10 h-10 rounded-full text-xl">−</button>
            <span className="w-10 text-center text-xl font-bold">{levouBrow}</span>
            <button onClick={() => setLevouBrow(levouBrow + 5)} className="bg-neutral-700 w-10 h-10 rounded-full text-xl">+</button>
          </div>
        </div>
      </div>

      <button onClick={() => registrar("brigadeiro")} className="w-full max-w-sm bg-amber-600 active:bg-amber-700 rounded-3xl py-8 text-2xl font-bold shadow-lg transition">
        🍫 Brigadeiro
        <div className="text-4xl mt-1">{brigadeiros} <span className="text-lg text-amber-200">/ {levouBrig}</span></div>
      </button>

      <button onClick={() => registrar("brownie")} className="w-full max-w-sm bg-orange-800 active:bg-orange-900 rounded-3xl py-8 text-2xl font-bold shadow-lg transition">
        🍰 Brownie
        <div className="text-4xl mt-1">{brownies} <span className="text-lg text-orange-200">/ {levouBrow}</span></div>
      </button>

      <p className="text-neutral-400 text-lg">Total vendido: {vendas.length} doces</p>

      <div className="w-full max-w-sm text-sm text-neutral-400">
        {vendas.slice(-5).reverse().map((v, i) => (
          <div key={i} className="flex justify-between border-b border-neutral-800 py-1">
            <span>{v.produto}</span>
            <span>{v.hora} · {v.bairro || "..."} · {v.temperatura !== null ? `${v.temperatura}°` : "..."}</span>
          </div>
        ))}
      </div>

      <button onClick={() => setMostrarBalanco(true)} className="w-full max-w-sm border border-neutral-600 rounded-2xl py-4 text-lg mt-2">
        Encerrar o dia
      </button>
    </main>
  );
}