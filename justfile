set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

# List available commands
_default:
  just --list

# Bump versions from the latest semver git tag, commit, tag, and push. Usage: just bump [patch|minor|major]
bump part="":
  #!/usr/bin/env bash
  set -euo pipefail

  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "Working tree has uncommitted changes. Commit or stash them before bumping." >&2
    exit 1
  fi

  part='{{part}}'
  if [ -z "$part" ]; then
    echo "Select version bump:"
    select choice in patch minor major; do
      case "$choice" in
        patch|minor|major) part="$choice"; break ;;
        *) echo "Please choose 1, 2, or 3." ;;
      esac
    done
  fi

  case "$part" in
    patch|minor|major) ;;
    *)
      echo "Usage: just bump [patch|minor|major]" >&2
      exit 2
      ;;
  esac

  latest="$(git tag --list | bun --eval '
    const tags = (await Bun.stdin.text())
      .split(/\r?\n/)
      .map((tag) => tag.trim())
      .filter(Boolean);

    const versions = tags
      .map((tag) => tag.match(/^v?(\d+)\.(\d+)\.(\d+)$/))
      .filter(Boolean)
      .map((match) => match.slice(1).map(Number));

    versions.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    const latest = versions.at(-1);
    if (latest) console.log(latest.join("."));
  ')"
  latest="${latest:-0.0.0}"

  IFS=. read -r major minor patch <<< "$latest"
  case "$part" in
    major)
      major=$((major + 1)); minor=0; patch=0
      ;;
    minor)
      minor=$((minor + 1)); patch=0
      ;;
    patch)
      patch=$((patch + 1))
      ;;
  esac

  next="$major.$minor.$patch"
  echo "Latest tag: $latest"
  echo "Bumping $part version to $next"

  VERSION="$next" bun --eval '
    import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
    import { join } from "node:path";

    const version = process.env.VERSION;
    if (!version) throw new Error("VERSION is required");

    const files = ["package.json"];
    for (const entry of readdirSync("packages", { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = join("packages", entry.name, "package.json");
      if (existsSync(file)) files.push(file);
    }

    const packages = files.map((file) => ({ file, json: JSON.parse(readFileSync(file, "utf8")) }));
    const workspaceNames = new Set(packages.map((pkg) => pkg.json.name).filter(Boolean));
    const dependencySections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

    for (const pkg of packages) {
      if (typeof pkg.json.version === "string") pkg.json.version = version;
      for (const section of dependencySections) {
        const deps = pkg.json[section];
        if (!deps || typeof deps !== "object") continue;
        for (const name of Object.keys(deps)) {
          if (workspaceNames.has(name)) deps[name] = version;
        }
      }
      writeFileSync(pkg.file, `${JSON.stringify(pkg.json, null, 2)}\n`);
      console.log(`updated ${pkg.file}`);
    }
  '

  bun install --lockfile-only

  git add package.json packages/*/package.json bun.lock
  git commit -m "chore: release $next [skip ci]"
  git tag "$next"
  git push
  git push origin "$next"

  echo "Done. Created and pushed release tag $next"
