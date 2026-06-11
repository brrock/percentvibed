import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const cli = join(repoRoot, "packages/cli/src/cli.ts");
const scanner = process.env.PERCENTVIBED_SCANNER ?? join(repoRoot, "packages/cli/bin/percentvibed-scan");
const work = mkdtempSync(join(tmpdir(), "pv-large-pr-"));
const home = join(work, "home");
const repo = join(work, "repo");
const piSessions = join(home, ".pi/agent/sessions/--tmp-pv-large-pr--");

mkdirSync(repo, { recursive: true });
mkdirSync(piSessions, { recursive: true });

const env = {
  ...process.env,
  HOME: home,
  PERCENTVIBED_SCANNER: scanner,
};

run("git", ["init"], repo);
run("git", ["config", "user.email", "test@example.com"], repo);
run("git", ["config", "user.name", "PercentVibed Smoke"], repo);

mkdirSync(join(repo, "src"));
mkdirSync(join(repo, "docs"));
writeFileSync(join(repo, "src/a.ts"), "export const baseA = 0;\n");
writeFileSync(join(repo, "src/b.ts"), "export const baseB = 0;\n");
writeFileSync(join(repo, "src/c.ts"), "export const baseC = 0;\n");
writeFileSync(join(repo, "docs/human.md"), "# Human docs\n");
run("git", ["add", "src", "docs"], repo);
run("git", ["commit", "-m", "init"], repo);

run("bun", [cli, "init"], repo, env);
run("git", ["add", ".percentvibed.json"], repo);
run("git", ["commit", "-m", "init percentvibed"], repo);

await commitOne();
await cleanupLikeSuccessfulPush();
await sleepForDistinctSessionMtime();

await commitTwo();
await cleanupLikeSuccessfulPush();
await sleepForDistinctSessionMtime();

await commitThree();

const report = run("bun", [cli, "report", "--base", "HEAD~3", "--format", "markdown"], repo, env);
console.log(report);

assertIncludes(report, "Detected agent-assisted share:** 77%");
assertIncludes(report, "| PR added lines | 155 |");
assertIncludes(report, "| Detected agent-assisted added lines | 120 |");
assertIncludes(report, "| Captured sessions | 3 |");
assertIncludes(report, "| Agent sessions detected | 3 |");
assertIncludes(report, "| src/a.ts | 55 | 0 |");
assertIncludes(report, "| src/b.ts | 40 | 0 |");
assertIncludes(report, "| src/c.ts | 25 | 0 |");

console.log(`large PR smoke passed in ${repo}`);

async function commitOne(): Promise<void> {
  run("bun", [cli, "start"], repo, env);
  const startedAt = activeStartedAt();

  appendGeneratedLines("src/a.ts", "agentA_commit1", 40);
  appendGeneratedLines("docs/human.md", "human docs commit1", 10);

  writeLargePiSession("one", startedAt, [
    editPatch("src/a.ts", "agentA_commit1", 40),
  ]);

  captureAndCommit("mixed commit one", ["src/a.ts", "docs/human.md"]);
}

async function commitTwo(): Promise<void> {
  run("bun", [cli, "start"], repo, env);
  const startedAt = activeStartedAt();

  appendGeneratedLines("src/a.ts", "agentA_commit2", 15);
  appendGeneratedLines("src/a.ts", "human same file commit2", 5);
  appendGeneratedLines("src/b.ts", "agentB_commit2", 30);

  writeLargePiSession("two", startedAt, [
    editPatch("src/a.ts", "agentA_commit2", 15),
    editPatch("src/b.ts", "agentB_commit2", 30),
  ]);

  captureAndCommit("mixed commit two", ["src/a.ts", "src/b.ts"]);
}

async function commitThree(): Promise<void> {
  run("bun", [cli, "start"], repo, env);
  const startedAt = activeStartedAt();

  appendGeneratedLines("src/c.ts", "agentC_commit3", 25);
  appendGeneratedLines("src/b.ts", "agentB_commit3", 10);
  appendGeneratedLines("docs/human.md", "human docs commit3", 20);

  writeLargePiSession("three", startedAt, [
    editPatch("src/c.ts", "agentC_commit3", 25),
    editPatch("src/b.ts", "agentB_commit3", 10),
  ]);

  captureAndCommit("mixed commit three", ["src/c.ts", "src/b.ts", "docs/human.md"]);
}

function captureAndCommit(message: string, files: string[]): void {
  run("git", ["add", ...files], repo);
  run("bun", [cli, "capture"], repo, env);
  assertCompactTransportBundle();
  run("git", ["add", ".percentvibed"], repo);
  run("git", ["commit", "-m", message], repo);
}

