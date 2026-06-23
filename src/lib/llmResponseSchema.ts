import { z } from "zod";

export const mandaloAgentResponseSchema = z.object({
  customer_reply: z.string().optional().nullable().default("¡Entendido! Dame un momento."),
  order_state: z
    .object({
      stage: z.string().default("collecting"),
      customer_name: z.string().optional().nullable(),
      category: z.string().optional().nullable(),
      items: z
        .array(
          z.object({
            name: z.string(),
            qty: z.union([z.string(), z.number()]).optional().nullable(),
            details: z.string().optional().nullable(),
          }),
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
