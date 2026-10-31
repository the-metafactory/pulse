import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
export interface RenderOptions {
    cmd?: string[];
    timeoutMs?: number;
}
export async function renderMermaid(source: string, options: RenderOptions = {}): Promise<Uint8Array | null> {
    const cmd = options.cmd ?? ["bunx", "--yes", "@mermaid-js/mermaid-cli@11"];
    const timeoutMs = options.timeoutMs ?? 30000;
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
    }
    catch (err) {
        console.error(`[renderMermaid] render failed, falling back to source: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
    finally {
        if (dir) {
            try {
                await rm(dir, { recursive: true, force: true });
            }
            catch (cleanupErr) {
                console.error(`[renderMermaid] temp cleanup failed: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
            }
        }
    }
}
