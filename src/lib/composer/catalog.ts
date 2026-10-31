import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { CatalogEntry } from "./validate-pipeline";
const fieldSchema = z.object({ type: z.string(), required: z.boolean().optional() }).passthrough();
const catalogEntrySchema = z.object({
  name: z.string().min(1), description: z.string().min(1),
  input: z.record(fieldSchema).default({}), output: z.record(fieldSchema).default({}),
  requires: z.array(z.string()).optional(), tags: z.array(z.string()).optional(),
});
export async function buildCatalog(blocksDir: string): Promise<CatalogEntry[]> {
    const entries = await readdir(blocksDir, { withFileTypes: true });
    const reads = entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry): Promise<CatalogEntry | null> => {
        const manifestPath = join(blocksDir, entry.name, "action.json");
        let raw: string;
        try {
            raw = await readFile(manifestPath, "utf-8");
        }
        catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
            throw error;
        }
        const parsed = catalogEntrySchema.safeParse(JSON.parse(raw));
        if (!parsed.success) throw new Error(`${manifestPath}: action.json must declare string name and description and valid input/output fields: ${parsed.error.message}`);
        return parsed.data;
    });
    const catalog = (await Promise.all(reads)).filter((e): e is CatalogEntry => e !== null);
    return catalog.sort((a, b) => a.name.localeCompare(b.name));
}
export async function loadInstalledCatalog(): Promise<CatalogEntry[]> {
    const proc = Bun.spawn(["arc", "list", "--json"], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`Arc catalog discovery failed (${code}): ${stderr.slice(0, 200)}`);
    const inventory = z.object({ packages: z.array(z.object({ name: z.string(), type: z.string(), status: z.string(), installPath: z.string() })) }).parse(JSON.parse(stdout));
    const actions = inventory.packages.filter((entry) => entry.type === "action" && entry.status === "active");
    const entries = await Promise.all(actions.map(async (action) => {
      const entry = catalogEntrySchema.parse(JSON.parse(await readFile(join(action.installPath, "action.json"), "utf-8")));
      if (entry.name !== action.name) throw new Error(`Installed action name mismatch: ${action.name}`);
      return entry;
    }));
    const byName = new Map<string, CatalogEntry>();
    for (const entry of entries) {
        const previous = byName.get(entry.name);
        if (previous && JSON.stringify(previous) !== JSON.stringify(entry))
            throw new Error(`Ambiguous installed action: ${entry.name}`);
        byName.set(entry.name, entry);
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
