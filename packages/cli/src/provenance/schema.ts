export type Agent = "claude" | "codex" | "pi" | "cursor-ide" | "cursor-cli" | "droid" | "unknown";
export type EditKind =
  | "write"
  | "edit"
  | "multi_edit"
  | "apply_patch"
  | "delete"
  | "rename"
  | "unknown_edit";
export type NormalizedEditEvent = {
  agent: Agent;
  kind: EditKind;
  file: string;
  timestamp?: string;
  callId?: string;
  confidence: number;
  evidence: {
    source: "tool_call" | "tool_result" | "patch" | "cursor_db" | "generic_scan";
    toolName?: string;
    sessionFileHash?: string;
  };
  oldHash?: string;
  newHash?: string;
  patchHash?: string;
  stats?: { added: number; deleted: number };
};
export type PvConfig = {
  version: 1;
  policy: "warn" | "strict";
  baseBranch: string;
  exclude: string[];
  hooks: { prePush: boolean; mode: "warn" | "strict" };
  scanner: Record<string, boolean>;
  github: { reportTarget: "comment"; labels: boolean };
};
export type ActiveSession = {
  version: 1;
  id: string;
  startedAt: string;
  branch: string;
  baseCommit: string;
};
export const defaultConfig: PvConfig = {
  version: 1,
  policy: "warn",
  baseBranch: "main",
  exclude: [
    ".percentvibed/**",
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "bun.lock",
    "Cargo.lock",
    "go.sum",
    "dist/**",
    "build/**",
    "generated/**",
  ],
  hooks: { prePush: true, mode: "warn" },
  scanner: { codex: true, claude: true, pi: true, cursorIde: true, cursorCli: true, droid: true },
  github: { reportTarget: "comment", labels: false },
};
