import { formatClarificationOptions } from "@/lib/clarificationAnswers";
import type { StoreKind } from "@/lib/categoryCopy";
import { parseQuantity } from "@/lib/catalogOrder/quantities";
import { formatProductListConfirm } from "@/lib/services/captureEngine";
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

function notAvailable(catalog: CatalogSnapshot, term: string): string {
  const label = titleCase(term);
  if (catalog.profile === "carniceria") {
    return `*${label}* no lo manejamos. En La Central tenemos res, puerco, pastor, chorizo, carbón y salsas.`;
  }
  return `*${label}* no lo manejamos. En George tenemos hamburguesas, dogos, tortas, quesadillas, alitas y refrescos.`;
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
    for (const extra of asks.slice(1)) questions.push(questionFor(catalog, extra, extra.source_text));
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

  const items = cart.map((line) => {
    const row = catalog.byId.get(line.productId);
    return { nombre_producto: row ? lineLabel(line, row) : "producto" };
  });
  return { reply: formatProductListConfirm(items, kindOf(catalog)), pending: null };
}
