import { normalizeWhatsAppText, waapiSendTextRequest } from "@/lib/waapi";

export type ProviderSendParams = {
  to: string;
  body: string;
};

export type ProviderSendResult = {
  ok: boolean;
  retryable: boolean;
  status: number | null;
  providerMessageId: string | null;
  providerStatus: string | null;
  raw: unknown;
  errorMessage: string | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return null;
}

function extractProviderMessageId(raw: unknown): string | null {
  const root = asRecord(raw);
  const data = asRecord(root.data);
  return firstString(
    root.messageId,
    root.message_id,
    root.id,
    data.messageId,
    data.message_id,
    data.id,
  );
}

function extractProviderStatus(raw: unknown): string | null {
  const root = asRecord(raw);
  const data = asRecord(root.data);
  return firstString(
    root.status,
    root.message_status,
    data.status,
    data.message_status,
  );
}

function isRetryableStatus(status: number | null): boolean {
  if (status == null) return true;
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function createProviderGateway() {
  return {
    async sendText(params: ProviderSendParams): Promise<ProviderSendResult> {
      const body = normalizeWhatsAppText(params.body);

      try {
        const result = await waapiSendTextRequest({
          to: params.to,
          body,
        });

        return {
          ok: result.ok,
          retryable: !result.ok && isRetryableStatus(result.status),
          status: result.status,
          providerMessageId: extractProviderMessageId(result.data),
          providerStatus: extractProviderStatus(result.data) ?? (result.ok ? "accepted" : "rejected"),
          raw: result.data ?? result.rawText ?? null,
          errorMessage: result.ok ? null : `Waapi error ${result.status}: ${String(result.rawText ?? "")}`,
        };
      } catch (error: unknown) {
        return {
          ok: false,
          retryable: true,
          status: null,
          providerMessageId: null,
          providerStatus: "transport_error",
          raw: null,
          errorMessage: toErrorMessage(error),
        };
      }
    },
  };
}

