import { z } from "zod";

export const RetryParametersSchema = z.object({
  attempts: z.number().int().min(1),
  backoff: z.enum(["constant", "linear", "exponential"]).optional(),
  initial_delay_ms: z.number().int().min(0).optional(),
  max_delay_ms: z.number().int().min(0).optional(),
});

export const RETRY_EDITABLE_FIELDS = [
  { name: "attempts", type: "number", minimum: RetryParametersSchema.shape.attempts.minValue ?? undefined },
  { name: "backoff", type: "string", enum: RetryParametersSchema.shape.backoff.unwrap().options },
  { name: "initial_delay_ms", type: "number", minimum: RetryParametersSchema.shape.initial_delay_ms.unwrap().minValue ?? undefined },
  { name: "max_delay_ms", type: "number", minimum: RetryParametersSchema.shape.max_delay_ms.unwrap().minValue ?? undefined },
] as const;
