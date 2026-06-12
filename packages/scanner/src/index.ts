import { existsSync } from "fs";
import { createRequire } from "module";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

export type ScanOptions = {
  repo: string;
  since: string;
  home?: string;
  scanDirs?: string;
};

type NativeScanner = {
  scan(repo: string, since: string, home: string, scanDirs: string): string;
};

const requireNative = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

let cachedNative: NativeScanner | undefined;
let cachedNativePath: string | undefined;

export function scanJson(options: ScanOptions): string {
  const native = loadNativeScanner();
  const home = options.home ?? process.env.HOME ?? process.env.USERPROFILE ?? "";
  const scanDirs = options.scanDirs ?? process.env.PERCENTVIBED_SCAN_DIRS ?? "";
  return native.scan(options.repo, options.since, home, scanDirs);
}

export function scan(options: ScanOptions): any {
  return JSON.parse(scanJson(options) || "{}");
}

export function nativeAddonPath(): string {
  loadNativeScanner();
  return cachedNativePath!;
}

function loadNativeScanner(): NativeScanner {
  if (cachedNative) return cachedNative;

  const failures: string[] = [];
  for (const candidate of nativeCandidates()) {
    if (!candidate) continue;

    if (candidate.startsWith("/") || candidate.startsWith(".") || /^[A-Za-z]:[\\/]/.test(candidate)) {
      if (!existsSync(candidate)) {
        failures.push(`${candidate}: missing`);
        continue;
      }
    }

    try {
      const loaded = requireNative(candidate) as NativeScanner;
      if (typeof loaded.scan !== "function") {
        failures.push(`${candidate}: missing scan() export`);
        continue;
      }

      cachedNative = loaded;
      cachedNativePath = candidate;
      return loaded;
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(
    "PercentVibed requires the native N-API scanner addon, but no working addon was found.\n\n" +
      "Tried:\n" +
      nativeCandidates().map((candidate) => `  - ${candidate}`).join("\n") +
      "\n\nFailures:\n" +
      failures.map((failure) => `  - ${failure}`).join("\n") +
      "\n\nBuild packages/scanner-zig or install the matching @percentvibed/scanner-* package.",
  );
}

function nativeCandidates(): string[] {
  const platformPackage = `@percentvibed/scanner-${process.platform}-${process.arch}`;
  const envNative = normalizePathCandidate(process.env.PERCENTVIBED_SCANNER_NATIVE);
  const legacyEnvNative = normalizePathCandidate(
    process.env.PERCENTVIBED_SCANNER?.endsWith(".node") ? process.env.PERCENTVIBED_SCANNER : undefined,
  );

  const candidates = [
    envNative,
    legacyEnvNative,
    resolveOptionalPackage(platformPackage),
    join(here, "..", "..", platformPackage, "percentvibed_scanner.node"),
    join(here, "..", "..", "scanner-zig", "zig-out", "percentvibed_scanner.node"),
  ];

  return [...new Set(candidates.filter(Boolean) as string[])];
}

function normalizePathCandidate(candidate: string | undefined): string | undefined {
  if (!candidate) return undefined;
  if (candidate.startsWith(".")) return resolve(process.cwd(), candidate);
  return candidate;
}

function resolveOptionalPackage(packageName: string): string | undefined {
  try {
    return requireNative.resolve(packageName);
  } catch {
    return undefined;
  }
}
