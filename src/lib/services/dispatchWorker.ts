import type { ProviderSendResult } from "@/lib/services/providerGateway";

export type OutboxMessageType =
  | "cotizacion_tienda"
  | "dispatch_repartidor"
  | "alerta_admin";

export type OutboxStatus =
  | "pendiente"
  | "procesando"
  | "enviado"
  | "reintentando"
  | "fallido"
  | "muerto";

export type EnqueueOutboundMessageInput = {
  pedidoId: number;
  tipoMensaje: OutboxMessageType;
  destinatarioTipo: "negocio" | "repartidor" | "admin";
  destinatarioId?: number | null;
  telefonoDestino: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
};

export type ReservedOutboxMessage = {
  id: number;
  pedidoId: number | null;
  tipoMensaje: OutboxMessageType;
  destinatarioTipo: "negocio" | "repartidor" | "admin";
  destinatarioId: number | null;
  telefonoDestino: string;
  payload: Record<string, unknown>;
  attemptCount: number;
  idempotencyKey: string | null;
};

export type OutboxRepositoryDeps = {
  reservePendingMessages(params: {
    limit: number;
    workerId: string;
    nowIso: string;
  }): Promise<ReservedOutboxMessage[]>;
  markMessageSent(params: {
    messageId: number;
    providerMessageId?: string | null;
    providerStatus?: string | null;
    providerResponse?: Record<string, unknown> | null;
    sentAtIso: string;
  }): Promise<void>;
  markMessageRetry(params: {
    messageId: number;
    attemptCount: number;
    nextAttemptAtIso: string;
    providerStatus?: string | null;
    providerResponse?: Record<string, unknown> | null;
    errorMessage?: string | null;
  }): Promise<void>;
  markMessageDead(params: {
    messageId: number;
    attemptCount: number;
    providerStatus?: string | null;
    providerResponse?: Record<string, unknown> | null;
    errorMessage?: string | null;
  }): Promise<void>;
};

export type ProviderGatewayDeps = {
  sendText(params: { to: string; body: string }): Promise<ProviderSendResult>;
};

export type TransitionServiceDeps = {
  handleDispatchAck(params: {
    pedidoId: number;
    messageType: OutboxMessageType;
    messageId: number;
    providerMessageId?: string | null;
    providerStatus?: string | null;
    payload?: Record<string, unknown>;
  }): Promise<void>;
  handleDispatchFailure(params: {
    pedidoId: number;
    messageType: OutboxMessageType;
    messageId: number;
    finalFailure: boolean;
    errorMessage?: string | null;
    payload?: Record<string, unknown>;
  }): Promise<void>;
};

export type DispatchWorkerDeps = {
  outboxRepository: OutboxRepositoryDeps;
  providerGateway: ProviderGatewayDeps;
  transitionService?: TransitionServiceDeps;
  now?: () => Date;
  logger?: Pick<Console, "log" | "warn" | "error">;
};

