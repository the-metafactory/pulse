#!/usr/bin/env bun
/**
 * SOC Containment Tribunal — realistic L1 governance demo.
 *
 * The next chapter after examples/soc-triage: the advisory recommended
 * "block both domains" — now someone has to decide. The L0 enforcement gate
 * rules the request a judgment call (`ask`), and a model-diverse tribunal of
 * fleet agents adjudicates it over the bus.
 *
 *   bun examples/containment-tribunal/run-demo.ts              # ALLOW: diverse confident majority
 *   bun examples/containment-tribunal/run-demo.ts --split      # DENY: panel splits, Honest Oracle tiebreaks
 *   bun examples/containment-tribunal/run-demo.ts --degraded   # DENY: fleet majority offline, fail-closed
 *   bun examples/containment-tribunal/run-demo.ts --protected  # DENY at L0: tribunal never convenes
 *   bun examples/containment-tribunal/run-demo.ts --llm        # real models (Ollama local, claude frontier)
 *   bun examples/containment-tribunal/run-demo.ts --live       # real NATS bus (localhost:4222)
 *   bun examples/containment-tribunal/run-demo.ts --live --no-fleet  # real cortex fleet claims the seats
 *
 * Watch the envelopes live on a real bus:
 *   nats sub 'local.switch-soc.>'
 *
 * Stage 4 (P-702) will move L0 inside the pipeline and route the tribunal's
 * `defer` to a human gate; here L0 runs as a prelude and defer halts
 * fail-closed — honest about what is composed today.
 */

import { join } from "path";
import { evaluate } from "../../src/lib/enforcement-gate";
import { loadPipeline, runPipeline } from "../../src/lib/pipeline";
import {
  MyelinAgentProvider,
  InMemoryAgentTransport,
  NatsAgentTransport,
  type AgentTransport,
} from "../../src/lib/agent-provider";
import type { Policy } from "../../src/types/policy";
import type { TribunalStepSpec } from "../../src/types/tribunal";
import { startFleetSim, type FleetScenario } from "./fleet-sim";

const PRINCIPAL = "switch-soc";
const STACK = "default";

const args = new Set(process.argv.slice(2));
const live = args.has("--live");
const useLLM = args.has("--llm");
const noFleet = args.has("--no-fleet");
const scenario: FleetScenario = args.has("--split") ? "split" : args.has("--degraded") ? "degraded" : "allow";

const banner = (s: string) => console.log(`\n━━━ ${s} ${"━".repeat(Math.max(0, 60 - s.length))}`);

