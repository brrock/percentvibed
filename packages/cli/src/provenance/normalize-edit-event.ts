import { createHash } from "crypto";
import type { NormalizedEditEvent, Agent, EditKind } from "./schema";
export const sha256 = (s: string | Buffer) =>
  "sha256:" + createHash("sha256").update(s).digest("hex");
export function repoRelative(path: string, root: string) {
  let p = path.replace(/\\/g, "/");
  const r = root.replace(/\\/g, "/");
  if (p.startsWith(r + "/")) p = p.slice(r.length + 1);
  if (p.startsWith("file://")) p = p.replace(/^file:\/\//, "");
  if (p.startsWith("/") || p.includes("..")) return undefined;
  return p;
}
export function inferKind(name: string): EditKind {
  const n = name.toLowerCase();
  if (n.includes("patch")) return "apply_patch";
  if (n.includes("multi")) return "multi_edit";
  if (n.includes("write") || n.includes("create")) return "write";
  if (n.includes("delete")) return "delete";
  if (n.includes("rename")) return "rename";
  if (n.includes("edit") || n.includes("replace")) return "edit";
  return "unknown_edit";
}
export function makeEvent(
  agent: Agent,
  kind: EditKind,
  file: string,
  confidence: number,
  source: NormalizedEditEvent["evidence"]["source"],
  toolName?: string,
  sessionFileHash?: string,
): NormalizedEditEvent {
  return { agent, kind, file, confidence, evidence: { source, toolName, sessionFileHash } };
}
