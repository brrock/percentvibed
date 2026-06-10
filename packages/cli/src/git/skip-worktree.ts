import { git } from "./repo";
export function trackedPercentFiles(root: string) {
  const r = git(["ls-files", "-z", ".percentvibed"], root);
  return r.stdout.split("\0").filter(Boolean);
}
export function setSkip(root: string, files: string[], skip: boolean) {
  if (!files.length) return;
  git(["update-index", skip ? "--skip-worktree" : "--no-skip-worktree", "--", ...files], root);
}
export function hiddenPercentFiles(root: string) {
  const r = git(["ls-files", "-v", ".percentvibed"], root);
  return r.stdout
    .split("\n")
    .filter((l) => l.startsWith("S "))
    .map((l) => l.slice(2));
}
