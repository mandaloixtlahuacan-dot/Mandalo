/**
 * Simulador de cliente. Entra por processMandaloWebhook.
 * Supabase y Whapi quedan en memoria. El agente usa AgentModel mock.
 * No manda WhatsApp real, no toca Supabase real y no llama a OpenAI.
 *
 * Correr: npm run simulate:customer
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

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

  const { processMandaloWebhook } = await import("../src/lib/mandaloFlow");
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
        const lines = reply.split("\n").filter((line) => /^\d+\./.test(line.trim()));
        const hasCoca = /coca/i.test(reply);
        const hasPrice = /\$\s*\d/.test(reply);
        const chooses = lines.length >= 2 || /cu[aá]l/i.test(reply);
        const closed = /est[aá]n bien estos productos/i.test(reply);
        const problems: string[] = [];
        if (!hasCoca) problems.push("la respuesta no muestra Coca");
        if (!chooses || closed) problems.push("no deja elegir: o no hay opciones, o ya cerró la lista");
        if (!hasPrice) problems.push(`no muestra precio. En el fixture, ${prices.pekesNullPrice} de ${prices.pekesRows} filas de Peke's traen precio null (${prices.pekesWithPrice} con precio)`);
        return {
          turns,
          verdict: {
            status: problems.length ? "FALLA" : "PASA",
            detail: problems.length ? problems.join(". ") : "Muestra Cocas reales, con precio, y deja elegir.",
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
        const lines = reply.split("\n").filter((line) => /^\d+\./.test(line.trim()));
        const asks = lines.length >= 2 || /cu[aá]l/i.test(reply);
        const mentions = [/62/, /duo/i, /caja/i].filter((pattern) => pattern.test(reply)).length;
        const closed = /est[aá]n bien estos productos/i.test(reply);
        const ok = asks && mentions >= 2 && !closed;
        return {
          turns,
          verdict: {
            status: ok ? "PASA" : "FALLA",
            detail: ok ? "Preguntó presentación (pieza, Duo o caja) y no cerró solo." : "Un Nito sin presentación debería preguntar 62 g, Duo o caja, sin anotar uno solo.",
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
  ];

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
