/**
 * Fleet simulator — two principals' agents on the bus.
 *
 * - "sage" (jc/default)            claims ecosystem.narrative on the LOCAL
 *                                  subjects — jc's own fleet.
 * - "andreas-agent" (andreas/meta-factory) claims ecosystem.perspective on the
 *                                  FEDERATED subjects and answers on jc's
 *                                  federated dispatch subjects — standing in
 *                                  for Andreas' real cortex stack until his
 *                                  stack pubkey lands and the leaf node is up.
 *
 * Both speak the contract real stacks speak; swap the simulator for the real
 * federation (run-journal --no-fleet) and pulse does not change at all.
 */

import type { AgentTransport, MyelinEnvelope } from "../../src/lib/agent-provider";

export interface JournalFleetOptions {
  /** Requesting principal (jc). */
  principal: string;
  stack?: string;
  /** Peer principal (andreas). */
  peerPrincipal: string;
  peerStack?: string;
  /** Try real models (claude CLI). Default: canned answers. */
  useLLM?: boolean;
  log?: (line: string) => void;
}

const CANNED_DRAFT = JSON.stringify({
  headline: "Agents started talking across the federation boundary",
  narrative:
    "This week pulse grew the last primitive it needed: federated agent steps. A pipeline on jc's stack can now hand work to an agent on a peer stack — the envelope crosses on federated.* subjects, the sovereignty policy travels with it, and the answer comes back on the requester's own dispatch subjects. The SOC triage demo got a Mattermost publisher, and this very journal is the first artifact two principals' agents co-authored.",
  highlights: [
    "pulse: federate: routing on agent steps — federated.{peer}.{stack}.tasks.*",
    "pulse: SOC triage demo posts advisories via Sage's Mattermost bot",
    "pulse: markdown-fence hardening for real-model JSON output",
    "site: public build log launched on stack.meta-factory.ai",
  ],
});

const CANNED_PERSPECTIVE = JSON.stringify({
  perspective:
    "From the meta-factory side this closes the loop we sketched in the federation design: local. never crosses the principal boundary, and now there is a real producer exercising that rule. The envelope grammar held up without changes — which is the result we wanted. Next on our side is the leaf-node config so the simulator can retire.",
  additions: [
    "myelin: envelope schema needed zero changes for cross-principal tasks",
    "cortex: leaf-node federation config staged, pubkey exchange pending",
  ],
  sign_off: true,
});

async function tryClaudeLLM(prompt: string): Promise<string | null> {
  try {
    const { createLocalCapabilities } = await import("../../src/lib/capabilities");
    const caps = await createLocalCapabilities(["llm"]);
    if (!caps.llm) return null;
    const res = await caps.llm(prompt, { tier: "standard", json: true });
    return res.json !== undefined ? JSON.stringify(res.json) : res.text;
  } catch (_err) {
    return null; // no claude CLI / API key — caller falls back to canned answer
  }
}

export async function startJournalFleet(
  transport: AgentTransport,
  opts: JournalFleetOptions,
): Promise<() => Promise<void>> {
  const stack = opts.stack ?? "default";
  const peerStack = opts.peerStack ?? "default";
  const log = opts.log ?? (() => {});

  const agents = [
    {
      id: "sage",
      principal: opts.principal,
      taskSubject: `local.${opts.principal}.${stack}.tasks.ecosystem.narrative`,
      replyPrefix: `local.${opts.principal}.${stack}`,
      source: `${opts.principal}.${stack}.sage`,
      canned: CANNED_DRAFT,
      home: `${opts.principal}/${stack} (local)`,
    },
    {
      id: "andreas-agent",
      principal: opts.peerPrincipal,
      taskSubject: `federated.${opts.peerPrincipal}.${peerStack}.tasks.ecosystem.perspective`,
      // The peer answers on the REQUESTER's federated dispatch subjects.
      replyPrefix: `federated.${opts.principal}.${stack}`,
      source: `${opts.peerPrincipal}.${peerStack}.fleet`,
      canned: CANNED_PERSPECTIVE,
      home: `${opts.peerPrincipal}/${peerStack} (federated peer)`,
    },
  ];

  const unsubs: Array<() => Promise<void>> = [];

  for (const agent of agents) {
    const unsub = await transport.subscribe(agent.taskSubject, (_subject, data) => {
      void (async () => {
        const task = JSON.parse(data) as MyelinEnvelope;
        log(`🤖 [${agent.id}] claimed task ${String(task.correlation_id).slice(0, 8)}… on ${agent.taskSubject}`);

        await transport.publish(
          `${agent.replyPrefix}.dispatch.task.started`,
          JSON.stringify({
            id: crypto.randomUUID(),
            source: agent.source,
            type: "dispatch.task.started",
            timestamp: new Date().toISOString(),
            correlation_id: task.correlation_id,
            sovereignty: task.sovereignty,
            payload: { task_id: task.correlation_id, agent_id: agent.id },
          }),
        );

        let text = agent.canned;
        let model = "canned";
        if (opts.useLLM) {
          const llmText = await tryClaudeLLM(String(task.payload.prompt ?? ""));
          if (llmText) {
            text = llmText;
            model = "claude/standard";
          } else {
            log(`⚠️  [${agent.id}] LLM unavailable — using canned answer`);
          }
        }

        let output: unknown = text;
        try {
          output = JSON.parse(text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim());
        } catch (_err) {
          // model returned non-JSON — pass raw text through; A_FORMAT_JOURNAL handles prose
        }

        log(`✅ [${agent.id}] completed (model=${model}) — answering on ${agent.replyPrefix}.dispatch.task.completed`);
        await transport.publish(
          `${agent.replyPrefix}.dispatch.task.completed`,
          JSON.stringify({
            id: crypto.randomUUID(),
            source: agent.source,
            type: "dispatch.task.completed",
            timestamp: new Date().toISOString(),
            correlation_id: task.correlation_id,
            sovereignty: task.sovereignty,
            payload: { task_id: task.correlation_id, output, agent_id: agent.id, model },
          }),
        );
      })();
    });
    unsubs.push(unsub);
    log(`🟢 fleet-sim: '${agent.id}' online — ${agent.home}`);
  }

  return async () => {
    for (const unsub of unsubs) await unsub();
  };
}
