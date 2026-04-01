import { Command } from "commander";
import { TreeParser } from "../lib/parser";

export function createValidateCommand(): Command {
  return new Command("validate")
    .description("Validate a tree JSON file")
    .argument("<file>", "Path to tree JSON file")
    .action(async (file: string) => {
      const json = await Bun.file(file).json();
      const parser = new TreeParser();

      try {
        const tree = parser.parse(json);
        const result = parser.validate(tree);

        if (result.valid) {
          console.log(`✓ Tree "${tree.id}" is valid (${tree.nodes.length} nodes)`);
          // Show structure
          for (const node of tree.nodes) {
            const deps = node.dependsOn?.length
              ? ` (depends on: ${node.dependsOn.join(", ")})`
              : " (root)";
            console.log(`  - ${node.id}: ${node.name}${deps}`);
          }
        } else {
          console.error(`✗ Tree "${tree.id}" has errors:`);
          for (const err of result.errors) {
            console.error(`  [${err.code}] ${err.message}`);
          }
          process.exit(1);
        }
      } catch (err: any) {
        console.error(`✗ Parse error: ${err.message}`);
        process.exit(1);
      }
    });
}
