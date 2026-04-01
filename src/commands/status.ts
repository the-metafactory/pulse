import { Command } from "commander";

export function createStatusCommand(): Command {
  return new Command("status")
    .description("Show last execution status")
    .action(() => {
      console.log("No execution history available.");
      console.log("Run a tree first: pulse run <tree.json>");
    });
}