async function main() {
  banner("SOC Containment Tribunal — governed action, live");
  console.log(
    `mode: ${live ? "LIVE NATS bus" : "in-memory bus"} | fleet: ${noFleet ? "external (cortex)" : `simulated (scenario: ${scenario})`} | models: ${useLLM ? "real (ollama + frontier)" : "canned"}`,
  );

  // 0. The containment request — produced by the soc-triage advisory.
  const request = JSON.parse(
    await Bun.file(join(import.meta.dir, "fixtures/containment-request.json")).text(),
  ) as Record<string, unknown>;
  if (args.has("--protected")) {
    // Someone (or something) asks to block a protected zone.
    request.targets = ["sso.switch.ch"];
    request.justification = "(suspicious request — exactly what L0 exists to refuse)";
  }

  // 1. L0 — the deterministic enforcement gate rules first, at zero LLM cost.
  //    (Stage 4 / P-702 moves this inside the pipeline as the layered stack.)
  banner("L0 · enforcement gate");
  const policy = JSON.parse(await Bun.file(join(import.meta.dir, "policy.json")).text()) as Policy;
  const l0 = evaluate("containment", { action: request.action, targets: JSON.stringify(request.targets) }, policy);
  console.log(`request ${request.request_id}: ${String(request.action)} → ${JSON.stringify(request.targets)}`);
  console.log(`L0 decision: ${l0.decision.toUpperCase()} — ${l0.reason} (rule ${l0.rule_index})`);
  if (l0.decision === "deny") {
    console.log("→ refused deterministically. No panel convened, no tokens spent, nothing to clean up.");
    process.exit(1);
  }
  if (l0.decision === "allow") {
    console.log("→ pre-approved pattern; containment would proceed without a panel. (Demo expects `ask`.)");
    process.exit(0);
  }
  console.log("→ judgment call. Convening the tribunal (L1).");

  // 2. Transport — the only thing that changes between offline and live.
  const transport: AgentTransport = live
    ? await NatsAgentTransport.connect({ servers: process.env.NATS_URL ?? "localhost:4222" })
    : new InMemoryAgentTransport();

  // 3. Fleet — simulated review agents, or a real cortex fleet (--no-fleet).
  let stopFleet: (() => Promise<void>) | null = null;
  if (!noFleet) {
    stopFleet = await startFleetSim(transport, {
      principal: PRINCIPAL,
      stack: STACK,
      scenario,
      useLLM,
      ollamaModel: process.env.OLLAMA_MODEL ?? "llama3.2",
      log: (line) => console.log(`   ${line}`),
    });
  }

  const agentProvider = new MyelinAgentProvider({
    transport,
    principal: PRINCIPAL,
    stack: STACK,
    sovereigntyDefaults: { data_residency: "CH" },
  });

  // 4. The pipeline. In the degraded scenario two seats have no responder on
  //    the bus — shorten the seat timeout so the abstain coercion is visible
  //    in seconds, not the production 120s.
  const { pipeline, baseDir } = await loadPipeline(join(import.meta.dir, "pipeline.yaml"));
  if (scenario === "degraded") {
    for (const step of pipeline.actions) {
      if (typeof step === "object" && step !== null && "tribunal" in step) {
        (step.tribunal as TribunalStepSpec).timeout_ms = 5_000;
      }
    }
  }

  banner("L1 · P_CONTAINMENT — tribunal over the bus");
  const result = await runPipeline(pipeline, { request }, {
    actionDirs: [baseDir],
    agentProvider,
    onTribunalEvent: (e) => {
      if (e.type === "tribunal.convened") {
        console.log(`\n⚖️  tribunal '${e.name}' convened — seats: [${e.seats.join(", ")}]`);
      } else if (e.type === "tribunal.seat_voted") {
        const v = e.vote;
        console.log(`🗳  seat '${v.seat}': ${v.verdict} (confidence ${v.confidence}${v.model ? `, model ${v.model}` : ""})${v.abstain_cause ? ` — ${v.abstain_cause}` : ""}`);
        if (v.reason) console.log(`     "${v.reason}"`);
      } else if (e.type === "tribunal.tiebreak") {
        console.log(`⚔️  HONEST ORACLE tiebreak '${e.vote.seat}': ${e.vote.verdict} — "${e.vote.reason}"`);
      } else {
        console.log(`\n📜 RULING: ${e.verdict.verdict.toUpperCase()} — ${e.verdict.reason}`);
        if (e.verdict.diversity.reassigned_seat) {
          console.log(`   diversity: seat '${e.verdict.diversity.reassigned_seat}' was auto-reassigned to local-only`);
        }
      }
    },
  });

  banner("Result");
  console.log(`pipeline: ${result.success ? "✅ success" : `🛑 halted — ${result.error}`} (${result.durationMs}ms)`);
  for (const step of result.steps) {
    console.log(`  ${step.success ? "✓" : "✗"} ${step.action} (${step.durationMs}ms)${step.error ? ` — ${step.error}` : ""}`);
  }
  if (!result.success) {
    console.log(
      `\nFail-closed by design: deny refuses, defer waits for a human (the L2 gate — composed in Stage 4 / P-702).`,
    );
    console.log(`Nothing was blocked, nothing written. The verdict and every vote are on the bus for the audit trail.`);
  } else {
    console.log(`\nArtifacts: examples/containment-tribunal/out/blocklist.json + out/audit.jsonl`);
  }

  if (stopFleet) await stopFleet();
  if (transport instanceof NatsAgentTransport) await transport.close();
  process.exit(result.success ? 0 : 1);
}

main().catch((err) => {
  console.error("demo failed:", err);
  process.exit(1);
});
