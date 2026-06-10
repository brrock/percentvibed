import { currentBranch, headCommit, repoRoot } from "../git/repo";
import type { ActiveSession } from "../provenance/schema";
export async function start() {
  const root = repoRoot();
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const id = `pv_${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  const s: ActiveSession = {
    version: 1,
    id,
    startedAt: d.toISOString(),
    branch: currentBranch(root),
    baseCommit: headCommit(root),
  };
  await Bun.$`mkdir -p ${root}/.git/percentvibed`;
  await Bun.write(`${root}/.git/percentvibed/active-session.json`, JSON.stringify(s, null, 2));
  console.log(
    `PercentVibed session started: ${id}\n\nUse your agent normally. Later run:\n  git add <changed-files>\n  percentvibed capture\n  git add .percentvibed`,
  );
}
