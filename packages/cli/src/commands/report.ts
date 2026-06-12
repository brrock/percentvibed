import { appendFileSync } from "fs";
import { diffNumstat, patchStats } from "../git/diff";
import { git, repoRoot } from "../git/repo";

type LineStat = {
  file: string;
  added: number;
  deleted: number;
};

type CapturedFile = LineStat;

type CapturedSummary = {
  added: number;
  deleted: number;
  sessions: number;
  detectedAgentSessions: number;
  files: CapturedFile[];
  warnings: string[];
};

type ReportArtifacts = {
  percent: number;
  badgeMarkdown: string;
  prBodyBlock: string;
  commentMarkdown: string;
};

const COMMENT_MARKER = "<!-- percentvibed:report -->";
const BODY_MARKER_START = "<!-- percentvibed:badge:start -->";
const BODY_MARKER_END = "<!-- percentvibed:badge:end -->";

export async function report(args: string[]): Promise<void> {
  const root = repoRoot();
  const local = args.includes("--local");
  const out = valueAfter(args, "--out");
  const base = valueAfter(args, "--base") ?? inferBaseRef();

  const prStats = diffNumstat(root, base);
  const captured = await readCapturedSummary(root, base, prStats.files.map((file) => file.file));
  const artifacts = renderReportArtifacts(prStats, captured);

  if (out) {
    await Bun.write(out, artifacts.commentMarkdown);
  }

  writeGitHubOutputs(artifacts, prStats, captured);

  if (local || !isGitHubActionsPullRequest()) {
    printLocalReport(base, artifacts);
    return;
  }

  await updateGitHubPullRequest(artifacts);
  await cleanupProvenanceOnGitHub(root);
}

async function readCapturedSummary(root: string, base: string, prFiles: string[]): Promise<CapturedSummary> {
  const prFileSet = new Set(prFiles);
  const bundles = await readBundles(root, base);

  if (bundles.length === 0) {
    return {
      added: 0,
      deleted: 0,
      sessions: 0,
      detectedAgentSessions: 0,
      files: [],
      warnings: ["No `.percentvibed` provenance bundle found for this PR."],
    };
  }

  const byFile = new Map<string, CapturedFile>();
  const warnings: string[] = [];
  let detectedAgentSessions = 0;
  let sessions = 0;

  for (const bundle of bundles) {
    sessions += 1;

    const metadata = bundle.metadata;
    const hasAgentEvidence = sessionHasAgentEvidence(metadata);
    const formatterBridgeStats = formatterBridgeStatsFromMetadata(metadata);

    detectedAgentSessions += metadata?.agentSignals?.detectedSessions ?? 0;

    if (!hasAgentEvidence) {
      warnings.push(
        `Session ${bundle.id} captured a diff but has no matching agent edit evidence, so it is not counted as agent-assisted.`,
      );
      continue;
    }

    let directStats = agentStatsFromMetadata(metadata);

    if (directStats.length === 0) {
      warnings.push(
        `Session ${bundle.id} has agent evidence but no per-event line stats; falling back to whole-file attribution.`,
      );
      directStats = bundle.fileStats;
    }

    addBoundedBundleStats(byFile, directStats, formatterBridgeStats, bundle.fileStats, prFileSet, warnings);
  }

  const files = [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file));

  return {
    added: files.reduce((sum, file) => sum + file.added, 0),
    deleted: files.reduce((sum, file) => sum + file.deleted, 0),
    sessions,
    detectedAgentSessions,
    files,
    warnings,
  };
}

type Bundle = {
  id: string;
  metadata: any;
  fileStats: LineStat[];
};

async function readBundles(root: string, base: string): Promise<Bundle[]> {
  const byId = new Map<string, Bundle>();

  for (const bundle of await readWorktreeBundles(root)) {
    byId.set(bundle.id, bundle);
  }

  for (const commit of commitsInRange(root, base)) {
    for (const bundle of readCommitBundles(root, commit)) {
      byId.set(bundle.id, bundle);
    }
  }

  return [...byId.values()];
}

