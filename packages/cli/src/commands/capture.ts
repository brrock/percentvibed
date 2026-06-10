import { stagedDiff, filesFromPatch } from "../git/diff";
import { repoRoot } from "../git/repo";
import { logDebug } from "../provenance/log";
import { writeBundle } from "../provenance/manifest";
import { findSecretHits, unsafePaths } from "../provenance/redact";
import { prepareTransportForCapture } from "../provenance/transport";
import type { ActiveSession, NormalizedEditEvent } from "../provenance/schema";
import { scanCursorIde } from "../scanner/cursor-sqlite";
import { runZigScanner } from "../scanner/run-zig-scanner";

export async function capture(args: string[]): Promise<void> {
  const root = repoRoot();
  const activeSessionPath = `${root}/.git/percentvibed/active-session.json`;

  if (!(await Bun.file(activeSessionPath).exists())) {
    throw new Error("No active session. Run percentvibed start first.");
  }

  const activeSession = (await Bun.file(activeSessionPath).json()) as ActiveSession;

  logDebug(root, "capture:start", {
    sessionId: activeSession.id,
    startedAt: activeSession.startedAt,
  });

  const patch = stagedDiff(root);

  if (!patch.trim()) {
    throw new Error("No staged changes to capture.");
  }

  const stagedFiles = filesFromPatch(patch);
  assertPatchIsSafe(patch, stagedFiles);

  await prepareTransportForCapture(root);

  logDebug(root, "scanner:zig:start", {
    since: activeSession.startedAt,
    stagedFiles: stagedFiles.length,
  });

  const zigResult = await runZigScanner(root, activeSession.startedAt);

  logDebug(root, "scanner:zig:done", {
    events: zigResult.events.length,
    agents: zigResult.agents.join(","),
  });

  const cursorEvents = scanCursorIdeSafely(root, activeSession.startedAt);

  logDebug(root, "scanner:cursor-ide:done", {
    events: cursorEvents.length,
  });

  const stagedFileSet = new Set(stagedFiles);
  const editEvents = [...zigResult.events, ...cursorEvents]
    .filter((event) => stagedFileSet.has(event.file))
    .slice(0, 500);

  const agents = [...new Set(editEvents.map((event) => event.agent))];

  logDebug(root, "capture:matched-events", {
    matchedEvents: editEvents.length,
    agents: agents.join(","),
  });

  await writeBundle(
    root,
    activeSession,
    patch,
    editEvents,
    agents.length > 0 ? agents : ["unknown"],
  );

  const evidenceLine = editEvents.length === 0
    ? "No matching agent edit evidence was found; this capture will not count as agent-assisted.\n"
    : `Found ${editEvents.length} matching agent edit event(s).\n`;

  logDebug(root, "capture:done", {
    files: stagedFiles.length,
    matchedEvents: editEvents.length,
  });

  console.log(
    `Captured ${stagedFiles.length} staged file(s) into .percentvibed/v1/.\n` +
      evidenceLine +
      `Debug log: .git/percentvibed/debug.log\n` +
      `Next: git add .percentvibed && git commit -m "..."`,
  );
}

function assertPatchIsSafe(patch: string, files: string[]): void {
  const privateFiles = unsafePaths(files);
  const secretHits = findSecretHits(patch);

  if (privateFiles.length === 0 && secretHits.length === 0) {
    return;
  }

  throw new Error(
    "Refusing to capture possible secrets/private files. " +
      `Files: ${privateFiles.join(", ") || "none"}; ` +
      `patterns: ${secretHits.join(", ") || "none"}`,
  );
}

function scanCursorIdeSafely(root: string, since: string): NormalizedEditEvent[] {
  try {
    return scanCursorIde(root, since);
  } catch {
    return [];
  }
}
