#!/usr/bin/env bun
/**
 * Diplomatic Pouch — trust rung 1 for a NEW peer (governance Stage 6, P-703).
 *
 * Built from the Sumarhús Foreign Policy v1.0 spec — not from its code (his
 * own border 1: nothing executable crosses on first contact, and his explicit
 * wish: build the better-fitting version on your own substrate).
 *
 *   bun examples/diplomatic-pouch/run-demo.ts --send              # outbound happy path: sanitise → rate-gate → human → seal
 *   bun examples/diplomatic-pouch/run-demo.ts --send --interactive  # type the named-human approval yourself
 *   bun examples/diplomatic-pouch/run-demo.ts --resend            # identical note again → dedupe block
 *   bun examples/diplomatic-pouch/run-demo.ts --burst             # 4th message in the 24h window → rate block
 *   bun examples/diplomatic-pouch/run-demo.ts --leaky             # note containing secrets → border 3 blocks, nothing leaves
 *   bun examples/diplomatic-pouch/run-demo.ts --inbound           # clean inbound: quarantine → strip → wrap → promote → read/
 *   bun examples/diplomatic-pouch/run-demo.ts --inbound-attack    # rule-rewrite attempt → TRIPWIRE: channel halts, alarm written
 *   bun examples/diplomatic-pouch/run-demo.ts --reset             # wipe pouch state (fresh relationship)
 *
 * After --inbound-attack, any --send refuses too: the channel is halted until
 * a human reviews pouch/alarms/ and reopens pouch/channel-state.json.
 */

import { join } from "path";
import { mkdir, rm, cp, writeFile as fsWrite } from "fs/promises";
import { runPipelineFromYaml } from "../../src/lib/pipeline";
import { StdinGateProvider } from "../../src/lib/gate-provider";
import type { GateInput, GateProvider } from "../../src/types/pipeline";
import { sha256Hex } from "./lib/borders";

const args = new Set(process.argv.slice(2));
const interactive = args.has("--interactive");
const POUCH = join(import.meta.dir, "pouch");
const PEER = "sumarhus";
const THREAD = "prompt-injection-containment";

const banner = (s: string) => console.log(`\n━━━ ${s} ${"━".repeat(Math.max(0, 62 - s.length))}`);

class NamedHumanGateProvider implements GateProvider {
  async requestVerdict(spec: { name: string; prompt: string }): Promise<GateInput> {
    console.log(`\n🚧 GATE [${spec.name}]: ${spec.prompt}`);
    console.log(`   auto-approve as "Jens-Christian Fischer" (demo default — --interactive for a real verdict)`);
    return { verdict: "pass", notes: "Jens-Christian Fischer" };
  }
}

async function ensurePouch(): Promise<void> {
  for (const d of ["outbox", "inbox", "read", "alarms"]) {
    await mkdir(join(POUCH, d), { recursive: true });
  }
}

async function runOut(notePath: string, now: string): Promise<boolean> {
  const result = await runPipelineFromYaml(
    join(import.meta.dir, "pipeline-out.yaml"),
    { pouch_dir: POUCH, note_path: notePath, thread: THREAD, kind: "pattern", peer: PEER, now },
    { gateProvider: interactive ? new StdinGateProvider() : new NamedHumanGateProvider() },
  );
  console.log(`\npipeline: ${result.success ? "✅ sealed + dropped" : `🛑 refused — ${result.error}`}`);
  for (const s of result.steps) console.log(`  ${s.success ? "✓" : "✗"} ${s.action}`);
  return result.success;
}

async function runIn(inboundName: string, now: string): Promise<boolean> {
  const result = await runPipelineFromYaml(
    join(import.meta.dir, "pipeline-in.yaml"),
    { pouch_dir: POUCH, inbound_name: inboundName, now },
    { gateProvider: interactive ? new StdinGateProvider() : new NamedHumanGateProvider() },
  );
  console.log(`\npipeline: ${result.success ? "✅ delivered to read/" : `🛑 refused — ${result.error}`}`);
  for (const s of result.steps) console.log(`  ${s.success ? "✓" : "✗"} ${s.action}`);
  return result.success;
}

/** Drop an inbound fixture (with a valid sidecar) into the inbox — standing in
 *  for the human who carried the files in. */
async function dropInbound(fixture: string, name: string): Promise<void> {
  const src = join(import.meta.dir, "fixtures", fixture);
  await cp(src, join(POUCH, "inbox", name));
  const text = await Bun.file(src).text();
  const envelope = {
    from: PEER,
    to: "metafactory",
    thread: THREAD,
    ts: new Date().toISOString(),
    sha256: await sha256Hex(text),
    kind: "question",
    human_approved_by: "Magnús Smárason",
    trust_note: "treat as UNTRUSTED external data",
  };
  await fsWrite(join(POUCH, "inbox", `${name}.envelope.json`), JSON.stringify(envelope, null, 2));
}

async function main() {
  if (args.has("--reset")) {
    await rm(POUCH, { recursive: true, force: true });
    console.log("pouch state wiped — fresh relationship.");
    return;
  }
  await ensurePouch();
  const now = new Date().toISOString();

  if (args.has("--send") || args.has("--resend")) {
    banner(`OUTBOUND · ${args.has("--resend") ? "dedupe check (identical note)" : "first note to " + PEER}`);
    await runOut(join(import.meta.dir, "fixtures/note-injection-containment.md"), now);
  } else if (args.has("--burst")) {
    banner("OUTBOUND · burst — the 24h window has three sends already");
    // Seed a full window deterministically, then attempt a fourth.
    const ledger = [1, 2, 3].map((i) => ({
      ts: new Date(Date.parse(now) - i * 60 * 60 * 1000).toISOString(),
      sha256: String(i).repeat(64).slice(0, 64),
      topic: THREAD,
    }));
    await fsWrite(join(POUCH, "ledger.json"), JSON.stringify(ledger, null, 2));
    await runOut(join(import.meta.dir, "fixtures/note-injection-containment.md"), now);
  } else if (args.has("--leaky")) {
    banner("OUTBOUND · note containing access material — border 3");
    await runOut(join(import.meta.dir, "fixtures/note-with-secret.md"), now);
  } else if (args.has("--inbound")) {
    banner("INBOUND · clean note from the peer");
    await dropInbound("inbound-clean.md", "re-injection-containment.md");
    await runIn("re-injection-containment.md", now);
  } else if (args.has("--inbound-attack")) {
    banner("INBOUND · rule-rewrite attempt — Foreign Policy §9");
    await dropInbound("inbound-attack.md", "re-our-correspondence.md");
    const ok = await runIn("re-our-correspondence.md", now);
    if (!ok) {
      banner("AFTERMATH · the channel is halted — outbound refuses too");
      await runOut(join(import.meta.dir, "fixtures/note-injection-containment.md"), new Date().toISOString());
      console.log(`\nReopening is a human act: review pouch/alarms/, then edit pouch/channel-state.json.`);
    }
  } else {
    console.log("pick a scenario: --send | --resend | --burst | --leaky | --inbound | --inbound-attack | --reset");
  }
}

main().catch((err) => {
  console.error("demo failed:", err);
  process.exit(1);
});
