import { scan } from "@percentvibed/scanner";
import type { NormalizedEditEvent } from "../provenance/schema";

export async function runZigScanner(
  root: string,
  since: string,
): Promise<{ events: NormalizedEditEvent[]; agents: string[]; raw: any }> {
  try {
    const raw = scan({ repo: root, since });
    const events = (raw.sessions || []).flatMap((session: any) => session.editEvents || []);
    const agents = [...new Set(events.map((event: any) => event.agent).filter(Boolean))] as string[];

    return { events, agents, raw };
  } catch (error) {
    throw new Error(
      "PercentVibed requires the native N-API scanner addon, but no working addon was found.\n\n" +
        `${error instanceof Error ? error.message : String(error)}\n\n` +
        "Build or install the scanner, then retry capture.",
    );
  }
}
