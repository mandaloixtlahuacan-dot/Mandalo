import { joinBlocks } from "@/lib/messageStyle";
import {
  clarificationChoicesForItem,
  prepareQuoteItems,
  quoteItemNeedsDetail,
  quoteLineSignature,
  quoteQuestionForItems,
} from "@/lib/quoteProductClarity";
import type { PedidoItemInput } from "@/lib/services/captureEngine";
import {
  applyListaToItems,
  listaChoiceForItem,
  LISTA_UNKNOWN_NOTE,
  unknownFromLista,
  type ListaProducto,
} from "@/lib/storeProductList";

export type PendingAsk = {
  itemKey: string;
  slots: string[];
  question: string;
  count: number;
  mode: "ask" | "options";
  choices?: string[];
};

export type QuoteTurn = {
  items: PedidoItemInput[];
  question: string | null;
  pendingAsk: PendingAsk | null;
  listaAvisos: string[];
};

function norm(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function itemKey(item: PedidoItemInput, index: number): string {
  return `${index}:${norm(item.nombre_producto)}`;
}

export function formatClarificationOptions(choice: { title: string; emoji: string; choices: string[] }): string {
  const lines = choice.choices.map((label, index) => `*${index + 1})* ${label}`);
  return joinBlocks([`${choice.emoji} *${choice.title}*`, ...lines, "_Contesta con el número._"]);
}

function openIndex(items: PedidoItemInput[]): number {
  return items.findIndex((item) => quoteItemNeedsDetail(item));
}

function waiveItem(items: PedidoItemInput[], index: number): PedidoItemInput[] {
  if (index < 0) return items;
  const next = items.map((item) => ({ ...item }));
  next[index] = { ...next[index], notas: "la que sea" };
  return next;
}

function choiceIndex(message: string, choices: string[]): number {
  const text = norm(message);
  if (!text) return -1;
  if (/\b(del que sea|la que sea|el que sea|cualquiera|la que tengas|lo que haya|me da igual)\b/.test(text)) {
    const any = choices.findIndex((choice) => /la que tengan|la que sea/.test(norm(choice)));
    return any >= 0 ? any : choices.length - 1;
  }
  if (/^\d+$/.test(text)) {
    const number = Number(text);
    if (number >= 1 && number <= choices.length) return number - 1;
  }
  const found = choices.findIndex((choice) => {
    const label = norm(choice);
    return text === label || text.includes(label) || label.includes(text);
  });
  return found;
}

function applyChoice(items: PedidoItemInput[], choice: string, ignoreText?: string | null): PedidoItemInput[] {
  if (/la que tengan|la que sea|del que sea/i.test(choice)) return waiveItem(items, openIndex(items));
  return prepareQuoteItems(items, choice, ignoreText);
}

function freshPending(items: PedidoItemInput[], question: string): PendingAsk | null {
  const index = openIndex(items);
  if (index < 0 || !question) return null;
  const item = items[index];
  return {
    itemKey: itemKey(item, index),
    slots: [],
    question,
    count: 1,
    mode: "ask",
  };
}

function shortYes(message: string): boolean {
  return /^(si|ok|va|sale|dale|esta bien|asi esta bien)$/.test(norm(message));
}

function withNote(question: string | null, note: string | null, already: boolean): string | null {
  if (!note || already) return question;
  if (!question) return note;
  if (question.includes(note)) return question;
  return `${note}\n\n${question}`;
}

export function advanceQuoteTurn(
  items: PedidoItemInput[],
  message: string,
  pending: PendingAsk | null,
  options?: { ignoreText?: string | null; lista?: ListaProducto[] | null; listaAvisos?: string[] | null },
): QuoteTurn {
  const ignoreText = options?.ignoreText;
  const avisos = [...(options?.listaAvisos ?? [])];
  const lista = options?.lista ?? [];

  if (pending?.mode === "options" && pending.choices?.length) {
    const picked = choiceIndex(message, pending.choices);
    let next = picked >= 0 ? applyChoice(items, pending.choices[picked], ignoreText) : waiveItem(items, openIndex(items));
    const listed = applyListaToItems(next, lista, message);
    next = listed.items;
    const question = quoteQuestionForItems(next);
    const noted = listed.note && !avisos.includes(LISTA_UNKNOWN_NOTE);
    if (noted) avisos.push(LISTA_UNKNOWN_NOTE);
    return {
      items: next,
      question: withNote(question, listed.note, !noted && Boolean(listed.note)),
      pendingAsk: question ? freshPending(next, question) : null,
      listaAvisos: avisos,
    };
  }

  let next = prepareQuoteItems(items, message, ignoreText);
  const unknown = unknownFromLista(message, lista, next);
  if (unknown) next = [...next, unknown];
  if (shortYes(message) && quoteItemNeedsDetail(next[openIndex(next)] ?? { nombre_producto: "" })) {
    const choice = clarificationChoicesForItem(next[openIndex(next)]);
    if (choice?.choices.length) next = applyChoice(next, choice.choices[0], ignoreText);
  }
  const listed = applyListaToItems(next, lista, message);
  next = listed.items;
  let question = quoteQuestionForItems(next);
  const listChoice = openIndex(next) >= 0 ? listaChoiceForItem(next[openIndex(next)], lista) : null;
  if (listChoice) question = formatClarificationOptions(listChoice);

  const same =
    Boolean(pending && question && norm(question) === norm(pending.question) && quoteLineSignature(items) === quoteLineSignature(next));
  if (pending && same && pending.mode !== "options") {
    const item = next[openIndex(next)];
    const choice = item ? clarificationChoicesForItem(item) : null;
    if (choice) {
      question = formatClarificationOptions(choice);
      const noted = listed.note && !avisos.includes(LISTA_UNKNOWN_NOTE);
      if (noted) avisos.push(LISTA_UNKNOWN_NOTE);
      return {
        items: next,
        question: withNote(question, listed.note, !noted && Boolean(listed.note)),
        pendingAsk: {
          itemKey: itemKey(item, openIndex(next)),
          slots: [],
          question,
          count: pending.count + 1,
          mode: "options",
          choices: choice.choices,
        },
        listaAvisos: avisos,
      };
    }
  }

  const noted = listed.note && !avisos.includes(LISTA_UNKNOWN_NOTE);
  if (noted) avisos.push(LISTA_UNKNOWN_NOTE);
  return {
    items: next,
    question: withNote(question, listed.note, !noted && Boolean(listed.note)),
    pendingAsk: question && !listChoice ? freshPending(next, question) : listChoice ? {
      itemKey: itemKey(next[openIndex(next)], openIndex(next)),
      slots: [],
      question: question ?? "",
      count: 1,
      mode: "options",
      choices: listChoice.choices,
    } : null,
    listaAvisos: avisos,
  };
}
