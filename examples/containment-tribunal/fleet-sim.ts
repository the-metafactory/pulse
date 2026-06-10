/**
 * Fleet Simulator — four review agents on the bus, standing in for a cortex
 * fleet. Same contract as the soc-triage sim (and as real cortex agents):
 * consume `tasks.*` envelopes, publish `dispatch.task.started|completed|failed`
 * with correlation_id = task_id, enforce sovereignty consumer-side.
 *
 *   net-reviewer        containment.review.network     frontier
 *   intel-reviewer      containment.review.intel       local-only (Ollama when --llm)
 *   provenance-reviewer containment.review.provenance  local-only backbone, claims `any` tasks
 *   oracle              review.adversarial             frontier (the Honest Oracle)
 *
 * Scenarios (canned votes; --llm replaces them with real model answers):
 *   allow (default) — diverse confident majority, containment proceeds
 *   split           — intel denies, panel ties, oracle attacks both and denies
 *   degraded        — intel + provenance agents never come online; their seats
 *                     time out into abstains and the incapacitated panel
 *                     (1 allow / 0 deny / 2 abstain) denies, fail-closed
 */

import type { AgentTransport, MyelinEnvelope } from "../../src/lib/agent-provider";

export type FleetScenario = "allow" | "split" | "degraded";

export interface FleetSimOptions {
  principal: string;
  stack?: string;
  scenario?: FleetScenario;
  /** Try real models (Ollama for local seats, claude CLI for frontier). */
  useLLM?: boolean;
  ollamaModel?: string;
  log?: (line: string) => void;
}

const vote = (verdict: string, confidence: number, reason: string) =>
  JSON.stringify({ verdict, confidence, reason });

const CANNED: Record<FleetScenario, Record<string, string>> = {
  allow: {
    "containment.review.network": vote("allow", 0.85, "Both domains are single-purpose campaign infrastructure; RPZ block at resolvers is reversible (72h TTL) with no shared-hosting collateral."),
    "containment.review.intel": vote("allow", 0.8, "Telemetry shows active harm: 14 member lookups in 6h and 2 post-delivery SSO logins — the block interrupts an ongoing credential harvest."),
    "containment.review.provenance": vote("allow", 0.7, "Request originates from the signed soc-triage pipeline with a published advisory behind it; targets are not legitimate infrastructure."),
  },
  split: {
    "containment.review.network": vote("allow", 0.75, "Proportionate, reversible, no collateral identified."),
    "containment.review.intel": vote("deny", 0.7, "Telemetry sample is thin for uni-b and hs-c; blocking now may tip the operator to rotate infrastructure before member IR teams finish account resets."),
    "containment.review.provenance": vote("abstain", 0.4, "Requester chain is plausible but the advisory reference cannot be independently verified from here."),
    "review.adversarial": vote("deny", 0.85, "The case FOR blocking survives on harm, but the case AGAINST stands stronger: rotation risk before resets complete is irreversible, the block is not. Delay 2h, reset accounts first, then block."),
  },
  degraded: {
    "containment.review.network": vote("allow", 0.85, "Proportionate, reversible, no collateral identified."),
    // intel-reviewer AND provenance-reviewer are OFFLINE in this scenario —
    // both seats time out into abstains: 1 allow / 0 deny / 2 abstain is an
    // incapacitated panel and the aggregation denies, fail-closed.
  },
};

async function tryOllama(prompt: string, model: string): Promise<string | null> {
  try {
    const res = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false, format: "json" }),
      signal: AbortSignal.timeout(110_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { response?: string };
    return data.response ?? null;
  } catch (_err) {
    return null; // Ollama not running — caller falls back to canned vote
  }
}

async function tryFrontierLLM(prompt: string): Promise<string | null> {
  try {
    const { createLocalCapabilities } = await import("../../src/lib/capabilities");
    const caps = await createLocalCapabilities(["llm"]);
    if (!caps.llm) return null;
    const res = await caps.llm(prompt, { tier: "standard", json: true });
    return res.json !== undefined ? JSON.stringify(res.json) : res.text;
  } catch (_err) {
    return null; // no claude CLI / API key — caller falls back to canned vote
  }
}

interface SimAgent {
  id: string;
  capability: string;
  modelClass: "local-only" | "frontier";
  answer: (prompt: string, canned: string) => Promise<{ text: string; model: string }>;
}

