/**
 * buildCatalog — scan a blocks directory for action.json manifests and return
 * the catalog the composer prompt and the validator both consume.
 *
 * The catalog is the source of truth (design §3.1): the composer is given
 * exactly this list at call time and must not invent block names; the
 * validator re-checks against the same list. The blocks directory is the
 * trust root — callers must point this at the installed palette, never at
 * composer- or user-supplied data.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CatalogEntry } from "./validate-pipeline";

export async function buildCatalog(blocksDir: string): Promise<CatalogEntry[]> {
  const entries = await readdir(blocksDir, { withFileTypes: true });

  const reads = entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry): Promise<CatalogEntry | null> => {
      const manifestPath = join(blocksDir, entry.name, "action.json");
      let raw: string;
      try {
        raw = await readFile(manifestPath, "utf-8");
      } catch (_err) {
        // Directory without a manifest (fixtures/, lib/) — not a block, skip.
        return null;
      }
      const manifest = JSON.parse(raw) as Record<string, unknown>;
      if (typeof manifest.name !== "string" || manifest.name.length === 0 ||
          typeof manifest.description !== "string" || manifest.description.length === 0) {
        throw new Error(`${manifestPath}: action.json must declare string name and description`);
      }
      return {
        name: manifest.name,
        description: manifest.description,
        input: (manifest.input ?? {}) as CatalogEntry["input"],
        output: (manifest.output ?? {}) as CatalogEntry["output"],
        requires: manifest.requires as string[] | undefined,
        tags: manifest.tags as string[] | undefined,
      };
    });

  const catalog = (await Promise.all(reads)).filter((e): e is CatalogEntry => e !== null);
  return catalog.sort((a, b) => a.name.localeCompare(b.name));
}
