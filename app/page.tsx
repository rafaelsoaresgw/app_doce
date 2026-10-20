"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "./supabase";
import {
  criarId,
  diaSemanaCDMX,
  diaSemanaDaData,
  hojeCDMX,
  horaCDMX,
  minutosEntre,
  periodoCDMX,
  type MotivoAmostra,
  type SessaoVenda,
} from "./lib/coleta";
import {
  enfileirar,
  liberarEsperas,
  listar as listarOutbox,
  migrarFilasAntigas,
  sincronizar,
  temDeletePendente,
  type ItemOutbox,
} from "./lib/outbox";
import { fetchJsonComTimeout } from "./lib/rede";

// Envia um item da outbox ao Supabase com tempo máximo (evita envio "pendurado" para sempre).
async function enviarItem(item: ItemOutbox) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    if (item.op === "delete") {
      return await supabase.from(item.tabela).delete().eq(item.conflito, item.payload[item.conflito] as string).abortSignal(ctrl.signal);
    }
    // Vendas: a tabela não permite UPDATE para o app (RLS). Por isso cada venda é enviada
    // uma única vez, já completa, e um reenvio de algo que já chegou é ignorado em vez de dar erro.
    const ignorarDuplicadas = item.tabela === "vendas";
    return await supabase.from(item.tabela).upsert(item.payload, { onConflict: item.conflito, ignoreDuplicates: ignorarDuplicadas }).abortSignal(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

function contarPendentes() {
  try {
    const itens = listarOutbox(localStorage);
    return {
      vendas: itens.filter((x) => x.tabela === "vendas").length,
      coleta: itens.filter((x) => x.tabela !== "vendas").length,
    };
  } catch {
    return { vendas: 0, coleta: 0 };
  }
}

function vendidosNaSessao(vendas: Venda[], sessaoId: string, produto: string) {
  return vendas.filter((v) => v.sessaoId === sessaoId && v.produto === produto).length;
}

type Venda = {
  id: string;
  produto: string;
  hora: string;
  data: string;
  momento?: string;
  sessaoId?: string | null;
};

type LocalConhecido = {
  lat: number; lon: number; bairro: string | null; tipoArea: string | null; quando: number;
};

type Recomendacao = {
  brownies: number;
  brigadeiros: number;
  mediaBrow: number;
  diasBase: number;
  melhorBairro: string | null;
  alternativas: string[];
  melhorHorario: string | null;
  horarioComMedicao: boolean;
  confianca: "baixa" | "media" | "boa";
  estoqueEsgotouPct: number;
  faixaMin: number;
  faixaMax: number;
  baseDescricao: string;
  fonteRegiao: "intervalos" | "historico" | "insuficiente";
  browniesHora: number | null;
  minutosRegiao: number;
  diasRegiao: number;
  tempoEstimadoMin: number | null;
  microzona: string | null;
  microzonaLat: number | null;
  microzonaLon: number | null;
};

type BalancoFinal = {
  brigadeiros: number;
  brownies: number;
  levouBrig: number;
  levouBrow: number;
  faturamento: number;
};

const FERIADOS_MX = [
  "01-01", "02-05", "03-21", "05-01", "09-16", "11-20", "12-25",
  "11-01", "11-02", "12-12", "12-24", "12-31",
];

function ehFeriado(data = hojeCDMX()) {
  const md = data.slice(5);
  return FERIADOS_MX.includes(md);
}

const DIA_ISO: Record<string, number> = {
  Segunda: 1, Terça: 2, Quarta: 3, Quinta: 4, Sexta: 5, Sábado: 6, Domingo: 7,
};

function faixaTresHoras(hora: string | null | undefined) {
  const h = Number(String(hora || "").slice(0, 2));
  if (!Number.isFinite(h)) return null;
  const inicio = Math.floor(h / 3) * 3;
  const fim = Math.min(24, inicio + 3);
  return `${String(inicio).padStart(2, "0")}h–${String(fim).padStart(2, "0")}h`;
}

function quantil(valores: number[], q: number) {
  if (valores.length === 0) return 0;
  const ordenados = [...valores].sort((a, b) => a - b);
  const pos = (ordenados.length - 1) * q;
  const base = Math.floor(pos);
  const resto = pos - base;
  const proximo = ordenados[base + 1];
  return proximo == null ? ordenados[base] : ordenados[base] + resto * (proximo - ordenados[base]);
}

function salvarEstadoAgora(dados: Record<string, unknown>) {
  try {
    localStorage.setItem("estado", JSON.stringify({ ...dados, data: hojeCDMX() }));
  } catch { /* ignora */ }
}

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
      osc.connect(vol); vol.connect(ctx.destination);
      vol.gain.setValueAtTime(0.18, agora + atraso);
      vol.gain.exponentialRampToValueAtTime(0.001, agora + atraso + 0.25);
      osc.start(agora + atraso); osc.stop(agora + atraso + 0.25);
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
  const [balancoFinal, setBalancoFinal] = useState<BalancoFinal | null>(null);
  const [mostrarConfig, setMostrarConfig] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ultimaVenda, setUltimaVenda] = useState<Venda | null>(null);
  const [pendentes, setPendentes] = useState(0);
  const [pendentesColeta, setPendentesColeta] = useState(0);
  const [gpsOk, setGpsOk] = useState(true);
  const [encerrando, setEncerrando] = useState(false);
  const [rec, setRec] = useState<Recomendacao | null>(null);
  const [sessao, setSessao] = useState<SessaoVenda | null>(null);
  const [coletandoAmostra, setColetandoAmostra] = useState(false);
  const [agoraTick, setAgoraTick] = useState(0);
  const [dataAtiva, setDataAtiva] = useState(() => hojeCDMX());
  const ultimoLocal = useRef<LocalConhecido | null>(null);
  const coletaEmAndamentoRef = useRef(false);
  const coletaAtualRef = useRef<Promise<void> | null>(null);
  const iniciandoRef = useRef(false);
  const desfeitasRef = useRef(new Set<string>());
  const ultimaAmostraEm = useRef(0);
  const ultimoPontoAmostrado = useRef<{ lat: number; lon: number; quando: number } | null>(null);

  const ref = useRef({ vendas, levouBrig, levouBrow, precoBrig, precoBrow, sessao });
  useEffect(() => {
    ref.current = { vendas, levouBrig, levouBrow, precoBrig, precoBrow, sessao };
  }, [vendas, levouBrig, levouBrow, precoBrig, precoBrow, sessao]);

  // ---------- PLANO DO DIA ----------
  // Usa intervalos reais (com tempo sem venda) quando já existem dados suficientes.
  // Enquanto o ML ainda aprende, cai para o histórico de vendas sem fingir precisão.
  const calcularRecomendacao = useCallback(async () => {
    try {
      const hoje = hojeCDMX();
      const dia = diaSemanaCDMX();
      const diaIso = DIA_ISO[dia] ?? 1;

      const { data: dias } = await supabase
        .from("dias")
        .select("data, dia_semana, vendeu_brow, vendeu_brig, levou_brow")
        .neq("data", hoje)
        .order("data", { ascending: false });

      if (!dias || dias.length === 0) return;

      const validos = dias.filter((d) => Number(d.levou_brow ?? 0) > 0);
      const doDia = validos.filter((d) => d.dia_semana === dia);
      const usaMesmoDia = doDia.length >= 3;
      const baseCompleta = usaMesmoDia ? doDia : validos;
      const base = baseCompleta.slice(0, 10);
      if (base.length === 0) return;

      const vals = base.map((d) => Number(d.vendeu_brow ?? 0));
      const media = vals.reduce((a, b) => a + b, 0) / vals.length;
      const p25 = quantil(vals, 0.25);
      const p75 = quantil(vals, 0.75);
      const esgotou = base.filter((d) => Number(d.vendeu_brow ?? 0) >= Number(d.levou_brow ?? 0)).length;
      const taxaEsgotou = esgotou / base.length;

      // Quando o estoque zerou, a venda observada é um limite inferior da demanda.
      const ajusteEsgotou = taxaEsgotou >= 0.4 ? 1.15 : taxaEsgotou >= 0.2 ? 1.08 : 1;
      const sugerido = Math.max(1, Math.round(Math.max(media, p75) * ajusteEsgotou));

      const valsBrig = base.map((d) => Number(d.vendeu_brig ?? 0));
      const mediaBrig = valsBrig.reduce((a, b) => a + b, 0) / valsBrig.length;

      let melhorBairro: string | null = null;
      let alternativas: string[] = [];
      let melhorHorario: string | null = null;
      let horarioComMedicao = false;
      let fonteRegiao: Recomendacao["fonteRegiao"] = "insuficiente";
      let browniesHora: number | null = null;
      let minutosRegiao = 0;
      let diasRegiao = 0;
      let microzona: string | null = null;
      let microzonaLat: number | null = null;
      let microzonaLon: number | null = null;

      // 1) Preferência: intervalos reais. Aqui sabemos também quanto tempo ela ficou SEM vender.
      const { data: intervalos } = await supabase
        .from("ml_intervalos_v2")
        .select("bairro, data, hora, dia_semana_num, minutos_intervalo, vendas_brow_intervalo, estoque_brow, coletado_em, grid_lat, grid_lon, movimento_m")
        .eq("dia_semana_num", diaIso)
        .neq("data", hoje)
        .gt("estoque_brow", 0)
        .not("bairro", "is", null)
        .limit(1200);

      if (intervalos && intervalos.length > 0) {
        type Agg = { chave: string; bairro: string; gridLat: number | null; gridLon: number | null; minutos: number; vendas: number; dias: Set<string>; intervalos: number };
        const mapa = new Map<string, Agg>();
        let totalMin = 0;
        let totalVendas = 0;

        for (const i of intervalos) {
          const bairro = String(i.bairro || "").trim();
          const minutos = Number(i.minutos_intervalo ?? 0);
          const vendasInt = Number(i.vendas_brow_intervalo ?? 0);
          const movimento = Number(i.movimento_m ?? 0);
          if (!bairro || minutos < 1 || minutos > 30 || movimento > 350) continue;
          const glat = i.grid_lat == null ? null : Number(i.grid_lat);
          const glon = i.grid_lon == null ? null : Number(i.grid_lon);
          const chave = glat != null && glon != null ? `${bairro}|${glat.toFixed(3)}|${glon.toFixed(3)}` : bairro;

          const atual = mapa.get(chave) || { chave, bairro, gridLat: glat, gridLon: glon, minutos: 0, vendas: 0, dias: new Set<string>(), intervalos: 0 };
          atual.minutos += minutos;
          atual.vendas += vendasInt;
          atual.intervalos += 1;
          if (i.data) atual.dias.add(String(i.data));
          mapa.set(chave, atual);
          totalMin += minutos;
          totalVendas += vendasInt;
        }

        const taxaGlobal = totalMin > 0 ? totalVendas * 60 / totalMin : 0;
        const priorMin = 60; // suaviza microzonas com pouca exposição
        const rankingMedido = Array.from(mapa.values())
          .filter((x) => x.minutos >= 30 && x.dias.size >= 2)
          .map((x) => ({
            ...x,
            taxa: (x.vendas + taxaGlobal * priorMin / 60) * 60 / (x.minutos + priorMin),
          }))
          .sort((a, b) => b.taxa - a.taxa || b.minutos - a.minutos);

        if (rankingMedido[0]) {
          const topo = rankingMedido[0];
          melhorBairro = topo.bairro;
          microzonaLat = topo.gridLat;
          microzonaLon = topo.gridLon;
          alternativas = Array.from(new Set(rankingMedido.slice(1).map((x) => x.bairro).filter((x) => x !== melhorBairro))).slice(0, 2);
          fonteRegiao = "intervalos";
          browniesHora = Math.round(topo.taxa * 10) / 10;
          minutosRegiao = Math.round(topo.minutos);
          diasRegiao = topo.dias.size;

          // Melhor faixa horária medida dentro do próprio bairro recomendado.
          const porFaixa = new Map<string, { minutos: number; vendas: number }>();
          for (const i of intervalos) {
            if (String(i.bairro || "").trim() !== melhorBairro) continue;
            if (microzonaLat != null && microzonaLon != null && i.grid_lat != null && i.grid_lon != null) {
              if (Number(i.grid_lat).toFixed(3) !== microzonaLat.toFixed(3) || Number(i.grid_lon).toFixed(3) !== microzonaLon.toFixed(3)) continue;
            }
            const faixa = faixaTresHoras(i.hora);
            const min = Number(i.minutos_intervalo ?? 0);
            const movimento = Number(i.movimento_m ?? 0);
            if (!faixa || min < 1 || min > 30 || movimento > 350) continue;
            const atual = porFaixa.get(faixa) || { minutos: 0, vendas: 0 };
            atual.minutos += min;
            atual.vendas += Number(i.vendas_brow_intervalo ?? 0);
            porFaixa.set(faixa, atual);
          }
          const melhorFaixa = Array.from(porFaixa.entries())
            .filter(([, x]) => x.minutos >= 20)
            .map(([faixa, x]) => ({ faixa, taxa: x.vendas * 60 / x.minutos, minutos: x.minutos }))
            .sort((a, b) => b.taxa - a.taxa || b.minutos - a.minutos)[0];
          if (melhorFaixa) {
            melhorHorario = melhorFaixa.faixa;
            horarioComMedicao = true;
          }
        }
      }

      // 2) Fallback: histórico de vendas. Útil agora, mas é tratado como sinal, não como "ML".
      const { data: vendasHistRaw } = await supabase
        .from("vendas")
        .select("cliente_id, bairro, data, dia_semana, hora, produto, lat, lon")
        .eq("produto", "brownie")
        .neq("data", hoje)
        .not("bairro", "is", null)
        .order("data", { ascending: false })
        .limit(3000);

      const vendasHist = vendasHistRaw || [];

      if (!melhorBairro && vendasHist.length > 5) {
        const mesmoDia = vendasHist.filter((v) => v.dia_semana === dia);
        const baseLocais = mesmoDia.length >= 12 ? mesmoDia : vendasHist;

        const unicas = new Map<string, { bairro: string; data: string; hora: string; lat: number | null; lon: number | null }>();
        for (const v of baseLocais) {
          if (!v.bairro || !v.data || !v.cliente_id) continue;
          if (!unicas.has(v.cliente_id)) {
            unicas.set(v.cliente_id, { bairro: String(v.bairro), data: String(v.data), hora: String(v.hora || ""), lat: v.lat == null ? null : Number(v.lat), lon: v.lon == null ? null : Number(v.lon) });
          }
        }

        const porBairroDia = new Map<string, Map<string, number>>();
        for (const v of unicas.values()) {
          if (!porBairroDia.has(v.bairro)) porBairroDia.set(v.bairro, new Map());
          const porDia = porBairroDia.get(v.bairro)!;
          porDia.set(v.data, (porDia.get(v.data) || 0) + 1);
        }

        const rankingHistorico = Array.from(porBairroDia.entries())
          .map(([bairro, porDia]) => {
            const contagens = Array.from(porDia.values());
            const mediaDia = contagens.reduce((a, b) => a + b, 0) / contagens.length;
            // Pequeno ajuste por amostra: evita 1-2 dias dominarem o ranking.
            const confiabilidade = 0.7 + 0.3 * Math.min(1, contagens.length / 5);
            return { bairro, dias: contagens.length, mediaDia, score: mediaDia * confiabilidade };
          })
          .filter((x) => x.dias >= 2)
          .sort((a, b) => b.score - a.score || b.dias - a.dias);

        if (rankingHistorico[0]) {
          melhorBairro = rankingHistorico[0].bairro;
          alternativas = rankingHistorico.slice(1, 3).map((x) => x.bairro);
          fonteRegiao = "historico";
          diasRegiao = rankingHistorico[0].dias;

          const grades = new Map<string, { n: number; dias: Set<string> }>();
          for (const v of unicas.values()) {
            if (v.bairro !== melhorBairro || v.lat == null || v.lon == null) continue;
            const chave = `${v.lat.toFixed(3)}, ${v.lon.toFixed(3)}`;
            const g = grades.get(chave) || { n: 0, dias: new Set<string>() };
            g.n += 1; g.dias.add(v.data); grades.set(chave, g);
          }
          const gradeTopo = Array.from(grades.entries())
            .map(([chave, g]) => ({ chave, n: g.n, dias: g.dias.size, score: g.n * (0.7 + 0.3 * Math.min(1, g.dias.size / 4)) }))
            .filter((g) => g.dias >= 2)
            .sort((a, b) => b.score - a.score || b.dias - a.dias)[0];
          if (gradeTopo) {
            const [latTxt, lonTxt] = gradeTopo.chave.split(",");
            microzonaLat = Number(latTxt);
            microzonaLon = Number(lonTxt);
          }
        }
      }

      // Horário de fallback: faixa com mais vendas registradas no bairro sugerido.
      if (melhorBairro && !melhorHorario && vendasHist.length > 0) {
        const candidatosMesmoDia = vendasHist.filter(
          (v) => v.bairro === melhorBairro && v.dia_semana === dia
        );
        const candidatos = candidatosMesmoDia.length >= 5
          ? candidatosMesmoDia
          : vendasHist.filter((v) => v.bairro === melhorBairro);

        const unicasHora = new Map<string, string>();
        for (const v of candidatos) {
          if (!v.cliente_id || !v.hora) continue;
          if (!unicasHora.has(v.cliente_id)) unicasHora.set(v.cliente_id, String(v.hora));
        }

        const contagemFaixa = new Map<string, number>();
        for (const hora of unicasHora.values()) {
          const faixa = faixaTresHoras(hora);
          if (faixa) contagemFaixa.set(faixa, (contagemFaixa.get(faixa) || 0) + 1);
        }
        const melhor = Array.from(contagemFaixa.entries()).sort((a, b) => b[1] - a[1])[0];
        if (melhor && melhor[1] >= 3) melhorHorario = melhor[0];
      }

      const regiaoTemBoaBase = fonteRegiao === "intervalos"
        ? minutosRegiao >= 120 && diasRegiao >= 3
        : fonteRegiao === "historico" && diasRegiao >= 4;

      const confianca: Recomendacao["confianca"] =
        doDia.length >= 6 && regiaoTemBoaBase ? "boa"
          : doDia.length >= 3 && melhorBairro ? "media"
            : "baixa";

      const baseDescricao = usaMesmoDia
        ? `${base.length} ${dia.toLowerCase()}${base.length === 1 ? "" : "s"}`
        : `${base.length} dias recentes; ainda há poucos dados específicos de ${dia.toLowerCase()}`;

      const brigadeirosSugeridos = mediaBrig > 1 ? Math.round(mediaBrig * 1.1) : 0;

      if (microzonaLat != null && microzonaLon != null) {
        try {
          const localMicro = await buscarLocal(microzonaLat, microzonaLon);
          microzona = localMicro.rotulo || "ponto recorrente dentro da região";
        } catch {
          microzona = "ponto recorrente dentro da região";
        }
      }

      setRec({
        brownies: sugerido,
        brigadeiros: brigadeirosSugeridos,
        mediaBrow: Math.round(media),
        diasBase: base.length,
        melhorBairro,
        alternativas,
        melhorHorario,
        horarioComMedicao,
        confianca,
        estoqueEsgotouPct: Math.round(taxaEsgotou * 100),
        faixaMin: Math.max(0, Math.floor(p25)),
        faixaMax: Math.max(0, Math.ceil(p75)),
        baseDescricao,
        fonteRegiao,
        browniesHora,
        minutosRegiao,
        diasRegiao,
        tempoEstimadoMin: browniesHora && browniesHora > 0 ? Math.round((sugerido / browniesHora) * 60) : null,
        microzona,
        microzonaLat,
        microzonaLon,
      });

      // Sem botão extra: se o estoque do dia ainda está zerado, preenche a sugestão.
      // Usa ref para respeitar qualquer quantidade que ela já tenha digitado.
      if (!ref.current.sessao && ref.current.levouBrow === 0) setLevouBrow(sugerido);
      if (!ref.current.sessao && ref.current.levouBrig === 0 && brigadeirosSugeridos > 0) {
        setLevouBrig(brigadeirosSugeridos);
      }
    } catch {
      // Sem histórico/conexão: o app continua funcionando normalmente.
    }
  }, []);

  // ---------- FILA DE ENVIO (OUTBOX) ----------
  // Vendas, sessões e amostras ficam salvas no aparelho até o banco confirmar.
  const atualizarContadoresPendentes = useCallback(() => {
    const p = contarPendentes();
    setPendentes(p.vendas);
    setPendentesColeta(p.coleta);
  }, []);

  const sincronizarTudo = useCallback(async () => {
    try {
      await sincronizar(localStorage, enviarItem);
    } catch { /* tenta de novo no próximo ciclo */ }
    atualizarContadoresPendentes();
  }, [atualizarContadoresPendentes]);

  function guardarESincronizar(tabela: ItemOutbox["tabela"], conflito: string, payload: Record<string, unknown>, op: ItemOutbox["op"] = "upsert") {
    try {
      enfileirar(localStorage, tabela, conflito, payload, op);
    } catch { /* localStorage indisponível: ainda tenta enviar abaixo */ }
    atualizarContadoresPendentes();
    void sincronizarTudo();
  }

  // ---------- RECONCILIAÇÃO ----------
  const reconciliar = useCallback(async () => {
    const hoje = hojeCDMX();
    try {
      const { data, error } = await supabase
        .from("vendas").select("cliente_id, produto, hora, data, vendido_em, sessao_id").eq("data", hoje);
      if (error || !data) return;
      // Não ressuscita vendas que ela desfez e cujo DELETE ainda está na fila.
      const doBanco: Venda[] = data.filter((v) => !v.cliente_id || !temDeletePendente(localStorage, "vendas", v.cliente_id)).map((v) => ({
        id: v.cliente_id || `banco-${v.hora}-${Math.random()}`,
        produto: v.produto, hora: v.hora, data: v.data,
        momento: v.vendido_em || undefined, sessaoId: v.sessao_id || null,
      }));
      setVendas((locais) => {
        const mapa = new Map<string, Venda>();
        for (const v of doBanco) mapa.set(v.id, v);
        for (const v of locais) mapa.set(v.id, v);
        const juntas = Array.from(mapa.values());
        salvarEstadoAgora({ ...ref.current, vendas: juntas });
        return juntas;
      });
    } catch { /* offline */ }
  }, []);

  // ---------- RESUMO DIÁRIO ----------
  // V5: finalizar uma saída NÃO encerra o dia. O resumo é recalculado somando todas
  // as sessões e vendas daquele dia, permitindo várias saídas sem sobrescrever dados.
  const atualizarResumoDia = useCallback(async (data: string) => {
    try {
      const [{ data: vendasDia, error: erroVendas }, { data: sessoesDia, error: erroSessoes }] = await Promise.all([
        supabase.from("vendas").select("produto, preco, cliente_id").eq("data", data),
        supabase.from("sessoes_venda").select("levou_brow, levou_brig, preco_brow, preco_brig").eq("data", data),
      ]);
      if (erroVendas || erroSessoes) return false;

      const unicas = new Map<string, { produto: string; preco: number }>();
      for (const v of vendasDia || []) {
        const id = String(v.cliente_id || `${v.produto}-${unicas.size}`);
        if (!unicas.has(id)) unicas.set(id, { produto: String(v.produto), preco: Number(v.preco ?? 0) });
      }
      const lista = Array.from(unicas.values());
      const vBrow = lista.filter((v) => v.produto === "brownie").length;
      const vBrig = lista.filter((v) => v.produto === "brigadeiro").length;
      const levouBrowDia = (sessoesDia || []).reduce((a, x) => a + Number(x.levou_brow ?? 0), 0);
      const levouBrigDia = (sessoesDia || []).reduce((a, x) => a + Number(x.levou_brig ?? 0), 0);
      const faturamentoDia = lista.reduce((a, v) => a + v.preco, 0);
      const precoBrowDia = Number((sessoesDia || []).at(-1)?.preco_brow ?? precoBrow);
      const precoBrigDia = Number((sessoesDia || []).at(-1)?.preco_brig ?? precoBrig);

      const registro = {
        data,
        levou_brig: Math.max(levouBrigDia, vBrig),
        levou_brow: Math.max(levouBrowDia, vBrow),
        vendeu_brig: vBrig, vendeu_brow: vBrow,
        sobrou_brig: Math.max(0, levouBrigDia - vBrig),
        sobrou_brow: Math.max(0, levouBrowDia - vBrow),
        preco_brig: precoBrigDia, preco_brow: precoBrowDia,
        faturamento: faturamentoDia,
        feriado: ehFeriado(data),
        dia_semana: diaSemanaDaData(data),
      };
      const { error } = await supabase.from("dias").upsert(registro, { onConflict: "data" });
      return !error;
    } catch {
      return false;
    }
  }, [precoBrow, precoBrig]);

  const enviarDiasPendentes = useCallback(async () => {
    const fila = JSON.parse(localStorage.getItem("filaDias") || "[]");
    if (fila.length === 0) return;
    const restantes = [];
    for (const item of fila) {
      const { error } = await supabase.from("dias").upsert(item, { onConflict: "data" });
      if (error) restantes.push(item);
    }
    localStorage.setItem("filaDias", JSON.stringify(restantes));
  }, []);

  // ---------- AO ABRIR ----------
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const salvo = localStorage.getItem("estado");
    const hoje = hojeCDMX();
    migrarFilasAntigas(localStorage);
    liberarEsperas(localStorage); // a página que ia completar GPS/bairro não existe mais
    let vendasSalvas: Venda[] = [];

    if (salvo) {
      const e = JSON.parse(salvo);
      vendasSalvas = Array.isArray(e.vendas) ? e.vendas : [];
      const dataSalva = e.data || hoje;
      if (e.precoBrig != null) setPrecoBrig(e.precoBrig);
      if (e.precoBrow != null) setPrecoBrow(e.precoBrow);

      if (dataSalva !== hoje) {
        setVendas([]); setLevouBrig(0); setLevouBrow(0);
      } else {
        setVendas(e.vendas || []);
        setLevouBrig(e.levouBrig || 0);
        setLevouBrow(e.levouBrow || 0);
      }
    }
    try {
      const sessaoSalva: SessaoVenda | null = JSON.parse(localStorage.getItem("sessaoVenda") || "null");
      if (sessaoSalva?.data === hoje) {
        setSessao(sessaoSalva);
      } else if (sessaoSalva) {
        // Saída de um dia anterior que não foi finalizada: encerra no banco usando a
        // última atividade conhecida neste aparelho (não o horário de agora).
        const ultimaAmostra = Number(localStorage.getItem("ultimaAmostraEm") || 0);
        const ultimaVenda = vendasSalvas
          .filter((v) => v.sessaoId === sessaoSalva.id && v.momento)
          .reduce((m, v) => Math.max(m, Date.parse(v.momento as string) || 0), 0);
        const fim = Math.max(Date.parse(sessaoSalva.inicio) || 0, ultimaAmostra, ultimaVenda);
        enfileirar(localStorage, "sessoes_venda", "id", {
          id: sessaoSalva.id, data: sessaoSalva.data, inicio: sessaoSalva.inicio,
          fim: new Date(fim).toISOString(), status: "encerrada",
          levou_brow: sessaoSalva.levouBrow, levou_brig: sessaoSalva.levouBrig,
          preco_brow: sessaoSalva.precoBrow, preco_brig: sessaoSalva.precoBrig,
        });
        localStorage.removeItem("sessaoVenda");
      }
    } catch { /* estado antigo ou inválido */ }

    setCarregado(true);
    atualizarContadoresPendentes();
  }, [atualizarContadoresPendentes]);

  // Se o aparelho perdeu a sessão local (outra aba, armazenamento limpo), recupera do banco
  // a saída ainda ativa de hoje em vez de deixar começar uma nova.
  useEffect(() => {
    if (!carregado || sessao) return;
    let cancelado = false;
    (async () => {
      try {
        const hoje = hojeCDMX();
        const { data, error } = await supabase
          .from("sessoes_venda")
          .select("id, data, inicio, levou_brow, levou_brig, preco_brow, preco_brig")
          .eq("data", hoje).eq("status", "ativa")
          .order("inicio", { ascending: false }).limit(1);
        if (cancelado || error || !data?.[0] || ref.current.sessao) return;
        if (listarOutbox(localStorage).some((x) => x.chave === `sessoes_venda:${data[0].id}` && x.payload.status === "encerrada")) return;
        const s = data[0];
        const recuperada: SessaoVenda = {
          id: s.id, data: s.data, inicio: s.inicio,
          levouBrow: Number(s.levou_brow ?? 0), levouBrig: Number(s.levou_brig ?? 0),
          precoBrow: Number(s.preco_brow ?? 0), precoBrig: Number(s.preco_brig ?? 0),
          browniesInicio: 0, brigadeirosInicio: 0,
        };
        localStorage.setItem("sessaoVenda", JSON.stringify(recuperada));
        setSessao(recuperada);
        setAviso("Venda em andamento recuperada");
        setTimeout(() => setAviso(null), 3000);
      } catch { /* offline: tenta na próxima abertura */ }
    })();
    return () => { cancelado = true; };
    // Só ao abrir; uma sessão iniciada aqui depois não deve disparar nova busca.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [carregado]);

  useEffect(() => {
    if (carregado) salvarEstadoAgora({ vendas, levouBrig, levouBrow, precoBrig, precoBrow });
  }, [vendas, levouBrig, levouBrow, precoBrig, precoBrow, carregado]);

  useEffect(() => {
    if (!carregado) return;
    void sincronizarTudo().then(reconciliar); enviarDiasPendentes(); calcularRecomendacao();
    const timer = setInterval(() => { void sincronizarTudo().then(reconciliar); enviarDiasPendentes(); }, 30000);
    const aoVoltar = () => { void sincronizarTudo().then(reconciliar); enviarDiasPendentes(); };
    const aoFocar = () => { if (document.visibilityState === "visible") void sincronizarTudo().then(reconciliar); };
    window.addEventListener("online", aoVoltar);
    document.addEventListener("visibilitychange", aoFocar);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", aoVoltar);
      document.removeEventListener("visibilitychange", aoFocar);
    };
  }, [carregado, sincronizarTudo, enviarDiasPendentes, reconciliar, calcularRecomendacao]);

  // Outra aba mexeu na fila: atualiza o aviso de pendências.
  useEffect(() => {
    const aoMudar = (e: StorageEvent) => { if (e.key === "outbox_v1") atualizarContadoresPendentes(); };
    window.addEventListener("storage", aoMudar);
    return () => window.removeEventListener("storage", aoMudar);
  }, [atualizarContadoresPendentes]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!navigator.permissions) return;
    navigator.permissions.query({ name: "geolocation" as PermissionName })
      .then((p) => {
        setGpsOk(p.state !== "denied");
        p.onchange = () => setGpsOk(p.state !== "denied");
      }).catch(() => {});
  }, []);

  // Se o app ficar aberto de um dia para o outro, prepara o novo dia sozinho.
  useEffect(() => {
    const verificarViradaDoDia = () => {
      const hoje = hojeCDMX();
      if (hoje === dataAtiva || sessao) return;
      setDataAtiva(hoje);
      setVendas([]);
      setLevouBrig(0);
      setLevouBrow(0);
      setBalancoFinal(null);
      setMostrarBalanco(false);
        salvarEstadoAgora({ vendas: [], levouBrig: 0, levouBrow: 0, precoBrig, precoBrow });
      void calcularRecomendacao();
    };
    const timer = setInterval(verificarViradaDoDia, 60_000);
    document.addEventListener("visibilitychange", verificarViradaDoDia);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", verificarViradaDoDia);
    };
  }, [dataAtiva, sessao, precoBrig, precoBrow, calcularRecomendacao]);

  // Permite abrir o app sem internet (cópia local da página). Só em produção.
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js")
      .then((r) => { if (navigator.onLine) void r.update(); })
      .catch(() => { /* navegador sem suporte: app segue funcionando online */ });
  }, []);

  // Evita fechar/recarregar a página sem querer enquanto existe uma venda em andamento.
  useEffect(() => {
    if (!sessao) return;
    const avisarSaida = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", avisarSaida);
    return () => window.removeEventListener("beforeunload", avisarSaida);
  }, [sessao]);

  // ---------- APIs ----------
  async function buscarClima(lat: number, lon: number) {
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,precipitation`;
      const d = await fetchJsonComTimeout(url, 6000);
      return { temperatura: d.current.temperature_2m, chuva: d.current.precipitation };
    } catch { return { temperatura: null, chuva: null }; }
  }

  async function buscarLocal(lat: number, lon: number) {
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=16&extratags=1`;
      const d = await fetchJsonComTimeout(url, 6000, { headers: { "Accept-Language": "pt" } });
      const e = d.address || {};
      const bairro = e.suburb || e.borough || e.neighbourhood || e.city || null;
      const rotulo = e.road || e.pedestrian || e.square || e.neighbourhood || d.name || null;
      // Não inventa "mista" quando o reverse geocoder não tem evidência suficiente.
      // Null é melhor que um rótulo errado para um futuro modelo de ML.
      let tipoArea: string | null = null;
      const cat = `${d.category || ""} ${d.type || ""} ${e.shop || ""} ${e.office || ""}`.toLowerCase();
      if (cat.includes("commercial") || cat.includes("retail") || cat.includes("mall") || e.shop) tipoArea = "comercial";
      else if (cat.includes("residential") || e.residential) tipoArea = "residencial";
      else if (cat.includes("industrial")) tipoArea = "industrial";
      return { bairro, tipoArea, rotulo };
    } catch { return { bairro: null, tipoArea: null, rotulo: null }; }
  }

  function pegarLocalizacao(): Promise<{ lat: number | null; lon: number | null; precisao: number | null }> {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve({ lat: null, lon: null, precisao: null });
      // Garantia extra: alguns navegadores nunca chamam o callback com a tela bloqueada.
      setTimeout(() => resolve({ lat: null, lon: null, precisao: null }), 12_000);
      navigator.geolocation.getCurrentPosition(
        (pos) => { setGpsOk(true); resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, precisao: pos.coords.accuracy }); },
        (err) => { if (err.code === err.PERMISSION_DENIED) setGpsOk(false); resolve({ lat: null, lon: null, precisao: null }); },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
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

  function distanciaMetros(aLat: number, aLon: number, bLat: number, bLon: number) {
    const R = 6371000;
    const rad = (x: number) => x * Math.PI / 180;
    const dLat = rad(bLat - aLat);
    const dLon = rad(bLon - aLon);
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  async function obterContextoLocal() {
    const pos = await pegarLocalizacao();
    let lat = pos.lat, lon = pos.lon, precisao = pos.precisao;
    let bairro: string | null = null, tipoArea: string | null = null;
    let temperatura: number | null = null, chuva: number | null = null;
    let aproximado = false;

    if (lat !== null && lon !== null) {
      const clima = await buscarClima(lat, lon);
      temperatura = clima.temperatura; chuva = clima.chuva;

      const cache = ultimoLocal.current;
      const podeReusarLocal = cache
        && Date.now() - cache.quando < 20 * 60 * 1000
        && distanciaMetros(cache.lat, cache.lon, lat, lon) < 250;

      if (podeReusarLocal && cache) {
        bairro = cache.bairro; tipoArea = cache.tipoArea;
      } else {
        const local = await buscarLocal(lat, lon);
        bairro = local.bairro; tipoArea = local.tipoArea;
      }
      ultimoLocal.current = { lat, lon, bairro, tipoArea, quando: Date.now() };
    } else if (ultimoLocal.current && Date.now() - ultimoLocal.current.quando < 30 * 60 * 1000) {
      lat = ultimoLocal.current.lat; lon = ultimoLocal.current.lon;
      bairro = ultimoLocal.current.bairro; tipoArea = ultimoLocal.current.tipoArea;
      precisao = null; aproximado = true;
      const clima = await buscarClima(lat, lon);
      temperatura = clima.temperatura; chuva = clima.chuva;
    }

    return { lat, lon, precisao, bairro, tipoArea, temperatura, chuva, aproximado };
  }

  async function coletarAmostra(sessaoAtual: SessaoVenda, motivo: MotivoAmostra) {
    if (coletaEmAndamentoRef.current) {
      // A amostra de fim nunca é pulada: espera a coleta em curso terminar.
      if (motivo !== "fim") return;
      try { await coletaAtualRef.current; } catch { /* ignora */ }
    }
    coletaEmAndamentoRef.current = true;
    setColetandoAmostra(true);
    const execucao = (async () => {
      // Horário e contadores são marcados no instante do disparo, ANTES de esperar
      // GPS/clima/bairro. Assim uma venda feita logo depois cai no intervalo novo.
      const agora = new Date();
      const estado = ref.current;
      const vendidosBrowSessao = vendidosNaSessao(estado.vendas, sessaoAtual.id, "brownie");
      const vendidosBrigSessao = vendidosNaSessao(estado.vendas, sessaoAtual.id, "brigadeiro");
      const id = criarId("amostra");
      const base = {
        id,
        sessao_id: sessaoAtual.id,
        coletado_em: agora.toISOString(),
        data: hojeCDMX(agora),
        hora: horaCDMX(agora),
        lat: null, lon: null, precisao: null, bairro: null, tipo_area: null,
        temperatura: null, chuva: null, local_aproximado: false,
        estoque_brow: Math.max(0, sessaoAtual.levouBrow - vendidosBrowSessao),
        estoque_brig: Math.max(0, sessaoAtual.levouBrig - vendidosBrigSessao),
        vendidos_brow: vendidosBrowSessao,
        vendidos_brig: vendidosBrigSessao,
        motivo,
      };
      // Guarda já (sobrevive a recarga); espera o GPS por até 30 s antes de enviar.
      enfileirar(localStorage, "amostras_venda", "id", base, "upsert", Date.now() + 30_000);
      ultimaAmostraEm.current = agora.getTime();
      localStorage.setItem("ultimaAmostraEm", String(ultimaAmostraEm.current));

      const contexto = await obterContextoLocal();
      // Sempre o registro COMPLETO: um envio parcial seria recusado pelo banco (colunas obrigatórias).
      guardarESincronizar("amostras_venda", "id", {
        ...base,
        lat: contexto.lat, lon: contexto.lon, precisao: contexto.precisao,
        bairro: contexto.bairro, tipo_area: contexto.tipoArea,
        temperatura: contexto.temperatura, chuva: contexto.chuva,
        local_aproximado: contexto.aproximado,
      });
      if (contexto.lat != null && contexto.lon != null) {
        ultimoPontoAmostrado.current = { lat: contexto.lat, lon: contexto.lon, quando: ultimaAmostraEm.current };
      } else if (motivo !== "fim") {
        // GPS ainda sem sinal (comum logo no início): tenta outra amostra em ~1 minuto.
        ultimaAmostraEm.current = Date.now() - 2 * 60 * 1000;
        localStorage.setItem("ultimaAmostraEm", String(ultimaAmostraEm.current));
      }
    })();
    coletaAtualRef.current = execucao;
    try {
      await execucao;
    } finally {
      coletaEmAndamentoRef.current = false;
      setColetandoAmostra(false);
    }
  }

  async function iniciarSessao(): Promise<SessaoVenda | null> {
    if (sessao) return sessao;
    if (iniciandoRef.current) return null; // evita duas sessões num toque duplo
    if (levouBrow <= 0 && levouBrig <= 0) {
      setAviso("Informe primeiro quantos doces ela levou");
      setTimeout(() => setAviso(null), 3000);
      return null;
    }
    iniciandoRef.current = true;
    try {
      const nova: SessaoVenda = {
        id: criarId("sessao"),
        data: hojeCDMX(),
        inicio: new Date().toISOString(),
        levouBrow, levouBrig, precoBrow, precoBrig,
        browniesInicio: 0,
        brigadeirosInicio: 0,
      };

      setSessao(nova);
      ultimaAmostraEm.current = Date.now();
      ultimoPontoAmostrado.current = null;
      localStorage.setItem("sessaoVenda", JSON.stringify(nova));
      guardarESincronizar("sessoes_venda", "id", {
        id: nova.id, data: nova.data, inicio: nova.inicio, fim: null, status: "ativa",
        levou_brow: nova.levouBrow, levou_brig: nova.levouBrig,
        preco_brow: nova.precoBrow, preco_brig: nova.precoBrig,
      });
      void coletarAmostra(nova, "inicio");
      setAviso("Vendas iniciadas");
      setTimeout(() => setAviso(null), 2500);
      return nova;
    } finally {
      iniciandoRef.current = false;
    }
  }

  async function encerrarSessao(silencioso = false) {
    const atual = sessao;
    if (!atual) return;
    await coletarAmostra(atual, "fim");
    guardarESincronizar("sessoes_venda", "id", {
      id: atual.id, data: atual.data, inicio: atual.inicio, fim: new Date().toISOString(), status: "encerrada",
      levou_brow: atual.levouBrow, levou_brig: atual.levouBrig,
      preco_brow: atual.precoBrow, preco_brig: atual.precoBrig,
    });
    setSessao(null);
    localStorage.removeItem("sessaoVenda");
    if (!silencioso) {
      setAviso("Vendas finalizadas");
      setTimeout(() => setAviso(null), 2000);
    }
  }

  // ---------- COLETA PERIÓDICA DA ROTA ----------
  useEffect(() => {
    if (!sessao) return;
    const salva = Number(localStorage.getItem("ultimaAmostraEm") || 0);
    ultimaAmostraEm.current = salva > 0 ? salva : Date.now();

    const verificarColeta = () => {
      setAgoraTick(Date.now());
      if (document.visibilityState !== "visible") return;
      if (Date.now() - ultimaAmostraEm.current >= 3 * 60 * 1000) {
        void coletarAmostra(sessao, "intervalo");
      }
    };

    const timer = setInterval(verificarColeta, 60_000);
    // Ao abrir/reabrir a página (ex.: o celular fechou a aba em segundo plano), verifica já,
    // sem esperar o primeiro minuto — senão uma venda feita logo em seguida fica sem amostra.
    verificarColeta();
    const aoFocar = () => { if (document.visibilityState === "visible") verificarColeta(); };
    document.addEventListener("visibilitychange", aoFocar);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", aoFocar);
    };
    // A sessão é a fronteira da coleta. As funções usam refs para ler o estado mais recente.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessao?.id]);

  // Se ela mudar cerca de 300 m, registra a mudança automaticamente.
  // Isso evita atribuir vendas de Coyoacán ao ponto anterior em Tlalpan, por exemplo.
  useEffect(() => {
    if (!sessao || !navigator.geolocation) return;
    const watchId = navigator.geolocation.watchPosition((pos) => {
      const ultimo = ultimoPontoAmostrado.current;
      if (!ultimo) return;
      const moveu = distanciaMetros(ultimo.lat, ultimo.lon, pos.coords.latitude, pos.coords.longitude);
      const passouTempo = Date.now() - ultimaAmostraEm.current >= 2 * 60 * 1000;
      if (moveu >= 300 && passouTempo && !coletaEmAndamentoRef.current) {
        void coletarAmostra(sessao, "intervalo");
      }
    }, () => {}, { enableHighAccuracy: true, maximumAge: 30_000, timeout: 20_000 });
    return () => navigator.geolocation.clearWatch(watchId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessao?.id]);

  // ---------- REGISTRO ----------
  async function completarRegistro(venda: Venda, preco: number) {
    const momento = venda.momento || new Date().toISOString();
    // 1) A venda é salva no aparelho imediatamente, antes de qualquer rede.
    try {
      enfileirar(localStorage, "vendas", "cliente_id", {
        cliente_id: venda.id, produto: venda.produto, hora: venda.hora, data: venda.data,
        vendido_em: momento, sessao_id: venda.sessaoId || null, preco,
        feriado: ehFeriado(venda.data), dia_semana: diaSemanaDaData(venda.data), periodo: periodoCDMX(new Date(momento)),
      }, "upsert", Date.now() + 30_000); // espera o GPS/bairro; se a página morrer, envia sem eles depois
    } catch { /* sem localStorage: segue e tenta enviar com contexto */ }
    atualizarContadoresPendentes();
    // 2) Contexto (GPS, clima, bairro) com tempo máximo; depois envia tudo junto.
    const contexto = await obterContextoLocal();
    if (desfeitasRef.current.has(venda.id)) return;
    guardarESincronizar("vendas", "cliente_id", {
      cliente_id: venda.id, produto: venda.produto, hora: venda.hora, data: venda.data,
      vendido_em: momento, sessao_id: venda.sessaoId || null, preco,
      lat: contexto.lat, lon: contexto.lon, bairro: contexto.bairro, tipo_area: contexto.tipoArea,
      temperatura: contexto.temperatura, chuva: contexto.chuva, precisao: contexto.precisao,
      local_aproximado: contexto.aproximado,
    });
  }

  async function registrar(produto: string) {
    const vendidosProdutoSessao = sessao ? vendidosNaSessao(vendas, sessao.id, produto) : 0;
    const estoqueInformado = produto === "brownie" ? levouBrow : levouBrig;
    if (estoqueInformado <= vendidosProdutoSessao) {
      setAviso("Ajuste primeiro a quantidade de doces levados");
      setTimeout(() => setAviso(null), 3000);
      return;
    }

    const sessaoVenda = sessao || await iniciarSessao();
    const agora = new Date();
    const venda: Venda = {
      id: criarId("venda"),
      produto,
      hora: horaCDMX(agora),
      data: hojeCDMX(agora),
      momento: agora.toISOString(),
      sessaoId: sessaoVenda?.id || null,
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
    void completarRegistro(venda, produto === "brigadeiro" ? precoBrig : precoBrow);
  }

  async function desfazer() {
    if (!ultimaVenda) return;
    const id = ultimaVenda.id;
    desfeitasRef.current.add(id);
    setVendas((atual) => {
      const novas = atual.filter((v) => v.id !== id);
      salvarEstadoAgora({ ...ref.current, vendas: novas });
      return novas;
    });
    setUltimaVenda(null); setAviso("Desfeito");
    setTimeout(() => setAviso(null), 1500);
    if (navigator.vibrate) navigator.vibrate([50, 50, 50]);
    // O DELETE entra na mesma fila, depois do envio da venda: a ordem fica garantida.
    guardarESincronizar("vendas", "cliente_id", { cliente_id: id }, "delete");
  }

  const brigadeiros = vendas.filter((v) => v.produto === "brigadeiro").length;
  const brownies = vendas.filter((v) => v.produto === "brownie").length;
  const faturamento = brigadeiros * precoBrig + brownies * precoBrow;
  const minutosSessao = sessao
    ? minutosEntre(sessao.inicio, new Date(agoraTick || Date.parse(sessao.inicio)))
    : 0;
  // Conta pelas vendas vinculadas à sessão (não por subtração do total do dia).
  const browniesSessao = sessao ? vendidosNaSessao(vendas, sessao.id, "brownie") : 0;
  const brigadeirosSessao = sessao ? vendidosNaSessao(vendas, sessao.id, "brigadeiro") : 0;
  const faturamentoSessao = browniesSessao * precoBrow + brigadeirosSessao * precoBrig;
  const taxaBrowniesHora = minutosSessao >= 5 ? browniesSessao * 60 / minutosSessao : 0;
  const vendasBrownieSessao = sessao
    ? vendas.filter((v) => v.produto === "brownie" && v.sessaoId === sessao.id)
    : [];
  const ultimaVendaBrowMomento = vendasBrownieSessao.at(-1)?.momento || sessao?.inicio || null;
  const minutosSemBrownie = ultimaVendaBrowMomento
    ? minutosEntre(ultimaVendaBrowMomento, new Date(agoraTick || Date.now()))
    : 0;
  const browniesRestantesSessao = sessao ? Math.max(0, sessao.levouBrow - browniesSessao) : 0;
  const tempoRestanteRitmoAtual = taxaBrowniesHora > 0
    ? Math.round((browniesRestantesSessao / taxaBrowniesHora) * 60)
    : null;

  async function finalizarVendas() {
    if (encerrando || !sessao) return;
    setEncerrando(true);

    const resumo: BalancoFinal = {
      brigadeiros: brigadeirosSessao,
      brownies: browniesSessao,
      levouBrig: sessao.levouBrig,
      levouBrow: sessao.levouBrow,
      faturamento: faturamentoSessao,
    };

    await encerrarSessao(true);
    await sincronizarTudo(); // garante que as vendas pendentes cheguem antes do resumo
    const ok = await atualizarResumoDia(hojeCDMX());
    setBalancoFinal(resumo);
    // Mantém as vendas do dia para a próxima sessão começar do ponto correto,
    // mas zera apenas o estoque da saída que acabou.
    setLevouBrig(0); setLevouBrow(0);
    salvarEstadoAgora({ vendas: ref.current.vendas, levouBrig: 0, levouBrow: 0, precoBrig, precoBrow });
    setMostrarBalanco(true); setEncerrando(false);
    setAviso(ok ? "Saída finalizada e salva" : "Saída finalizada; resumo diário será atualizado quando houver conexão");
    setTimeout(() => setAviso(null), 2500);
    void calcularRecomendacao();
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
    const b = balancoFinal || { brigadeiros, brownies, levouBrig, levouBrow, faturamento };
    return (
      <main className="min-h-screen bg-neutral-950 text-white flex flex-col items-center justify-center gap-6 p-6">
        <h1 className="text-3xl font-bold">Resumo das vendas</h1>
        <div className="w-full max-w-sm bg-neutral-900 rounded-2xl p-6 space-y-4 text-lg">
          <div className="flex justify-between"><span>🍫 Brigadeiros</span><span>{b.brigadeiros} / {b.levouBrig} vendidos</span></div>
          <div className="flex justify-between text-neutral-400"><span>Sobraram</span><span>{Math.max(0, b.levouBrig - b.brigadeiros)}</span></div>
          <hr className="border-neutral-700" />
          <div className="flex justify-between"><span>🍰 Brownies</span><span>{b.brownies} / {b.levouBrow} vendidos</span></div>
          <div className="flex justify-between text-neutral-400"><span>Sobraram</span><span>{Math.max(0, b.levouBrow - b.brownies)}</span></div>
          <hr className="border-neutral-700" />
          <div className="flex justify-between"><span>Total vendido</span><span>{b.brigadeiros + b.brownies} doces</span></div>
          <div className="flex justify-between text-xl font-bold text-green-400"><span>Faturamento</span><span>${b.faturamento}</span></div>
        </div>
        <button onClick={() => { setMostrarBalanco(false); void calcularRecomendacao(); }}
          className="w-full max-w-sm bg-green-700 active:bg-green-800 disabled:opacity-50 rounded-2xl py-5 text-xl font-bold">
          ✓ Fechar resumo
        </button>
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

      {/* PLANO DO DIA — aparece automaticamente, sem adicionar passos para ela */}
      {rec && !sessao && (
        <div className="w-full max-w-sm bg-gradient-to-br from-indigo-950/90 to-purple-950/70 border border-indigo-500/70 rounded-3xl p-5 shadow-xl">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-indigo-300 text-sm font-medium">Plano de hoje · {diaSemanaCDMX()}</p>
              <p className="text-xs text-indigo-400/80 mt-1">Sugestão baseada nos seus próprios dados</p>
            </div>
            <span className={`text-xs px-2.5 py-1 rounded-full border ${
              rec.confianca === "boa"
                ? "text-emerald-300 border-emerald-600 bg-emerald-950/50"
                : rec.confianca === "media"
                  ? "text-amber-200 border-amber-600 bg-amber-950/40"
                  : "text-neutral-300 border-neutral-600 bg-neutral-900/50"
            }`}>
              {rec.confianca === "boa" ? "Boa base" : rec.confianca === "media" ? "Base inicial" : "Aprendendo"}
            </span>
          </div>

          <div className="mt-4 space-y-2">
            {rec.melhorBairro ? (
              <div className="bg-black/20 rounded-2xl p-4">
                <p className="text-xs uppercase tracking-wide text-indigo-300">Onde tentar primeiro</p>
                <p className="text-2xl font-bold mt-1">📍 {rec.melhorBairro}</p>
                {rec.microzona && (
                  <div className="mt-1">
                    <p className="text-xs text-indigo-200/75">
                      {rec.fonteRegiao === "intervalos" ? "Ponto mais promissor" : "Ponto com mais vendas registradas"}: perto de {rec.microzona}
                    </p>
                    {rec.microzonaLat != null && rec.microzonaLon != null && (
                      <a
                        href={`https://www.google.com/maps/search/?api=1&query=${rec.microzonaLat},${rec.microzonaLon}`}
                        target="_blank" rel="noreferrer"
                        className="inline-block text-xs text-sky-300 underline mt-1"
                      >
                        Abrir ponto no mapa
                      </a>
                    )}
                  </div>
                )}
                {rec.alternativas.length > 0 && (
                  <p className="text-sm text-indigo-200/80 mt-2">
                    Alternativas: {rec.alternativas.join(" · ")}
                  </p>
                )}
              </div>
            ) : (
              <div className="bg-black/20 rounded-2xl p-4">
                <p className="text-sm text-indigo-200">📍 Ainda não há dados suficientes para escolher uma região com segurança.</p>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2">
              <div className="bg-black/20 rounded-2xl p-4">
                <p className="text-xs uppercase tracking-wide text-indigo-300">Quanto levar</p>
                <p className="text-2xl font-bold mt-1">🍰 {rec.brownies}</p>
                <p className="text-xs text-indigo-200/70 mt-1">
                  Faixa histórica: {rec.faixaMin}–{rec.faixaMax}
                </p>
              </div>
              <div className="bg-black/20 rounded-2xl p-4">
                <p className="text-xs uppercase tracking-wide text-indigo-300">Quando</p>
                <p className="text-xl font-bold mt-1">{rec.melhorHorario ? `🕒 ${rec.melhorHorario}` : "🕒 —"}</p>
                <p className="text-xs text-indigo-200/70 mt-1">
                  {rec.melhorHorario
                    ? rec.horarioComMedicao ? "faixa medida por tempo" : "mais vendas registradas"
                    : "ainda aprendendo horário"}
                </p>
              </div>
            </div>
          </div>

          <div className="mt-4 border-t border-indigo-400/20 pt-3 text-xs text-indigo-200/75 space-y-1">
            <p>Base de quantidade: {rec.baseDescricao}.</p>
            {rec.fonteRegiao === "intervalos" && rec.browniesHora != null ? (
              <p>
                Região: {rec.browniesHora.toFixed(1)} brownies/h estimados com {rec.minutosRegiao} min medidos em {rec.diasRegiao} {rec.diasRegiao === 1 ? "dia" : "dias"}.
                {rec.tempoEstimadoMin != null && <> Para {rec.brownies} brownies: cerca de {Math.floor(rec.tempoEstimadoMin / 60)}h {rec.tempoEstimadoMin % 60}min de venda.</>}
              </p>
            ) : rec.fonteRegiao === "historico" ? (
              <p>
                Região: sinal histórico de {rec.diasRegiao} {rec.diasRegiao === 1 ? "dia" : "dias"}; o app ainda está aprendendo o tempo sem venda.
              </p>
            ) : null}
            {rec.estoqueEsgotouPct >= 20 && (
              <p>Em {rec.estoqueEsgotouPct}% dos dias usados o estoque acabou; a demanda pode ter sido maior.</p>
            )}
            {rec.confianca === "baixa" && (
              <p className="text-amber-300">Use como ponto de partida, não como garantia. Cada saída nova melhora a recomendação.</p>
            )}
          </div>

          <p className="text-center text-xs text-indigo-300/70 mt-4">
            A quantidade sugerida já foi preenchida abaixo. Ela pode ajustar se quiser.
          </p>
        </div>
      )}

      {!gpsOk && (
        <button onClick={pedirLocalizacao} className="w-full max-w-sm bg-red-900/60 border border-red-500 rounded-2xl py-3 px-4 text-center">
          <span className="text-red-200 font-bold">📍 Localização desativada</span>
          <div className="text-red-300 text-sm mt-1">Toque aqui para ativar</div>
        </button>
      )}

      {!sessao && (
        <div className="w-full max-w-sm bg-neutral-900 rounded-2xl p-4">
          <p className="text-center text-neutral-400 mb-3">Quanto ela levou para vender?</p>
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
      )}

      {!sessao && (
        <button onClick={() => void iniciarSessao()}
          className="w-full max-w-sm bg-sky-700 active:bg-sky-800 rounded-2xl py-5 text-xl font-bold shadow-lg">
          ▶ Começar vendas
        </button>
      )}

      {sessao && (
        <div className="w-full max-w-sm bg-emerald-950/60 border border-emerald-600 rounded-2xl p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="font-bold text-emerald-300">● Vendas em andamento</p>
              <p className="text-xs text-emerald-400 mt-1">
                Localização e movimento estão sendo registrados automaticamente
              </p>
            </div>
            {coletandoAmostra && <span className="text-xs text-emerald-300">Sincronizando…</span>}
          </div>
          <div className="grid grid-cols-2 gap-2 mt-3 text-sm">
            <div className="bg-black/20 rounded-xl p-3">
              <p className="text-neutral-400">Tempo</p>
              <p className="font-bold">{Math.floor(minutosSessao / 60)}h {Math.floor(minutosSessao % 60)}min</p>
            </div>
            <div className="bg-black/20 rounded-xl p-3">
              <p className="text-neutral-400">Brownies/h</p>
              <p className="font-bold">{taxaBrowniesHora > 0 ? taxaBrowniesHora.toFixed(1) : "—"}</p>
            </div>
          </div>
          {tempoRestanteRitmoAtual != null && browniesRestantesSessao > 0 && minutosSessao >= 10 && (
            <p className="text-xs text-emerald-200/80 mt-3">
              No ritmo atual, faltam cerca de {Math.floor(tempoRestanteRitmoAtual / 60)}h {tempoRestanteRitmoAtual % 60}min para acabar os brownies.
            </p>
          )}
          {minutosSessao >= 20 && minutosSemBrownie >= 20 && browniesRestantesSessao > 0 && (
            <div className="mt-3 bg-amber-950/70 border border-amber-600 rounded-xl p-3 text-sm text-amber-100">
              ⚠️ Há {Math.floor(minutosSemBrownie)} min sem vender brownie. Considere mudar de ponto
              {rec?.alternativas?.[0] ? <>; a próxima alternativa histórica é <strong>{rec.alternativas[0]}</strong>.</> : "."}
            </div>
          )}
        </div>
      )}

      {sessao && (
        <>
          <button onClick={() => void registrar("brigadeiro")}
            className="w-full max-w-sm bg-amber-600 active:bg-amber-700 rounded-3xl py-8 text-2xl font-bold shadow-lg transition">
            🍫 Brigadeiro
            <div className="text-4xl mt-1">{brigadeirosSessao} <span className="text-lg text-amber-200">/ {sessao.levouBrig}</span></div>
          </button>

          <button onClick={() => void registrar("brownie")}
            className="w-full max-w-sm bg-orange-800 active:bg-orange-900 rounded-3xl py-8 text-2xl font-bold shadow-lg transition">
            🍰 Brownie
            <div className="text-4xl mt-1">{browniesSessao} <span className="text-lg text-orange-200">/ {sessao.levouBrow}</span></div>
          </button>
        </>
      )}

      {sessao && ultimaVenda && (
        <button onClick={desfazer} className="text-neutral-400 underline text-lg">
          Desfazer último ({ultimaVenda.produto})
        </button>
      )}

      {sessao && <div className="text-center">
        <p className="text-neutral-400 text-lg">Nesta saída: {browniesSessao + brigadeirosSessao} doces</p>
        <p className="text-green-400 text-2xl font-bold">${faturamentoSessao}</p>
      </div>}

      {(pendentes > 0 || pendentesColeta > 0) && (
        <p className="text-amber-500 text-sm text-center">
          {pendentes > 0 && `${pendentes} venda(s) pendente(s)`}
          {pendentes > 0 && pendentesColeta > 0 && " · "}
          {pendentesColeta > 0 && `${pendentesColeta} dado(s) pendente(s)`}
          <br /><span className="text-amber-600">Serão reenviadas quando houver internet.</span>
        </p>
      )}

      {sessao && (
        <button onClick={() => void finalizarVendas()} disabled={encerrando}
          className="w-full max-w-sm bg-red-900/70 border border-red-700 active:bg-red-900 disabled:opacity-50 rounded-2xl py-5 text-xl font-bold mt-2">
          {encerrando ? "Salvando..." : "■ Finalizar vendas"}
        </button>
      )}
    </main>
  );
}