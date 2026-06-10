#!/usr/bin/env bun
import { capture } from "./commands/capture";
import { clean } from "./commands/clean";
import { detectorsInspect } from "./commands/detectors-inspect";
import { doctor } from "./commands/doctor";
import { hook } from "./commands/hook";
import { init } from "./commands/init";
import { installHooks } from "./commands/install-hooks";
import { push } from "./commands/push";
import { report } from "./commands/report";
import { restore } from "./commands/restore";
import { start } from "./commands/start";
import { updateComment } from "./github/comment";

const [, , command, subcommand, ...rest] = Bun.argv;

try {
  await dispatch(command, subcommand, rest);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

async function dispatch(command?: string, subcommand?: string, rest: string[] = []) {
  switch (command) {
    case "init":
      return init();
    case "start":
      return start();
    case "capture":
      return capture([subcommand, ...rest].filter(Boolean) as string[]);
    case "install-hooks":
      return installHooks();
    case "hook":
      return hook([subcommand, ...rest].filter(Boolean) as string[]);
    case "push":
      return push([subcommand, ...rest].filter(Boolean) as string[]);
    case "clean":
      return clean([subcommand, ...rest].filter(Boolean) as string[]);
    case "restore":
      return restore();
    case "report":
      return report([subcommand, ...rest].filter(Boolean) as string[]);
    case "doctor":
      return doctor();
    case "detectors":
      if (subcommand === "inspect") return detectorsInspect(rest);
      break;
    case "github":
      if (subcommand === "update-comment") {
        const file = valueAfter(rest, "--file");
        if (!file) throw new Error("github update-comment requires --file <file>");
        return updateComment(file);
      }
      break;
    case "help":
    case undefined:
      return printHelp();
  }

  throw new Error(`Unknown command. Run percentvibed help.`);
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function printHelp() {
  console.log(`PercentVibed

Commands:
  init
  start
  capture
  install-hooks
  hook pre-push
  push [...git-push-args]
  clean --hide
  restore
  report --base <ref> --format markdown [--out <file>]
  github update-comment --file <file>
  doctor
  detectors inspect [--out <file>]
`);
}
