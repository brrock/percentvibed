import { repoRoot } from "../git/repo";
import { defaultConfig } from "../provenance/schema";

export async function init(): Promise<void> {
  const root = repoRoot();
  const created = await createConfigIfMissing(root);

  if (created) {
    console.log("PercentVibed initialized: wrote .percentvibed.json.");
  } else {
    console.log("PercentVibed already initialized: .percentvibed.json exists.");
  }

  console.log("Next: percentvibed start");
}

async function createConfigIfMissing(root: string): Promise<boolean> {
  const path = `${root}/.percentvibed.json`;

  if (await Bun.file(path).exists()) {
    return false;
  }

  await Bun.write(path, `${JSON.stringify(defaultConfig, null, 2)}\n`);
  return true;
}