function assertCompactTransportBundle(): void {
  const manifestPath = join(repo, ".percentvibed/v1/manifest.json");
  const sessionsPath = join(repo, ".percentvibed/v1/sessions");
  const patchesPath = join(repo, ".percentvibed/v1/patches");

  if (!existsSync(manifestPath)) {
    throw new Error("expected compact transport manifest to exist");
  }

  if (!existsSync(sessionsPath) || readdirSync(sessionsPath).length === 0) {
    throw new Error("expected compact transport session metadata to exist");
  }

  if (existsSync(patchesPath)) {
    throw new Error("expected compact transport to omit .percentvibed/v1/patches");
  }

  const sessionFiles = readdirSync(sessionsPath).filter((file) => file.endsWith(".json"));
  for (const file of sessionFiles) {
    const session = JSON.parse(readFileSync(join(sessionsPath, file), "utf8"));
    if (!Array.isArray(session.fileStats)) {
      throw new Error(`expected ${file} to include fileStats`);
    }
  }
}

async function cleanupLikeSuccessfulPush(): Promise<void> {
  run("bun", [cli, "clean", "--hide"], repo, env);

  if (await Bun.file(join(repo, ".percentvibed")).exists()) {
    throw new Error("expected .percentvibed to be removed after clean --hide");
  }

  const status = run("git", ["status", "--short"], repo, env);
  if (status.trim() !== "") {
    throw new Error(`expected clean worktree after hiding .percentvibed, got:\n${status}`);
  }
}

function activeStartedAt(): string {
  return JSON.parse(readFileSync(join(repo, ".git/percentvibed/active-session.json"), "utf8")).startedAt;
}

function appendGeneratedLines(relativePath: string, prefix: string, count: number): void {
  const path = join(repo, relativePath);
  const lines = Array.from({ length: count }, (_, index) => generatedLine(relativePath, prefix, index + 1));
  writeFileSync(path, readFileSync(path, "utf8") + lines.join(""));
}

function generatedLine(relativePath: string, prefix: string, index: number): string {
  if (relativePath.endsWith(".md")) return `- ${prefix} ${index}\n`;
  return `export const ${identifier(prefix)}_${index} = ${index};\n`;
}

function editPatch(relativePath: string, prefix: string, count: number): { file: string; patch: string } {
  const addedLines = Array.from(
    { length: count },
    (_, index) => `+${generatedLine(relativePath, prefix, index + 1).trimEnd()}\n`,
  ).join("");

  return {
    file: relativePath,
    patch: `--- ${relativePath}\n+++ ${relativePath}\n@@ -1,1 +1,${count + 1} @@\n ${relativePath}\n${addedLines}`,
  };
}

function writeLargePiSession(name: string, timestamp: string, edits: { file: string; patch: string }[]): void {
  const rows: string[] = [
    JSON.stringify({ type: "session", version: 3, id: name, timestamp, cwd: repo }),
  ];

  for (let index = 0; index < 120; index += 1) {
    rows.push(JSON.stringify({ type: "message", timestamp, message: { role: "assistant", content: [] } }));
  }

  for (const [index, edit] of edits.entries()) {
    rows.push(
      JSON.stringify({
        type: "message",
        timestamp,
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: `call_${name}_${index}`,
              name: "edit",
              arguments: {
                path: edit.file,
                oldText: "<redacted>",
                newText: "<redacted>",
              },
            },
          ],
        },
      }),
    );

    rows.push(
      JSON.stringify({
        type: "message",
        timestamp,
        message: {
          role: "toolResult",
          toolName: "edit",
          toolCallId: `call_${name}_${index}`,
          details: { patch: edit.patch },
          isError: false,
        },
      }),
    );
  }

  const path = join(piSessions, `${timestamp.replace(/[:.]/g, "-")}_${name}.jsonl`);
  writeFileSync(path, `${rows.join("\n")}\n`);

  const mtime = new Date(Date.parse(timestamp));
  utimesSync(path, mtime, mtime);
}

function identifier(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, "_");
}

async function sleepForDistinctSessionMtime(): Promise<void> {
  await Bun.sleep(1500);
}

function run(command: string, args: string[], cwd: string, commandEnv = env): string {
  const result = Bun.spawnSync([command, ...args], {
    cwd,
    env: commandEnv,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);

  if (result.exitCode !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${stdout}\n${stderr}`);
  }

  return stdout;
}

function assertIncludes(value: string, expected: string): void {
  if (!value.includes(expected)) {
    throw new Error(`expected report to include ${JSON.stringify(expected)}`);
  }
}