export async function startFleetSim(
  transport: AgentTransport,
  opts: FleetSimOptions,
): Promise<() => Promise<void>> {
  const stack = opts.stack ?? "default";
  const prefix = `local.${opts.principal}.${stack}`;
  const scenario = opts.scenario ?? "allow";
  const log = opts.log ?? (() => {});

  const localAnswer = async (prompt: string, canned: string) => {
    if (opts.useLLM) {
      const model = opts.ollamaModel ?? "llama3.2";
      const text = await tryOllama(prompt, model);
      if (text) return { text, model: `ollama/${model}` };
      log(`⚠️  Ollama unavailable — using canned vote`);
    }
    return { text: canned, model: "canned/local-llm" };
  };

  const frontierAnswer = (modelName: string) => async (prompt: string, canned: string) => {
    if (opts.useLLM) {
      const text = await tryFrontierLLM(prompt);
      if (text) return { text, model: "claude/standard" };
      log(`⚠️  frontier LLM unavailable — using canned vote`);
    }
    return { text: canned, model: modelName };
  };

  // Distinct model strings per agent — the tribunal's post-hoc diversity
  // check inspects the executing model of every allowing vote.
  const agents: SimAgent[] = [
    { id: "net-reviewer", capability: "containment.review.network", modelClass: "frontier", answer: frontierAnswer("canned/frontier-a") },
    { id: "intel-reviewer", capability: "containment.review.intel", modelClass: "local-only", answer: localAnswer },
    { id: "provenance-reviewer", capability: "containment.review.provenance", modelClass: "local-only", answer: frontierAnswer("canned/local-b") },
    { id: "oracle", capability: "review.adversarial", modelClass: "frontier", answer: frontierAnswer("canned/frontier-b") },
  ];

  const OFFLINE_IN_DEGRADED = new Set(["intel-reviewer", "provenance-reviewer"]);
  const active = agents.filter((a) => !(scenario === "degraded" && OFFLINE_IN_DEGRADED.has(a.id)));
  if (active.length < agents.length) {
    log(`💀 scenario=degraded: agents 'intel-reviewer' + 'provenance-reviewer' are OFFLINE — their seats will time out into abstains`);
  }

  async function publishLifecycle(
    state: "started" | "completed" | "failed",
    task: MyelinEnvelope,
    payload: Record<string, unknown>,
  ) {
    await transport.publish(
      `${prefix}.dispatch.task.${state}`,
      JSON.stringify({
        id: crypto.randomUUID(),
        source: `${opts.principal}.${stack}.fleet-sim`,
        type: `dispatch.task.${state}`,
        timestamp: new Date().toISOString(),
        correlation_id: task.correlation_id,
        sovereignty: task.sovereignty,
        payload,
      }),
    );
  }

  const unsubs: Array<() => Promise<void>> = [];

  for (const agent of active) {
    const unsub = await transport.subscribe(`${prefix}.tasks.${agent.capability}`, (_subject, data) => {
      void (async () => {
        const task = JSON.parse(data) as MyelinEnvelope;
        const sov = task.sovereignty;

        // Sovereignty enforcement at the consumer — the policy travelled WITH the task.
        if (agent.modelClass === "frontier" && (sov.frontier_ok === false || sov.model_class === "local-only")) {
          log(`🛑 [${agent.id}] REFUSED task ${String(task.correlation_id).slice(0, 8)}…: envelope demands ${sov.model_class}, frontier_ok=${sov.frontier_ok}`);
          await publishLifecycle("failed", task, {
            task_id: task.correlation_id,
            error: `sovereignty violation: agent '${agent.id}' is model_class=frontier but task requires ${sov.model_class}`,
            agent_id: agent.id,
          });
          return;
        }

        log(`🤖 [${agent.id}] claimed seat task ${String(task.correlation_id).slice(0, 8)}… (${agent.capability}, model_class=${sov.model_class})`);
        await publishLifecycle("started", task, { task_id: task.correlation_id, agent_id: agent.id });

        const prompt = String(task.payload.prompt ?? "");
        const canned = CANNED[scenario][agent.capability] ?? vote("abstain", 0, "no scripted vote for this capability");
        const { text, model } = await agent.answer(prompt, canned);

        const cleaned = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
        let output: unknown = text;
        try {
          output = JSON.parse(cleaned);
        } catch (_err) {
          // model returned non-JSON — pass raw text through; parseSeatVote
          // coerces anything unrecognizable to a fail-closed abstain
        }

        log(`🗳  [${agent.id}] voted on task ${String(task.correlation_id).slice(0, 8)}… (model=${model})`);
        await publishLifecycle("completed", task, {
          task_id: task.correlation_id,
          output,
          agent_id: agent.id,
          model,
        });
      })();
    });
    unsubs.push(unsub);
    log(`🟢 fleet-sim: agent '${agent.id}' online — capability ${agent.capability} (${agent.modelClass})`);
  }

  return async () => {
    for (const unsub of unsubs) await unsub();
  };
}
