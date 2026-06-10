import { spawnSync } from "bun";
export function git(args: string[], cwd = process.cwd(), env: Record<string, string> = {}) {
  const r = spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: r.exitCode,
    stdout: new TextDecoder().decode(r.stdout),
    stderr: new TextDecoder().decode(r.stderr),
  };
}
export function repoRoot() {
  const r = git(["rev-parse", "--show-toplevel"]);
  if (r.code !== 0) throw new Error("Not inside a git repository");
  return r.stdout.trim();
}
export function currentBranch(root: string) {
  const r = git(["branch", "--show-current"], root);
  return r.stdout.trim() || "HEAD";
}
export function headCommit(root: string) {
  const r = git(["rev-parse", "HEAD"], root);
  return r.code === 0 ? r.stdout.trim() : "";
}
export function ensureDir(path: string) {
  return Bun.write(path.replace(/\/[^/]+$/, "/.keep"), "")
    .then(() => {})
    .catch(() => {});
}
