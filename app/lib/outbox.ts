// Fila local persistente ("outbox") para tudo que precisa chegar ao Supabase.
//
// Regras:
// - Cada registro é gravado no localStorage ANTES de qualquer chamada de rede.
// - Um item só sai da fila quando o banco confirma o envio daquela versão (rev).
// - Nunca se reescreve a fila inteira depois de um await: cada leitura+escrita é
//   síncrona, então itens adicionados durante um envio não são perdidos.
// - Registros com a mesma chave são mesclados (ex.: venda + localização depois).

export type Tabela = "vendas" | "sessoes_venda" | "amostras_venda";
export type Operacao = "upsert" | "delete";

export type ItemOutbox = {
  chave: string;
  tabela: Tabela;
  conflito: string;
  op: Operacao;
  payload: Record<string, unknown>;
  rev: number;
  criadoEm: number;
  tentativas: number;
  /** Não enviar antes deste instante (ms). Usado para esperar GPS/bairro da venda. */
  naoAntesDe?: number;
};

export interface Armazenamento {
  getItem(chave: string): string | null;
  setItem(chave: string, valor: string): void;
  removeItem?(chave: string): void;
}

export type Enviar = (item: ItemOutbox) => Promise<{ error: unknown }>;

export const CHAVE_OUTBOX = "outbox_v1";

// Sessões antes de amostras (chave estrangeira) e antes de vendas.
const PRIORIDADE: Record<Tabela, number> = { sessoes_venda: 0, amostras_venda: 1, vendas: 2 };

export function listar(s: Armazenamento): ItemOutbox[] {
  try {
    const v = JSON.parse(s.getItem(CHAVE_OUTBOX) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function gravar(s: Armazenamento, itens: ItemOutbox[]) {
  s.setItem(CHAVE_OUTBOX, JSON.stringify(itens));
}

export function chaveDe(tabela: Tabela, conflito: string, payload: Record<string, unknown>) {
  return `${tabela}:${String(payload[conflito])}`;
}

/** Grava (ou mescla) um registro na fila. Operação síncrona. Retorna a nova rev. */
export function enfileirar(
  s: Armazenamento,
  tabela: Tabela,
  conflito: string,
  payload: Record<string, unknown>,
  op: Operacao = "upsert",
  naoAntesDe = 0,
): number {
  const itens = listar(s);
  const chave = chaveDe(tabela, conflito, payload);
  const i = itens.findIndex((x) => x.chave === chave);
  if (i >= 0) {
    const atual = itens[i];
    const novo: ItemOutbox = {
      ...atual,
      op,
      payload: op === "delete" ? { [conflito]: payload[conflito] } : { ...atual.payload, ...payload },
      rev: atual.rev + 1,
      naoAntesDe,
    };
    itens[i] = novo;
    gravar(s, itens);
    return novo.rev;
  }
  itens.push({ chave, tabela, conflito, op, payload: op === "delete" ? { [conflito]: payload[conflito] } : payload, rev: 1, criadoEm: Date.now(), tentativas: 0, naoAntesDe });
  gravar(s, itens);
  return 1;
}

/** Remove o item somente se ele ainda estiver na mesma versão que foi enviada. */
export function confirmar(s: Armazenamento, chave: string, rev: number) {
  const itens = listar(s);
  const resto = itens.filter((x) => !(x.chave === chave && x.rev === rev));
  if (resto.length !== itens.length) gravar(s, resto);
}

function marcarTentativa(s: Armazenamento, chave: string) {
  const itens = listar(s);
  const i = itens.findIndex((x) => x.chave === chave);
  if (i >= 0) {
    itens[i] = { ...itens[i], tentativas: itens[i].tentativas + 1 };
    gravar(s, itens);
  }
}

export function temDeletePendente(s: Armazenamento, tabela: Tabela, id: string) {
  return listar(s).some((x) => x.tabela === tabela && x.op === "delete" && x.chave.endsWith(`:${id}`));
}

let emAndamento: Promise<number> | null = null;
let repetir = false;

async function rodada(s: Armazenamento, enviar: Enviar): Promise<number> {
  const tentados = new Map<string, number>();
  for (let voltas = 0; voltas < 500; voltas++) {
    const proximo = listar(s)
      .filter((x) => tentados.get(x.chave) !== x.rev && !((x.naoAntesDe ?? 0) > Date.now()))
      .sort((a, b) => PRIORIDADE[a.tabela] - PRIORIDADE[b.tabela] || a.criadoEm - b.criadoEm)[0];
    if (!proximo) break;
    tentados.set(proximo.chave, proximo.rev);
    let erro: unknown = null;
    try {
      erro = (await enviar(proximo)).error;
    } catch (e) {
      erro = e ?? "erro";
    }
    if (erro) {
      marcarTentativa(s, proximo.chave);
      // Se uma sessão falhou, amostras dela também falhariam (chave estrangeira).
      if (proximo.tabela === "sessoes_venda") {
        for (const x of listar(s)) if (x.tabela === "amostras_venda") tentados.set(x.chave, x.rev);
      }
    } else {
      confirmar(s, proximo.chave, proximo.rev);
    }
  }
  return listar(s).length;
}

/**
 * Envia tudo que estiver pendente, um item por vez. Chamadas simultâneas na mesma aba
 * reaproveitam o envio em curso; se alguém pedir envio durante uma rodada (ex.: a internet
 * voltou), uma nova rodada é feita logo em seguida. Retorna quantos itens continuam pendentes.
 */
export function sincronizar(s: Armazenamento, enviar: Enviar): Promise<number> {
  if (emAndamento) {
    repetir = true;
    return emAndamento;
  }
  emAndamento = (async () => {
    let restantes = 0;
    let rodadas = 0;
    do {
      repetir = false;
      restantes = await rodada(s, enviar);
      rodadas++;
    } while (repetir && restantes > 0 && rodadas < 10);
    return restantes;
  })().finally(() => {
    emAndamento = null;
  });
  return emAndamento;
}

/** Ao abrir o app: itens que esperavam GPS de uma página anterior podem ser enviados já. */
export function liberarEsperas(s: Armazenamento) {
  const itens = listar(s);
  if (itens.some((x) => (x.naoAntesDe ?? 0) > 0)) gravar(s, itens.map((x) => ({ ...x, naoAntesDe: 0 })));
}

/** Move as filas da versão anterior ("fila" e "filaColeta") para a outbox. */
export function migrarFilasAntigas(s: Armazenamento) {
  try {
    const fila = JSON.parse(s.getItem("fila") || "[]");
    if (Array.isArray(fila)) {
      for (const r of fila) if (r && r.cliente_id) enfileirar(s, "vendas", "cliente_id", r);
    }
    s.setItem("fila", "[]");
  } catch { /* fila inválida: mantém como está */ }
  try {
    const fila = JSON.parse(s.getItem("filaColeta") || "[]");
    if (Array.isArray(fila)) {
      for (const x of fila) {
        if (x && (x.tabela === "sessoes_venda" || x.tabela === "amostras_venda") && x.payload?.id) {
          enfileirar(s, x.tabela, "id", x.payload);
        }
      }
    }
    s.setItem("filaColeta", "[]");
  } catch { /* idem */ }
}
