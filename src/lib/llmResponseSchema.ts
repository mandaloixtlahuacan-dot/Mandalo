import { z } from "zod";

export const mandaloAgentResponseSchema = z.object({
  customer_reply: z.string().min(1),
  order_state: z
    .object({
      stage: z
        .enum([
          "lead",
          "collecting",
          "ready_to_quote",
          "awaiting_quote_confirm",
          "awaiting_confirmation",
          "awaiting_quote",
          "cotizando",
          "awaiting_confirm",
          "confirmado",
          "cancelado",
          "delivering",
        ])
        .default("collecting"),
      customer_name: z.string().optional().nullable(),
      category: z.string().optional().nullable(),
      items: z
        .array(
          z.object({
            name: z.string(),
            qty: z.string().optional().nullable(),
            details: z.string().optional().nullable(),
          }),
        )
        .default([]),
      address_text: z.string().optional().nullable(),
      total: z.number().optional().nullable(),
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
