/**
 * Gate input providers — sources for operator verdicts on interactive gates.
 *
 * The default StdinGateProvider reads from process.stdin in a CLI-attached
 * runner. Hosts (meta-factory, journey-runner, custom UIs) can implement
 * the GateProvider interface and inject their own.
 */

import type { GateProvider, GateInput, GateVerdict } from "../types/pipeline";

/**
 * Reads the operator verdict from stdin. Wire format:
 *
 *   <prompt is printed>
 *   pass|fail               <-- single line: the verdict
 *   <free-form notes...>    <-- zero or more lines of notes
 *   EOF                     <-- terminator on its own line
 *
 * The provider rejects with a clear error if stdin closes before EOF
 * or if the abort signal fires (timeout / cancel).
 */
export class StdinGateProvider implements GateProvider {
  async requestVerdict(spec: {
    name: string;
    prompt: string;
    timeout_ms?: number;
    signal?: AbortSignal;
  }): Promise<GateInput> {
    process.stdout.write(`\n[gate ${spec.name}] ${spec.prompt}\n`);
    process.stdout.write(`Enter 'pass' or 'fail' on the first line, then notes, then 'EOF' on its own line:\n`);

    const lines = await readLinesUntilTerminator(spec.signal);
    if (lines.length === 0) {
      throw new Error(`gate ${spec.name}: no input received`);
    }

    const verdictLine = lines[0].trim().toLowerCase();
    if (verdictLine !== "pass" && verdictLine !== "fail") {
      throw new Error(
        `gate ${spec.name}: expected 'pass' or 'fail' as first line, got '${lines[0]}'`,
      );
    }
    const verdict: GateVerdict = verdictLine;
    const notes = lines.slice(1).join("\n").trim();

    return { verdict, notes };
  }
}

/**
 * Reads stdin line by line until a single line "EOF" appears (or stdin closes).
 * Cancels and rejects when the signal aborts.
 */
function readLinesUntilTerminator(signal?: AbortSignal): Promise<string[]> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }

    const lines: string[] = [];
    let buffer = "";

    const onAbort = () => {
      cleanup();
      reject(new Error("aborted"));
    };

    const onData = (chunk: Buffer | string) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      while (true) {
        const nl = buffer.indexOf("\n");
        if (nl === -1) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim() === "EOF") {
          cleanup();
          resolve(lines);
          return;
        }
        lines.push(line);
      }
    };

    const onEnd = () => {
      // Treat any remaining buffered text as a final unterminated line, then resolve.
      if (buffer.length > 0) {
        const tail = buffer;
        buffer = "";
        if (tail.trim() !== "EOF") lines.push(tail);
      }
      cleanup();
      resolve(lines);
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    function cleanup() {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    }

    signal?.addEventListener("abort", onAbort, { once: true });
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.once("error", onError);
  });
}
