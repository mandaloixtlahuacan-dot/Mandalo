import { formatClarificationOptions } from "@/lib/clarificationAnswers";
import type { StoreKind } from "@/lib/categoryCopy";
import { parseQuantity } from "@/lib/catalogOrder/quantities";
import { formatCatalogFinalTicket } from "@/lib/customerUx";
import { formatMoney } from "@/lib/ordenes";
import type { CartLine, CatalogRow, CatalogSnapshot, PendingCatalogAsk, SellUnit, Unmatched } from "@/lib/catalogOrder/types";
import { fold, tokens } from "@/lib/catalogOrder/text";

function kindOf(catalog: CatalogSnapshot): StoreKind {
  return catalog.profile === "carniceria" ? "carniceria" : "restaurante";
}

function qtyText(qty: number): string {
  const rounded = Math.round(qty * 1000) / 1000;
  if (Math.abs(rounded - 0.25) < 0.001) return "¼ kg";
  if (Math.abs(rounded - 0.5) < 0.001) return "½ kg";
  if (Math.abs(rounded - 0.75) < 0.001) return "¾ kg";
  if (Math.abs(rounded - 1.5) < 0.001) return "1½ kg";
  if (Math.abs(rounded - 1.25) < 0.001) return "1¼ kg";
  if (Math.abs(rounded - 2.5) < 0.001) return "2½ kg";
  if (Number.isInteger(rounded)) return `${rounded} kg`;
  return `${rounded} kg`;
}

function approxKg(amount: number, precio: number): string {
  const kg = Math.round((amount / precio) * 100) / 100;
  return Number.isInteger(kg) ? String(kg) : String(kg);
}

export function lineLabel(line: CartLine, row: CatalogRow): string {
  if (line.unit === "pesos") {
    const amount = Number.isInteger(line.qty) ? String(line.qty) : String(line.qty);
    const kilos = row.unit === "kg" && row.precio > 0 ? ` (aprox. ${approxKg(line.qty, row.precio)} kg)` : "";
    return `$${amount} de ${row.name}${kilos}`;
  }
  if (line.unit === "kg") return `${qtyText(line.qty)} de ${row.name}`;
  const name = line.variant ? `${row.searchName} ${line.variant}` : row.name;
  if (Math.abs(line.qty - 1) < 0.001) return name;
  const qty = Number.isInteger(line.qty) ? String(line.qty) : String(line.qty);
  return `${qty} ${name}`;
}

function titleCase(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/(^|\s)\S/g, (chunk) => chunk.toUpperCase());
}

const FAMILY_HEADS = ["alitas", "torta", "hamburguesa", "quesadilla", "dogo", "papas", "refresco", "bistec", "costilla", "salsa"];

const RETIRED_HEAD = /\b(tortas?|quesadillas?|sincronizadas?|aletas?|alitas?)\b/;

/** Tortas, sincronizadas, quesadillas y alitas ya no están. El aviso es el de siempre, más lo más cercano que sí hay. */
export function droppedMenuNotice(source: string): string | null {
  const folded = fold(source);
  const head = folded.match(RETIRED_HEAD)?.[1] ?? (/\bingrediente extra\b/.test(folded) ? "ingrediente extra" : "");
  if (!head) return null;
  if (head === "ingrediente extra") {
    return "*Ingrediente extra* no lo manejamos. En George tenemos hamburguesas, dogos, papas y refrescos.";
  }
  const singular = head.replace(/^tortas$/, "torta").replace(/^quesadillas$/, "quesadilla").replace(/^sincronizadas$/, "sincronizada").replace(/^aletas?$/, "alitas");
  let label = singular === "alitas" ? "Alitas" : titleCase(singular);
  const flavor = folded.match(/\b(hawaiana|hawaiano|cubana|cubano|arrachera|camaron|pollo|res)\b/)?.[1];
  if (flavor && singular !== "alitas") {
    const shown = flavor === "camaron" ? "Camarón" : flavor === "hawaiano" ? "Hawaiana" : flavor === "cubano" ? "Cubana" : titleCase(flavor);
    const joiner = /^(arrachera|camaron|pollo|res)$/.test(flavor) ? " de " : " ";
    label = `${titleCase(singular)}${joiner}${shown}`;
  }
  return `*${label}* no lo manejamos. ${closestGeorgeSuggestion(folded)}`;
}

