/**
 * Catalog CLI — print the installed block catalog as JSON.
 *
 * Usage: bun examples/soc-demo/tools/catalog.ts [blocksDir]
 * Default blocksDir: examples/soc-demo/blocks (relative to this file).
 *
 * The composer wiring runs this at call time to load the catalog into the
 * composer prompt — the catalog is never hard-coded (design §8.4).
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCatalog } from "../lib/catalog";

const here = dirname(fileURLToPath(import.meta.url));
const blocksDir = process.argv[2] ?? join(here, "..", "blocks");

const catalog = await buildCatalog(blocksDir);
console.log(JSON.stringify(catalog, null, 2));
