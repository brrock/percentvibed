import { repoRoot } from "../git/repo";
import { setSkip, trackedPercentFiles } from "../git/skip-worktree";
export async function clean(args: string[]) {
  if (!args.includes("--hide")) throw new Error("clean requires --hide");
  const root = repoRoot();
  const files = trackedPercentFiles(root);
  setSkip(root, files, true);
  await Bun.$`rm -rf ${root}/.percentvibed`;
  console.log(`Hidden ${files.length} tracked .percentvibed file(s) locally.`);
}
