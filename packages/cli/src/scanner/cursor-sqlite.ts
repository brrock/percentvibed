import { readdirSync, statSync } from "fs";
import { Database } from "bun:sqlite";
import { repoRelative, sha256 } from "../provenance/normalize-edit-event";
import type { NormalizedEditEvent } from "../provenance/schema";

const HOME = process.env.HOME ?? "";

export function scanCursorIde(root: string, _since: string): NormalizedEditEvent[] {
  const events: NormalizedEditEvent[] = [];

  for (const dbPath of cursorDatabasePaths()) {
    events.push(...scanCursorDatabase(dbPath, root));
  }

  return dedupeEvents(events).slice(0, 200);
}

function cursorDatabasePaths(): string[] {
  return [
    `${HOME}/Library/Application Support/Cursor/User/workspaceStorage`,
    `${HOME}/.config/Cursor/User/workspaceStorage`,
  ].flatMap((directory) => findFiles(directory, "state.vscdb"));
}

function scanCursorDatabase(dbPath: string, root: string): NormalizedEditEvent[] {
  const events: NormalizedEditEvent[] = [];

  try {
    const db = new Database(dbPath, { readonly: true });
    const tables = db.query("select name from sqlite_master where type='table'").all() as { name: string }[];

    for (const table of tables) {
      if (!isKeyValueTable(db, table.name)) continue;

      const rows = db
        .query(`select key, value from ${table.name} where key like '%ai%' or key like '%composer%' or key like '%chat%' limit 200`)
        .all() as { key: string; value: unknown }[];

      for (const row of rows) {
        events.push(...eventsFromCursorValue(row.key, row.value, dbPath, root));
      }
    }

    db.close();
  } catch {
    // Cursor may have locked or version-specific DBs. Ignore safely.
  }

  return events;
}

function isKeyValueTable(db: Database, table: string): boolean {
  const columns = db.query(`pragma table_info(${table})`).all() as { name: string }[];
  const names = new Set(columns.map((column) => column.name));
  return names.has("key") && names.has("value");
}

function eventsFromCursorValue(key: string, value: unknown, dbPath: string, root: string): NormalizedEditEvent[] {
  if (typeof value !== "string") return [];

  const parsed = parseJsonOrString(value);
  const strings = collectStrings(parsed);
  const diffLikeEvidence = strings.some((item) =>
    /assistantSuggestedDiffs|gitDiffs|fileDiffTrajectories|diffsSinceLastApply|newlyCreatedFiles|deletedFiles/.test(item),
  );

  return strings
    .map((item) => extractRepoFile(item, root))
    .filter((file): file is string => Boolean(file))
    .map((file) => ({
      agent: "cursor-ide" as const,
      kind: diffLikeEvidence ? ("edit" as const) : ("unknown_edit" as const),
      file,
      confidence: diffLikeEvidence ? 0.65 : 0.35,
      evidence: {
        source: "cursor_db" as const,
        toolName: key,
        sessionFileHash: sha256(dbPath),
      },
    }));
}

function parseJsonOrString(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function collectStrings(value: unknown, output: string[] = []): string[] {
  if (typeof value === "string") {
    output.push(value);
  } else if (Array.isArray(value)) {
    value.forEach((item) => collectStrings(item, output));
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      output.push(key);
      collectStrings(child, output);
    }
  }

  return output;
}

function extractRepoFile(value: string, root: string): string | undefined {
  const fromAbsolutePath = repoRelative(value, root);
  if (fromAbsolutePath) return fromAbsolutePath;

  return value.match(/(?:^|["'\s])([\w./-]+\.(?:ts|tsx|js|jsx|zig|rs|go|py|md|json|css|html))/)?.[1];
}

function dedupeEvents(events: NormalizedEditEvent[]): NormalizedEditEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = `${event.agent}:${event.kind}:${event.file}:${event.evidence.toolName}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findFiles(directory: string, basename: string): string[] {
  try {
    const stat = statSync(directory);
    if (!stat.isDirectory()) return [];
  } catch {
    return [];
  }

  const results: string[] = [];
  const stack = [directory];

  while (stack.length > 0) {
    const current = stack.pop()!;

    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = `${current}/${entry.name}`;
      if (entry.isDirectory()) stack.push(path);
      if (entry.isFile() && entry.name === basename) results.push(path);
    }
  }

  return results;
}
