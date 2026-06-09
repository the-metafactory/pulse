/**
 * Fleet Simulator — two agents on the bus, standing in for a cortex fleet.
 *
 * - "local-llm"   claims soc.triage.email  — runs a LOCAL model (Ollama when
 *                 available), accepts model_class local-only/any.
 * - "frontier"    claims soc.enrich.iocs   — runs a frontier model (claude CLI
 *                 via pulse's llm capability when available) and REFUSES any
 *                 task whose envelope says frontier_ok: false. Sovereignty is
 *                 enforced by the consumer, visible on the bus.
 *
 * Both speak the same contract cortex agents speak: consume `tasks.*`
 * envelopes, publish `dispatch.task.started|completed|failed` with
 * correlation_id = task_id. Swap this module for a real cortex fleet
 * (run-demo --no-fleet) and pulse does not change at all.
 */

import type { AgentTransport, MyelinEnvelope } from "../../src/lib/agent-provider";

export interface FleetSimOptions {
  principal: string;
  stack?: string;
  /** Try real models (Ollama for local, claude CLI for frontier). Default: canned answers. */
  useLLM?: boolean;
  /** Ollama model for the local agent. */
  ollamaModel?: string;
  log?: (line: string) => void;
}

const CANNED_TRIAGE = JSON.stringify({
  verdict: "phishing",
  confidence: 0.96,
  iocs: {
    urls: [
      "https://swiitch-security-portal.net/sso/verify?token=a8f3e2",
      "http://cdn.update-mirror.ru/swiss-edu/SecurityUpdate.exe",
    ],
    domains: ["swiitch-security-portal.net", "cdn.update-mirror.ru"],
    senders: ["it-support@swiitch-security-portal.net"],
    hashes: ["e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  },
  summary:
    "Credential-phishing with malware fallback: typosquatted SWITCH domain, urgency pretext (24h account lock), Russian CDN hosting a fake security update.",
});

const CANNED_ENRICHMENT = JSON.stringify({
  enrichment:
    "swiitch-security-portal.net registered <48h ago, same registrant pattern as the May 2026 'EduLock' wave targeting Swiss universities. cdn.update-mirror.ru previously served AgentTesla droppers. Hash is a known placeholder/decoy.",
  advisory:
    "CommunitySOC Advisory: Active credential-phishing campaign impersonating SWITCH IT-Support (typosquat: swiitch-security-portal.net). Lure: 24h account-lock urgency, German language. Secondary payload from cdn.update-mirror.ru. Recommended: block both domains, hunt for SSO logins following mail delivery, warn service desks. TLP:GREEN.",
});

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
    return null; // Ollama not running — caller falls back to canned answer
  }
}

async function tryFrontierLLM(prompt: string): Promise<string | null> {
  try {
    const { createLocalCapabilities } = await import("../../src/lib/capabilities");
    const caps = await createLocalCapabilities(["llm"]);
    if (!caps.llm) return null;
    const res = await caps.llm(prompt, { tier: "standard", json: true });
    return res.text;
  } catch (_err) {
    return null; // no claude CLI / API key — caller falls back to canned answer
  }
}

interface SimAgent {
  id: string;
  capability: string;
  modelClass: "local-only" | "frontier";
  answer: (prompt: string) => Promise<{ text: string; model: string }>;
}

export async function startFleetSim(
  transport: AgentTransport,
  opts: FleetSimOptions,
): Promise<() => Promise<void>> {
  const stack = opts.stack ?? "default";
  const prefix = `local.${opts.principal}.${stack}`;
  const log = opts.log ?? (() => {});

  const agents: SimAgent[] = [
    {
      id: "soc-local-llm",
      capability: "soc.triage.email",
      modelClass: "local-only",
      answer: async (prompt) => {
        if (opts.useLLM) {
          const model = opts.ollamaModel ?? "llama3.2";
          const text = await tryOllama(prompt, model);
          if (text) return { text, model: `ollama/${model}` };
          log(`⚠️  [soc-local-llm] Ollama unavailable — using canned analysis`);
        }
        return { text: CANNED_TRIAGE, model: "canned/local" };
      },
    },
    {
      id: "soc-frontier",
      capability: "soc.enrich.iocs",
      modelClass: "frontier",
      answer: async (prompt) => {
        if (opts.useLLM) {
          const text = await tryFrontierLLM(prompt);
          if (text) return { text, model: "claude/standard" };
          log(`⚠️  [soc-frontier] frontier LLM unavailable — using canned enrichment`);
        }
        return { text: CANNED_ENRICHMENT, model: "canned/frontier" };
      },
    },
  ];

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

  for (const agent of agents) {
    const unsub = await transport.subscribe(`${prefix}.tasks.${agent.capability}`, (_subject, data) => {
      void (async () => {
        const task = JSON.parse(data) as MyelinEnvelope;
        const sov = task.sovereignty;

        // Sovereignty enforcement at the consumer — the policy travelled WITH the task.
        if (agent.modelClass === "frontier" && (sov.frontier_ok === false || sov.model_class === "local-only")) {
          log(`🛑 [${agent.id}] REFUSED task ${task.correlation_id}: envelope demands ${sov.model_class}, frontier_ok=${sov.frontier_ok}`);
          await publishLifecycle("failed", task, {
            task_id: task.correlation_id,
            error: `sovereignty violation: agent '${agent.id}' is model_class=frontier but task requires ${sov.model_class} (frontier_ok=${sov.frontier_ok})`,
            agent_id: agent.id,
          });
          return;
        }

        log(`🤖 [${agent.id}] claimed task ${String(task.correlation_id).slice(0, 8)}… (${agent.capability}, model_class=${sov.model_class})`);
        await publishLifecycle("started", task, { task_id: task.correlation_id, agent_id: agent.id });

        const prompt = String(task.payload.prompt ?? "");
        const { text, model } = await agent.answer(prompt);

        let output: unknown = text;
        try {
          output = JSON.parse(text);
        } catch (_err) {
          // model returned non-JSON — pass raw text through; downstream actions handle both
        }

        log(`✅ [${agent.id}] completed task ${String(task.correlation_id).slice(0, 8)}… (model=${model})`);
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
