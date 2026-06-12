import { repoRoot } from "../git/repo";
import type { ActiveSession } from "../provenance/schema";
import {
  changedFilesAfterCommand,
  classifyCommand,
  createBeforeSnapshot,
  isFormatterBridgeCommand,
  writeCommandRecord,
} from "../provenance/formatter-bridge";

export async function run(args: string[]): Promise<void> {
  const command = parseRunArgs(args);
  const root = repoRoot();
  const activeSessionPath = `${root}/.git/percentvibed/active-session.json`;

  if (!(await Bun.file(activeSessionPath).exists())) {
    throw new Error("No active session. Run percentvibed start before percentvibed run.");
  }

  const activeSession = (await Bun.file(activeSessionPath).json()) as ActiveSession;
  const kind = classifyCommand(command);
  const before = createBeforeSnapshot(root);
  const startedAt = new Date().toISOString();

  const child = Bun.spawn(command, {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, PERCENTVIBED_RUN: "1" },
  });

  const exitCode = await child.exited;
  const endedAt = new Date().toISOString();
  const files = changedFilesAfterCommand(root, before);
  const record = writeCommandRecord(root, activeSession, command, startedAt, endedAt, exitCode, files);

  const countedHint = isFormatterBridgeCommand(kind)
    ? "can preserve AI attribution for matching agent-edited files when captured"
    : "is recorded for audit context but will not affect AI attribution";

  console.error(
    `PercentVibed recorded ${record.commandText} as ${kind}; ${files.length} changed file(s) ${countedHint}.`,
  );

  process.exit(exitCode);
}

function parseRunArgs(args: string[]): string[] {
  const command = args[0] === "--" ? args.slice(1) : args;

  if (command.length === 0) {
    throw new Error("run requires a command, for example: percentvibed run -- bun run format");
  }

  return command;
}