function closestGeorgeSuggestion(folded: string): string {
  if (/\balitas?\b|\baletas?\b/.test(folded)) return "¿Te late el *Boneless*?";
  if (/\bhawaian[oa]\b/.test(folded)) return "¿Te late la *Hamburguesa Hawaiana*, chica o grande?";
  if (/\bcuban[oa]\b/.test(folded)) return "¿Te late la *Hamburguesa Cubana*, chica o grande?";
  if (/\barrachera\b/.test(folded)) return "¿Te late la *Hamburguesa de Arrachera*, chica o grande?";
  if (/\bcamaron\b/.test(folded)) return "¿Te late la *Hamburguesa de Camarón*, chica o grande?";
  if (/\bpollo\b/.test(folded)) return "¿Te late la *Hamburguesa de Pollo*, chica o grande?";
  if (/\bres\b/.test(folded)) return "¿Te late la *Hamburguesa de Res*, chica o grande?";
  if (RETIRED_HEAD.test(folded)) return "¿Te late una *hamburguesa*?";
  return "En George tenemos hamburguesas, dogos, papas y refrescos.";
}

export function droppedCandidateIds(catalog: CatalogSnapshot, source: string): number[] {
  const folded = fold(source);
  if (/\balitas?\b|\baletas?\b/.test(folded)) {
    return catalog.rows.filter((row) => /\bboneless\b/.test(fold(row.name))).map((row) => row.id);
  }
  const burgers = catalog.rows.filter((row) => fold(row.name).startsWith("hamburguesa") || fold(row.family).startsWith("hamburguesa"));
  const flavor = folded.match(/\b(hawaian|cuban|arrachera|camaron|pollo|res)\b/);
  if (!flavor) return burgers.map((row) => row.id);
  const matched = burgers.filter((row) => fold(`${row.name} ${row.family}`).includes(flavor[1]));
  return (matched.length ? matched : burgers).map((row) => row.id);
}

function notAvailable(catalog: CatalogSnapshot, term: string): string {
  const label = titleCase(term);
  if (catalog.profile === "carniceria") {
    return `*${label}* no lo manejamos. En La Central tenemos res, puerco, pastor, chorizo, carbón y salsas.`;
  }
  return `*${label}* no lo manejamos. En George tenemos hamburguesas, dogos, papas y refrescos.`;
}

function familyHead(text: string): string | null {
  const folded = fold(text);
  return FAMILY_HEADS.find((head) => new RegExp(`\\b${head}s?\\b`).test(folded)) ?? null;
}

function offerFor(catalog: CatalogSnapshot, source: string): { question: string; ids: number[] } | null {
  const folded = fold(source);
  if (/\bsprite\b/.test(folded)) {
    const ids = catalog.rows.filter((row) => row.variants.length > 0).map((row) => row.id);
    return { question: "Sprite no está en el menú. ¿Te late *Seven*?", ids };
  }
  const head = familyHead(source);
  if (!head) return null;
  const ids = catalog.rows.filter((row) => fold(`${row.family} ${row.name}`).includes(head)).map((row) => row.id);
  if (ids.length < 2 && head !== "refresco") return null;
  const question = questionFor(catalog, { source_text: source, reason: "ambiguous", candidate_ids: ids }, source);
  if (!/[¿?]/.test(question)) return null;
  return { question, ids };
}

