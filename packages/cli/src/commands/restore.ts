import { repoRoot, git } from "../git/repo";
import { setSkip, trackedPercentFiles } from "../git/skip-worktree";
export async function restore() {
  const root = repoRoot();
  const files = trackedPercentFiles(root);
  setSkip(root, files, false);
  git(["restore", ".percentvibed"], root);
  console.log(`Restored .percentvibed (${files.length} file(s)).`);
}
