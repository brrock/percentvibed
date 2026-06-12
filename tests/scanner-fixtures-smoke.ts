import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { scan } from "../packages/scanner/src/index";

const work = mkdtempSync(join(tmpdir(), "pv-scanner-fixtures-"));
const home = join(work, "home");
const repo = join(work, "repo");
const since = "2026-06-09T10:00:00Z";
const after = "2026-06-09T10:01:00Z";
const before = "2026-06-09T09:59:00Z";

mkdirSync(join(repo, "src"), { recursive: true });
writeFileSync(join(repo, "src/pi.ts"), "");
writeFileSync(join(repo, "src/codex.ts"), "");
writeFileSync(join(repo, "src/claude.ts"), "");

writePiFixture();
writeCodexFixture();
writeClaudeFixture();
writeOldFixture();

const result = scan({ repo, since, home });
const events = result.sessions.flatMap((session: any) => session.editEvents ?? []);

assertEvent(events, "pi", "src/pi.ts", 2);
assertEvent(events, "codex", "src/codex.ts", 2);
assertEvent(events, "claude", "src/claude.ts", 1);

if (events.some((event: any) => event.file === "src/old.ts")) {
  throw new Error("scanner included an event from before --since");
}

console.log(`scanner fixture smoke passed with ${events.length} event(s)`);

function writePiFixture() {
  const dir = join(home, ".pi/agent/sessions/--tmp-fixture--");
  mkdirSync(dir, { recursive: true });
  writeSessionFile(join(dir, "pi.jsonl"), after, [
    {
      type: "session",
      version: 3,
      id: "pi",
      timestamp: after,
      cwd: repo,
    },
    {
      type: "message",
      timestamp: after,
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_pi",
            name: "edit",
            arguments: { path: "src/pi.ts", oldText: "export const x = 1;\n", newText: "export const x = 1;\nexport const y = 2;\nexport const z = 3;\n" },
          },
        ],
      },
    },
    {
      type: "message",
      timestamp: after,
      message: {
        role: "toolResult",
        toolName: "edit",
        toolCallId: "call_pi",
        details: {
          patch: "--- src/pi.ts\n+++ src/pi.ts\n@@ -1 +1,3 @@\n export const x = 1;\n+export const y = 2;\n+export const z = 3;\n",
        },
        isError: false,
      },
    },
  ]);
}

function writeCodexFixture() {
  const dir = join(home, ".codex/sessions/2026/06/09");
  mkdirSync(dir, { recursive: true });
  writeSessionFile(join(dir, "rollout.jsonl"), after, [
    {
      timestamp: after,
      type: "response_item",
      payload: {
        type: "function_call",
        name: "apply_patch",
        call_id: "call_codex",
        arguments: JSON.stringify({
          patch: "*** Begin Patch\n*** Update File: src/codex.ts\n@@\n+export const a = 1;\n+export const b = 2;\n*** End Patch",
        }),
      },
    },
  ]);
}

function writeClaudeFixture() {
  const dir = join(home, ".claude/projects/-tmp-fixture");
  mkdirSync(dir, { recursive: true });
  writeSessionFile(join(dir, "claude.jsonl"), after, [
    {
      timestamp: after,
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_claude",
            name: "Edit",
            input: {
              file_path: join(repo, "src/claude.ts"),
              old_string: "export const x = 1;\n",
              new_string: "export const x = 1;\nexport const y = 2;\n",
            },
          },
        ],
      },
    },
  ]);
}

function writeOldFixture() {
  const dir = join(home, ".pi/agent/sessions/--tmp-old--");
  mkdirSync(dir, { recursive: true });
  writeSessionFile(join(dir, "old.jsonl"), before, [
    {
      type: "message",
      timestamp: before,
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_old",
            name: "edit",
            arguments: { path: "src/old.ts", oldText: "", newText: "export const old = 1;\n" },
          },
        ],
      },
    },
  ]);
}

function writeSessionFile(path: string, timestamp: string, rows: unknown[]) {
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  const mtime = new Date(Date.parse(timestamp));
  utimesSync(path, mtime, mtime);
}

function assertEvent(events: any[], agent: string, file: string, added: number) {
  const event = events.find((candidate) => candidate.agent === agent && candidate.file === file);
  if (!event) throw new Error(`missing ${agent} event for ${file}`);
  if (event.stats?.added !== added) {
    throw new Error(`expected ${agent} ${file} added=${added}, got ${event.stats?.added}`);
  }
}
