#!/usr/bin/env bun
import { Command } from "commander";
import { parse } from "yaml";
import { z } from "zod";
import { createRunCommand } from "./commands/run";
import { createValidateCommand } from "./commands/validate";
import { createStatusCommand } from "./commands/status";
import { createFlowCommand } from "./commands/flow";

import { createComposeCommand } from "./commands/compose";
import { createRoutineContractCommand } from "./commands/routine-contract";

const program = new Command();
const release = z.object({ version: z.string() }).parse(parse(await Bun.file(new URL("../arc-manifest.yaml", import.meta.url)).text()));

program
  .name("pulse")
  .description("Process execution engine for the metafactory ecosystem")
  .version(release.version);

program.addCommand(createComposeCommand());
program.addCommand(createRoutineContractCommand());
program.addCommand(createRunCommand());
program.addCommand(createValidateCommand());
program.addCommand(createStatusCommand());
program.addCommand(createFlowCommand());

program.parse();
