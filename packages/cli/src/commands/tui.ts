import type { Command } from "commander";

/** Compatibility entrypoint; interactive terminal rendering has been retired. */
export function registerTuiCommand(program: Command): void {
  program.command("tui").alias("watch")
    .description("Retired terminal UI; use 0 web for interactive work")
    .action(() => {
      console.log("The interactive terminal UI has been retired. Run 0 web to open the browser console. Headless commands and 0 chat --prompt remain available.");
    });
}
