export type SessaoVenda = {
  id: string;
  data: string;
  inicio: string;
  levouBrow: number;
  levouBrig: number;
  precoBrow: number;
  precoBrig: number;
  browniesInicio: number;
  brigadeirosInicio: number;
};

export type MotivoAmostra = "inicio" | "intervalo" | "manual" | "fim";

const TZ = "America/Mexico_City";

function partesCDMX(data = new Date()) {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(data);
  const mapa = Object.fromEntries(partes.map((p) => [p.type, p.value]));
  return {
    ano: mapa.year,
    mes: mapa.month,
    dia: mapa.day,
    hora: Number(mapa.hour),
    minuto: mapa.minute,
  };
}

export function hojeCDMX(data = new Date()) {
  const p = partesCDMX(data);
  return `${p.ano}-${p.mes}-${p.dia}`;
}

export function horaCDMX(data = new Date()) {
  const p = partesCDMX(data);
  return `${String(p.hora).padStart(2, "0")}:${p.minuto}`;
}

const DIAS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

export function diaSemanaDaData(data: string) {
  // Meio-dia UTC evita mudanças acidentais de dia por fuso horário.
  const d = new Date(`${data}T12:00:00Z`);
  return DIAS[d.getUTCDay()];
}

export function diaSemanaCDMX(data = new Date()) {
  return diaSemanaDaData(hojeCDMX(data));
}

export function periodoCDMX(data = new Date()) {
  const h = partesCDMX(data).hora;
  if (h < 12) return "manhã";
  if (h < 18) return "tarde";
  return "noite";
}

export function criarId(prefixo: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefixo}-${crypto.randomUUID()}`;
  }
  return `${prefixo}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function minutosEntre(inicioIso: string, fim = new Date()) {
  const inicio = new Date(inicioIso).getTime();
  return Math.max(0, (fim.getTime() - inicio) / 60000);
}
