# PercentVibed
> [!WARNING]  
> Beta, half tested software, thats not ready to be fully used yet.


PercentVibed is a local CLI + GitHub Action workflow. It lets a user or coding agent mark the beginning of an AI-assisted coding session, capture the staged git diff, attach compact provenance stats to the PR, and then remove the temporary transport bundle from the branch after GitHub has reported on it.

## What it reports

PercentVibed reports the share of a PR that has matching agent edit evidence.

It uses:

- the PR git diff as the source of truth for total changed lines
- local agent session stores as supporting evidence
- compact `.percentvibed` metadata for temporary PR transport

It does **not** count a change as agent-assisted just because someone ran `percentvibed start` or `percentvibed capture`. The scanner must find matching agent edit evidence for the changed files.

## Install/init

In a project:

```bash
percentvibed init
```

This creates only:

```txt
.percentvibed.json
```

It does not mutate your README, AGENTS.md, CONTRIBUTING.md, or GitHub workflows.

## Normal workflow

For agent-assisted changes:

```bash
percentvibed start

# edit with your agent

git add <changed-files>
percentvibed capture
git add .percentvibed
git commit -m "agent-assisted change"
percentvibed push
```

Human-only commits can stay normal:

```bash
git add <files>
git commit -m "fix typo"
git push
```

## Storage model

```txt
.git/percentvibed/
  active-session.json
  debug.log
  local private state
  never committed

.percentvibed/
  v1/
    manifest.json
    sessions/<session-id>.json
  compact sanitized PR transport data
  committed temporarily on PR branches
```

`.percentvibed` stores file-by-file stats, percentages inputs, and hashed evidence references. It does **not** store raw prompts, raw logs, raw local paths, secrets, or full patch files.

After `percentvibed push`, the local `.percentvibed` directory is hidden with git skip-worktree and removed from the working tree so local status stays clean.

On GitHub Actions, `percentvibed report` reads the committed transport bundle, updates the PR, then removes `.percentvibed` from the PR branch with a cleanup commit and pushes that cleanup commit.

## GitHub Action

Copy this into `.github/workflows/percentvibed.yml`:

```yaml
name: PercentVibed

on:
  pull_request:
    types: [opened, synchronize, reopened, edited]

permissions:
  contents: write
  pull-requests: write
  issues: write

jobs:
  percentvibed:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: oven-sh/setup-bun@v2

      - id: percentvibed
        run: bunx percentvibed report
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - run: echo "PercentVibed share is ${{ steps.percentvibed.outputs.percent }}%"
```

`percentvibed report` requires no args on GitHub Actions. It:

1. infers the PR base from `GITHUB_BASE_REF`
2. reads `.percentvibed` from the current tree and previous PR commits
3. updates the top of the PR description with a shields.io badge
4. creates/updates a sticky comment with the file-by-file breakdown
5. writes GitHub Actions outputs for automation
6. removes `.percentvibed` from the PR branch, commits, and pushes the cleanup

Set this if you want to keep the temporary bundle for debugging:

```yaml
env:
  PERCENTVIBED_KEEP_BUNDLE: "1"
```

## Automation examples

Block or label based on percentage:

```yaml
- id: percentvibed
  run: bunx percentvibed report
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

- if: ${{ steps.percentvibed.outputs.percent == '100' }}
  run: echo "fully agent-assisted"

- if: ${{ fromJSON(steps.percentvibed.outputs.percent) >= 50 }}
  run: echo "at least half agent-assisted"

- if: ${{ fromJSON(steps.percentvibed.outputs.percent) < 10 }}
  run: echo "mostly human-authored"
```

Available outputs:

| Output | Meaning |
|---|---|
| `percent` | detected agent-assisted percentage |
| `pr_added` | PR added lines |
| `pr_deleted` | PR deleted lines |
| `agent_added` | detected agent-assisted added lines |
| `agent_deleted` | detected agent-assisted deleted lines |
| `agent_files` | files with detected agent evidence |
| `captured_sessions` | PercentVibed capture sessions read |
| `agent_sessions` | sessions with agent edit evidence |

## Local report preview

Use local mode to preview the GitHub output without making API calls:

```bash
percentvibed report --local
```

This prints:

- the PR description badge block
- the sticky PR comment markdown
- the file-by-file breakdown

You can still pass a base locally if needed:

```bash
percentvibed report --local --base HEAD~3
```

## Commands

| Command | Purpose |
|---|---|
| `percentvibed init` | create `.percentvibed.json` |
| `percentvibed start` | create local active session state in `.git/percentvibed` |
| `percentvibed capture` | scan agent sessions since start and write compact `.percentvibed` transport data for staged changes |
| `percentvibed install-hooks` | install a non-blocking pre-push warning hook |
| `percentvibed hook pre-push` | internal hook entrypoint |
| `percentvibed push [...git-push-args]` | run managed `git push`, then hide local `.percentvibed` on success |
| `percentvibed clean --hide` | hide tracked `.percentvibed` locally with skip-worktree |
| `percentvibed restore` | undo local skip-worktree hiding and restore `.percentvibed` |
| `percentvibed report` | GitHub report/update mode in Actions; local preview outside Actions |
| `percentvibed report --local` | force local preview and never call GitHub |
| `percentvibed doctor` | print diagnostics and actionable fixes |
| `percentvibed detectors inspect` | safely summarize local detector/session formats |

## Scanner

The Zig scanner is required for capture. It scans local session stores modified after `percentvibed start`, extracts normalized edit evidence, and returns sanitized JSON.

Supported targets in v1:

- Pi coding agent
- OpenAI Codex CLI
- Claude Code
- Cursor CLI generic stores
- Factory Droid generic stores

Cursor IDE SQLite parsing is handled in TypeScript.

The scanner must not output raw prompts, raw logs, secrets, or absolute local paths.

## Safety rules

PercentVibed refuses or avoids unsafe transport data. Do not commit:

- raw prompts
- raw agent logs
- `.env` files
- secrets or credentials
- private keys
- raw local filesystem paths

At minimum capture checks for obvious secrets such as private key markers and common token/API key names.

## Direct main/master pushes

PercentVibed is PR-oriented. If you run `percentvibed push` directly from `main` or `master`, it prompts before continuing. In non-interactive terminals, pass:

```bash
percentvibed push --allow-main
```

For direct main/master pushes, local PercentVibed state is removed before pushing because there will be no PR report.

## More docs

- [Storage and lifecycle](docs/storage-and-lifecycle.md)
- [GitHub Actions integration](docs/github-actions.md)
- [Local demo](docs/local-demo.md)
- [Publishing](docs/publishing.md)
- [Detector research](docs/detectors/research.md)

## Debugging

Local debug logs live in:

```txt
.git/percentvibed/debug.log
```

These logs are private local state and are never committed.