function questionFor(catalog: CatalogSnapshot, item: Unmatched | PendingCatalogAsk, source: string): string {
  const ids = "candidateIds" in item ? item.candidateIds : item.candidate_ids;
  const rows = ids.map((id) => catalog.byId.get(id)).filter((row): row is CatalogRow => Boolean(row));
  const text = fold(source);

  if (/\bsprite\b/.test(text)) {
    return "Sprite no está en el menú. ¿Te late *Seven*?";
  }
  if (/\bcarne de puerco\b/.test(text) && !/\b(pulpa|bistec|pastor|costilla)\b/.test(text)) {
    return "¿Te refieres a Pulpa de puerco o Bistec de puerco?";
  }
  if (rows.length === 1 && !rows[0].variants.length) {
    return `¿Te refieres a ${rows[0].name}?`;
  }
  if (rows.length === 1 && rows[0].variants.length) {
    const flavors = rows[0].variants.join(", ").replace(/, ([^,]+)$/, " o $1");
    return `¿El refresco de qué sabor: ${flavors}?`;
  }
  if (rows.length && rows.every((row) => row.family === "alitas")) {
    const sizes = rows.map((row) => row.size).filter(Boolean).join(", ");
    return `¿De cuántas alitas: ${sizes}?`;
  }
  if (rows.length === 2 && rows.every((row) => row.family === rows[0].family) && rows.every((row) => row.size === "chica" || row.size === "grande")) {
    return `¿La ${rows[0].family} chica o grande?`;
  }
  if (rows.length && rows.every((row) => /papas/.test(row.family))) {
    return "¿Papas a la francesa o gajo?";
  }
  if (rows.length && rows.every((row) => /salsa/.test(fold(row.name)))) {
    return "¿La salsa BBQ o Hot Wings?";
  }
  if (rows.length && rows.every((row) => /costilla/.test(fold(row.name)))) {
    return "¿La costilla normal o la marinada?";
  }
  if (rows.length && rows.every((row) => /bistec/.test(fold(row.name)))) {
    return "¿El bistec de res o de puerco?";
  }
  if (rows.length && rows.every((row) => /dogo/.test(row.family) || /dogo/.test(fold(row.name)))) {
    const names = rows.map((row) => row.name).join(", ");
    return `¿Cuál dogo? Tenemos ${names}.`;
  }
  if (/hamburguesa/.test(text)) {
    const named = rows.filter((row) => {
      const blob = fold(`${row.name} ${row.family}`);
      return tokens(text).filter((word) => word.length >= 4).every((word) => blob.includes(word));
    });
    const pool = named.length ? named : rows;
    const sameFamily = pool.length >= 2 && pool.every((row) => row.family === pool[0].family);
    if (sameFamily && pool.some((row) => row.size === "chica") && pool.some((row) => row.size === "grande")) {
      return `¿La ${pool[0].family} chica o grande?`;
    }
  }
  if (rows.length && /hamburguesa/.test(text + rows.map((row) => row.family).join(" "))) {
    return "¿Cuál hamburguesa?";
  }
  if (rows.length && rows.every((row) => row.family.includes("torta") || /torta/.test(fold(row.name)))) {
    return "¿Cuál torta?";
  }
  if (rows.length && rows.every((row) => row.family.includes("quesadilla") || /quesadilla/.test(fold(row.name)))) {
    return "¿Cuál quesadilla?";
  }
  if (rows.length) {
    const sample = rows.slice(0, 3).map((row) => row.name).join(", ");
    return `¿Te refieres a ${sample}?`;
  }
  if (/\bhamburguesa\b/.test(text)) return "¿Cuál hamburguesa?";
  if (/\btorta\b/.test(text)) return "¿Cuál torta?";
  if (/\bquesadilla\b/.test(text)) return "¿Cuál quesadilla?";
  if (/\bdogo\b/.test(text)) return "¿Cuál dogo? Por ejemplo el *Clásico*.";
  if (/\bpapas\b/.test(text)) return "¿Papas a la francesa o gajo?";
  if (/\brefresco\b/.test(text)) return "¿El refresco de qué sabor: Pepsi, Seven, Coca, Mirinda o Manzana?";
  if (/\balitas\b/.test(text)) return "¿De cuántas alitas: 5, 10, 15, 20 o 30?";
  return "¿Te refieres a alguno del menú?";
}

function sharedFamily(catalog: CatalogSnapshot, ids: number[]): string | null {
  const rows = ids.map((id) => catalog.byId.get(id)).filter((row): row is CatalogRow => Boolean(row));
  if (!rows.length || !rows.every((row) => row.family === rows[0].family)) return null;
  return rows[0].family;
}

function askQty(catalog: CatalogSnapshot, item: Unmatched, pending: PendingCatalogAsk | null): { qty: number; unit: SellUnit } {
  const parsed = parseQuantity(item.source_text, catalog.profile);
  const qty = item.qty && item.qty > 0 ? item.qty : parsed.qty > 0 ? parsed.qty : pending?.qty ?? 1;
  const unit: SellUnit = item.unit
    ?? (parsed.unit === "pesos" || parsed.unit === "kg" ? parsed.unit : pending?.unit ?? (catalog.profile === "carniceria" ? "kg" : "pz"));
  return { qty, unit };
}

