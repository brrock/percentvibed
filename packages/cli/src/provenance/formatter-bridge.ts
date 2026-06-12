import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import type { ActiveSession, CommandKind, CommandRecord, FormatterBridgeEvent, FormatterBridgeFileStat } from "./schema";
import { sha256 } from "./normalize-edit-event";
import { git } from "../git/repo";

const MAX_TEXT_FILE_BYTES = 2_000_000;
const MAX_LCS_CELLS = 2_000_000;
const FORMATTER_BRIDGE_KINDS = new Set<CommandKind>(["formatter", "lint_fix"]);

type FileSnapshot = {
  exists: boolean;
  hash?: string;
  content?: string;
};

type BeforeSnapshot = {
  paths: Set<string>;
  files: Map<string, FileSnapshot>;
};

export function classifyCommand(command: string[] | string): CommandKind {
  const parts = Array.isArray(command) ? command : splitCommandText(command);
  const lowerParts = parts.map((part) => part.toLowerCase());
  const text = lowerParts.join(" ");

  if (!text.trim()) return "unknown";

  if (
    /(^|\s)(lint:fix|fix:lint)(\s|$)/.test(text) ||
    /(^|\s)lint(\s|$)/.test(text) && /(^|\s)--fix(\s|$)/.test(text) ||
    commandIncludes(lowerParts, "eslint") && lowerParts.includes("--fix") ||
    commandIncludes(lowerParts, "stylelint") && lowerParts.includes("--fix") ||
    commandIncludes(lowerParts, "tslint") && lowerParts.includes("--fix") ||
    commandIncludes(lowerParts, "ruff") && lowerParts.includes("check") && lowerParts.includes("--fix") ||
    commandIncludes(lowerParts, "biome") && lowerParts.includes("check") && hasWriteFlag(lowerParts)
  ) {
    return "lint_fix";
  }

  if (
    /(^|\s)(format(:[\w-]+)?|fmt)(\s|$)/.test(text) ||
    commandIncludes(lowerParts, "prettier") && hasWriteFlag(lowerParts) ||
    commandIncludes(lowerParts, "biome") && lowerParts.includes("format") && hasWriteFlag(lowerParts) ||
    commandIncludes(lowerParts, "ruff") && lowerParts.includes("format") ||
    commandIncludes(lowerParts, "black") ||
    commandIncludes(lowerParts, "isort") ||
    commandIncludes(lowerParts, "stylua") ||
    commandIncludes(lowerParts, "rustfmt") ||
    commandIncludes(lowerParts, "gofmt") && lowerParts.includes("-w") ||
    commandIncludes(lowerParts, "cargo") && lowerParts.includes("fmt") ||
    commandIncludes(lowerParts, "zig") && lowerParts.includes("fmt") ||
    commandIncludes(lowerParts, "dart") && lowerParts.includes("format") ||
    commandIncludes(lowerParts, "clang-format") && lowerParts.includes("-i")
  ) {
    return "formatter";
  }

  if (/(^|\s)test(:|\s|$)/.test(text)) return "test";
  if (/(^|\s)(build|compile)(:|\s|$)/.test(text)) return "build";

  return "unknown";
}

export function isFormatterBridgeCommand(kind: CommandKind): boolean {
  return FORMATTER_BRIDGE_KINDS.has(kind);
}

export function createBeforeSnapshot(root: string): BeforeSnapshot {
  const paths = new Set(changedWorktreePaths(root));
  const files = new Map<string, FileSnapshot>();

  for (const path of paths) {
    files.set(path, snapshotFile(root, path));
  }

  return { paths, files };
}

export function changedFilesAfterCommand(root: string, before: BeforeSnapshot): FormatterBridgeFileStat[] {
  const afterPaths = new Set(changedWorktreePaths(root));
  const paths = new Set([...before.paths, ...afterPaths]);
  const stats: FormatterBridgeFileStat[] = [];

  for (const path of [...paths].sort()) {
    if (!isSafeRepoPath(path) || path.startsWith(".percentvibed/")) continue;

    const beforeFile = before.files.get(path) ?? snapshotHead(root, path);
    const afterFile = snapshotFile(root, path);

    if (beforeFile.exists === afterFile.exists && beforeFile.hash === afterFile.hash) continue;

    const beforeContent = beforeFile.exists ? beforeFile.content : "";
    const afterContent = afterFile.exists ? afterFile.content : "";
    const lineStats = beforeContent === undefined || afterContent === undefined
      ? { added: 0, deleted: 0 }
      : diffLineStats(beforeContent, afterContent);

    stats.push({
      file: path,
      added: lineStats.added,
      deleted: lineStats.deleted,
      beforeHash: beforeFile.hash,
      afterHash: afterFile.hash,
    });
  }

  return stats;
}