export type DispatchWorkerRunResult = {
  reserved: number;
  sent: number;
  retried: number;
  dead: number;
  failures: Array<{
    messageId: number;
    pedidoId: number | null;
    retryable: boolean;
    errorMessage: string | null;
  }>;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function computeRetryDelayMs(nextAttempt: number): number {
  switch (nextAttempt) {
    case 1:
      return 0;
    case 2:
      return 30_000;
    case 3:
      return 2 * 60_000;
    case 4:
      return 5 * 60_000;
    default:
      return 15 * 60_000;
  }
}

function buildOutboundText(message: ReservedOutboxMessage): string {
  const body = String(message.payload.body ?? "").trim();
  if (!body) {
    throw new Error(`Outbox message ${message.id} no tiene payload.body`);
  }
  return body;
}

function isTerminalFailure(nextAttempt: number, retryable: boolean): boolean {
  if (!retryable) return true;
  return nextAttempt > 5;
}

export function createDispatchWorker(deps: DispatchWorkerDeps) {
  const logger = deps.logger ?? console;
  const now = deps.now ?? (() => new Date());

  return {
    async run(params?: { limit?: number; workerId?: string }): Promise<DispatchWorkerRunResult> {
      const limit = params?.limit ?? 20;
      const workerId = params?.workerId ?? `dispatch-worker-${process.pid}`;
      const nowIso = now().toISOString();

      const reserved = await deps.outboxRepository.reservePendingMessages({
        limit,
        workerId,
        nowIso,
      });

      const result: DispatchWorkerRunResult = {
        reserved: reserved.length,
        sent: 0,
        retried: 0,
        dead: 0,
        failures: [],
      };

      for (const message of reserved) {
        try {
          const body = buildOutboundText(message);

          logger.log("[dispatchWorker] sending", {
            messageId: message.id,
            pedidoId: message.pedidoId,
            tipoMensaje: message.tipoMensaje,
            destinatarioTipo: message.destinatarioTipo,
            telefonoDestino: message.telefonoDestino,
            attemptCount: message.attemptCount,
          });

          const providerResult = await deps.providerGateway.sendText({
            to: message.telefonoDestino,
            body,
          });

          if (providerResult.ok) {
            await deps.outboxRepository.markMessageSent({
              messageId: message.id,
              providerMessageId: providerResult.providerMessageId,
              providerStatus: providerResult.providerStatus,
              providerResponse: asRecord(providerResult.raw),
              sentAtIso: now().toISOString(),
            });

            if (message.pedidoId != null && deps.transitionService) {
              await deps.transitionService.handleDispatchAck({
                pedidoId: message.pedidoId,
                messageType: message.tipoMensaje,
                messageId: message.id,
                providerMessageId: providerResult.providerMessageId,
                providerStatus: providerResult.providerStatus,
                payload: message.payload,
              });
            }

            result.sent += 1;
            continue;
          }

          const nextAttempt = message.attemptCount + 1;
          const terminal = isTerminalFailure(nextAttempt, providerResult.retryable);

          if (terminal) {
            await deps.outboxRepository.markMessageDead({
              messageId: message.id,
              attemptCount: nextAttempt,
              providerStatus: providerResult.providerStatus,
              providerResponse: asRecord(providerResult.raw),
              errorMessage: providerResult.errorMessage,
            });

            if (message.pedidoId != null && deps.transitionService) {
              await deps.transitionService.handleDispatchFailure({
                pedidoId: message.pedidoId,
                messageType: message.tipoMensaje,
                messageId: message.id,
                finalFailure: true,
                errorMessage: providerResult.errorMessage,
                payload: message.payload,
              });
            }

            result.dead += 1;
          } else {
            const nextAttemptAtIso = new Date(now().getTime() + computeRetryDelayMs(nextAttempt)).toISOString();
            await deps.outboxRepository.markMessageRetry({
              messageId: message.id,
              attemptCount: nextAttempt,
              nextAttemptAtIso,
              providerStatus: providerResult.providerStatus,
              providerResponse: asRecord(providerResult.raw),
              errorMessage: providerResult.errorMessage,
            });

            if (message.pedidoId != null && deps.transitionService) {
              await deps.transitionService.handleDispatchFailure({
                pedidoId: message.pedidoId,
                messageType: message.tipoMensaje,
                messageId: message.id,
                finalFailure: false,
                errorMessage: providerResult.errorMessage,
                payload: message.payload,
              });
            }

            result.retried += 1;
          }

          result.failures.push({
            messageId: message.id,
            pedidoId: message.pedidoId,
            retryable: providerResult.retryable,
            errorMessage: providerResult.errorMessage,
          });
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          const nextAttempt = message.attemptCount + 1;
          const terminal = nextAttempt > 5;

          logger.error("[dispatchWorker] unexpected failure", {
            messageId: message.id,
            pedidoId: message.pedidoId,
            errorMessage,
          });

          if (terminal) {
            await deps.outboxRepository.markMessageDead({
              messageId: message.id,
              attemptCount: nextAttempt,
              providerStatus: "worker_error",
              providerResponse: null,
              errorMessage,
            });

            if (message.pedidoId != null && deps.transitionService) {
              await deps.transitionService.handleDispatchFailure({
                pedidoId: message.pedidoId,
                messageType: message.tipoMensaje,
                messageId: message.id,
                finalFailure: true,
                errorMessage,
                payload: message.payload,
              });
            }

            result.dead += 1;
          } else {
            const nextAttemptAtIso = new Date(now().getTime() + computeRetryDelayMs(nextAttempt)).toISOString();
            await deps.outboxRepository.markMessageRetry({
              messageId: message.id,
              attemptCount: nextAttempt,
              nextAttemptAtIso,
              providerStatus: "worker_error",
              providerResponse: null,
              errorMessage,
            });

            if (message.pedidoId != null && deps.transitionService) {
              await deps.transitionService.handleDispatchFailure({
                pedidoId: message.pedidoId,
                messageType: message.tipoMensaje,
                messageId: message.id,
                finalFailure: false,
                errorMessage,
                payload: message.payload,
              });
            }

            result.retried += 1;
          }

          result.failures.push({
            messageId: message.id,
            pedidoId: message.pedidoId,
            retryable: !terminal,
            errorMessage,
          });
        }
      }

      return result;
    },
  };
}
