import { existsSync } from "node:fs";
import { repoRoot } from "../git/repo";
export async function hook(args: string[]) {
  if (args[0] !== "pre-push") throw new Error("unknown hook");
  const root = repoRoot();
  if (!existsSync(`${root}/.percentvibed`)) return;
  if (process.env.PERCENTVIBED_MANAGED_PUSH === "1")
    console.error("PercentVibed: managed push detected.");
  else
    console.error(
      "PercentVibed: .percentvibed/ detected, but this push was not run through `percentvibed push`.\n\nThe PR report may still work, but local cleanup will not run automatically.\n\nUse next time:\n  percentvibed push",
    );
}
