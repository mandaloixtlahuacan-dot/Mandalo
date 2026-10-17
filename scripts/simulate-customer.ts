/**
 * Simulador de cliente. Entra por processMandaloWebhook.
 * Supabase y Whapi quedan en memoria. El agente usa AgentModel mock.
 * No manda WhatsApp real, no toca Supabase real y no llama a OpenAI.
 *
 * Correr: npm run simulate:customer
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { outboundLeak } from "../src/lib/outboundCopy";
import { createSimAgentModel } from "./sim/agent-model";
import { MemoryDatabase, seedFixtures, type CatalogPriceReport } from "./sim/memory-db";

type Outbound = { at: string; channel: string; kind: string; to: string; body: string; url?: string };
type TurnRecord = {
  customer: string;
  location: { latitude: number; longitude: number } | null;
  replies: Array<{ to: string; role: string; kind: string; body: string }>;
  outbox: Array<{ tipo: string; destinatario: string; telefono: string; contenido: string }>;
  result: unknown;
};

type Verdict = { status: "PASA" | "FALLA"; detail: string };

const PIN = { latitude: 20.865831, longitude: -103.240017 };
const PHONES = {
  pekes: "5213300000007",
  george: "5213300000005",
  central: "5213300000006",
  roberto: "5213300000011",
  mateo: "5213300000012",
  admin: "5213399990000",
};

function installEnv(): void {
  const fake = {
    SUPABASE_URL: "https://simulador.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "simulador-local-no-es-secreto-real-0001",
    OPENAI_API_KEY: "simulador-local-no-es-llave-real-0001",
    OPENAI_MODEL: "sim-mock",
    WAAPI_TOKEN: "simulador",
    WAAPI_API_BASE: "https://whapi.sim.invalid",
    MANDALO_ADMIN_PHONE: PHONES.admin,
    ORDER_AGENT: "on",
    CATALOG_ORDER_QUIET: "1",
  };
  for (const [key, value] of Object.entries(fake)) process.env[key] = value;
  delete process.env.OPENAI_ORDER_ESCALATION_MODEL;
}

function digits(value: string): string {
  return String(value ?? "").replace(/\D/g, "");
}

function roleFor(to: string): string {
  const key = digits(to).slice(-10);
  const table: Array<[string, string]> = [
    [PHONES.pekes, "tienda"],
    [PHONES.george, "tienda"],
    [PHONES.central, "tienda"],
    [PHONES.roberto, "repartidor"],
    [PHONES.mateo, "repartidor"],
    [PHONES.admin, "admin"],
  ];
  return table.find(([phone]) => phone.endsWith(key))?.[1] ?? "cliente";
}

function installRuntime(db: MemoryDatabase): void {
  const sim = globalThis as typeof globalThis & {
    __MANDALO_SIM__?: {
      supabase: ReturnType<MemoryDatabase["client"]>;
      createModel: typeof createSimAgentModel;
      outbound: Outbound[];
      chatCompletion?: () => string;
    };
  };
  sim.__MANDALO_SIM__ = {
    supabase: db.client(),
    createModel: createSimAgentModel,
    outbound: [],
    chatCompletion: () =>
      JSON.stringify({
        customer_reply: "Cuéntame qué se te antoja y de qué tienda, y lo armamos.",
        order_state: { stage: "collecting", items: [] },
      }),
  };
}

function takeOutbound(): Outbound[] {
  const sim = (globalThis as { __MANDALO_SIM__?: { outbound?: Outbound[] } }).__MANDALO_SIM__;
  const rows = sim?.outbound?.splice(0, sim.outbound.length) ?? [];
  return rows;
}

async function main(): Promise<void> {
  installEnv();
  const db = new MemoryDatabase();
  const prices = seedFixtures(db);
  installRuntime(db);

  const { processMandaloWebhook, parseIncomingWhatsAppMessage } = await import("../src/lib/mandaloFlow");
  const { classifyInbound } = await import("../src/lib/inboundMessage");
  const { normalizePhone } = await import("../src/lib/roles");
  const { resetOutboundGuard } = await import("../src/lib/outboundGuard");
  const { clearListaProductosCache } = await import("../src/lib/repositories/pedidoRepositoryV2");
  const { IXTLAHUACAN_CENTER } = await import("../src/lib/services/geo");

  async function say(phone: string, text: string, location?: { latitude: number; longitude: number }): Promise<TurnRecord> {
    resetOutboundGuard();
    const before = db.rows("admin_notificaciones").length;
    let result: unknown;
    try {
      result = await processMandaloWebhook({
        from: phone,
        body: text,
        raw: { simulated: true },
        location,
      });
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const replies = takeOutbound().map((row) => ({
      to: row.to,
      role: roleFor(row.to),
      kind: row.kind,
      body: row.body,
    }));
    const outbox = db
      .rows("admin_notificaciones")
      .slice(before)
      .map((row) => ({
        tipo: String(row.tipo ?? ""),
        destinatario: String(row.destinatario_tipo ?? ""),
        telefono: String(row.destinatario_telefono ?? ""),
        contenido: String(row.contenido ?? ""),
      }));
    return { customer: text, location: location ?? null, replies, outbox, result };
  }

  async function sayWhapi(payload: unknown): Promise<TurnRecord> {
    resetOutboundGuard();
    const before = db.rows("admin_notificaciones").length;
    const inbound = classifyInbound(payload);
    let result: unknown = { ok: false, inbound: inbound.kind };
    let location: { latitude: number; longitude: number } | null = null;
    if (inbound.kind !== "ignore" && inbound.kind !== "missing_from") {
      const numero = normalizePhone(inbound.from);
      location = inbound.kind === "location" ? { latitude: inbound.latitude, longitude: inbound.longitude } : null;
      const normalized = {
        data: {
          from: numero,
          body: inbound.body || " ",
          ...(location ? { latitude: location.latitude, longitude: location.longitude } : {}),
        },
      };
      try {
        const incoming = parseIncomingWhatsAppMessage(normalized);
        incoming.mediaKind = inbound.kind === "media" ? inbound.media : null;
        incoming.liveLocation = inbound.kind === "live_location";
        incoming.locationAttempt = inbound.kind === "location_unparsed";
        result = await processMandaloWebhook(incoming);
      } catch (error) {
        result = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    const replies = takeOutbound().map((row) => ({
      to: row.to,
      role: roleFor(row.to),
      kind: row.kind,
      body: row.body,
    }));
    const outbox = db
      .rows("admin_notificaciones")
      .slice(before)
      .map((row) => ({
        tipo: String(row.tipo ?? ""),
        destinatario: String(row.destinatario_tipo ?? ""),
        telefono: String(row.destinatario_telefono ?? ""),
        contenido: String(row.contenido ?? ""),
      }));
    return { customer: "", location, replies, outbox, result };
  }

  function whapiLocation(phone: string, location: Record<string, unknown>): unknown {
    return {
      messages: [
        {
          id: `loc-${phone}`,
          from_me: false,
          type: "location",
          chat_id: `${phone}@s.whatsapp.net`,
          from: phone,
          location,
        },
      ],
      event: { type: "messages", event: "post" },
    };
  }

  function customerText(turns: TurnRecord[]): string {
    return turns
      .flatMap((turn) => turn.replies.filter((row) => row.role === "cliente").map((row) => row.body))
      .join("\n");
  }

  function adminRows(turns: TurnRecord[]): TurnRecord["outbox"] {
    return turns.flatMap((turn) =>
      turn.outbox.filter((row) => row.destinatario === "admin" || row.tipo === "queja_cliente" || row.tipo === "cancelacion_tardia"),
    );
  }

  async function shop(phone: string, niche: string, store: string): Promise<TurnRecord[]> {
    return [await say(phone, "hola"), await say(phone, niche), await say(phone, store)];
  }

  const scenarios: Array<{
    id: string;
    title: string;
    run: () => Promise<{ turns: TurnRecord[]; verdict: Verdict }>;
  }> = [
    {
      id: "coca-pekes",
      title: "Quiero una coca en Peke's",
      run: async () => {
        const phone = "5213310001001";
        const turns = [...(await shop(phone, "abarrotes", "Peke's")), await say(phone, "quiero una coca")];
        const reply = customerText(turns.slice(-1));
        const hasCoca = /coca/i.test(reply);
        const productPrice = reply.replace(/\$35/g, "").match(/\$\s*\d/);
        const asked = /cu[aá]l de estos/i.test(reply);
        const closed = /est[aá]n bien estos productos/i.test(reply);
        const quotes = /cotiza|confirma el precio/i.test(reply);
        const problems: string[] = [];
        if (!hasCoca) problems.push("la respuesta no muestra Coca");
        if (!asked) problems.push("no preguntó la presentación de la Coca");
        if (closed) problems.push("anotó una Coca sin que el cliente eligiera presentación");
        if (productPrice) problems.push("mostró un monto de producto; Peke's cotiza");
        if (!quotes) problems.push("no dijo que la tienda cotiza");
        return {
          turns,
          verdict: {
            status: problems.length ? "FALLA" : "PASA",
            detail: problems.length
              ? problems.join(". ")
              : `Preguntó la presentación de la Coca, sin precio de producto. ${prices.pekesNullPrice} de ${prices.pekesRows} filas de Peke's traen precio null.`,
          },
        };
      },
    },
    {
      id: "dogos-george",
      title: "3 dogos en George",
      run: async () => {
        const phone = "5213310001002";
        const turns = [...(await shop(phone, "restaurantes", "George")), await say(phone, "3 dogos")];
        const reply = customerText(turns.slice(-1));
        const aboutDogos = /dogo/i.test(reply);
        const qty = /\b3\b|x3|×3/.test(reply);
        const asks = /cu[aá]l/i.test(reply) && /dogo/i.test(reply);
        const listed = /est[aá]n bien estos productos/i.test(reply);
        const ok = aboutDogos && ((qty && listed) || asks);
        return {
          turns,
          verdict: {
            status: ok ? "PASA" : "FALLA",
            detail: ok
              ? qty && listed
                ? "Anotó 3 dogos y mostró la lista para confirmar."
                : "Preguntó cuál dogo en vez de cerrar uno solo."
              : "No quedó un pedido de 3 dogos ni una pregunta para elegir dogo.",
          },
        };
      },
    },
    {
      id: "nito-caja",
      title: "Una caja de Nito en Peke's",
      run: async () => {
        const phone = "5213310001003";
        const turns = [...(await shop(phone, "abarrotes", "Peke's")), await say(phone, "una caja de Nito")];
        const reply = customerText(turns.slice(-1));
        const pickedBox = /caja nito/i.test(reply) && /est[aá]n bien estos productos/i.test(reply);
        const asked = /cu[aá]l de estos/i.test(reply);
        return {
          turns,
          verdict: {
            status: pickedBox && !asked ? "PASA" : "FALLA",
            detail: pickedBox && !asked ? "Eligió la caja de Nito y la dejó en la lista." : "No se quedó con la caja. Una caja de Nito debería elegir la caja, no preguntar otra vez.",
          },
        };
      },
    },
    {
      id: "nito-pieza",
      title: "Un Nito en Peke's",
      run: async () => {
        const phone = "5213310001004";
        const turns = [...(await shop(phone, "abarrotes", "Peke's")), await say(phone, "un Nito")];
        const reply = customerText(turns.slice(-1));
        const picked = /nito 62g/i.test(reply) && /est[aá]n bien estos productos/i.test(reply);
        const asked = /cu[aá]l de estos/i.test(reply);
        const other = /duo|funk|hotkis|caja nito/i.test(reply);
        const ok = picked && !asked && !other;
        return {
          turns,
          verdict: {
            status: ok ? "PASA" : "FALLA",
            detail: ok ? "Anotó Nito 62g, la pieza estándar, y cerró la lista." : "Un Nito sin presentación debe anotar Nito 62g, no la caja, el Duo, el Funk ni el Hotkis.",
          },
        };
      },
    },
    {
      id: "leche-pekes",
      title: "Leche en Peke's",
      run: async () => {
        const phone = "5213310001005";
        const turns = [...(await shop(phone, "abarrotes", "Peke's")), await say(phone, "leche")];
        const reply = customerText(turns.slice(-1));
        const lines = reply.split("\n").filter((line) => /^\d+\./.test(line.trim()));
        const asks = (lines.length >= 2 || /cu[aá]l/i.test(reply)) && /leche/i.test(reply);
        const closed = /est[aá]n bien estos productos/i.test(reply);
        return {
          turns,
          verdict: {
            status: asks && !closed ? "PASA" : "FALLA",
            detail: asks && !closed ? "Mostró leches reales y dejó elegir." : "No preguntó cuál leche, o ya dio la lista por cerrada.",
          },
        };
      },
    },
    {
      id: "kilo-central",
      title: "Un kilo en Carnicería La Central",
      run: async () => {
        const phone = "5213310001006";
        const turns = [...(await shop(phone, "carnicerías", "La Central")), await say(phone, "un kilo de diezmillo")];
        const reply = customerText(turns.slice(-1));
        const hasCut = /diezmillo/i.test(reply);
        const hasKilo = /kilo/i.test(reply);
        const hasPrice = /\$\s*\d/.test(reply);
        const ok = hasCut && (hasKilo || hasPrice);
        return {
          turns,
          verdict: {
            status: ok ? "PASA" : "FALLA",
            detail: ok ? "Anotó diezmillo por kilo, con el precio del menú si ya se puede mostrar." : "No anotó el kilo de diezmillo.",
          },
        };
      },
    },
    {
      id: "george-completo",
      title: "Pedido George hasta ubicación y confirmación",
      run: async () => {
        const phone = "5213310001007";
        const turns = [
          ...(await shop(phone, "restaurantes", "George")),
          await say(phone, "un dogo clásico"),
        ];
        let reply = customerText(turns.slice(-1));
        if (/cu[aá]l de estos/i.test(reply)) {
          turns.push(await say(phone, "sí"));
          reply = customerText(turns.slice(-1));
        }
        if (/est[aá]n bien estos productos/i.test(reply)) {
          turns.push(await say(phone, "sí"));
          reply = customerText(turns.slice(-1));
        }
        const askedPin = /ubicaci[oó]n por gps|compartes tu ubicaci/i.test(reply);
        if (askedPin) turns.push(await say(phone, "", PIN));
        const afterPin = customerText(turns.slice(-1));
        const rejectedEarly = /cuando ya est[eé] armado/i.test(afterPin);
        const confirmed = !rejectedEarly && /pedido #|total|programad/i.test(afterPin);
        const ok = askedPin && confirmed;
        return {
          turns,
          verdict: {
            status: ok ? "PASA" : "FALLA",
            detail: ok
              ? "Pidió la ubicación y, con el pin dentro de Ixtlahuacán, siguió la confirmación."
              : !askedPin
                ? `No llegó a pedir la ubicación. Pin de prueba: ${IXTLAHUACAN_CENTER.latitude}, ${IXTLAHUACAN_CENTER.longitude}.`
                : "Pidió el pin, pero al recibirlo lo rechazó (location_early): la fase guardada sigue en pedido, así que el GPS no cuenta todavía.",
          },
        };
      },
    },
    {
      id: "sin-sentido",
      title: "Mensaje sin sentido",
      run: async () => {
        const phone = "5213310001008";
        const turns = [await say(phone, "hola"), await say(phone, "asdf qwerty blorp")];
        const reply = customerText(turns.slice(-1));
        const inventedList = /est[aá]n bien estos productos/i.test(reply);
        const answered = reply.trim().length > 0;
        return {
          turns,
          verdict: {
            status: answered && !inventedList ? "PASA" : "FALLA",
            detail: answered && !inventedList ? "Contestó sin armar un pedido inventado." : "Se quedó callado o armó una lista con un mensaje sin sentido.",
          },
        };
      },
    },
    {
      id: "recomendacion",
      title: "¿Qué me recomiendas?",
      run: async () => {
        const phone = "5213310001009";
        const turns = [await say(phone, "hola"), await say(phone, "¿qué me recomiendas?")];
        const reply = customerText(turns.slice(-1));
        const inventedList = /est[aá]n bien estos productos/i.test(reply);
        const answered = reply.trim().length > 0;
        return {
          turns,
          verdict: {
            status: answered && !inventedList ? "PASA" : "FALLA",
            detail: answered && !inventedList ? "Contestó sin inventar un pedido." : "No contestó, o armó una lista sin que el cliente pidiera algo.",
          },
        };
      },
    },
    {
      id: "cancelar-a-medias",
      title: "Cancelación a media orden",
      run: async () => {
        const phone = "5213310001010";
        const turns = [...(await shop(phone, "abarrotes", "Peke's")), await say(phone, "leche"), await say(phone, "cancela")];
        const asked = customerText(turns.slice(-1));
        const question = /quieres cancelar el pedido/i.test(asked) && /s[ií] o no/i.test(asked);
        turns.push(await say(phone, "sí"));
        const after = customerText(turns.slice(-1));
        const greeting = /de d[oó]nde quieres/i.test(after);
        const admins = adminRows(turns);
        const problems: string[] = [];
        if (!question) problems.push('no preguntó "¿Quieres cancelar el pedido? Sí o No"');
        if (!greeting) problems.push("con sí no volvió al saludo");
        if (admins.length) problems.push(`se encoló aviso al admin (${admins.map((row) => row.tipo).join(", ")})`);
        return {
          turns,
          verdict: {
            status: problems.length ? "FALLA" : "PASA",
            detail: problems.length ? problems.join(". ") : "Preguntó, con sí volvió al saludo y no avisó al admin.",
          },
        };
      },
    },
    {
      id: "queja-pedido",
      title: "Queja: está mal mi pedido",
      run: async () => {
        const phone = "5213310001011";
        const turns = [await say(phone, "hola"), await say(phone, "está mal mi pedido")];
        return complaintVerdict(turns);
      },
    },
    {
      id: "hablar-con-alguien",
      title: "Quiere hablar con alguien",
      run: async () => {
        const phone = "5213310001012";
        const turns = [await say(phone, "hola"), await say(phone, "quiero hablar con alguien")];
        return complaintVerdict(turns);
      },
    },
    {
      id: "cancelar-antes-despacho",
      title: "Cancelación antes de despacho",
      run: async () => {
        const phone = "5213310001013";
        const turns = [...(await shop(phone, "abarrotes", "Peke's")), await say(phone, "leche"), await say(phone, "cancela"), await say(phone, "sí")];
        return cancelVerdict(turns, { greeting: true, store: false, courier: false });
      },
    },
    {
      id: "cancelar-tienda",
      title: "Cancelación después de mandar a la tienda",
      run: async () => {
        const phone = "5213310001014";
        await seedLiveOrder(phone, "pendiente_tiendas", null);
        const turns = [await say(phone, "cancela"), await say(phone, "sí")];
        const verdict = cancelVerdict(turns, { greeting: true, store: true, courier: false });
        verdict.verdict.detail = `Pedido sembrado en pendiente_tiendas (no es un despacho en vivo). ${verdict.verdict.detail}`;
        return verdict;
      },
    },
    {
      id: "cancelar-repartidor",
      title: "Cancelación con repartidor asignado",
      run: async () => {
        const phone = "5213310001015";
        await seedLiveOrder(phone, "repartidor_asignado", 1);
        const turns = [await say(phone, "cancela"), await say(phone, "sí")];
        const verdict = cancelVerdict(turns, { greeting: true, store: true, courier: true });
        verdict.verdict.detail = `Pedido sembrado en repartidor_asignado (no es un despacho en vivo). ${verdict.verdict.detail}`;
        return verdict;
      },
    },
    {
      id: "cancelar-no",
      title: "No a la pregunta de cancelar",
      run: async () => {
        const phone = "5213310001016";
        const turns = [...(await shop(phone, "abarrotes", "Peke's")), await say(phone, "leche"), await say(phone, "cancela"), await say(phone, "no")];
        const reply = customerText(turns.slice(-1));
        const stayed = /seguimos con tu pedido/i.test(reply);
        const stillOpen = db.rows("pedidos").some((row) => String(row.cliente_telefono) === phone && row.estado === "seleccion_productos");
        const admins = db.rows("admin_notificaciones").length;
        const problems: string[] = [];
        if (!stayed) problems.push('con no no dijo "Va, seguimos con tu pedido."');
        if (!stillOpen) problems.push("el pedido no siguió abierto");
        if (admins) problems.push(`${admins} admin_notificaciones`);
        return {
          turns,
          verdict: {
            status: problems.length ? "FALLA" : "PASA",
            detail: problems.length ? problems.join(". ") : "Con no siguió el pedido y no avisó al admin.",
          },
        };
      },
    },
    {
      id: "pedido-144-dentro",
      title: "Pedido 144: sí fuera de horario y pin dentro de la cabecera",
      run: async () => {
        const phone = "5213310001101";
        setClock("2026-10-16T17:59:00.000Z");
        await setGeorgeHours("19:00", "00:00");
        try {
          const turns = [...(await shop(phone, "restaurantes", "George")), await say(phone, "3 dogos de pollo, 2 dogos clásicos, 1 Pepsi y una manzanita")];
          const built = await closeFixedList(phone, turns);
          built.push(await say(phone, "Si"));
          const asked = customerText(built.slice(-2, -1));
          const afterYes = customerText(built.slice(-1));
          built.push(await say(phone, "", PIN));
          const afterPin = customerText(built.slice(-1));
          const problems: string[] = [];
          if (!/ubicaci[oó]n/i.test(afterYes) && !/ubicaci[oó]n/i.test(asked)) problems.push("el sí no pasó a ubicación");
          if (/cuando ya est[eé] armado/i.test(afterPin)) problems.push("location_early: el pin de adentro no se aceptó");
          if (/fuera de esa zona/i.test(afterPin)) problems.push("rechazó un pin dentro de la cabecera");
          if (!/programad|pedido #|envi/i.test(afterPin)) problems.push("no programó ni registró el pedido");
          return { turns: built, verdict: { status: problems.length ? "FALLA" : "PASA", detail: problems.join(". ") || "El sí pidió ubicación y el pin de la cabecera se aceptó." } };
        } finally {
          setClock(null);
          await setGeorgeHours("08:00", "21:00");
        }
      },
    },
    {
      id: "pedido-144-fuera",
      title: "Pedido 144: pin fuera, Ok gracias y cambiar de tienda",
      run: async () => {
        const phone = "5213310001102";
        setClock("2026-10-16T17:59:00.000Z");
        await setGeorgeHours("19:00", "00:00");
        try {
          const turns = [...(await shop(phone, "restaurantes", "George")), await say(phone, "3 dogos de pollo, 2 dogos clásicos, 1 Pepsi y una manzanita")];
          const built = await closeFixedList(phone, turns);
          built.push(await say(phone, "Si"));
          built.push(await say(phone, "", { latitude: 21.05, longitude: -103.24 }));
          const rejected = customerText(built.slice(-1));
          built.push(await say(phone, "Ok gracias"));
          const thanks = customerText(built.slice(-1));
          built.push(await say(phone, "cambiar de tienda"));
          const ask = customerText(built.slice(-1));
          built.push(await say(phone, "Si"));
          const after = customerText(built.slice(-1));
          const menu = /men[uú]|dogos|hamburguesa|foto/i.test(thanks) && !/ubicaci[oó]n|direcci[oó]n|cancelar/i.test(thanks);
          const problems: string[] = [];
          if (!/fuera de esa zona/i.test(rejected)) problems.push("el pin de afuera no se rechazó");
          if (!/otra ubicaci[oó]n|escribe/i.test(rejected)) problems.push("el rechazo no ofreció otra ubicación o la dirección");
          if (menu) problems.push("Ok gracias reenvió el menú de George");
          if (!/ubicaci[oó]n|direcci[oó]n|cancelar/i.test(thanks)) problems.push("Ok gracias no se quedó en ubicación");
          if (!/quieres cancelar el pedido/i.test(ask)) problems.push("cambiar de tienda no preguntó sí o no");
          if (/no pidi[oó] quitar|el cliente/i.test(`${ask}\n${thanks}`)) problems.push("mostró texto interno");
          if (!/de d[oó]nde quieres/i.test(after)) problems.push("el sí no canceló y volvió al saludo");
          return { turns: built, verdict: { status: problems.length ? "FALLA" : "PASA", detail: problems.join(". ") || "Pin de afuera, se quedó en ubicación y cancelar preguntó sí o no." } };
        } finally {
          setClock(null);
          await setGeorgeHours("08:00", "21:00");
        }
      },
    },
    {
      id: "e2e-george",
      title: "George de saludo a entrega, dentro de horario",
      run: () => walkFixedToDelivery("5213310001201", "restaurantes", "George", "3 dogos"),
    },
    {
      id: "e2e-central",
      title: "La Central de saludo a entrega, dentro de horario",
      run: () => walkFixedToDelivery("5213310001202", "carnicerías", "La Central", "un kilo de diezmillo"),
    },
    {
      id: "e2e-pekes",
      title: "Peke's por cotización, de saludo a entrega",
      run: () => walkQuoteToDelivery("5213310001203"),
    },
    {
      id: "repartidor-formato",
      title: "Comandos de repartidor mal formados",
      run: async () => {
        const turns = [
          await say(PHONES.roberto, "confirmo 12"),
          await say(PHONES.roberto, "#CONFIRMO"),
          await say(PHONES.roberto, "#CONFIRMO 99999"),
          await say(PHONES.roberto, "#RECOGI"),
        ];
        const text = turns.flatMap((turn) => turn.replies.map((row) => row.body)).join("\n");
        const problems: string[] = [];
        if (/administrador/i.test(text)) problems.push("pidió contactar al administrador");
        if (!/#CONFIRMO 123/.test(text) || !/#RECOGI 123/.test(text) || !/#ENTREGADO 123/.test(text)) {
          problems.push("la ayuda no trae el formato correcto");
        }
        if (!/no encontr[eé]/i.test(text)) problems.push("un número que no existe no se explicó");
        return {
          turns,
          verdict: {
            status: problems.length ? "FALLA" : "PASA",
            detail: problems.join(". ") || "Minúsculas, sin # y sin número reciben la ayuda con el formato.",
          },
        };
      },
    },
    {
      id: "pedido-144-parse",
      title: "Pin de Whapi: 0,0 con grados, e7, link y pin vacío",
      run: async () => {
        setClock("2026-10-16T17:59:00.000Z");
        await setGeorgeHours("19:00", "00:00");
        const problems: string[] = [];
        const turns: TurnRecord[] = [];
        const cases: Array<{ phone: string; location: Record<string, unknown>; expect: "accept" | "unparsed" }> = [
          {
            phone: "5213310001103",
            location: { latitude: 0, longitude: 0, degreesLatitude: PIN.latitude, degreesLongitude: PIN.longitude },
            expect: "accept",
          },
          {
            phone: "5213310001104",
            location: { latitude: Math.round(PIN.latitude * 1e7), longitude: Math.round(PIN.longitude * 1e7) },
            expect: "accept",
          },
          {
            phone: "5213310001105",
            location: { url: `https://www.google.com/maps?q=${PIN.latitude},${PIN.longitude}` },
            expect: "accept",
          },
          { phone: "5213310001106", location: { latitude: null, longitude: null }, expect: "unparsed" },
        ];
        try {
          for (const item of cases) {
            const built = [
              ...(await shop(item.phone, "restaurantes", "George")),
              await say(item.phone, "3 dogos de pollo, 2 dogos clásicos, 1 Pepsi y una manzanita"),
            ];
            const ready = await closeFixedList(item.phone, built);
            ready.push(await say(item.phone, "Si"));
            ready.push(await sayWhapi(whapiLocation(item.phone, item.location)));
            const after = customerText(ready.slice(-1));
            if (item.expect === "accept") {
              if (/fuera de esa zona/i.test(after)) problems.push(`${item.phone} rechazó un pin de la cabecera`);
              if (/cuando ya est[eé] armado/i.test(after)) problems.push(`${item.phone} location_early`);
              if (!/programad|pedido #|envi/i.test(after)) problems.push(`${item.phone} no registró el pin`);
            } else if (/fuera de esa zona/i.test(after)) {
              problems.push(`${item.phone} trató un pin vacío como fuera de zona`);
            } else if (!/pin|ubicaci[oó]n|direcci[oó]n/i.test(after)) {
              problems.push(`${item.phone} no pidió otro pin`);
            }
            turns.push(...ready);
          }
          return {
            turns,
            verdict: {
              status: problems.length ? "FALLA" : "PASA",
              detail: problems.join(". ") || "0,0 con grados, e7 y el link se aceptan; un pin vacío no dice fuera de zona.",
            },
          };
        } finally {
          setClock(null);
          await setGeorgeHours("08:00", "21:00");
        }
      },
    },
    {
      id: "repartidor-nadie",
      title: "Comando en otro paso y nadie acepta",
      run: async () => {
        setClock("2026-10-17T02:00:00.000Z");
        await setGeorgeHours("19:00", "00:00");
        try {
          const phone = "5213310001107";
          const turns = [...(await shop(phone, "restaurantes", "George")), await say(phone, "3 dogos")];
          const built = await closeFixedList(phone, turns);
          built.push(await say(phone, "sí"));
          built.push(await say(phone, "", PIN));
          const placed = customerText(built.slice(-1));
          const problems: string[] = [];
          if (/fuera de esa zona|cuando ya est[eé] armado/i.test(placed)) problems.push("no llegó a ofrecer el pedido");
          const row = db.rows("pedidos").find((item) => String(item.cliente_telefono ?? "").endsWith(phone.slice(-10)));
          const id = Number(row?.id);
          if (!id || String(row?.estado) !== "dispatch_repartidor_pendiente") {
            problems.push(`estado ${String(row?.estado ?? "sin pedido")}, no dispatch`);
          } else {
            built.push(await say(PHONES.roberto, `#RECOGI ${id}`));
            built.push(await say(PHONES.roberto, `#ENTREGADO ${id}`));
            const courier = built.slice(-2).flatMap((turn) => turn.replies.map((reply) => reply.body)).join("\n");
            if (/administrador/i.test(courier)) problems.push("el paso equivocado manda con el administrador");
            if (!/no está en el paso/i.test(courier)) problems.push("no explicó que el comando no corresponde");
            const meta =
              row && row.metadata_json && typeof row.metadata_json === "object"
                ? (row.metadata_json as Record<string, unknown>)
                : {};
            meta.courier_confirmation_deadline_at = "2000-01-01T00:00:00.000Z";
            if (row) row.metadata_json = meta;
            const before = db.rows("admin_notificaciones").length;
            try {
              const { createOrderTimeoutWorker } = await import("../src/lib/services/orderTimeoutWorker");
              await createOrderTimeoutWorker().run();
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              if (!/is not a function|no está soportado/i.test(message)) problems.push(`el worker falló: ${message}`);
            }
            const fresh = db.rows("admin_notificaciones").slice(before);
            const notices = fresh.map((item) => String(item.contenido ?? ""));
            const customer = notices.filter((body) => /no tenemos repartidores/i.test(body));
            if (customer.length !== 1) problems.push(`aviso al cliente ${customer.length} veces`);
            if (!notices.some((body) => /no es necesario prepararlo/i.test(body))) problems.push("la tienda no supo que ya no lo prepare");
            if (!notices.some((body) => /ya no hace falta que lo recojas/i.test(body))) problems.push("el repartidor no supo que se canceló");
            if (notices.some((body) => /administrador/i.test(body))) problems.push("el timeout menciona al administrador");
            built.push({
              customer: "(timeout de repartidor)",
              location: null,
              replies: [],
              outbox: fresh.map((item) => ({
                tipo: String(item.tipo ?? ""),
                destinatario: String(item.destinatario_tipo ?? ""),
                telefono: String(item.destinatario_telefono ?? ""),
                contenido: String(item.contenido ?? ""),
              })),
              result: { ok: true },
            });
          }
          return {
            turns: built,
            verdict: {
              status: problems.length ? "FALLA" : "PASA",
              detail: problems.join(". ") || "Comando en otro paso se explica, y si nadie acepta se avisa una vez.",
            },
          };
        } finally {
          setClock(null);
          await setGeorgeHours("08:00", "21:00");
        }
      },
    },
  ];

  function complaintVerdict(turns: TurnRecord[]): { turns: TurnRecord[]; verdict: Verdict } {
    const reply = customerText(turns.slice(-1));
    const offers = /corregir/i.test(reply) && /abarrotes/i.test(reply);
    const promisesContact = /contact|avis[eé] a nuestro equipo|te van a/i.test(reply);
    const admins = db.rows("admin_notificaciones").length;
    const problems: string[] = [];
    if (!offers) problems.push("no ofreció ayuda ni las opciones de pedido");
    if (promisesContact) problems.push("dijo que alguien lo va a contactar");
    if (admins) problems.push(`${admins} admin_notificaciones`);
    return {
      turns,
      verdict: {
        status: problems.length ? "FALLA" : "PASA",
        detail: problems.length ? problems.join(". ") : "Ofreció ayuda y opciones, sin avisar al admin.",
      },
    };
  }

  function cancelVerdict(
    turns: TurnRecord[],
    expect: { greeting: boolean; store: boolean; courier: boolean },
  ): { turns: TurnRecord[]; verdict: Verdict } {
    const asked = turns.length >= 2 ? customerText([turns[turns.length - 2]]) : "";
    const after = customerText(turns.slice(-1));
    const question = /quieres cancelar el pedido/i.test(asked) && /s[ií] o no/i.test(asked);
    const greeting = /de d[oó]nde quieres/i.test(after);
    const store = turns.some((turn) => turn.replies.some((row) => row.role === "tienda" && /cancel/i.test(row.body)));
    const courier = turns.some((turn) => turn.replies.some((row) => row.role === "repartidor" && /cancel/i.test(row.body)));
    const admins = db.rows("admin_notificaciones").length;
    const problems: string[] = [];
    if (!question) problems.push('no preguntó "¿Quieres cancelar el pedido? Sí o No"');
    if (expect.greeting && !greeting) problems.push("con sí no volvió al saludo");
    if (store !== expect.store) problems.push(expect.store ? "no avisó a la tienda" : "avisó a la tienda sin haberle mandado el pedido");
    if (courier !== expect.courier) problems.push(expect.courier ? "no avisó al repartidor" : "avisó a un repartidor que no tenía el pedido");
    if (admins) problems.push(`${admins} admin_notificaciones`);
    return {
      turns,
      verdict: {
        status: problems.length ? "FALLA" : "PASA",
        detail: problems.length ? problems.join(". ") : "Preguntó, canceló con sí, avisó solo a quien ya tenía el pedido y no escribió admin_notificaciones.",
      },
    };
  }

  async function seedLiveOrder(phone: string, estado: string, repartidorId: number | null): Promise<void> {
    await db.client().from("clientes").upsert({ telefono: phone, nombre: "Cliente sim", metadata_json: {} }, { onConflict: "telefono" });
    const pedido = await db
      .client()
      .from("pedidos")
      .insert({
        cliente_telefono: phone,
        estado,
        repartidor_id: repartidorId,
        servicio_mandalo: 0,
        servicio_repartidor: 35,
        metadata_json: {
          capture_snapshot: {
            businessId: 5,
            businessPhone: PHONES.george,
            businessName: "Hamburguesas Hotdogs George",
            items: [{ nombre_producto: "Dogo Clásico", cantidad: 1 }],
          },
        },
      })
      .select("id")
      .maybeSingle();
    if (pedido.error || !pedido.data) throw new Error(pedido.error?.message ?? "no se sembró el pedido");
    const pedidoId = Number((pedido.data as { id: number }).id);
    const tienda = await db
      .client()
      .from("pedido_tiendas")
      .insert({ pedido_id: pedidoId, tienda_id: 5, subtotal_tienda: 35, estado_tienda: "confirmado" })
      .select("id")
      .maybeSingle();
    if (tienda.error || !tienda.data) throw new Error(tienda.error?.message ?? "no se sembró la tienda del pedido");
    await db.client().from("pedido_items").insert({
      pedido_tienda_id: Number((tienda.data as { id: number }).id),
      nombre_producto: "Dogo Clásico",
      cantidad: 1,
      disponible: true,
    });
  }

  function setClock(iso: string | null): void {
    if (iso) process.env.MANDALO_CLOCK_ISO = iso;
    else delete process.env.MANDALO_CLOCK_ISO;
  }

  async function setGeorgeHours(abre: string, cierra: string): Promise<void> {
    const { error } = await db.client().from("tiendas").update({ hora_apertura: abre, hora_cierre: cierra }).eq("telefono", PHONES.george);
    if (error) throw new Error(error.message);
  }

  async function closeFixedList(phone: string, turns: TurnRecord[]): Promise<TurnRecord[]> {
    const next = [...turns];
    for (let i = 0; i < 6; i += 1) {
      const reply = customerText(next.slice(-1));
      if (/ubicaci[oó]n por GPS|est[aá]n bien estos productos/i.test(reply)) return next;
      if (/cu[aá]l de estos/i.test(reply)) {
        next.push(await say(phone, "1"));
        continue;
      }
      break;
    }
    return next;
  }

  function blob(turns: TurnRecord[]): string {
    return turns
      .flatMap((turn) => [...turn.replies.map((row) => row.body), ...turn.outbox.map((row) => row.contenido)])
      .join("\n");
  }

  function once(turns: TurnRecord[], pattern: RegExp): number {
    return (blob(turns).match(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`)) ?? []).length;
  }

  async function finishWithCouriers(phone: string, turns: TurnRecord[]): Promise<string[]> {
    const problems: string[] = [];
    const idMatch = blob(turns).match(/#(\d+)/);
    const pedidoId = idMatch ? Number(idMatch[1]) : null;
    if (!pedidoId) {
      problems.push("no salió el número de pedido");
      return problems;
    }
    turns.push(await say(PHONES.roberto, `#CONFIRMO ${pedidoId}`));
    turns.push(await say(PHONES.mateo, `#CONFIRMO ${pedidoId}`));
    const race = turns[turns.length - 1]?.replies.map((row) => row.body).join("\n") ?? "";
    if (!/ya lo tom[oó] otro repartidor/i.test(race)) problems.push("el segundo repartidor no recibió el aviso de que ya lo tomaron");
    turns.push(await say(PHONES.roberto, `#RECOGI ${pedidoId}`));
    turns.push(await say(PHONES.roberto, `#ENTREGADO ${pedidoId}`));
    const all = blob(turns);
    if (!/acept[oó] tu pedido/i.test(all)) problems.push("el cliente no supo que el repartidor aceptó");
    if (!/en camino/i.test(all)) problems.push("el cliente no supo de la recogida");
    if (!/gracias por tu compra/i.test(all)) problems.push("el cliente no recibió el cierre");
    if (once(turns, /acept[oó] tu pedido/i) !== 1) problems.push("el aviso de aceptación no salió una sola vez");
    if (once(turns, /gracias por tu compra/i) !== 1) problems.push("el cierre no salió una sola vez");
    return problems;
  }

  async function walkFixedToDelivery(phone: string, niche: string, store: string, order: string): Promise<{ turns: TurnRecord[]; verdict: Verdict }> {
    setClock("2026-10-17T02:00:00.000Z");
    await setGeorgeHours("19:00", "00:00");
    try {
      const turns = [...(await shop(phone, niche, store)), await say(phone, order)];
      const built = await closeFixedList(phone, turns);
      if (!/est[aá]n bien estos productos/i.test(customerText(built.slice(-1)))) {
        return { turns: built, verdict: { status: "FALLA", detail: "no armó la lista con precio antes del sí" } };
      }
      built.push(await say(phone, "sí"));
      if (!/ubicaci[oó]n por GPS/i.test(customerText(built.slice(-1)))) {
        return { turns: built, verdict: { status: "FALLA", detail: "el sí no pidió la ubicación" } };
      }
      built.push(await say(phone, "", PIN));
      const placed = customerText(built.slice(-1));
      if (/cuando ya est[eé] armado|fuera de esa zona/i.test(placed)) {
        return { turns: built, verdict: { status: "FALLA", detail: "el pin de adentro no siguió" } };
      }
      const problems = await finishWithCouriers(phone, built);
      return {
        turns: built,
        verdict: { status: problems.length ? "FALLA" : "PASA", detail: problems.join(". ") || "Llegó a entregado, con un solo aviso por paso." },
      };
    } finally {
      setClock(null);
      await setGeorgeHours("08:00", "21:00");
    }
  }

  async function walkQuoteToDelivery(phone: string): Promise<{ turns: TurnRecord[]; verdict: Verdict }> {
    setClock("2026-10-17T02:00:00.000Z");
    try {
      const turns = [...(await shop(phone, "abarrotes", "Peke's")), await say(phone, "quiero una coca")];
      let guard = 0;
      while (guard < 4 && /cu[aá]l de estos/i.test(customerText(turns.slice(-1)))) {
        turns.push(await say(phone, "1"));
        guard += 1;
      }
      const optionText = customerText(turns.filter((turn) => /cu[aá]l de estos/i.test(customerText([turn]))));
      if (/\$\s*\d/.test(optionText)) {
        return { turns, verdict: { status: "FALLA", detail: "las opciones de Peke's mostraron monto" } };
      }
      if (optionText && !/confirma el precio/i.test(optionText)) {
        return { turns, verdict: { status: "FALLA", detail: "las opciones no dijeron que la tienda confirma el precio" } };
      }
      if (!/est[aá]n bien estos productos/i.test(customerText(turns.slice(-1)))) {
        turns.push(await say(phone, "sí"));
      }
      if (!/est[aá]n bien estos productos/i.test(customerText(turns.slice(-1)))) {
        return { turns, verdict: { status: "FALLA", detail: "no armó la lista para cotizar" } };
      }
      turns.push(await say(phone, "sí"));
      turns.push(await say(phone, "", PIN));
      const idMatch = blob(turns).match(/ORDEN #(\d+)/i) ?? blob(turns).match(/Pedido #(\d+)/i);
      const pedidoId = idMatch ? Number(idMatch[1]) : null;
      if (!pedidoId) return { turns, verdict: { status: "FALLA", detail: "la tienda no recibió la orden para cotizar" } };
      turns.push(await say(PHONES.pekes, `ORDEN #${pedidoId} PRECIO 48`));
      const priced = blob(turns);
      if (!/\$\s*48|\$48|total/i.test(priced)) {
        return { turns, verdict: { status: "FALLA", detail: "el cliente no recibió el precio cotizado" } };
      }
      turns.push(await say(phone, "sí"));
      const problems = await finishWithCouriers(phone, turns);
      return {
        turns,
        verdict: { status: problems.length ? "FALLA" : "PASA", detail: problems.join(". ") || "Cotizó, el cliente confirmó y se entregó." },
      };
    } finally {
      setClock(null);
    }
  }

  const written: string[] = [];
  const summary: Array<{ id: string; status: string; detail: string }> = [];
  for (const scenario of scenarios) {
    db.resetOperational();
    clearListaProductosCache();
    resetOutboundGuard();
    const { turns, verdict } = await scenario.run();
    const file = writeTranscript(scenario.id, scenario.title, turns, verdict, prices);
    written.push(file);
    summary.push({ id: scenario.id, status: verdict.status, detail: verdict.detail });
    console.log(`${verdict.status}  ${scenario.id}: ${verdict.detail}`);
    const bodies = turns.flatMap((turn) => [
      ...turn.replies.map((row) => ({ to: row.to, body: row.body })),
      ...turn.outbox.map((row) => ({ to: row.telefono, body: row.contenido })),
    ]);
    for (const row of bodies) {
      const leak = outboundLeak(row.body);
      if (leak) {
        console.error(`TEXTO INTERNO en ${scenario.id} hacia ${row.to}: ${leak}`);
        process.exitCode = 1;
      }
    }
    for (let index = 1; index < bodies.length; index += 1) {
      const prev = bodies[index - 1];
      const curr = bodies[index];
      if (prev.to && curr.to && prev.to === curr.to && prev.body.trim() && prev.body.trim() === curr.body.trim()) {
        console.error(`DUPLICADO seguido en ${scenario.id} hacia ${curr.to}`);
        process.exitCode = 1;
      }
    }
  }

  const index = renderIndex(summary, prices);
  writeBoth("sim-transcripts/indice.md", index);
  console.log(`Transcripciones: ${written.length}`);
}

function writeBoth(relative: string, contents: string): void {
  const targets = [resolve(relative), resolve("/opt/cursor/artifacts", relative.replace(/^sim-transcripts\//, "sim-transcripts/"))];
  if (!relative.startsWith("sim-transcripts/")) targets.splice(1, 1);
  for (const target of targets) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
}

function writeTranscript(id: string, title: string, turns: TurnRecord[], verdict: Verdict, prices: CatalogPriceReport): string {
  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(`Veredicto: **${verdict.status}**`);
  lines.push("");
  lines.push(verdict.detail);
  lines.push("");
  lines.push("Simulación en memoria. `ORDER_AGENT=on` solo en este proceso. El modelo es un `AgentModel` mock inyectado en `createOpenAIOrderAgentModel` (lo usa `runOrderAgentTurn`). No hubo llamada de red a OpenAI, Whapi ni Supabase.");
  lines.push("");
  lines.push(`Precios del fixture de Peke's: ${prices.pekesNullPrice} de ${prices.pekesRows} filas con precio null; ${prices.pekesWithPrice} traen precio. George ${prices.georgeRows} filas, La Central ${prices.centralRows}.`);
  lines.push("");
  lines.push("## Transcripción");
  lines.push("");
  turns.forEach((turn, index) => {
    lines.push(`### Turno ${index + 1}`);
    lines.push("");
    if (turn.location && !turn.customer.trim()) lines.push("**Cliente:** [pin GPS]");
    else lines.push(`**Cliente:** ${turn.customer || "(vacío)"}`);
    if (turn.location) lines.push(`**Ubicación:** ${turn.location.latitude}, ${turn.location.longitude}`);
    lines.push("");
    if (!turn.replies.length) lines.push("**Mándalo:** (sin WhatsApp saliente)");
    for (const reply of turn.replies) {
      const label = reply.kind === "image" ? `${reply.role} (foto)` : reply.role;
      lines.push(`**Mándalo → ${label}:**`);
      lines.push("");
      lines.push(reply.body || "(vacío)");
      lines.push("");
    }
    if (turn.outbox.length) {
      lines.push("**Outbox `admin_notificaciones`:**");
      lines.push("");
      for (const row of turn.outbox) {
        lines.push(`- ${row.destinatario} / ${row.tipo} / ${row.telefono}`);
        lines.push("");
        lines.push(row.contenido);
        lines.push("");
      }
    }
    const accion = turn.result && typeof turn.result === "object" && "accion" in turn.result ? String((turn.result as { accion?: unknown }).accion ?? "") : "";
    if (accion) lines.push(`Acción interna: \`${accion}\``);
    lines.push("");
  });
  const relative = `sim-transcripts/${id}.md`;
  writeBoth(relative, lines.join("\n"));
  const artifact = resolve("/opt/cursor/artifacts/sim-transcripts", `${id}.md`);
  mkdirSync(dirname(artifact), { recursive: true });
  writeFileSync(artifact, lines.join("\n"));
  return relative;
}

function renderIndex(summary: Array<{ id: string; status: string; detail: string }>, prices: CatalogPriceReport): string {
  const lines = [
    "# Simulador de cliente",
    "",
    `Peke's: ${prices.pekesNullPrice}/${prices.pekesRows} precios null.`,
    "",
    "| Escenario | Resultado |",
    "| --- | --- |",
    ...summary.map((row) => `| ${row.id} | ${row.status}. ${row.detail.replace(/\|/g, "/")} |`),
    "",
  ];
  return lines.join("\n");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
