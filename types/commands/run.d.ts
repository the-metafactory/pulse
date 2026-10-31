import { Command } from "commander";
import { PulseRunner } from "../lib/runner";
export declare function createRunCommand(): Command;
export declare function runTreeWithEvents(runner: PulseRunner, tree: any, verbose: boolean): Promise<void>;
