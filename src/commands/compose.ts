import { Command } from "commander";
import { createLocalCapabilities, chatModelLLM } from "../lib/capabilities";
import { OpenAICompatibleChatModel } from "../lib/chat-model";
import { composeFlow } from "../lib/composer/flow";
import { buildCatalog, loadInstalledCatalog } from "../lib/composer/catalog";
import { proposeRoutineEdit } from "../lib/routine-proposal";

export function createComposeCommand(): Command {
  return new Command("compose")
    .description("Compose and validate a pipeline without executing it")
    .requiredOption("--request <text>", "Plain-language request")
    .option("--json", "Print the typed result as JSON")
    .option("--catalog-dir <path>", "Action directory override")
    .option("--routine-edit <json>", "Propose patches for an owner-redacted routine view without execution")
    .option("--model-url <url>", "OpenAI-compatible model base URL", process.env.PULSE_COMPOSE_MODEL_URL)
    .option("--model <name>", "Model name for --model-url", process.env.PULSE_COMPOSE_MODEL)
    .action(async (options: { request: string; json?: boolean; catalogDir?: string; modelUrl?: string; model?: string; routineEdit?: string }) => {
      try {
        if (Boolean(options.modelUrl) !== Boolean(options.model)) throw new Error("--model-url and --model must be supplied together");
        const llm = options.modelUrl && options.model
          ? chatModelLLM(new OpenAICompatibleChatModel({ baseUrl: options.modelUrl, model: options.model, apiKeyEnv: "PULSE_COMPOSE_API_KEY", label: "pulse-compose" }))
          : (await createLocalCapabilities(["llm"])).llm;
        if (!llm) throw new Error("Composer LLM unavailable");
        if (options.routineEdit) {
          const result = await proposeRoutineEdit(options.request, JSON.parse(options.routineEdit), llm);
          console.log(JSON.stringify(result));
          return;
        }
        const catalog = options.catalogDir ? await buildCatalog(options.catalogDir) : await loadInstalledCatalog();
        if (catalog.length === 0) throw new Error("No installed actions found; install actions with Arc or pass --catalog-dir");
        const result = await composeFlow(options.request, { catalog, llm });
        console.log(options.json ? JSON.stringify(result) : result.status === "complete" ? result.yaml : JSON.stringify(result));
        if (result.status !== "complete") process.exitCode = 1;
      } catch (error) {
        console.log(JSON.stringify({ status: "invalid", kind: "configuration-failed", findings: [{ message: error instanceof Error ? error.message : String(error) }] }));
        process.exitCode = 1;
      }
    });
}
