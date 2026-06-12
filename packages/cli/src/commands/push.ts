import { existsSync } from "node:fs";
import { currentBranch, git, repoRoot } from "../git/repo";
import { setSkip, trackedPercentFiles } from "../git/skip-worktree";
import { clean } from "./clean";

type PushOptions = {
  gitArgs: string[];
  allowMain: boolean;
};

const MAIN_BRANCHES = new Set(["main", "master"]);

export async function push(args: string[]): Promise<void> {
  const root = repoRoot();
  const options = parsePushOptions(args);
  const branch = currentBranch(root);
  const pushingDirectlyToMain = MAIN_BRANCHES.has(branch);

  if (pushingDirectlyToMain) {
    await confirmAndDropProvenanceBeforeMainPush(root, branch, options.allowMain);
  }

  const result = git(["push", ...options.gitArgs], root, {
    PERCENTVIBED_MANAGED_PUSH: "1",
  });

  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);

  if (result.code !== 0) {
    process.exit(result.code);
  }

  if (!pushingDirectlyToMain && existsSync(`${root}/.percentvibed`)) {
    await clean(["--hide"]);
  }
}

function parsePushOptions(args: string[]): PushOptions {
  const gitArgs: string[] = [];
  let allowMain = false;

  for (const arg of args) {
    if (arg === "--allow-main" || arg === "--yes-main") {
      allowMain = true;
    } else {
      gitArgs.push(arg);
    }
  }

  return { gitArgs, allowMain };
}

async function confirmAndDropProvenanceBeforeMainPush(
  root: string,
  branch: string,
  allowMain: boolean,
): Promise<void> {
  if (!allowMain) {
    if (!canPrompt()) {
      throw new Error(
        `Refusing to run managed push directly from ${branch} in a non-interactive terminal.\n\n` +
          "PercentVibed reports are PR-oriented, so direct main pushes drop local PercentVibed state before pushing.\n\n" +
          "If this is intentional, rerun with:\n" +
          "  percentvibed push --allow-main",
      );
    }

    const proceed = confirm(
      `You are about to push directly from ${branch}. PercentVibed only reports through PRs, ` +
        "so local PercentVibed state will be removed before pushing. Continue?",
    );

    if (!proceed) {
      throw new Error("Push cancelled.");
    }
  }

  assertNoTrackedTransportWillBePushed(root, branch);
  await removeLocalPercentVibedState(root);
}

function assertNoTrackedTransportWillBePushed(root: string, branch: string): void {
  const trackedFiles = trackedPercentFiles(root);
  if (trackedFiles.length === 0) return;

  throw new Error(
    `.percentvibed files are tracked on ${branch}. A direct main push would publish PR-only provenance data.\n\n` +
      "Remove it from the commit first, for example:\n" +
      "  git rm -r .percentvibed\n" +
      "  git commit --amend\n\n" +
      "Then rerun:\n" +
      "  percentvibed push --allow-main",
  );
}

async function removeLocalPercentVibedState(root: string): Promise<void> {
  const trackedFiles = trackedPercentFiles(root);
  setSkip(root, trackedFiles, false);

  await Bun.$`rm -rf ${root}/.percentvibed`;
  await Bun.$`rm -f ${root}/.git/percentvibed/active-session.json`;

  console.log("Removed local PercentVibed state before direct main push.");
}

function canPrompt(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && process.env.TERM !== "dumb");
}