async function readWorktreeBundles(root: string): Promise<Bundle[]> {
  const manifestPath = `${root}/.percentvibed/v1/manifest.json`;
  if (!(await Bun.file(manifestPath).exists())) return [];

  try {
    const manifest = await Bun.file(manifestPath).json();
    const bundles: Bundle[] = [];

    for (const session of manifest.sessions ?? []) {
      const metadataPath = `${root}/.percentvibed/v1/${session.metadata}`;
      if (!(await Bun.file(metadataPath).exists())) continue;

      const metadata = await Bun.file(metadataPath).json();
      const patchPath = session.patch ? `${root}/.percentvibed/v1/${session.patch}` : undefined;
      const legacyPatch = patchPath && (await Bun.file(patchPath).exists()) ? await Bun.file(patchPath).text() : undefined;

      bundles.push({
        id: session.id,
        metadata,
        fileStats: fileStatsFromMetadata(metadata, legacyPatch),
      });
    }

    return bundles;
  } catch {
    return [];
  }
}

function readCommitBundles(root: string, commit: string): Bundle[] {
  const manifestText = gitShow(root, commit, ".percentvibed/v1/manifest.json");
  if (!manifestText) return [];

  try {
    const manifest = JSON.parse(manifestText);
    const bundles: Bundle[] = [];

    for (const session of manifest.sessions ?? []) {
      const metadataText = gitShow(root, commit, `.percentvibed/v1/${session.metadata}`);
      if (!metadataText) continue;

      const metadata = JSON.parse(metadataText);
      const legacyPatch = session.patch ? gitShow(root, commit, `.percentvibed/v1/${session.patch}`) : undefined;

      bundles.push({
        id: session.id,
        metadata,
        fileStats: fileStatsFromMetadata(metadata, legacyPatch),
      });
    }

    return bundles;
  } catch {
    return [];
  }
}

function fileStatsFromMetadata(metadata: any, legacyPatch?: string): LineStat[] {
  if (Array.isArray(metadata?.fileStats)) {
    return metadata.fileStats.map((file: any) => ({
      file: String(file.file),
      added: Math.max(0, Number(file.added) || 0),
      deleted: Math.max(0, Number(file.deleted) || 0),
    }));
  }

  if (legacyPatch) {
    return patchStats(legacyPatch).files;
  }

  return (metadata?.files ?? []).map((file: string) => ({ file, added: 0, deleted: 0 }));
}

function commitsInRange(root: string, base: string): string[] {
  const result = git(["rev-list", "--reverse", `${base}..HEAD`], root);
  if (result.code !== 0) return [];
  return result.stdout.trim().split(/\n/).filter(Boolean);
}

function gitShow(root: string, commit: string, path: string): string | undefined {
  const result = git(["show", `${commit}:${path}`], root);
  return result.code === 0 ? result.stdout : undefined;
}

function sessionHasAgentEvidence(metadata: any | undefined): boolean {
  if (!metadata) return false;

  const editEvents = Array.isArray(metadata.editEvents) ? metadata.editEvents : [];
  const attributedEvents = editEvents.filter((event: any) => event.agent && event.agent !== "unknown");
  const detectedSessions = metadata.agentSignals?.detectedSessions ?? 0;
  const confidence = metadata.agentSignals?.confidence ?? 0;

  return attributedEvents.length > 0 || (detectedSessions > 0 && confidence > 0);
}

function agentStatsFromMetadata(metadata: any | undefined): LineStat[] {
  const editEvents = Array.isArray(metadata?.editEvents) ? metadata.editEvents : [];
  const byFile = new Map<string, LineStat>();

  for (const event of editEvents) {
    if (!event.file || event.agent === "unknown" || !event.stats) continue;

    const current = byFile.get(event.file) ?? { file: event.file, added: 0, deleted: 0 };
    current.added += Math.max(0, Number(event.stats.added) || 0);
    current.deleted += Math.max(0, Number(event.stats.deleted) || 0);
    byFile.set(event.file, current);
  }

  return [...byFile.values()];
}

function formatterBridgeStatsFromMetadata(metadata: any | undefined): LineStat[] {
  const formatterBridgeEvents = Array.isArray(metadata?.formatterBridgeEvents)
    ? metadata.formatterBridgeEvents
    : Array.isArray(metadata?.mechanicalEvents)
      ? metadata.mechanicalEvents
      : [];
  const byFile = new Map<string, LineStat>();

  for (const event of formatterBridgeEvents) {
    if (!event.file || !event.stats) continue;
    if (event.kind !== "formatter" && event.kind !== "lint_fix") continue;

    const current = byFile.get(event.file) ?? { file: event.file, added: 0, deleted: 0 };
    current.added += Math.max(0, Number(event.stats.added) || 0);
    current.deleted += Math.max(0, Number(event.stats.deleted) || 0);
    byFile.set(event.file, current);
  }

  return [...byFile.values()];
}

