#!/usr/bin/env bun
import { scanJson } from "./index";

const args = Bun.argv.slice(2);
const repo = valueAfter(args, "--repo");
const since = valueAfter(args, "--since");
const json = args.includes("--json");

if (!repo || !since || !json) {
  console.error("usage: percentvibed-scan --repo <repo-root> --since <iso-date> --json");
  process.exit(2);
}

try {
  process.stdout.write(scanJson({ repo, since }));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}
