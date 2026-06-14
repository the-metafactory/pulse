/**
 * P-806 rehearsal — run the 8 ranked audience scenarios (design §9) through
 * the full wiring: compose → validate → ack(auto) → execute, offline.
 *
 *   bun examples/soc-demo/rehearse.ts            # stub or real LLM (env-gated)
 *
 * With ANTHROPIC_API_KEY set the real composer runs per scenario (the true
 * rehearsal); without it the deterministic stub LLM exercises the wiring
 * path only — useful for CI smoke, not for prompt tuning. Disposition rule
 * (design §8.7): a failure is a composer-prompt bug (fix the prompt) unless
 * the scenario will likely come up live AND needs a missing block.
 */

import { createLocalCapabilities } from "../../src/lib/capabilities";
import type { GateProvider } from "../../src/types/pipeline";
import { runScenario, makeStubLLM, resolveAgentProvider } from "./run-demo";
import { ConsolePoster } from "./lib/mm";

const SCENARIOS: Array<{ id: number; name: string; text: string }> = [
  { id: 1, name: "CERT advisory impact", text: "We received a CERT-EU advisory about CVE-2021-44228 (Log4Shell). Does it affect our member institutions and who do we notify?" },
  { id: 2, name: "Credential leak", text: "HIBP flagged test@example.org in a fresh combolist paste. Identify the account owner and get a reset + notification out." },
  { id: 3, name: "Suspicious login", text: "A Shibboleth login for a staff account came from an unusual network, IP 198.51.100.7. Enrich it and let an analyst decide block or accept." },
  { id: 4, name: "DMCA abuse mail", text: "A DMCA notice arrived naming IP 130.59.10.10 sharing copyrighted material last night. Find the responsible institution and send the compliance notification." },
  { id: 5, name: "Shadow IT exposure", text: "A new TLS cert for gitlab.example-university.ch showed up in certificate transparency and the service answers on the open internet. Who owns it and how do we notify them?" },
  { id: 6, name: "Typosquat brand abuse", text: "Someone registered switcch.ch and it serves a lookalike login page. Document it (screenshot/verdict) and prepare a registrar abuse report." },
  { id: 7, name: "Scanner traffic", text: "We see a burst of probes from 162.142.125.10 across member networks. Is it a known scanner or something to escalate to peers?" },
  { id: 8, name: "FADP breach notice", text: "A member reports a confirmed personal-data breach. Draft the 72-hour FADP regulator notification and route it past the DPO before anything leaves." },
];

const autoAck: GateProvider = {
  async requestVerdict(spec) {
    console.log(`  [auto-ack] gate ${spec.name} → pass`);
    return { verdict: "pass", notes: "rehearsal auto-ack" };
  },
};

const useRealLlm = Boolean(process.env.ANTHROPIC_API_KEY);
const llm = useRealLlm ? (await createLocalCapabilities(["llm"])).llm! : makeStubLLM();
console.log(`Rehearsal: ${useRealLlm ? "REAL composer LLM" : "stub LLM (wiring smoke only — set ANTHROPIC_API_KEY for the true rehearsal)"}\n`);

// Honor sovereign routing: with PULSE_LOCAL_MODEL/OLLAMA_URL set, local-only
// agent steps run on Ollama instead of being refused (matches the CLI + Yarrow).
const agentProvider = resolveAgentProvider(llm);
if (agentProvider) console.log(`🧠 local model enabled (${process.env.PULSE_LOCAL_MODEL ?? "llama3.2:latest"}) — local-only steps route to Ollama\n`);

const rows: string[] = [];
for (const scenario of SCENARIOS) {
  console.log(`\n━━━ Scenario ${scenario.id}: ${scenario.name} ━━━`);
  const poster = new ConsolePoster();
  const started = Date.now();
  try {
    const result = await runScenario(scenario.text, {
      llm,
      poster,
      gateProvider: autoAck,
      render: false,
      ...(agentProvider && { agentProvider }),
    });
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const steps = poster.posts.filter((p) => p.startsWith("✅")).length;
    rows.push(`| ${scenario.id} | ${scenario.name} | ${result.status} | ${steps} | ${secs}s |`);
  } catch (err) {
    rows.push(`| ${scenario.id} | ${scenario.name} | ERROR: ${err instanceof Error ? err.message.slice(0, 60) : String(err)} | - | - |`);
  }
}

console.log("\n\n## Rehearsal results\n");
console.log(`| # | Scenario | Outcome | Steps run | Wall clock |`);
console.log(`|---|----------|---------|-----------|------------|`);
for (const row of rows) console.log(row);
