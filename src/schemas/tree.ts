import { z } from "zod";

export const PulseNodeDefSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  dependsOn: z.array(z.string()).optional(),
  retries: z.number().int().min(0).max(10).optional(),
  timeout: z.number().int().min(100).optional(),
});

export const PulseTreeDefSchema = z.object({
  id: z.string().min(1),
  nodes: z.array(PulseNodeDefSchema).min(1),
});