function addBoundedBundleStats(
  byFile: Map<string, CapturedFile>,
  directStats: LineStat[],
  formatterBridgeStats: LineStat[],
  capturedPatchStats: LineStat[],
  prFileSet: Set<string>,
  warnings: string[],
): void {
  const bounds = new Map(capturedPatchStats.map((file) => [file.file, file]));
  const directByFile = new Map(directStats.map((file) => [file.file, file]));
  const bridgeByFile = new Map(formatterBridgeStats.map((file) => [file.file, file]));

  for (const fileName of directByFile.keys()) {
    if (!prFileSet.has(fileName)) {
      warnings.push(`Captured evidence file ${fileName} is not present in the current PR diff.`);
      continue;
    }

    const bound = bounds.get(fileName);
    if (!bound) continue;

    const direct = directByFile.get(fileName) ?? { file: fileName, added: 0, deleted: 0 };
    const bridge = bridgeByFile.get(fileName) ?? { file: fileName, added: 0, deleted: 0 };
    const current = byFile.get(fileName) ?? { file: fileName, added: 0, deleted: 0 };

    current.added += Math.min(direct.added + bridge.added, bound.added);
    current.deleted += Math.min(direct.deleted + bridge.deleted, bound.deleted);
    byFile.set(fileName, current);
  }
}

function renderReportArtifacts(prStats: ReturnType<typeof diffNumstat>, captured: CapturedSummary): ReportArtifacts {
  const percent = prStats.added > 0 ? Math.min(100, Math.round((captured.added / prStats.added) * 100)) : 0;
  const badgeMarkdown = renderBadge(percent);
  const prBodyBlock = `${BODY_MARKER_START}\n${badgeMarkdown}\n${BODY_MARKER_END}`;
  const commentMarkdown = renderCommentMarkdown(prStats, captured, percent);

  return { percent, badgeMarkdown, prBodyBlock, commentMarkdown };
}

function renderBadge(percent: number): string {
  const color = percent >= 80 ? "brightgreen" : percent >= 50 ? "yellow" : percent > 0 ? "orange" : "lightgrey";
  return `![PercentVibed ${percent}%](https://img.shields.io/badge/PercentVibed-${percent}%25-${color})`;
}

function renderCommentMarkdown(
  prStats: ReturnType<typeof diffNumstat>,
  captured: CapturedSummary,
  percent: number,
): string {
  const lines: string[] = [];

  lines.push(`${COMMENT_MARKER}\n`);
  lines.push("## PercentVibed report\n");
  lines.push(`**Detected agent-assisted share:** ${percent}%\n`);
  lines.push("| Metric | Value |");
  lines.push("|---|---:|");
  lines.push(`| PR added lines | ${prStats.added} |`);
  lines.push(`| PR deleted lines | ${prStats.deleted} |`);
  lines.push(`| Detected agent-assisted added lines | ${captured.added} |`);
  lines.push(`| Detected agent-assisted deleted lines | ${captured.deleted} |`);
  lines.push(`| Captured sessions | ${captured.sessions} |`);
  lines.push(`| Agent sessions detected | ${captured.detectedAgentSessions} |`);
  lines.push(`| Detected agent-assisted files | ${captured.files.length} |\n`);

  if (captured.warnings.length > 0) {
    lines.push("### Warnings\n");
    for (const warning of [...new Set(captured.warnings)]) {
      lines.push(`- ⚠️ ${warning}`);
    }
    lines.push("");
  }

  if (captured.files.length > 0) {
    lines.push("### File breakdown\n");
    lines.push("| File | Agent-assisted + | Agent-assisted - |");
    lines.push("|---|---:|---:|");
    for (const file of captured.files) {
      lines.push(`| ${file.file} | ${file.added} | ${file.deleted} |`);
    }
  }

  return `${lines.join("\n")}\n`;
}

async function updateGitHubPullRequest(artifacts: ReportArtifacts): Promise<void> {
  const context = await githubContext();
  const headers = githubHeaders(context.token);
  const pullUrl = `https://api.github.com/repos/${context.repo}/pulls/${context.pullNumber}`;
  const issueCommentsUrl = `https://api.github.com/repos/${context.repo}/issues/${context.pullNumber}/comments`;

  const pull = await githubJson(pullUrl, { headers });
  const updatedBody = upsertBodyBadge(String(pull.body ?? ""), artifacts.prBodyBlock);

  await githubJson(pullUrl, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ body: updatedBody }),
  });

  const comments = (await githubJson(issueCommentsUrl, { headers })) as any[];
  const existing = comments.find((comment) => String(comment.body ?? "").includes(COMMENT_MARKER));

  if (existing) {
    await githubJson(existing.url, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ body: artifacts.commentMarkdown }),
    });
  } else {
    await githubJson(issueCommentsUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: artifacts.commentMarkdown }),
    });
  }

  console.log(`Updated PR badge and ${existing ? "comment" : "created comment"}.`);
}

