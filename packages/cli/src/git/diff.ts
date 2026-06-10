import { git } from "./repo";
export function stagedDiff(root: string) {
  const r = git(
    ["diff", "--cached", "--binary", "--find-renames", "--", ".", ":(exclude).percentvibed/**"],
    root,
  );
  if (r.code !== 0) throw new Error(r.stderr);
  return r.stdout;
}
export function diffNumstat(root: string, base: string) {
  const r = git(
    [
      "diff",
      "--numstat",
      base,
      "--",
      ".",
      ":(exclude).percentvibed/**",
      ":(exclude)dist/**",
      ":(exclude)build/**",
      ":(exclude)generated/**",
    ],
    root,
  );
  return parseNumstat(r.stdout);
}
export function stagedNumstat(root: string) {
  const r = git(["diff", "--cached", "--numstat", "--", ".", ":(exclude).percentvibed/**"], root);
  return parseNumstat(r.stdout);
}
export function parseNumstat(out: string) {
  let added = 0,
    deleted = 0;
  const files: { file: string; added: number; deleted: number }[] = [];
  for (const l of out.trim().split(/\n/).filter(Boolean)) {
    const [a, d, ...rest] = l.split(/\t/);
    const aa = a === "-" ? 0 : +a,
      dd = d === "-" ? 0 : +d;
    added += aa;
    deleted += dd;
    files.push({ file: rest.join("\t"), added: aa, deleted: dd });
  }
  return { added, deleted, files };
}
export function filesFromPatch(patch: string) {
  const s = new Set<string>();
  for (const m of patch.matchAll(/^diff --git a\/(.*?) b\/(.*?)$/gm)) s.add(m[2]);
  return [...s].filter((f) => !f.startsWith(".percentvibed/"));
}

export type PatchFileStat = {
  file: string;
  added: number;
  deleted: number;
};

export function patchStats(patch: string): { added: number; deleted: number; files: PatchFileStat[] } {
  const byFile = new Map<string, PatchFileStat>();
  let current: PatchFileStat | undefined;

  for (const line of patch.split(/\n/)) {
    const diffMatch = line.match(/^diff --git a\/(.*?) b\/(.*?)$/);

    if (diffMatch) {
      const file = diffMatch[2];
      current = byFile.get(file) ?? { file, added: 0, deleted: 0 };
      byFile.set(file, current);
      continue;
    }

    if (!current || current.file.startsWith(".percentvibed/")) continue;
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;

    if (line.startsWith("+")) current.added += 1;
    if (line.startsWith("-")) current.deleted += 1;
  }

  const files = [...byFile.values()].filter((file) => !file.file.startsWith(".percentvibed/"));

  return {
    added: files.reduce((sum, file) => sum + file.added, 0),
    deleted: files.reduce((sum, file) => sum + file.deleted, 0),
    files,
  };
}
