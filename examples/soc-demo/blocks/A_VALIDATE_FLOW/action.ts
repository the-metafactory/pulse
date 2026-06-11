/**
 * A_VALIDATE_FLOW — block wrapper around the pure validateFlow core.
 *
 * Sits between compose and execute (design §5). D-class, no capabilities,
 * no network, no block execution. The composer retry loop reads
 * `validation.findings`; the execution wiring refuses to run any flow where
 * `validation.valid` is false.
 */

import type { ActionContext } from "../../../../src/types/action";
import { validateFlow, type CatalogEntry } from "../../lib/validate-flow";

export default {
  async execute(input: Record<string, unknown>, _ctx: ActionContext) {
    const { flow_yaml, catalog, initial_fields, ...payload } = input;

    if (typeof flow_yaml !== "string") {
      throw new Error("A_VALIDATE_FLOW: flow_yaml must be a string");
    }
    if (!Array.isArray(catalog)) {
      throw new Error("A_VALIDATE_FLOW: catalog must be an array of catalog entries");
    }

    const validation = validateFlow(flow_yaml, catalog as CatalogEntry[], {
      initialFields: Array.isArray(initial_fields) ? (initial_fields as string[]) : undefined,
    });

    return { ...payload, validation };
  },
};
