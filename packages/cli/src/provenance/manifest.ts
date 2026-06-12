import { filesFromPatch, patchStats, stagedNumstat } from "../git/diff";
import type { ActiveSession, CommandRecord, FormatterBridgeEvent, NormalizedEditEvent } from "./schema";

type ManifestSession = {
  id: string;
  metadata: string;
  patch?: string;
};

type Manifest = {
  version: 1;
  generatedBy: string;
  sessions: ManifestSession[];
};

export async function writeBundle(
  root: string,
  active: ActiveSession,
  patch: string,
  events: NormalizedEditEvent[],
  agents: string[],
  formatterBridgeEvents: FormatterBridgeEvent[] = [],
  commands: CommandRecord[] = [],
): Promise<void> {
  const dir = `${root}/.percentvibed/v1`;
  const id = await uniqueSessionId(active.id, root);
  const capturedAt = new Date().toISOString();
  const stats = stagedNumstat(root);
  const fileStats = patchStats(patch).files;
  const files = filesFromPatch(patch);
  const confidence = averageConfidence(events);

  await Bun.$`mkdir -p ${dir}/sessions`;

  await Bun.write(
    `${dir}/sessions/${id}.json`,
    JSON.stringify(
      {
        version: 1,
        id,
        capturedAt,
        startedAt: active.startedAt,
        git: { branch: active.branch, baseCommit: active.baseCommit },
        stats: { filesChanged: files.length, added: stats.added, deleted: stats.deleted },
        files,
        fileStats,
        agentSignals: {
          detectedSessions: events.length ? 1 : 0,
          agents: [...new Set(agents)],
          confidence,
        },
        commandSignals: {
          commandsSeen: commands.map((command) => ({
            id: command.id,
            source: command.source,
            command: command.commandText,
            kind: command.kind,
            exitCode: command.exitCode,
            filesChanged: command.files.length,
            startedAt: command.startedAt,
            endedAt: command.endedAt,
          })),
          formatterBridgeCommands: commands.filter((command) => command.kind === "formatter" || command.kind === "lint_fix").length,
        },
        editEvents: events,
        formatterBridgeEvents,
        redacted: true,
      },
      null,
      2,
    ),
  );

  const manifest = await readManifest(dir);
  manifest.sessions = manifest.sessions.filter((session) => session.id !== id);
  manifest.sessions.push({
    id,
    metadata: `sessions/${id}.json`,
  });

  await Bun.write(`${dir}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function readManifest(dir: string): Promise<Manifest> {
  const path = `${dir}/manifest.json`;

  if (await Bun.file(path).exists()) {
    try {
      const manifest = (await Bun.file(path).json()) as Manifest;
      return {
        version: 1,
        generatedBy: "percentvibed@0.1.0",
        sessions: Array.isArray(manifest.sessions) ? manifest.sessions : [],
      };
    } catch {
      // Fall through and replace malformed local generated metadata.
    }
  }

  return {
    version: 1,
    generatedBy: "percentvibed@0.1.0",
    sessions: [],
  };
}

async function uniqueSessionId(baseId: string, root: string): Promise<string> {
  const now = new Date();
  const suffix = `${now.getUTCHours()}${now.getUTCMinutes()}${now.getUTCSeconds()}${now.getUTCMilliseconds()}`;
  const basePath = `${root}/.percentvibed/v1/sessions/${baseId}.json`;

  if (!(await Bun.file(basePath).exists())) {
    return baseId;
  }

  return `${baseId}_${suffix}`;
}

function averageConfidence(events: NormalizedEditEvent[]): number {
  if (events.length === 0) return 0;

  const average = events.reduce((sum, event) => sum + event.confidence, 0) / events.length;
  return Math.round(average * 100) / 100;
}
