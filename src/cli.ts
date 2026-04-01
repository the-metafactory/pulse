#!/usr/bin/env bun
import { Command } from "commander";
import { createRunCommand } from "./commands/run";
import { createValidateCommand } from "./commands/validate";
import { createStatusCommand } from "./commands/status";

const program = new Command();

program
  .name("pulse")
  .description("Process execution engine for the metafactory ecosystem")
  .version("0.1.0");

program.addCommand(createRunCommand());
program.addCommand(createValidateCommand());
program.addCommand(createStatusCommand());

program.parse();
