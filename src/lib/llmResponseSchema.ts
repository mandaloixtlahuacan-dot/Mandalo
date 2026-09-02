import { z } from "zod";

export const mandaloAgentResponseSchema = z.object({
  customer_reply: z.string().optional().nullable().default("¡Entendido! Dame un momento."),
  order_state: z
    .object({
      stage: z.string().default("collecting"),
      customer_name: z.string().optional().nullable(),
      category: z.string().optional().nullable(),
      // "name"/"qty"/"details" son nombres viejos que ya nadie usa en el
      // resto del sistema — el prompt (mandaloPrompt.ts) y el consumidor real
      // (captureEngine.extractCandidateItems) hablan en términos de
      // nombre_producto/marca/presentacion/cantidad/unidad/notas. Antes
      // "name" era obligatorio aquí, así que CADA vez que la IA mandaba
      // nombre_producto (lo que se le pide) en vez de name, la validación
      // completa fallaba y se descartaba TODO el order_state (business_id,
      // dirección, items) — bug confirmado en producción agosto 2026, un
      // cliente quedó en bucle infinito pidiendo "el negocio" para siempre
      // en cuanto la IA repetía productos. Ahora nada es obligatorio y
      // .passthrough() deja pasar cualquier campo — extractCandidateItems ya
      // filtra de forma segura un item sin nombre usable, no hace falta que
      // Zod sea el gatekeeper aquí.
      items: z
        .array(
          z
            .object({
              name: z.string().optional(),
              nombre: z.string().optional(),
              nombre_producto: z.string().optional(),
              qty: z.union([z.string(), z.number()]).optional().nullable(),
              cantidad: z.union([z.string(), z.number()]).optional().nullable(),
              details: z.string().optional().nullable(),
              marca: z.string().optional().nullable(),
              presentacion: z.string().optional().nullable(),
              unidad: z.string().optional().nullable(),
              notas: z.string().optional().nullable(),
            })
            .passthrough(),
        )
        .default([]),
      address_text: z.string().optional().nullable(),
      total: z.union([z.number(), z.string()]).optional().nullable(),
    })
    .passthrough()
    .default({ stage: "collecting", items: [] }),
  dispatch: z
    .object({
      to_business_phone: z.string().optional().nullable(),
      business_message: z.string().optional().nullable(),
      to_courier_phone: z.string().optional().nullable(),
      courier_message: z.string().optional().nullable(),
    })
    .optional()
    .nullable(),
});

export type MandaloAgentResponse = z.infer<typeof mandaloAgentResponseSchema>;
