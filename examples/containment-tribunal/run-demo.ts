#!/usr/bin/env bun
/**
 * SOC Containment — the full governed-action stack, in-pipeline (Stage 4 / P-702).
 *
 * The advisory recommended "block both domains" — now someone has to decide.
 * One `governed:` step in pipeline.yaml runs all three layers: deterministic
 * policy (L0), model-diverse tribunal over the bus (L1), analyst gate (L2).
 * Refusals are terminal at every layer; only uncertainty travels down.
 *
 *   bun examples/containment-tribunal/run-demo.ts                # ALLOW at L1: diverse confident majority
 *   bun examples/containment-tribunal/run-demo.ts --preapproved  # ALLOW at L0: sinkhole target, panel never convenes
 *   bun examples/containment-tribunal/run-demo.ts --protected    # DENY at L0: protected zone, zero LLM cost
 *   bun examples/containment-tribunal/run-demo.ts --split        # DENY at L1: panel splits, Honest Oracle tiebreaks
 *   bun examples/containment-tribunal/run-demo.ts --degraded     # DENY at L1: fleet majority offline, fail-closed
 *   bun examples/containment-tribunal/run-demo.ts --defer        # ALLOW at L2: low-confidence panel defers to the analyst
 *   bun examples/containment-tribunal/run-demo.ts --defer --interactive   # type the analyst verdict yourself
 *   bun examples/containment-tribunal/run-demo.ts --llm          # real models (Ollama local, claude frontier)
 *   bun examples/containment-tribunal/run-demo.ts --live         # real NATS bus (localhost:4222)
 *   bun examples/containment-tribunal/run-demo.ts --live --no-fleet  # simulator off — seat subjects left free for an external fleet you run
 *
 * Every layer's verdict is published to the bus (governance.verdict.*):
 *   nats sub 'local.switch-soc.>'
 */

import { join } from "path";
import { loadPipeline, runPipeline } from "../../src/lib/pipeline";
import {
  MyelinAgentProvider,
  InMemoryAgentTransport,
  NatsAgentTransport,
  type AgentTransport,
} from "../../src/lib/agent-provider";
import { StdinGateProvider } from "../../src/lib/gate-provider";
import type { GateInput, GateProvider } from "../../src/types/pipeline";
import type { GovernedStepSpec } from "../../src/types/governed";
import { startFleetSim, type FleetScenario } from "./fleet-sim";

const PRINCIPAL = "switch-soc";
const STACK = "default";

const args = new Set(process.argv.slice(2));
const live = args.has("--live");
const useLLM = args.has("--llm");
const noFleet = args.has("--no-fleet");
const interactive = args.has("--interactive");
const scenario: FleetScenario = args.has("--split")
  ? "split"
  : args.has("--degraded")
    ? "degraded"
    : args.has("--defer")
      ? "defer"
      : "allow";

const banner = (s: string) => console.log(`\n━━━ ${s} ${"━".repeat(Math.max(0, 60 - s.length))}`);

/** Demo gate that auto-passes after showing the prompt (non-interactive runs). */
class AutoGateProvider implements GateProvider {
  async requestVerdict(spec: { name: string; prompt: string }): Promise<GateInput> {
    console.log(`\n🚧 L2 GATE [${spec.name}]: ${spec.prompt}`);
    console.log(`   auto-approve (demo default — use --interactive for a real verdict): verdict=pass`);
    return { verdict: "pass", notes: "auto-approved (demo default)" };
  }
}

