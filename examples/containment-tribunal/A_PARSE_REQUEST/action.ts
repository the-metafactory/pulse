/**
 * A_PARSE_REQUEST — deterministic intake for a containment request.
 *
 * Validates required fields and derives blast_radius from the scope:
 * resolver blocks are reversible (low), host isolation touches a running
 * machine (high). Downstream seats and the audit record consume the
 * normalized fields; malformed requests fail here, before any agent cost.
 */

import type { ActionContext } from "../../../src/types/action";

interface ContainmentRequest {
  request_id?: string;
  action?: string;
  targets?: string[];
  scope?: string;
  requested_by?: string;
  source_advisory?: string;
  justification?: string;
  sanitized_summary?: string;
  confidential_telemetry?: string;
  ttl_hours?: number;
}

const KNOWN_ACTIONS = new Set(["block-domain", "isolate-host"]);

export default {
  async execute(input: Record<string, unknown>, _ctx: ActionContext) {
    const { request, ...payload } = input;
    const req = (request ?? {}) as ContainmentRequest;

    if (!req.action || !KNOWN_ACTIONS.has(req.action)) {
      throw new Error(`A_PARSE_REQUEST: unknown containment action '${req.action}'`);
    }
    if (!Array.isArray(req.targets) || req.targets.length === 0) {
      throw new Error("A_PARSE_REQUEST: 'targets' must be a non-empty array");
    }
    if (!req.requested_by) {
      throw new Error("A_PARSE_REQUEST: 'requested_by' is required — anonymous containment is not auditable");
    }

    const blast_radius = req.action === "isolate-host" || req.scope === "network" ? "high" : "low";

    return {
      ...payload,
      request_id: req.request_id ?? crypto.randomUUID(),
      action: req.action,
      targets: req.targets,
      targets_list: req.targets.join(", "),
      scope: req.scope ?? "resolver",
      blast_radius,
      requested_by: req.requested_by,
      source_advisory: req.source_advisory ?? "(none)",
      justification: req.justification ?? "(none)",
      sanitized_summary: req.sanitized_summary ?? "(none)",
      confidential_telemetry: req.confidential_telemetry ?? "(none)",
      ttl_hours: req.ttl_hours ?? 24,
    };
  },
};
