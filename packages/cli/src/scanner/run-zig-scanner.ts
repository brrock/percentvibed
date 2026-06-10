import type { NormalizedEditEvent } from "../provenance/schema";

export async function runZigScanner(
  root: string,
  since: string,
): Promise<{ events: NormalizedEditEvent[]; agents: string[]; raw: any }> {
  const candidates = scannerCandidates();
  const failures: string[] = [];

  for (const bin of candidates) {
    try {
      const process = Bun.spawn([bin, "--repo", root, "--since", since, "--json"], {
        stdout: "pipe",
        stderr: "pipe",
      });

      const out = await new Response(process.stdout).text();
      const stderr = await new Response(process.stderr).text();
      const code = await process.exited;

      if (code !== 0) {
        failures.push(`${bin}: exited ${code}: ${stderr.slice(0, 500)}`);
        continue;
      }

      const raw = JSON.parse(out || "{}");
      const events = (raw.sessions || []).flatMap((session: any) => session.editEvents || []);
      const agents = [...new Set(events.map((event: any) => event.agent).filter(Boolean))] as string[];

      return { events, agents, raw };
    } catch (error) {
      failures.push(`${bin}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(
    "PercentVibed requires the Zig scanner, but no working percentvibed-scan binary was found.\n\n" +
      "Tried:\n" +
      candidates.map((candidate) => `  - ${candidate}`).join("\n") +
      "\n\nFailures:\n" +
      failures.map((failure) => `  - ${failure}`).join("\n") +
      "\n\nBuild or install the scanner, then retry capture.",
  );
}

function scannerCandidates(): string[] {
  return [
    process.env.PERCENTVIBED_SCANNER,
    `${import.meta.dir}/../../bin/percentvibed-scan`,
    `${import.meta.dir}/../../bin/percentvibed-scan.exe`,
    "percentvibed-scan",
  ].filter(Boolean) as string[];
}
