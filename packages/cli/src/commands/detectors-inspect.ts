import { readdirSync, statSync } from "fs";
import { Database } from "bun:sqlite";

const HOME = process.env.HOME ?? "";

export async function detectorsInspect(args: string[]): Promise<void> {
  const report = await buildDetectorReport();
  const out = valueAfter(args, "--out");

  if (out) {
    await Bun.write(out, report);
  } else {
    console.log(report);
  }
}

async function buildDetectorReport(): Promise<string> {
  const lines: string[] = [];

  lines.push("# PercentVibed detector research\n");
  lines.push(`Generated safely: ${new Date().toISOString()}\n`);

  await addJsonlSection(lines, "Pi coding agent", `${HOME}/.pi/agent/sessions`, ".jsonl");
  await addJsonlSection(lines, "OpenAI Codex CLI", `${HOME}/.codex/sessions`, ".jsonl");
  await addJsonlSection(lines, "Claude Code", `${HOME}/.claude/projects`, ".jsonl");
  await addGenericSection(lines, "Cursor CLI", `${HOME}/.cursor`);
  await addGenericSection(lines, "Factory Droid", `${HOME}/.factory`);
  addCursorIdeSection(lines);

  lines.push("\n## Detector conclusions\n");
  lines.push("- Pi: high confidence for assistant `toolCall` records named `edit` or `write`.\n");
  lines.push("- Codex: high confidence for `response_item` function calls named `apply_patch`.\n");
  lines.push("- Claude: medium-high confidence for `Edit`, `Write`, and `MultiEdit` tool-use records.\n");
  lines.push("- Cursor IDE: medium confidence from SQLite composer/chat diff-like JSON fields.\n");
  lines.push("- Cursor CLI and Droid: generic lower-confidence scanning until more schemas are observed.\n");
  lines.push("\nNo raw prompts, raw logs, secrets, or absolute paths are included.\n");

  return lines.join("");
}

async function addJsonlSection(lines: string[], title: string, root: string, suffix: string): Promise<void> {
  const files = findFiles(root, suffix).slice(0, 20);
  const topLevelKeys = new Set<string>();
  const toolNames = new Map<string, number>();

  for (const file of files.slice(0, 5)) {
    const text = await Bun.file(file).text().catch(() => "");

    for (const line of text.split(/\n/).slice(0, 200)) {
      inspectJsonLine(line, topLevelKeys, toolNames);
    }
  }

  lines.push(`\n## ${title}\n\n`);
  lines.push(`Files sampled: ${files.length}\n\n`);
  lines.push(`Top-level keys: ${[...topLevelKeys].slice(0, 20).join(", ") || "n/a"}\n\n`);
  lines.push(`Tool names: ${formatToolNames(toolNames)}\n`);
}

async function addGenericSection(lines: string[], title: string, root: string): Promise<void> {
  const files = findFiles(root, "").slice(0, 20);
  lines.push(`\n## ${title}\n\n`);
  lines.push(`Path: ${shortPath(root)}/**\n\n`);
  lines.push(`Files sampled: ${files.length}\n`);
}

function addCursorIdeSection(lines: string[]): void {
  const dbs = findFiles(`${HOME}/Library/Application Support/Cursor/User/workspaceStorage`, "state.vscdb").slice(0, 10);

  lines.push("\n## Cursor IDE SQLite\n\n");
  lines.push("Pattern: `~/Library/Application Support/Cursor/User/workspaceStorage/**/state.vscdb`\n\n");
  lines.push(`DBs sampled: ${dbs.length}\n\n`);

  for (const dbPath of dbs.slice(0, 3)) {
    inspectCursorDb(lines, dbPath);
  }
}

function inspectCursorDb(lines: string[], dbPath: string): void {
  try {
    const db = new Database(dbPath, { readonly: true });
    const tables = db.query("select name from sqlite_master where type='table'").all() as { name: string }[];

    lines.push(`- ${shortPath(dbPath)} tables: ${tables.map((table) => table.name).join(", ")}\n`);

    for (const table of tables) {
      const rows = db
        .query(`select key, length(value) as len from ${table.name} where key like '%ai%' or key like '%composer%' limit 10`)
        .all() as { key: string; len: number }[];

      if (rows.length > 0) {
        lines.push(`  - ${table.name} keys: ${rows.map((row) => `${row.key}<${row.len}>`).join(", ")}\n`);
      }
    }

    db.close();
  } catch {
    // Ignore DBs that are locked or not key/value shaped.
  }
}

function inspectJsonLine(line: string, keys: Set<string>, tools: Map<string, number>): void {
  try {
    const object = JSON.parse(line);
    Object.keys(object).forEach((key) => keys.add(key));

    JSON.stringify(object).replace(/"(?:name|tool_name|toolName)"\s*:\s*"([^"]+)"/g, (_match, toolName) => {
      tools.set(toolName, (tools.get(toolName) ?? 0) + 1);
      return "";
    });
  } catch {
    // Ignore non-JSON rows.
  }
}

function formatToolNames(tools: Map<string, number>): string {
  const formatted = [...tools.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([tool, count]) => `${tool}(${count})`);

  return formatted.join(", ") || "n/a";
}

function findFiles(root: string, suffix: string): string[] {
  try {
    if (!statSync(root).isDirectory()) return [];
  } catch {
    return [];
  }

  const results: string[] = [];
  const stack = [root];

  while (stack.length > 0 && results.length < 200) {
    const current = stack.pop()!;

    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = `${current}/${entry.name}`;
      if (entry.isDirectory()) stack.push(path);
      if (entry.isFile() && (suffix === "" || entry.name.endsWith(suffix))) results.push(path);
    }
  }

  return results;
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function shortPath(path: string): string {
  return path.replace(HOME, "~");
}
