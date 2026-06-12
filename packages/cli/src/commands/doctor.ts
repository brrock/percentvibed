import { nativeAddonPath } from "@percentvibed/scanner";
import { hasHook } from "../git/hooks";
import { repoRoot } from "../git/repo";
import { hiddenPercentFiles } from "../git/skip-worktree";

type Check = {
  name: string;
  ok: boolean | Promise<boolean>;
  fix: string;
};

export async function doctor(): Promise<void> {
  const root = findRepoOrReport();
  if (!root) return;

  const checks: Check[] = [
    {
      name: "config exists",
      ok: Bun.file(`${root}/.percentvibed.json`).exists(),
      fix: "run percentvibed init",
    },
    {
      name: "active session exists",
      ok: Bun.file(`${root}/.git/percentvibed/active-session.json`).exists(),
      fix: "run percentvibed start before agent work",
    },
    {
      name: ".percentvibed bundle exists",
      ok: Bun.file(`${root}/.percentvibed`).exists(),
      fix: "run percentvibed capture",
    },
    {
      name: "pre-push hook installed",
      ok: hasHook(root),
      fix: "run percentvibed install-hooks",
    },
    {
      name: "README exists",
      ok: Bun.file(`${root}/README.md`).exists(),
      fix: "optional: create a README for project docs",
    }
  ];

  for (const check of checks) {
    await printCheck(check);
  }

  console.log(`Hidden .percentvibed skip-worktree files: ${hiddenPercentFiles(root).length}`);
  await printScannerCheck();
}

function findRepoOrReport(): string | undefined {
  try {
    const root = repoRoot();
    console.log("✓ inside git repo", root);
    return root;
  } catch {
    console.log("✗ not inside git repo");
    return undefined;
  }
}

async function printCheck(check: Check): Promise<void> {
  const ok = await check.ok;
  console.log(`${ok ? "✓" : "!"} ${check.name}${ok ? "" : ` — ${check.fix}`}`);
}

async function printScannerCheck(): Promise<void> {
  try {
    console.log(`✓ Native scanner N-API addon available (${nativeAddonPath()})`);
  } catch {
    console.log("✗ Native scanner N-API addon missing (capture requires it)");
  }
}
