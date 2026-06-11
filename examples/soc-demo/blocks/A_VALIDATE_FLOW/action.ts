/**
 * A_VALIDATE_FLOW — block wrapper around the pure validatePipeline core.
 *
 * Sits between compose and execute (design §5). D-class, no capabilities,
 * no network, no block execution. The composer retry loop reads
 * `validation.findings`; the execution wiring (P-805) must refuse to run any
 * flow where `validation.valid` is false.
 *
 * Trust root: the catalog is loaded from the installed blocks directory —
 * by default this block's own parent directory — NEVER from pipeline input.
 * A caller-supplied catalog would let composer/user data vouch for invented
 * block names and bypass the unknown-block gate entirely. `blocks_dir` is an
 * operator-configured override for non-standard installs, still a filesystem
 * path the operator controls, not data flowing from the composer.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ActionContext } from "../../../../src/types/action";
import { validatePipeline } from "../../lib/validate-pipeline";
import { buildCatalog } from "../../lib/catalog";

const INSTALLED_BLOCKS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

export default {
  async execute(input: Record<string, unknown>, _ctx: ActionContext) {
    const { flow_yaml, blocks_dir, ...payload } = input;

    if (typeof flow_yaml !== "string") {
      throw new Error("A_VALIDATE_FLOW: flow_yaml must be a string");
    }

    const catalogDir = typeof blocks_dir === "string" ? blocks_dir : INSTALLED_BLOCKS_DIR;
    const catalog = await buildCatalog(catalogDir);

    const initialFields = Array.isArray(input.initial_fields)
      ? (input.initial_fields as string[])
      : undefined;
    delete (payload as Record<string, unknown>).initial_fields;

    const validation = validatePipeline(flow_yaml, catalog, { initialFields });

    return { ...payload, validation };
  },
};