async function cleanupProvenanceOnGitHub(root: string): Promise<void> {
  if (process.env.PERCENTVIBED_KEEP_BUNDLE === "1") {
    console.log("PERCENTVIBED_KEEP_BUNDLE=1 set; leaving .percentvibed in the PR branch.");
    return;
  }

  const hasTrackedBundle = git(["ls-files", "--error-unmatch", ".percentvibed/v1/manifest.json"], root).code === 0;
  if (!hasTrackedBundle) return;

  git(["config", "user.name", "github-actions[bot]"], root);
  git(["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"], root);

  const rm = git(["rm", "-r", ".percentvibed"], root);
  if (rm.code !== 0) {
    console.warn(`Could not remove .percentvibed: ${rm.stderr}`);
    return;
  }

  const commit = git(["commit", "-m", "chore(percentvibed): remove PR transport bundle"], root);
  if (commit.code !== 0) {
    console.warn(`Could not commit .percentvibed removal: ${commit.stderr}`);
    return;
  }

  const headRef = process.env.GITHUB_HEAD_REF;
  const pushArgs = headRef ? ["push", "origin", `HEAD:refs/heads/${headRef}`] : ["push"];
  const push = git(pushArgs, root);
  if (push.code !== 0) {
    throw new Error(`Failed to push .percentvibed cleanup commit: ${push.stderr}`);
  }

  console.log("Removed .percentvibed from the PR branch after reporting.");
}

function writeGitHubOutputs(
  artifacts: ReportArtifacts,
  prStats: ReturnType<typeof diffNumstat>,
  captured: CapturedSummary,
): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;

  const lines = [
    `percent=${artifacts.percent}`,
    `pr_added=${prStats.added}`,
    `pr_deleted=${prStats.deleted}`,
    `agent_added=${captured.added}`,
    `agent_deleted=${captured.deleted}`,
    `agent_files=${captured.files.length}`,
    `captured_sessions=${captured.sessions}`,
    `agent_sessions=${captured.detectedAgentSessions}`,
  ];

  try {
    appendFileSync(outputPath, `${lines.join("\n")}\n`);
  } catch {
    // Outputs are best-effort and should not fail local reporting.
  }
}

function upsertBodyBadge(body: string, block: string): string {
  const managedBlockRegex = new RegExp(`${BODY_MARKER_START}[\\s\\S]*?${BODY_MARKER_END}`);

  if (managedBlockRegex.test(body)) {
    return body.replace(managedBlockRegex, block);
  }

  return body.trim().length > 0 ? `${block}\n\n${body}` : block;
}

async function githubContext(): Promise<{ token: string; repo: string; pullNumber: number }> {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const eventPath = process.env.GITHUB_EVENT_PATH;

  if (!token || !repo || !eventPath) {
    throw new Error("GITHUB_TOKEN, GITHUB_REPOSITORY, and GITHUB_EVENT_PATH are required on GitHub Actions.");
  }

  const event = await Bun.file(eventPath).json();
  const pullNumber = event.pull_request?.number;

  if (!pullNumber) {
    throw new Error("percentvibed report can update GitHub only for pull_request events.");
  }

  return { token, repo, pullNumber };
}

function githubHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

async function githubJson(url: string, init: RequestInit): Promise<any> {
  const response = await fetch(url, init);

  if (!response.ok) {
    throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
  }

  return response.status === 204 ? undefined : response.json();
}

function printLocalReport(base: string, artifacts: ReportArtifacts): void {
  console.log(`# PercentVibed local report preview\n`);
  console.log(`Base ref: ${base}\n`);
  console.log("## PR description badge block\n");
  console.log(artifacts.prBodyBlock);
  console.log("\n## Sticky PR comment\n");
  console.log(artifacts.commentMarkdown);
}

function inferBaseRef(): string {
  if (process.env.GITHUB_BASE_REF) return `origin/${process.env.GITHUB_BASE_REF}`;
  return "main";
}

function isGitHubActionsPullRequest(): boolean {
  return Boolean(process.env.GITHUB_ACTIONS && process.env.GITHUB_EVENT_NAME === "pull_request");
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}
