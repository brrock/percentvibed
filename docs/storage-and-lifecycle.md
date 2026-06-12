# PercentVibed storage and lifecycle

PercentVibed uses two storage areas with different purposes.

## Local private state

```txt
.git/percentvibed/
  active-session.json
  commands/<command-id>.json
  debug.log
```

This directory is local-only git internals. It is never committed.

`active-session.json` records the session id, start time, branch, and base commit. `capture` passes the start time to the scanner so only fresh agent sessions are considered.

`commands/` stores local `percentvibed run` command records with sanitized command text, per-file line stats, and content hashes. These records are private local state until `capture` writes compact matching evidence into `.percentvibed/`; formatter/lint-fix records only contribute to files that also have agent edit evidence.

`debug.log` records safe operational diagnostics such as scanner start/done, matched event counts, and capture completion. It must not contain prompts, raw logs, secrets, or full diffs.

## Temporary PR transport

```txt
.percentvibed/
  v1/
    manifest.json
    sessions/
      <session-id>.json
```

This is committed temporarily on PR branches so GitHub Actions can read it.

The transport bundle contains compact reporting data only:

- session id and timestamps
- git branch/base commit metadata
- total staged file stats
- file-by-file changed line stats
- normalized agent edit events
- event-level line stats when available
- formatter/lint-fix command summaries from `percentvibed run`
- compact formatter/lint-fix per-file stats and hashes used only to preserve attribution for agent-edited files
- hashed evidence references

It does not contain raw prompts, raw logs, raw local paths, secrets, or full patch files.

## Local lifecycle

```bash
percentvibed start
# writes .git/percentvibed/active-session.json

# edit with an agent

# optionally preserve AI attribution through formatter/lint-fix output
percentvibed run -- bun run format
percentvibed run -- bun run lint:fix

git add <changed-files>
percentvibed capture
# writes .percentvibed/v1/...

git add .percentvibed
git commit -m "agent-assisted change"
percentvibed push
```

After a successful `percentvibed push`, tracked `.percentvibed` files are marked skip-worktree and the local directory is removed. This keeps the working tree clean without deleting the committed transport from the PR branch before GitHub Actions can read it.

## Multi-commit PR lifecycle

A PR can have many commits and many PercentVibed sessions. After local cleanup, the next `capture` hydrates the last committed `.percentvibed` bundle from `HEAD`, appends the new session metadata, and writes a new compact transport bundle.

On GitHub, `report` also scans previous PR commits for `.percentvibed` bundles. This lets reporting continue to work after the action has cleaned the bundle from the latest commit.

## GitHub lifecycle

In GitHub Actions:

```bash
percentvibed report
```

The command:

1. infers the base ref from `GITHUB_BASE_REF`
2. computes total PR stats from git diff
3. reads compact `.percentvibed` bundles from the current tree and previous PR commits
4. updates the PR description badge
5. updates the sticky PR comment
6. writes GitHub Actions outputs
7. removes `.percentvibed`, commits that removal, and pushes it back to the PR branch

Set `PERCENTVIBED_KEEP_BUNDLE=1` to skip the cleanup commit for debugging.
