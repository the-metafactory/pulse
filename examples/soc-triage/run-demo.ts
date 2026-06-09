#!/usr/bin/env bun
/**
 * CommunitySOC Phishing Triage — agentic flow demo (NetSecWG).
 *
 *   bun examples/soc-triage/run-demo.ts                  # offline: in-memory bus + simulated fleet
 *   bun examples/soc-triage/run-demo.ts --llm            # + real models (Ollama local, claude frontier)
 *   bun examples/soc-triage/run-demo.ts --live           # real NATS bus (localhost:4222), simulated fleet
 *   bun examples/soc-triage/run-demo.ts --live --no-fleet # real NATS + real cortex fleet handles tasks
 *   bun examples/soc-triage/run-demo.ts --auto-approve   # non-interactive analyst gate (CI / smoke test)
 *
 * Watch the envelopes live on a real bus:
 *   nats sub 'local.switch-soc.>'
 *
 * The same pipeline, provider, and envelopes run in every mode — only the
 * transport (in-memory vs NATS) and the fleet (simulated vs cortex) change.
 */

import { join } from "path";
import { runPipelineFromYaml } from "../../src/lib/pipeline";
import {
  MyelinAgentProvider,
  InMemoryAgentTransport,
  NatsAgentTransport,
  type AgentTransport,
} from "../../src/lib/agent-provider";
import type { GateInput, GateProvider } from "../../src/types/pipeline";
import { StdinGateProvider } from "../../src/lib/gate-provider";
import { startFleetSim } from "./fleet-sim";

const PRINCIPAL = "switch-soc";
const STACK = "default";

const args = new Set(process.argv.slice(2));
const live = args.has("--live");
const useLLM = args.has("--llm");
const noFleet = args.has("--no-fleet");
const autoApprove = args.has("--auto-approve");

const banner = (s: string) => console.log(`\n━━━ ${s} ${"━".repeat(Math.max(0, 56 - s.length))}`);

/** Demo gate that auto-passes after showing the prompt (for non-interactive runs). */
class AutoGateProvider implements GateProvider {
  async requestVerdict(spec: { name: string; prompt: string }): Promise<GateInput> {
    console.log(`\n🚧 GATE [${spec.name}]: ${spec.prompt}`);
    console.log(`   --auto-approve: verdict=pass`);
    return { verdict: "pass", notes: "auto-approved (demo flag)" };
  }
}

async function main() {
  banner("CommunitySOC Phishing Triage — pulse agentic flow");
  console.log(`mode: ${live ? "LIVE NATS bus" : "in-memory bus"} | fleet: ${noFleet ? "external (cortex)" : "simulated"} | models: ${useLLM ? "real (ollama + frontier)" : "canned"}`);

  // 1. Transport — the only thing that changes between offline and live.
  const transport: AgentTransport = live
    ? await NatsAgentTransport.connect({ servers: process.env.NATS_URL ?? "localhost:4222" })
    : new InMemoryAgentTransport();

  // 2. Fleet — simulated agents, or none (a real cortex fleet claims the tasks).
  let stopFleet: (() => Promise<void>) | null = null;
  if (!noFleet) {
    stopFleet = await startFleetSim(transport, {
      principal: PRINCIPAL,
      stack: STACK,
      useLLM,
      ollamaModel: process.env.OLLAMA_MODEL ?? "llama3.2",
      log: (line) => console.log(`   ${line}`),
    });
  }

  // 3. The provider — pulse's only new moving part: publish task envelope,
  //    await dispatch lifecycle.
  const agentProvider = new MyelinAgentProvider({
    transport,
    principal: PRINCIPAL,
    stack: STACK,
    sovereigntyDefaults: { data_residency: "CH" },
  });

  // 4. Input: the reported phishing mail (confidential member data).
  const emailRaw = await Bun.file(join(import.meta.dir, "fixtures/reported-email.txt")).text();

  // Optional: demonstrate sovereignty ENFORCEMENT — try to hand the raw
  // (confidential) email to the frontier agent. The envelope says
  // model_class=local-only; the frontier consumer refuses the task.
  if (args.has("--violate")) {
    banner("Sovereignty violation attempt");
    console.log("Dispatching RAW member email to the frontier capability with model_class=local-only…");
    const refused = await agentProvider.dispatch({
      capability: "soc.enrich.iocs",
      prompt: `Analyze this email:\n${emailRaw}`,
      sovereignty: { model_class: "local-only", frontier_ok: false },
    });
    console.log(`→ task ${refused.task_id.slice(0, 8)}… status=${refused.status}`);
    console.log(`→ ${refused.error}`);
    console.log("The policy travelled with the data. The fleet enforced it.\n");
  }

  banner("Running P_PHISH_TRIAGE");
  const result = await runPipelineFromYaml(
    join(import.meta.dir, "pipeline.yaml"),
    { email_raw: emailRaw },
    {
      agentProvider,
      gateProvider: autoApprove ? new AutoGateProvider() : new StdinGateProvider(),
      onAgentEvent: (e) => {
        if (e.type === "agent.dispatched") {
          console.log(`\n📤 [pulse] agent step '${e.name}' → capability ${e.capability} (envelope on bus)`);
        } else if (e.type === "agent.completed") {
          console.log(`📥 [pulse] agent step '${e.name}' completed in ${e.duration_ms}ms`);
        } else if (e.type === "agent.failed") {
          console.log(`💥 [pulse] agent step '${e.name}' failed: ${e.error}`);
        } else {
          console.log(`⏰ [pulse] agent step '${e.name}' timed out after ${e.timeout_ms}ms`);
        }
      },
      onGateEvent: (e) => {
        if (e.type === "gate.closed") {
          console.log(`🚧 [pulse] gate '${e.name}' closed: verdict=${e.verdict}`);
        }
      },
    },
  );

  banner("Result");
  console.log(`pipeline: ${result.success ? "✅ success" : `❌ failed — ${result.error}`} (${result.durationMs}ms)`);
  console.log(`steps:`);
  for (const step of result.steps) {
    console.log(`  ${step.success ? "✓" : "✗"} ${step.action} (${step.durationMs}ms)${step.error ? ` — ${step.error}` : ""}`);
  }

  if (stopFleet) await stopFleet();
  if (transport instanceof NatsAgentTransport) await transport.close();
  process.exit(result.success ? 0 : 1);
}

main().catch((err) => {
  console.error("demo failed:", err);
  process.exit(1);
});
