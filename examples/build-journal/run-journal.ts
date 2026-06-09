#!/usr/bin/env bun
/**
 * Federated Build Journal — "metafactory builds metafactory, in public".
 *
 *   bun examples/build-journal/run-journal.ts                # offline: in-memory bus + simulated agents, Discord dry-run
 *   bun examples/build-journal/run-journal.ts --llm          # + real model (claude CLI) for both agents
 *   bun examples/build-journal/run-journal.ts --live         # real NATS bus (localhost:4222), simulated agents
 *   bun examples/build-journal/run-journal.ts --no-fleet     # real fleets claim the tasks (needs andreas' stack federated)
 *   bun examples/build-journal/run-journal.ts --post         # actually post to Discord (public!)
 *   bun examples/build-journal/run-journal.ts --deploy       # commit+push site repo, wrangler deploy (public!)
 *   bun examples/build-journal/run-journal.ts --interactive  # type the editor gate verdict yourself
 *   bun examples/build-journal/run-journal.ts --days 14      # journal period (default 7)
 *
 * Watch the federation moment on a real bus:
 *   nats sub 'federated.>'
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
import { startJournalFleet } from "./fleet-sim";

const PRINCIPAL = "jc";
const STACK = "default";
const PEER_PRINCIPAL = "andreas";
const PEER_STACK = "meta-factory";

const argv = process.argv.slice(2);
const args = new Set(argv);
const live = args.has("--live");
const useLLM = args.has("--llm");
const noFleet = args.has("--no-fleet");
const post = args.has("--post");
const deploy = args.has("--deploy");
const interactive = args.has("--interactive");
const daysIdx = argv.indexOf("--days");
const days = daysIdx >= 0 ? Number(argv[daysIdx + 1]) || 7 : 7;

const banner = (s: string) => console.log(`\n━━━ ${s} ${"━".repeat(Math.max(0, 56 - s.length))}`);

/** Demo gate that auto-passes after showing the prompt. */
class AutoGateProvider implements GateProvider {
  async requestVerdict(spec: { name: string; prompt: string }): Promise<GateInput> {
    console.log(`\n🚧 GATE [${spec.name}]: ${spec.prompt}`);
    console.log(`   auto-approve (demo default — use --interactive for a real verdict): verdict=pass`);
    return { verdict: "pass", notes: "auto-approved (demo default)" };
  }
}

async function main() {
  banner("Federated Build Journal — pulse cross-principal flow");
  console.log(
    `mode: ${live ? "LIVE NATS bus" : "in-memory bus"} | agents: ${noFleet ? "real fleets" : "simulated"} | model: ${useLLM ? "real (claude)" : "canned"} | discord: ${post ? "POSTING" : "dry-run"} | period: ${days}d`,
  );

  const transport: AgentTransport = live
    ? await NatsAgentTransport.connect({ servers: process.env.NATS_URL ?? "localhost:4222" })
    : new InMemoryAgentTransport();

  let stopFleet: (() => Promise<void>) | null = null;
  if (!noFleet) {
    stopFleet = await startJournalFleet(transport, {
      principal: PRINCIPAL,
      stack: STACK,
      peerPrincipal: PEER_PRINCIPAL,
      peerStack: PEER_STACK,
      useLLM,
      log: (line) => console.log(`   ${line}`),
    });
  }

  const agentProvider = new MyelinAgentProvider({
    transport,
    principal: PRINCIPAL,
    stack: STACK,
    sovereigntyDefaults: { data_residency: "CH" },
  });

  banner("Running P_BUILD_JOURNAL");
  const result = await runPipelineFromYaml(
    join(import.meta.dir, "pipeline.yaml"),
    {
      days,
      discord_post: post,
      site_deploy: deploy,
      // Without --deploy, pages land in a local preview dir — demo runs must
      // never dirty the site repo (a later --deploy would ship stale content).
      ...(deploy ? {} : { site_dir: join(import.meta.dir, "preview-site") }),
      discord_channel: process.env.DISCORD_CHANNEL ?? "general",
    },
    {
      agentProvider,
      gateProvider: interactive ? new StdinGateProvider() : new AutoGateProvider(),
      onAgentEvent: (e) => {
        if (e.type === "agent.dispatched") {
          console.log(`\n📤 [pulse] agent step '${e.name}' → ${e.capability} (envelope on bus)`);
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
  if (result.success) {
    const out = result.output as { buildlog?: { page?: string; site_dir?: string } };
    if (out?.buildlog?.page) {
      console.log(`\nbuild log page: ${out.buildlog.site_dir}/${out.buildlog.page}`);
      console.log(`preview locally, then deploy the site with wrangler when happy.`);
    }
  }

  if (stopFleet) await stopFleet();
  if (transport instanceof NatsAgentTransport) await transport.close();
  process.exit(result.success ? 0 : 1);
}

main().catch((err) => {
  console.error("demo failed:", err);
  process.exit(1);
});
