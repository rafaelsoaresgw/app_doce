"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "./supabase";

type Venda = {
  id: string;
  produto: string;
  hora: string;
  data: string;
};

type LocalConhecido = {
  lat: number;
  lon: number;
  bairro: string | null;
  tipoArea: string | null;
  quando: number;
};

const FERIADOS_MX = [
  "01-01", "02-05", "03-21", "05-01", "09-16", "11-20", "12-25",
  "11-01", "11-02", "12-12", "12-24", "12-31",
];

function hojeLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function ehFeriado() {
  const d = new Date();
  const md = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return FERIADOS_MX.includes(md);
}

const DIAS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
function diaSemana() { return DIAS[new Date().getDay()]; }

function periodoDoDia() {
  const h = new Date().getHours();
  if (h < 12) return "manhã";
  if (h < 18) return "tarde";
  return "noite";
}

function salvarEstadoAgora(dados: Record<string, unknown>) {
  try {
    localStorage.setItem("estado", JSON.stringify({ ...dados, data: hojeLocal() }));
  } catch { /* ignora */ }
}

// som de moeda gerado no próprio navegador (sem arquivo, funciona offline)
function tocarMoeda() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const agora = ctx.currentTime;

    [[988, 0], [1319, 0.07]].forEach(([freq, atraso]) => {
      const osc = ctx.createOscillator();
      const vol = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = freq;
      osc.connect(vol);
      vol.connect(ctx.destination);
      vol.gain.setValueAtTime(0.18, agora + atraso);
      vol.gain.exponentialRampToValueAtTime(0.001, agora + atraso + 0.25);
      osc.start(agora + atraso);
      osc.stop(agora + atraso + 0.25);
    });

    setTimeout(() => ctx.close(), 600);
  } catch { /* ignora */ }
}