export function writeCommandRecord(
  root: string,
  active: ActiveSession,
  command: string[],
  startedAt: string,
  endedAt: string,
  exitCode: number,
  files: FormatterBridgeFileStat[],
): CommandRecord {
  const id = commandRecordId(startedAt);
  const sanitizedCommand = sanitizeCommand(command);
  const record: CommandRecord = {
    version: 1,
    id,
    source: "percentvibed_run",
    sessionId: active.id,
    startedAt,
    endedAt,
    command: sanitizedCommand,
    commandText: sanitizedCommand.join(" "),
    kind: classifyCommand(command),
    exitCode,
    files,
  };

  const dir = `${root}/.git/percentvibed/commands`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/${id}.json`, `${JSON.stringify(record, null, 2)}\n`);

  return record;
}

export async function readFormatterBridgeProvenance(
  root: string,
  since: string,
  stagedFiles: string[],
): Promise<{ commands: CommandRecord[]; events: FormatterBridgeEvent[] }> {
  const dir = `${root}/.git/percentvibed/commands`;
  if (!existsSync(dir)) return { commands: [], events: [] };

  const stagedFileSet = new Set(stagedFiles);
  const sinceMs = Date.parse(since);
  const commands: CommandRecord[] = [];
  const events: FormatterBridgeEvent[] = [];

  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;

    const record = readCommandRecord(`${dir}/${entry}`);
    if (!record) continue;
    if (Number.isFinite(sinceMs) && Date.parse(record.startedAt) < sinceMs) continue;

    commands.push(record);

    if (!isFormatterBridgeCommand(record.kind)) continue;

    for (const file of record.files) {
      if (!stagedFileSet.has(file.file)) continue;

      events.push({
        source: record.source,
        commandId: record.id,
        command: record.commandText,
        kind: record.kind,
        file: file.file,
        stats: { added: Math.max(0, file.added), deleted: Math.max(0, file.deleted) },
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        exitCode: record.exitCode,
        confidence: record.exitCode === 0 ? 0.9 : 0.7,
        beforeHash: file.beforeHash,
        afterHash: file.afterHash,
      });
    }
  }

  commands.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  events.sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  return { commands, events };
}

function hasWriteFlag(parts: string[]): boolean {
  return parts.includes("--write") || parts.includes("--fix") || parts.includes("--apply") || parts.includes("-w");
}

function commandIncludes(parts: string[], executable: string): boolean {
  return parts.some((part) => part === executable || part.endsWith(`/${executable}`) || part.endsWith(`\\${executable}`));
}

function changedWorktreePaths(root: string): string[] {
  return unique([
    ...gitNul(root, ["diff", "--name-only", "-z"]),
    ...gitNul(root, ["diff", "--cached", "--name-only", "-z"]),
    ...gitNul(root, ["ls-files", "-z", "--others", "--exclude-standard"]),
  ]).filter(isSafeRepoPath);
}

function gitNul(root: string, args: string[]): string[] {
  const result = git(args, root);
  if (result.code !== 0 || !result.stdout) return [];
  return result.stdout.split("\0").filter(Boolean);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function snapshotFile(root: string, path: string): FileSnapshot {
  if (!isSafeRepoPath(path)) return { exists: false };

  const fullPath = `${root}/${path}`;
  if (!existsSync(fullPath)) return { exists: false };

  try {
    const stat = statSync(fullPath);
    if (!stat.isFile() || stat.size > MAX_TEXT_FILE_BYTES) return { exists: true };

    const bytes = readFileSync(fullPath);
    const hash = sha256(bytes);
    if (bytes.includes(0)) return { exists: true, hash };

    return { exists: true, hash, content: bytes.toString("utf8") };
  } catch {
    return { exists: false };
  }
}

function snapshotHead(root: string, path: string): FileSnapshot {
  if (!isSafeRepoPath(path)) return { exists: false };

  const result = git(["show", `HEAD:${path}`], root);
  if (result.code !== 0) return { exists: false };

  const content = result.stdout;
  return { exists: true, hash: sha256(content), content };
}

function diffLineStats(beforeText: string, afterText: string): { added: number; deleted: number } {
  const beforeLines = splitLines(beforeText);
  const afterLines = splitLines(afterText);

  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) {
    prefix += 1;
  }

  let beforeEnd = beforeLines.length;
  let afterEnd = afterLines.length;
  while (beforeEnd > prefix && afterEnd > prefix && beforeLines[beforeEnd - 1] === afterLines[afterEnd - 1]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }

  const beforeMid = beforeLines.slice(prefix, beforeEnd);
  const afterMid = afterLines.slice(prefix, afterEnd);
  const cells = beforeMid.length * afterMid.length;

  if (cells > MAX_LCS_CELLS) {
    return { added: afterMid.length, deleted: beforeMid.length };
  }

  const lcs = lcsLength(beforeMid, afterMid);
  return {
    added: afterMid.length - lcs,
    deleted: beforeMid.length - lcs,
  };
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

function lcsLength(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;

  let previous = new Array<number>(b.length + 1).fill(0);
  let current = new Array<number>(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = a[i - 1] === b[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
    }

    [previous, current] = [current, previous];
    current.fill(0);
  }

  return previous[b.length];
}

function commandRecordId(startedAt: string): string {
  return `cmd_${startedAt.replace(/[^0-9A-Za-z]/g, "")}_${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeCommand(command: string[]): string[] {
  const sanitized: string[] = [];
  let redactNext = false;

  for (const arg of command) {
    if (redactNext) {
      sanitized.push("[REDACTED]");
      redactNext = false;
      continue;
    }

    if (/^(--?|\/).*(token|secret|password|passwd|api[-_]?key|access[-_]?key)$/i.test(arg)) {
      sanitized.push(arg);
      redactNext = true;
      continue;
    }

    sanitized.push(
      arg
        .replace(/^([^=]*(?:token|secret|password|passwd|api[-_]?key|access[-_]?key)[^=]*)=.*/i, "$1=[REDACTED]")
        .replace(/^(GITHUB_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|AWS_SECRET_ACCESS_KEY)=.*/i, "$1=[REDACTED]"),
    );
  }

  return sanitized;
}

function splitCommandText(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

function readCommandRecord(path: string): CommandRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CommandRecord;
    if (parsed.version !== 1 || parsed.source !== "percentvibed_run") return undefined;
    if (!Array.isArray(parsed.files) || !Array.isArray(parsed.command)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function isSafeRepoPath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.includes("..") && !path.startsWith(".git/");
}
