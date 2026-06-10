import { mkdirSync, appendFileSync } from "fs";

type LogFields = Record<string, string | number | boolean | undefined>;

export function logDebug(root: string, message: string, fields: LogFields = {}): void {
  try {
    const dir = `${root}/.git/percentvibed`;
    mkdirSync(dir, { recursive: true });

    const safeFields = Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value !== undefined),
    );

    appendFileSync(
      `${dir}/debug.log`,
      `${new Date().toISOString()} ${message} ${JSON.stringify(safeFields)}\n`,
    );
  } catch {
    // Debug logging must never break capture/push/report workflows.
  }
}