export default function Home() {
  const [vendas, setVendas] = useState<Venda[]>([]);
  const [levouBrig, setLevouBrig] = useState(0);
  const [levouBrow, setLevouBrow] = useState(0);
  const [precoBrig, setPrecoBrig] = useState(20);
  const [precoBrow, setPrecoBrow] = useState(35);
  const [carregado, setCarregado] = useState(false);
  const [mostrarBalanco, setMostrarBalanco] = useState(false);
  const [mostrarConfig, setMostrarConfig] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ultimaVenda, setUltimaVenda] = useState<Venda | null>(null);
  const [pendentes, setPendentes] = useState(0);
  const [gpsOk, setGpsOk] = useState(true);
  const ultimoLocal = useRef<LocalConhecido | null>(null);

  const ref = useRef({ vendas, levouBrig, levouBrow, precoBrig, precoBrow });
  ref.current = { vendas, levouBrig, levouBrow, precoBrig, precoBrow };

  // ---------- FILA DE REENVIO ----------
  const enviarPendentes = useCallback(async () => {
    const fila = JSON.parse(localStorage.getItem("fila") || "[]");
    if (fila.length === 0) { setPendentes(0); return; }
    const restantes = [];
    for (const item of fila) {
      const { error } = await supabase.from("vendas").insert(item);
      if (error) restantes.push(item);
    }
    localStorage.setItem("fila", JSON.stringify(restantes));
    setPendentes(restantes.length);
  }, []);

  function adicionarNaFila(registro: Record<string, unknown>) {
    const fila = JSON.parse(localStorage.getItem("fila") || "[]");
    fila.push(registro);
    localStorage.setItem("fila", JSON.stringify(fila));
    setPendentes(fila.length);
  }

  // ---------- RECONCILIAÇÃO ----------
  const reconciliar = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from("vendas")
        .select("cliente_id, produto, hora, data")
        .eq("data", hojeLocal());
      if (error || !data) return;

      const doBanco: Venda[] = data.map((v) => ({
        id: v.cliente_id || `banco-${v.hora}-${Math.random()}`,
        produto: v.produto,
        hora: v.hora,
        data: v.data,
      }));

      setVendas((locais) => {
        const mapa = new Map<string, Venda>();
        for (const v of doBanco) mapa.set(v.id, v);
        for (const v of locais) mapa.set(v.id, v);
        const juntas = Array.from(mapa.values());
        salvarEstadoAgora({ ...ref.current, vendas: juntas });
        return juntas;
      });
    } catch { /* offline: mantém o local */ }
  }, []);

  // ---------- SALVAR DIA ----------
  const salvarDia = useCallback(async (d: {
    data: string; levouBrig: number; levouBrow: number;
    vBrig: number; vBrow: number; pBrig: number; pBrow: number;
    feriado: boolean; dia: string;
  }) => {
    const registro = {
      data: d.data,
      levou_brig: d.levouBrig,
      levou_brow: d.levouBrow,
      vendeu_brig: d.vBrig,
      vendeu_brow: d.vBrow,
      sobrou_brig: d.levouBrig - d.vBrig,
      sobrou_brow: d.levouBrow - d.vBrow,
      preco_brig: d.pBrig,
      preco_brow: d.pBrow,
      faturamento: d.vBrig * d.pBrig + d.vBrow * d.pBrow,
      feriado: d.feriado,
      dia_semana: d.dia,
    };
    const { error } = await supabase.from("dias").insert(registro);
    if (error) {
      const filaDias = JSON.parse(localStorage.getItem("filaDias") || "[]");
      filaDias.push(registro);
      localStorage.setItem("filaDias", JSON.stringify(filaDias));
    }
  }, []);

  const enviarDiasPendentes = useCallback(async () => {
    const fila = JSON.parse(localStorage.getItem("filaDias") || "[]");
    if (fila.length === 0) return;
    const restantes = [];
    for (const item of fila) {
      const { error } = await supabase.from("dias").insert(item);
      if (error) restantes.push(item);
    }
    localStorage.setItem("filaDias", JSON.stringify(restantes));
  }, []);

  // ---------- AO ABRIR ----------
  useEffect(() => {
    const salvo = localStorage.getItem("estado");
    const hoje = hojeLocal();

    if (salvo) {
      const e = JSON.parse(salvo);
      const dataSalva = e.data || hoje;
      if (e.precoBrig != null) setPrecoBrig(e.precoBrig);
      if (e.precoBrow != null) setPrecoBrow(e.precoBrow);

      if (dataSalva !== hoje) {
        const vendasAntigas: Venda[] = e.vendas || [];
        const vBrig = vendasAntigas.filter((v) => v.produto === "brigadeiro").length;
        const vBrow = vendasAntigas.filter((v) => v.produto === "brownie").length;
        if (vendasAntigas.length > 0 || e.levouBrig > 0 || e.levouBrow > 0) {
          salvarDia({
            data: dataSalva,
            levouBrig: e.levouBrig || 0,
            levouBrow: e.levouBrow || 0,
            vBrig, vBrow,
            pBrig: e.precoBrig ?? 20,
            pBrow: e.precoBrow ?? 35,
            feriado: false,
            dia: "",
          });
        }
        setVendas([]);
        setLevouBrig(0);
        setLevouBrow(0);
      } else {
        setVendas(e.vendas || []);
        setLevouBrig(e.levouBrig || 0);
        setLevouBrow(e.levouBrow || 0);
      }
    }
    setCarregado(true);
    setPendentes(JSON.parse(localStorage.getItem("fila") || "[]").length);
  }, [salvarDia]);

  useEffect(() => {
    if (carregado) salvarEstadoAgora({ vendas, levouBrig, levouBrow, precoBrig, precoBrow });
  }, [vendas, levouBrig, levouBrow, precoBrig, precoBrow, carregado]);

  useEffect(() => {
    if (!carregado) return;
    reconciliar();
    enviarPendentes();
    enviarDiasPendentes();
    const timer = setInterval(() => {
      enviarPendentes(); enviarDiasPendentes(); reconciliar();
    }, 60000);
    const aoVoltar = () => { enviarPendentes(); enviarDiasPendentes(); reconciliar(); };
    const aoFocar = () => { if (document.visibilityState === "visible") reconciliar(); };
    window.addEventListener("online", aoVoltar);
    document.addEventListener("visibilitychange", aoFocar);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", aoVoltar);
      document.removeEventListener("visibilitychange", aoFocar);
    };
  }, [carregado, enviarPendentes, enviarDiasPendentes, reconciliar]);

  useEffect(() => {
    if (!navigator.permissions) return;
    navigator.permissions.query({ name: "geolocation" as PermissionName })
      .then((p) => {
        setGpsOk(p.state !== "denied");
        p.onchange = () => setGpsOk(p.state !== "denied");
      })
      .catch(() => {});
  }, []);

  // ---------- APIs ----------
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

  async function buscarLocal(lat: number, lon: number) {
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=16&extratags=1`;
      const r = await fetch(url, { headers: { "Accept-Language": "pt" } });
      const d = await r.json();
      const e = d.address || {};
      const bairro = e.suburb || e.borough || e.neighbourhood || e.city || null;
      let tipoArea: string | null = "mista";
      const cat = `${d.category || ""} ${d.type || ""} ${e.shop || ""} ${e.office || ""}`.toLowerCase();
      if (cat.includes("commercial") || cat.includes("retail") || e.shop) tipoArea = "comercial";
      else if (cat.includes("residential") || e.residential) tipoArea = "residencial";
      else if (cat.includes("industrial")) tipoArea = "industrial";
      return { bairro, tipoArea };
    } catch {
      return { bairro: null, tipoArea: null };
    }
  }

  function pegarLocalizacao(): Promise<{ lat: number | null; lon: number | null; precisao: number | null }> {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve({ lat: null, lon: null, precisao: null });
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          setGpsOk(true);
          resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, precisao: pos.coords.accuracy });
        },
        (err) => {
          if (err.code === err.PERMISSION_DENIED) setGpsOk(false);
          resolve({ lat: null, lon: null, precisao: null });
        },
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 }
      );
    });
  }

  function pedirLocalizacao() {
    navigator.geolocation.getCurrentPosition(
      () => { setGpsOk(true); setAviso("Localização ativada!"); setTimeout(() => setAviso(null), 2000); },
      () => { setGpsOk(false); setAviso("Ative nas configurações do navegador"); setTimeout(() => setAviso(null), 4000); },
      { enableHighAccuracy: true, timeout: 20000 }
    );
  }

  // ---------- REGISTRO ----------
  async function completarRegistro(venda: Venda, preco: number) {
    const pos = await pegarLocalizacao();
    let lat = pos.lat, lon = pos.lon, precisao = pos.precisao;
    let bairro: string | null = null, tipoArea: string | null = null;
    let temperatura: number | null = null, chuva: number | null = null;
    let aproximado = false;

    if (lat && lon) {
      const clima = await buscarClima(lat, lon);
      const local = await buscarLocal(lat, lon);
      temperatura = clima.temperatura; chuva = clima.chuva;
      bairro = local.bairro; tipoArea = local.tipoArea;
      ultimoLocal.current = { lat, lon, bairro, tipoArea, quando: Date.now() };
    } else if (ultimoLocal.current && Date.now() - ultimoLocal.current.quando < 30 * 60 * 1000) {
      lat = ultimoLocal.current.lat; lon = ultimoLocal.current.lon;
      bairro = ultimoLocal.current.bairro; tipoArea = ultimoLocal.current.tipoArea;
      precisao = null; aproximado = true;
      const clima = await buscarClima(lat, lon);
      temperatura = clima.temperatura; chuva = clima.chuva;
    }

    const registro = {
      cliente_id: venda.id,
      produto: venda.produto,
      hora: venda.hora,
      data: venda.data,
      preco, lat, lon, bairro,
      tipo_area: tipoArea,
      temperatura, chuva, precisao,
      local_aproximado: aproximado,
      feriado: ehFeriado(),
      dia_semana: diaSemana(),
      periodo: periodoDoDia(),
    };

    const { error } = await supabase.from("vendas").insert(registro);
    if (error) adicionarNaFila(registro);
  }

  function registrar(produto: string) {
    const agora = new Date();
    const hora = agora.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    const venda: Venda = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      produto, hora, data: hojeLocal(),
    };

    setVendas((atual) => {
      const novas = [...atual, venda];
      salvarEstadoAgora({ ...ref.current, vendas: novas });
      return novas;
    });

    tocarMoeda();
    if (navigator.vibrate) navigator.vibrate(100);
    const nome = produto === "brigadeiro" ? "Brigadeiro" : "Brownie";
    setAviso(`${nome} registrado!`);
    setUltimaVenda(venda);
    setTimeout(() => setAviso(null), 2000);
    setTimeout(() => setUltimaVenda((u) => (u?.id === venda.id ? null : u)), 6000);

    completarRegistro(venda, produto === "brigadeiro" ? precoBrig : precoBrow);
  }

  async function desfazer() {
    if (!ultimaVenda) return;
    const id = ultimaVenda.id;
    setVendas((atual) => {
      const novas = atual.filter((v) => v.id !== id);
      salvarEstadoAgora({ ...ref.current, vendas: novas });
      return novas;
    });
    setUltimaVenda(null);
    setAviso("Desfeito");
    setTimeout(() => setAviso(null), 1500);
    if (navigator.vibrate) navigator.vibrate([50, 50, 50]);

    const fila = JSON.parse(localStorage.getItem("fila") || "[]");
    const novaFila = fila.filter((f: { cliente_id?: string }) => f.cliente_id !== id);
    localStorage.setItem("fila", JSON.stringify(novaFila));
    setPendentes(novaFila.length);
    await supabase.from("vendas").delete().eq("cliente_id", id);
  }

  const brigadeiros = vendas.filter((v) => v.produto === "brigadeiro").length;
  const brownies = vendas.filter((v) => v.produto === "brownie").length;
  const faturamento = brigadeiros * precoBrig + brownies * precoBrow;

  async function encerrarDia() {
    await salvarDia({
      data: hojeLocal(),
      levouBrig, levouBrow,
      vBrig: brigadeiros, vBrow: brownies,
      pBrig: precoBrig, pBrow: precoBrow,
      feriado: ehFeriado(), dia: diaSemana(),
    });
    setVendas([]); setLevouBrig(0); setLevouBrow(0);
    salvarEstadoAgora({ vendas: [], levouBrig: 0, levouBrow: 0, precoBrig, precoBrow });
    setMostrarBalanco(false);
  }

  // ---------- TELAS ----------
  if (mostrarConfig) {
    return (
      <main className="min-h-screen bg-neutral-950 text-white flex flex-col items-center justify-center gap-6 p-6">
        <h1 className="text-2xl font-bold">Preço dos doces</h1>
        <p className="text-neutral-400 text-center text-sm">Configure uma vez. Usado para calcular o faturamento.</p>
        <div className="w-full max-w-sm bg-neutral-900 rounded-2xl p-5 space-y-5">
          <div className="flex justify-between items-center">
            <span>🍫 Brigadeiro</span>
            <div className="flex items-center gap-2">
              <button onClick={() => setPrecoBrig(Math.max(0, precoBrig - 1))} className="bg-neutral-700 w-10 h-10 rounded-full text-xl">−</button>
              <input type="number" inputMode="numeric" value={precoBrig}
                onChange={(e) => setPrecoBrig(Math.max(0, parseInt(e.target.value) || 0))}
                onFocus={(e) => e.target.select()}
                className="w-16 h-10 text-center text-xl font-bold bg-neutral-800 rounded-lg" />
              <button onClick={() => setPrecoBrig(precoBrig + 1)} className="bg-neutral-700 w-10 h-10 rounded-full text-xl">+</button>
            </div>
          </div>
          <div className="flex justify-between items-center">
            <span>🍰 Brownie</span>
            <div className="flex items-center gap-2">
              <button onClick={() => setPrecoBrow(Math.max(0, precoBrow - 1))} className="bg-neutral-700 w-10 h-10 rounded-full text-xl">−</button>
              <input type="number" inputMode="numeric" value={precoBrow}
                onChange={(e) => setPrecoBrow(Math.max(0, parseInt(e.target.value) || 0))}
                onFocus={(e) => e.target.select()}
                className="w-16 h-10 text-center text-xl font-bold bg-neutral-800 rounded-lg" />
              <button onClick={() => setPrecoBrow(precoBrow + 1)} className="bg-neutral-700 w-10 h-10 rounded-full text-xl">+</button>
            </div>
          </div>
        </div>
        <button onClick={() => setMostrarConfig(false)} className="w-full max-w-sm bg-green-700 rounded-2xl py-4 text-lg font-bold">Salvar</button>
      </main>
    );
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
          <div className="flex justify-between"><span>Total vendido</span><span>{vendas.length} doces</span></div>
          <div className="flex justify-between text-xl font-bold text-green-400"><span>Faturamento</span><span>${faturamento}</span></div>
        </div>
        <button onClick={encerrarDia} className="w-full max-w-sm bg-green-700 active:bg-green-800 rounded-2xl py-5 text-xl font-bold">✓ Confirmar e começar novo dia</button>
        <button onClick={() => setMostrarBalanco(false)} className="text-neutral-400 underline">Voltar</button>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-neutral-950 text-white flex flex-col items-center gap-5 p-6">
      <div className="w-full max-w-sm flex justify-between items-center mt-4">
        <h1 className="text-3xl font-bold">Vendas de hoje</h1>
        <button onClick={() => setMostrarConfig(true)} className="text-neutral-500 text-2xl">⚙</button>
      </div>

      {aviso && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-50 bg-green-600 text-white px-6 py-3 rounded-full text-lg font-bold shadow-lg">
          ✓ {aviso}
        </div>
      )}

      {!gpsOk && (
        <button onClick={pedirLocalizacao} className="w-full max-w-sm bg-red-900/60 border border-red-500 rounded-2xl py-3 px-4 text-center">
          <span className="text-red-200 font-bold">📍 Localização desativada</span>
          <div className="text-red-300 text-sm mt-1">Toque aqui para ativar</div>
        </button>
      )}

      <div className="w-full max-w-sm bg-neutral-900 rounded-2xl p-4">
        <p className="text-center text-neutral-400 mb-3">Quanto levei hoje?</p>
        <div className="flex justify-between items-center mb-3">
          <span>🍫 Brigadeiros</span>
          <div className="flex items-center gap-2">
            <button onClick={() => setLevouBrig(Math.max(0, levouBrig - 1))} className="bg-neutral-700 w-10 h-10 rounded-full text-xl">−</button>
            <input type="number" inputMode="numeric" value={levouBrig}
              onChange={(e) => setLevouBrig(Math.max(0, parseInt(e.target.value) || 0))}
              onFocus={(e) => e.target.select()}
              className="w-16 h-10 text-center text-xl font-bold bg-neutral-800 rounded-lg" />
            <button onClick={() => setLevouBrig(levouBrig + 1)} className="bg-neutral-700 w-10 h-10 rounded-full text-xl">+</button>
          </div>
        </div>
        <div className="flex justify-between items-center">
          <span>🍰 Brownies</span>
          <div className="flex items-center gap-2">
            <button onClick={() => setLevouBrow(Math.max(0, levouBrow - 1))} className="bg-neutral-700 w-10 h-10 rounded-full text-xl">−</button>
            <input type="number" inputMode="numeric" value={levouBrow}
              onChange={(e) => setLevouBrow(Math.max(0, parseInt(e.target.value) || 0))}
              onFocus={(e) => e.target.select()}
              className="w-16 h-10 text-center text-xl font-bold bg-neutral-800 rounded-lg" />
            <button onClick={() => setLevouBrow(levouBrow + 1)} className="bg-neutral-700 w-10 h-10 rounded-full text-xl">+</button>
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

      {ultimaVenda && (
        <button onClick={desfazer} className="text-neutral-400 underline text-lg">
          Desfazer último ({ultimaVenda.produto})
        </button>
      )}

      <div className="text-center">
        <p className="text-neutral-400 text-lg">Total vendido: {vendas.length} doces</p>
        <p className="text-green-400 text-2xl font-bold">${faturamento}</p>
      </div>

      {pendentes > 0 && (
        <p className="text-amber-500 text-sm">{pendentes} venda(s) aguardando internet</p>
      )}

      <button onClick={() => setMostrarBalanco(true)} className="w-full max-w-sm border border-neutral-600 rounded-2xl py-4 text-lg mt-2">
        Encerrar o dia
      </button>
    </main>
  );
}