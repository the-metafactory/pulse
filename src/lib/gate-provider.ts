/**
 * Gate input providers — sources for operator verdicts on interactive gates.
 *
 * The default StdinGateProvider reads from process.stdin in a CLI-attached
 * runner. Hosts (meta-factory, journey-runner, custom UIs) can implement
 * the GateProvider interface and inject their own.
 */

import { createInterface, type Interface as ReadlineInterface } from "readline";
import type { Readable } from "stream";
import type { GateProvider, GateInput, GateVerdict } from "../types/pipeline";

/**
 * Reads the operator verdict from stdin (or any Readable). Wire format:
 *
 *   <prompt is printed>
 *   pass|fail               <-- single line: the verdict
 *   <free-form notes...>    <-- zero or more lines of notes
 *   .                       <-- terminator on its own line
 *
 * Notes containing a literal "." on its own line will be truncated; document
 * this constraint to operators or pick a custom provider for richer input.
 *
 * The provider serializes invocations through a single readline interface and
 * an internal line queue so that multiple sequential gates in one process
 * don't race on `process.stdin`'s data events. Concurrent gates are not
 * supported via stdin (an operator can only answer one prompt at a time);
 * the second concurrent `requestVerdict` call queues behind the first.
 */
export class StdinGateProvider implements GateProvider {
  private readonly input: Readable;
  private readonly output: NodeJS.WritableStream;
  private rl: ReadlineInterface | null = null;
  private readonly buffered: string[] = [];
  private waiter: ((line: string | null) => void) | null = null;
  private closed = false;
  private inFlight: Promise<unknown> = Promise.resolve();

  constructor(opts?: { input?: Readable; output?: NodeJS.WritableStream }) {
    this.input = opts?.input ?? process.stdin;
    this.output = opts?.output ?? process.stdout;
  }

  async requestVerdict(spec: {
    name: string;
    prompt: string;
    signal?: AbortSignal;
  }): Promise<GateInput> {
    // Serialize sequential calls so we never race on the readline interface.
    const myTurn = this.inFlight.then(() => this.runOne(spec));
    this.inFlight = myTurn.catch(() => undefined);
    return myTurn;
  }

  private async runOne(spec: {
    name: string;
    prompt: string;
    signal?: AbortSignal;
  }): Promise<GateInput> {
    if (spec.signal?.aborted) throw new Error("aborted");

    this.output.write(`\n[gate ${spec.name}] ${spec.prompt}\n`);
    this.output.write(
      `Enter 'pass' or 'fail' on the first line, then notes, then '.' on its own line:\n`,
    );

    this.ensureReadline();

    const collected: string[] = [];
    while (true) {
      if (spec.signal?.aborted) throw new Error("aborted");
      const line = await this.nextLine(spec.signal);
      if (line === null) break; // stream closed
      if (line.trim() === ".") break;
      collected.push(line);
    }

    if (collected.length === 0) {
      throw new Error(`gate ${spec.name}: no input received`);
    }

    const verdictLine = collected[0].trim().toLowerCase();
    if (verdictLine !== "pass" && verdictLine !== "fail") {
      throw new Error(
        `gate ${spec.name}: expected 'pass' or 'fail' as first line, got '${collected[0]}'`,
      );
    }
    const verdict: GateVerdict = verdictLine;
    const notes = collected.slice(1).join("\n").trim();
    return { verdict, notes };
  }

  private ensureReadline(): void {
    if (this.rl) return;
    this.rl = createInterface({ input: this.input, output: this.output, terminal: false });
    this.rl.on("line", (line) => {
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w(line);
      } else {
        this.buffered.push(line);
      }
    });
    this.rl.once("close", () => {
      this.closed = true;
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w(null);
      }
    });
  }

  private nextLine(signal?: AbortSignal): Promise<string | null> {
    if (this.buffered.length > 0) return Promise.resolve(this.buffered.shift()!);
    if (this.closed) return Promise.resolve(null);

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.waiter = null;
        signal?.removeEventListener("abort", onAbort);
        reject(new Error("aborted"));
      };
      this.waiter = (line) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(line);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Close the underlying readline interface. Used by tests. */
  close() {
    this.rl?.close();
    this.rl = null;
  }
}
