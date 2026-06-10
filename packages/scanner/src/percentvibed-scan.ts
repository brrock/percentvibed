#!/usr/bin/env bun
import { existsSync } from "fs";
import { join } from "path";

const platformPackage = `@percentvibed/scanner-${process.platform}-${process.arch}`;
const executable = process.platform === "win32" ? "percentvibed-scan.exe" : "percentvibed-scan";

const candidates = [
  process.env.PERCENTVIBED_SCANNER_NATIVE,
  join(import.meta.dir, "..", "..", platformPackage, "bin", executable),
  join(import.meta.dir, "..", "..", "scanner-zig", "zig-out", "bin", executable),
  join(import.meta.dir, "..", "..", "cli", "bin", executable),
].filter(Boolean) as string[];

for (const candidate of candidates) {
  if (!existsSync(candidate)) continue;

  const child = Bun.spawn([candidate, ...Bun.argv.slice(2)], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  process.exit(await child.exited);
}

console.error(`PercentVibed scanner binary missing for ${process.platform}/${process.arch}.`);
console.error("Build packages/scanner-zig or install the matching @percentvibed/scanner-* package.");
process.exit(1);
