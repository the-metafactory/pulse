/**
 * renderMermaid — Mermaid source → PNG via `bunx @mermaid-js/mermaid-cli`.
 *
 * Shell-out keeps pulse at zero new runtime dependencies; mermaid-cli is
 * fetched by bunx on first use. ANY failure (bunx missing, render error,
 * timeout) returns null — the caller posts the fenced Mermaid source instead.
 * Rendering must never break the demo (design/soc-demo-mm-composer.md §8.5).
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface RenderOptions {
  /** Command prefix override (tests). Default: ["bunx", "--yes", "@mermaid-js/mermaid-cli"]. */
  cmd?: string[];
  /** Kill the renderer after this many ms. Default 30s. */
  timeoutMs?: number;
}

/** Returns the rendered PNG bytes, or null on any failure (fallback-to-source). */
export async function renderMermaid(
  source: string,
  options: RenderOptions = {},
): Promise<Uint8Array | null> {
  // Pinned major — an unpinned bunx fetch could swap renderer behavior
  // between rehearsal and stage.
  const cmd = options.cmd ?? ["bunx", "--yes", "@mermaid-js/mermaid-cli@11"];
  const timeoutMs = options.timeoutMs ?? 30_000;

  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "pulse-mermaid-"));
    const input = join(dir, "diagram.mmd");
    const output = join(dir, "diagram.png");
    await writeFile(input, source, "utf-8");

    const proc = Bun.spawn([...cmd, "-i", input, "-o", output, "--scale", "2"], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const code = await proc.exited;
    clearTimeout(timer);

    if (code !== 0) {
      const stderr = await new Response(proc.stderr).text();
      console.error(`[renderMermaid] mermaid-cli exited ${code}: ${stderr.slice(0, 300)}`);
      return null;
    }
    return new Uint8Array(await readFile(output));
  } catch (err) {
    console.error(`[renderMermaid] render failed, falling back to source: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    if (dir) {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch (cleanupErr) {
        // Never let temp-dir cleanup mask the render result.
        console.error(`[renderMermaid] temp cleanup failed: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
      }
    }
  }
}