export function buildCatalogReply(params: {
  catalog: CatalogSnapshot;
  cart: CartLine[];
  unmatched: Unmatched[];
  pending: PendingCatalogAsk | null;
  confirmedList: boolean;
}): { reply: string; pending: PendingCatalogAsk | null } {
  const { catalog, cart } = params;
  const notes: string[] = [];
  const offered: Array<{ source: string; question: string; ids: number[] }> = [];
  for (const item of params.unmatched.filter((entry) => entry.reason === "not_on_menu")) {
    const retired = catalog.profile === "restaurante" ? droppedMenuNotice(item.source_text) : null;
    if (retired) {
      notes.push(retired);
      const question = retired.split("no lo manejamos. ")[1] ?? "";
      if (/[¿?]/.test(question)) {
        offered.push({ source: item.source_text, question, ids: droppedCandidateIds(catalog, item.source_text) });
      }
      continue;
    }
    const offer = offerFor(catalog, item.source_text);
    if (offer) {
      notes.push(`*${titleCase(item.source_text)}* no lo manejamos. ${offer.question}`);
      offered.push({ source: item.source_text, question: offer.question, ids: offer.ids });
    } else notes.push(notAvailable(catalog, item.source_text));
  }
  const asks = params.unmatched.filter((item) => item.reason === "ambiguous" || item.reason === "unclear");

  if (params.confirmedList && asks.length === 0) {
    return { reply: "", pending: null };
  }

  let pending = params.pending;
  const questions: string[] = [];
  if (asks.length) {
    const first = asks[0];
    const count = pending && fold(pending.question) === fold(questionFor(catalog, first, first.source_text)) ? pending.count + 1 : pending?.count ?? 1;
    const source = first.source_text;
    const prose = questionFor(catalog, first, source);
    if (count >= 2 && first.candidate_ids.length > 1) {
      const rows = first.candidate_ids.map((id) => catalog.byId.get(id)?.name ?? "").filter(Boolean);
      questions.push(
        formatClarificationOptions({
          title: "¿Cuál de estos?",
          emoji: catalog.profile === "carniceria" ? "🥩" : "🍔",
          choices: rows,
        }),
      );
    } else questions.push(prose);
    pending = {
      sourceText: source,
      candidateIds: first.candidate_ids,
      qty: askQty(catalog, first, pending).qty,
      unit: askQty(catalog, first, pending).unit,
      variant: null,
      family: sharedFamily(catalog, first.candidate_ids) ?? pending?.family ?? null,
      question: prose,
      count,
    };
  } else if (offered.length) {
    const offer = offered[0];
    const parsed = parseQuantity(offer.source, catalog.profile);
    pending = {
      sourceText: offer.source,
      candidateIds: offer.ids,
      qty: parsed.qty > 0 ? parsed.qty : 1,
      unit: parsed.unit === "pesos" || parsed.unit === "kg" ? parsed.unit : catalog.profile === "carniceria" ? "kg" : "pz",
      variant: null,
      family: sharedFamily(catalog, offer.ids),
      question: offer.question,
      count: 1,
    };
  } else pending = null;

  if (questions.length || notes.length) {
    const blocks = [...notes, ...questions].filter(Boolean);
    const followUp = Boolean(questions.length || offered.length);
    return { reply: blocks.join("\n\n"), pending: followUp ? pending : null };
  }

  if (!cart.length) {
    const invite = catalog.profile === "carniceria"
      ? "Dime el corte y los kilos, o cuántos pesos."
      : "Dime qué se te antoja del menú y cuántos.";
    return { reply: invite, pending: null };
  }

  return { reply: listReply(catalog, cart), pending: null };
}

function listReply(catalog: CatalogSnapshot, cart: CartLine[]): string {
  let subtotal = 0;
  let complete = cart.length > 0;
  const lines = cart.map((line) => {
    const row = catalog.byId.get(line.productId);
    if (!row) {
      complete = false;
      return "producto";
    }
    const label = lineLabel(line, row);
    if (line.unit === "pesos") {
      subtotal += line.qty;
      return `${label} — ${formatMoney(line.qty)}`;
    }
    if (!Number.isFinite(row.precio)) {
      complete = false;
      return label;
    }
    const lineTotal = Math.round(row.precio * line.qty * 100) / 100;
    subtotal += lineTotal;
    return `${label} — ${formatMoney(lineTotal)}`;
  });
  return formatCatalogFinalTicket({
    itemLines: lines,
    subtotal: complete ? Math.round(subtotal * 100) / 100 : null,
    kind: kindOf(catalog),
  });
}