async function main() {
  banner("SOC Containment — governed-action stack (L0→L1→L2)");
  console.log(
    `mode: ${live ? "LIVE NATS bus" : "in-memory bus"} | fleet: ${noFleet ? "external" : `simulated (scenario: ${scenario})`} | models: ${useLLM ? "real" : "canned"} | gate: ${interactive ? "interactive" : "auto-pass"}`,
  );

  // The containment request — produced by the soc-triage advisory.
  const request = JSON.parse(
    await Bun.file(join(import.meta.dir, "fixtures/containment-request.json")).text(),
  ) as Record<string, unknown>;
  if (args.has("--protected")) {
    request.targets = ["sso.switch.ch"];
    request.justification = "(suspicious request — exactly what L0 exists to refuse)";
  }
  if (args.has("--preapproved")) {
    request.targets = ["sinkhole-test.example"];
    request.justification = "scheduled sinkhole verification run";
  }

  // Transport — the only thing that changes between offline and live.
  const transport: AgentTransport = live
    ? await NatsAgentTransport.connect({ servers: process.env.NATS_URL ?? "localhost:4222" })
    : new InMemoryAgentTransport();

  // Publish every layer's verdict to the bus — the audit trail Stage 5 reads
  // back. Demo wiring (event sinks → transport.publish); Stage 5 standardizes
  // the subject + envelope. Promises collected and settled before teardown so
  // the printed bus trail is real, not hoped-for.
  const verdictPublishes: Promise<void>[] = [];
  const publishVerdict = (layer: string, payload: Record<string, unknown>) => {
    verdictPublishes.push(
      transport.publish(
        `local.${PRINCIPAL}.${STACK}.governance.verdict.${layer}`,
        JSON.stringify({
          id: crypto.randomUUID(),
          source: `${PRINCIPAL}.${STACK}.pulse.P_CONTAINMENT`,
          type: `governance.verdict.${layer}`,
          timestamp: new Date().toISOString(),
          sovereignty: { classification: "local", data_residency: "CH" },
          payload,
        }),
      ),
    );
  };

  // Fleet — simulated review agents, or a real cortex fleet (--no-fleet).
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

  // The pipeline. In the degraded scenario two seats have no responder on the
  // bus — shorten the seat timeout so the abstain coercion is visible in
  // seconds, not the production 120s.
  const { pipeline, baseDir } = await loadPipeline(join(import.meta.dir, "pipeline.yaml"));
  if (scenario === "degraded") {
    for (const step of pipeline.actions) {
      if (typeof step === "object" && step !== null && "governed" in step) {
        const g = step.governed as GovernedStepSpec;
        if (g.tribunal) g.tribunal.timeout_ms = 5_000;
      }
    }
  }

  banner("P_CONTAINMENT — one governed: step, three layers");
  const result = await runPipeline(pipeline, { request }, {
    actionDirs: [baseDir],
    agentProvider,
    gateProvider: interactive ? new StdinGateProvider() : new AutoGateProvider(),
    onGovernedEvent: (e) => {
      if (e.type === "governed.l0") {
        console.log(`\n🪨 L0 [${e.tool}]: ${e.decision.decision.toUpperCase()} — ${e.decision.reason} (rule ${e.decision.rule_index})`);
        publishVerdict("l0", { name: e.name, tool: e.tool, ...e.decision });
        if (e.decision.decision === "allow") console.log(`   → pre-approved. Panel never convenes — zero LLM cost.`);
        if (e.decision.decision === "deny") console.log(`   → refused deterministically. No panel, no tokens, nothing to clean up.`);
      } else if (e.type === "governed.escalated") {
        console.log(`⬇️  escalating to ${e.to.toUpperCase()}: ${e.reason}`);
      } else {
        console.log(`\n⚖️  GOVERNED RESULT: ${e.result.outcome.toUpperCase()} — resolved by ${e.result.resolved_by.toUpperCase()}`);
        publishVerdict("resolved", e.result as unknown as Record<string, unknown>);
      }
    },
    onTribunalEvent: (e) => {
      if (e.type === "tribunal.convened") {
        console.log(`⚖️  L1 tribunal '${e.name}' convened — seats: [${e.seats.join(", ")}]`);
      } else if (e.type === "tribunal.seat_voted") {
        const v = e.vote;
        console.log(`🗳  seat '${v.seat}': ${v.verdict} (confidence ${v.confidence}${v.model ? `, model ${v.model}` : ""})${v.abstain_cause ? ` — ${v.abstain_cause}` : ""}`);
        if (v.reason) console.log(`     "${v.reason}"`);
      } else if (e.type === "tribunal.tiebreak") {
        console.log(`⚔️  HONEST ORACLE tiebreak '${e.vote.seat}': ${e.vote.verdict} — "${e.vote.reason}"`);
      } else {
        console.log(`📜 L1 ruling: ${e.verdict.verdict.toUpperCase()} — ${e.verdict.reason}`);
        publishVerdict("tribunal", e.verdict as unknown as Record<string, unknown>);
      }
    },
    onGateEvent: (e) => {
      if (e.type === "gate.closed") {
        console.log(`🚧 L2 gate '${e.name}' closed: verdict=${e.verdict} — ${e.notes}`);
        publishVerdict("gate", { name: e.name, verdict: e.verdict, notes: e.notes, closed_at: e.closed_at });
      }
    },
  });

  banner("Result");
  console.log(`pipeline: ${result.success ? "✅ success" : `🛑 halted — ${result.error}`} (${result.durationMs}ms)`);
  for (const step of result.steps) {
    console.log(`  ${step.success ? "✓" : "✗"} ${step.action} (${step.durationMs}ms)${step.error ? ` — ${step.error}` : ""}`);
  }
  if (!result.success) {
    console.log(`\nFail-closed by design: refusals are terminal at every layer; only uncertainty travels down.`);
    console.log(`Nothing was blocked, nothing written. Every layer's verdict is on the bus (governance.verdict.*).`);
  } else {
    console.log(`\nArtifacts: examples/containment-tribunal/out/blocklist.json + out/audit.jsonl`);
    console.log(`Bus trail: governance.verdict.l0 [+ .tribunal] [+ .gate] + .resolved`);
  }

  const settled = await Promise.allSettled(verdictPublishes);
  const failedPublishes = settled.filter((s) => s.status === "rejected");
  if (failedPublishes.length > 0) {
    console.log(`⚠️  ${failedPublishes.length} verdict publish(es) failed — bus trail incomplete`);
  }
  if (stopFleet) await stopFleet();
  if (transport instanceof NatsAgentTransport) await transport.close();
  process.exit(result.success ? 0 : 1);
}

main().catch((err) => {
  console.error("demo failed:", err);
  process.exit(1);
});
