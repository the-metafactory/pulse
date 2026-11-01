import { Command } from "commander";
import { RoutineContractInput, routineContract } from "../lib/routine-contract";

export function createRoutineContractCommand(): Command {
  return new Command("routine-contract").description("Inspect or validate routine parameter patches without execution").action(async () => {
    try {
      const input = await Bun.stdin.text();
      if (input.length > 1100000) throw new Error("Routine contract input exceeds the size limit");
      const request = RoutineContractInput.parse(JSON.parse(input));
      process.stdout.write(JSON.stringify(routineContract(request)));
    } catch (error) {
      const text = error instanceof Error ? error.message : "";
      const safe = /^(\[[\s\S]*?\]): (parameter is not declared editable|expected (?:string|number|boolean)|value outside allowed integer range|value is not an allowed choice)$/.exec(text);
      process.stdout.write(JSON.stringify({ error: safe ? `${safe[1]}: ${safe[2]}` : "Flow or parameter validation failed. Refresh the routine and check its editable field contracts." }));
      process.exitCode = 1;
    }
  });
}