/** Respuesta del motor nuevo: la pregunta guarda las palabras, la cantidad y las opciones. */
export function buildAiReply(params: {
  catalog: CatalogSnapshot;
  cart: CartLine[];
  notOnMenu: string[];
  question: { text: string; candidateIds: number[]; qty?: number | null; unit?: SellUnit | null; sourceText?: string | null } | null;
  pending: PendingCatalogAsk | null;
  pendingQueue?: Array<{ text: string; candidateIds: number[]; qty?: number | null; unit?: SellUnit | null; sourceText?: string | null }>;
  message?: string;
  confirmedList: boolean;
}): { reply: string; pending: PendingCatalogAsk | null } {
  const { catalog, cart } = params;
  if (params.confirmedList) return { reply: "", pending: null };

  const notes = params.notOnMenu.map((term) => {
    if (catalog.profile === "restaurante") {
      const retired = droppedMenuNotice(term);
      if (retired) return retired;
    }
    return notAvailable(catalog, term);
  });
  const retiredOffer = params.notOnMenu
    .map((term) => {
      if (catalog.profile !== "restaurante") return null;
      const retired = droppedMenuNotice(term);
      const question = retired?.split("no lo manejamos. ")[1] ?? "";
      if (!retired || !/[¿?]/.test(question)) return null;
      return { source: term, question, ids: droppedCandidateIds(catalog, term) };
    })
    .find((offer): offer is { source: string; question: string; ids: number[] } => Boolean(offer)) ?? null;
  const question = params.question;
  if (question) {
    const same = params.pending && fold(params.pending.question) === fold(question.text);
    const count = same ? params.pending!.count + 1 : 1;
    let prose = question.text;
    if (count >= 2 && question.candidateIds.length > 1) {
      const rows = question.candidateIds.map((id) => catalog.byId.get(id)?.name ?? "").filter(Boolean);
      if (rows.length) {
        prose = formatClarificationOptions({
          title: "¿Cuál de estos?",
          emoji: catalog.profile === "carniceria" ? "🥩" : "🍔",
          choices: rows,
        });
      }
    }
    const parsed = parseQuantity(question.sourceText || params.message || "", catalog.profile);
    const sourceText = question.sourceText?.trim()
      || (same ? params.pending?.sourceText : "")
      || params.message?.trim()
      || question.text;
    const qty = question.qty != null && question.qty > 0
      ? question.qty
      : same && params.pending
        ? params.pending.qty
        : parsed.qty > 0 ? parsed.qty : 1;
    const unit: SellUnit = question.unit
      ?? (same ? params.pending?.unit : null)
      ?? (parsed.unit === "kg" || parsed.unit === "pesos" ? parsed.unit : null)
      ?? (catalog.profile === "carniceria" ? "kg" : "pz");
    const queue = (params.pendingQueue ?? []).filter((item) => item.text.trim()).map((item) => {
      const itemQty = item.qty != null && item.qty > 0 ? item.qty : qty;
      const itemUnit: SellUnit = item.unit ?? unit;
      return {
        sourceText: item.sourceText?.trim() || sourceText,
        candidateIds: item.candidateIds,
        qty: itemQty,
        unit: itemUnit,
        question: item.text,
      };
    });
    const pending: PendingCatalogAsk = {
      sourceText,
      candidateIds: question.candidateIds,
      qty,
      unit,
      variant: null,
      family: sharedFamily(catalog, question.candidateIds),
      question: question.text,
      count,
      queue,
    };
    return { reply: [...notes, prose].filter(Boolean).join("\n\n"), pending };
  }

  let offeredPending: PendingCatalogAsk | null = null;
  if (retiredOffer) {
    const parsed = parseQuantity(retiredOffer.source || params.message || "", catalog.profile);
    offeredPending = {
      sourceText: retiredOffer.source,
      candidateIds: retiredOffer.ids,
      qty: parsed.qty > 0 ? parsed.qty : 1,
      unit: parsed.unit === "pesos" || parsed.unit === "kg" ? parsed.unit : catalog.profile === "carniceria" ? "kg" : "pz",
      variant: null,
      family: sharedFamily(catalog, retiredOffer.ids),
      question: retiredOffer.question,
      count: 1,
    };
  }

  if (!cart.length) {
    const invite = catalog.profile === "carniceria"
      ? "Dime el corte y los kilos, o cuántos pesos."
      : "Dime qué se te antoja del menú y cuántos.";
    const reply = notes.length ? notes.join("\n\n") : invite;
    return { reply, pending: offeredPending };
  }

  const list = listReply(catalog, cart);
  const reply = notes.length ? `${notes.join("\n\n")}\n\n${list}` : list;
  return { reply, pending: offeredPending };
}
