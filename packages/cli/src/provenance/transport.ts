import { git } from "../git/repo";
import { setSkip, trackedPercentFiles } from "../git/skip-worktree";

type ManifestSession = {
  metadata?: string;
  patch?: string;
};

/**
 * `.percentvibed/` is removed locally after a managed push with skip-worktree.
 * The next capture must be able to create a fresh transport directory anyway.
 *
 * To support multi-commit PRs without requiring the local directory to remain:
 * 1. clear skip-worktree on the previously committed transport files;
 * 2. remove the local directory;
 * 3. hydrate the last committed bundle from HEAD, if one exists;
 * 4. the new capture appends/replaces generated files on top of that bundle.
 */
export async function prepareTransportForCapture(root: string): Promise<void> {
  const trackedFiles = trackedPercentFiles(root);
  setSkip(root, trackedFiles, false);

  await Bun.$`rm -rf ${root}/.percentvibed`;
  await hydrateCommittedBundle(root);
}

async function hydrateCommittedBundle(root: string): Promise<void> {
  const manifestText = gitShow(root, ".percentvibed/v1/manifest.json");
  if (!manifestText) return;

  await Bun.$`mkdir -p ${root}/.percentvibed/v1/sessions`;
  await Bun.write(`${root}/.percentvibed/v1/manifest.json`, manifestText);

  const manifest = parseManifest(manifestText);
  for (const session of manifest.sessions ?? []) {
    if (session.metadata) await hydrateFile(root, `.percentvibed/v1/${session.metadata}`);
    if (session.patch) await hydrateFile(root, `.percentvibed/v1/${session.patch}`);
  }
}

async function hydrateFile(root: string, path: string): Promise<void> {
  const content = gitShow(root, path);
  if (!content) return;

  const destination = `${root}/${path}`;
  await Bun.$`mkdir -p ${destination.substring(0, destination.lastIndexOf("/"))}`;
  await Bun.write(destination, content);
}

function gitShow(root: string, path: string): string | undefined {
  const result = git(["show", `HEAD:${path}`], root);
  return result.code === 0 ? result.stdout : undefined;
}

function parseManifest(text: string): { sessions?: ManifestSession[] } {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
