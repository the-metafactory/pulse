/**
 * buildCatalog — scan a blocks directory for action.json manifests and return
 * the catalog the composer prompt and the validator both consume.
 *
 * The catalog is the source of truth (design §3.1): the composer is given
 * exactly this list at call time and must not invent block names; the
 * validator re-checks against the same list.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CatalogEntry } from "./validate-flow";

export async function buildCatalog(blocksDir: string): Promise<CatalogEntry[]> {
  const entries = await readdir(blocksDir, { withFileTypes: true });
  const catalog: CatalogEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(blocksDir, entry.name, "action.json");
    let raw: string;
    try {
      raw = await readFile(manifestPath, "utf-8");
    } catch (_err) {
      // Directory without a manifest (fixtures/, lib/) — not a block, skip.
      continue;
    }
    const manifest = JSON.parse(raw) as CatalogEntry & Record<string, unknown>;
    if (!manifest.name || !manifest.description) {
      throw new Error(`${manifestPath}: action.json must declare name and description`);
    }
    catalog.push({
      name: manifest.name,
      description: manifest.description,
      input: manifest.input ?? {},
      output: manifest.output ?? {},
      requires: manifest.requires,
      tags: manifest.tags,
    });
  }

  return catalog.sort((a, b) => a.name.localeCompare(b.name));
}
