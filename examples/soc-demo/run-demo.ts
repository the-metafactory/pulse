export * from "../../src/lib/composer/scenario";
import { join } from "node:path";
import * as scenarioLibrary from "../../src/lib/composer/scenario";
export const BLOCKS_DIR = join(import.meta.dir, "blocks");
export const runScenario = (request: string, options: Omit<scenarioLibrary.RunScenarioOptions, "blocksDir"> & { blocksDir?: string }) => scenarioLibrary.runScenario(request, { ...options, blocksDir: options.blocksDir ?? BLOCKS_DIR });
export const runSavedFlow = (yaml: string, options: Omit<scenarioLibrary.RunScenarioOptions, "blocksDir"> & { blocksDir?: string }) => scenarioLibrary.runSavedFlow(yaml, { ...options, blocksDir: options.blocksDir ?? BLOCKS_DIR });
export const composeFlow = (request: string, options: Omit<Parameters<typeof scenarioLibrary.composeScenario>[1], "blocksDir"> & { blocksDir?: string }) => scenarioLibrary.composeScenario(request, { ...options, blocksDir: options.blocksDir ?? BLOCKS_DIR });
import { makeStubLLM, resolveAgentProvider } from "../../src/lib/composer/scenario";
import { createLocalCapabilities } from "../../src/lib/capabilities";
import { StdinGateProvider } from "../../src/lib/gate-provider";
import type { GateProvider } from "../../src/types/pipeline";
import { ConsolePoster, MMAckGateProvider, MattermostThread, mmConfigFromEnv, type ThreadPoster } from "../../src/lib/composer/mm";
if (import.meta.main) {
  const scenario = process.argv.slice(2).join(" ").trim();
  if (!scenario) {
    console.error('Usage: bun examples/soc-demo/run-demo.ts "<scenario from the audience>"');
    process.exit(1);
  }

  const mmConfig = mmConfigFromEnv();
  const thread = mmConfig ? new MattermostThread(mmConfig) : null;
  const poster: ThreadPoster = thread ?? new ConsolePoster();
  const gateProvider: GateProvider = thread ? new MMAckGateProvider(thread) : new StdinGateProvider();
  if (!mmConfig) console.log("📭 MATTERMOST_* unset — console mode (stub-safe)");

  const llm = process.env.ANTHROPIC_API_KEY
    ? (await createLocalCapabilities(["llm"])).llm ?? makeStubLLM()
    : (console.log("🤖 ANTHROPIC_API_KEY unset — stub composer LLM"), makeStubLLM());

  const agentProvider = resolveAgentProvider(llm);
  if (agentProvider) console.log(`🧠 local model enabled (${process.env.PULSE_LOCAL_MODEL ?? "llama3.2:latest"}) — local-only steps route to Ollama`);
  const result = await runScenario(scenario, {
    llm,
    poster,
    gateProvider,
    ...(agentProvider && { agentProvider }),
  });
  console.log(`\n[run-demo] ${result.status}`);
  process.exit(result.status === "complete" || result.status === "no-match" ? 0 : 1);
}
