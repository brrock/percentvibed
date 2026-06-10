# GitHub Actions integration

PercentVibed is designed so GitHub Actions needs no custom arguments.

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
```

## What `report` updates

`percentvibed report` updates two PR surfaces:

1. the top of the PR description with a shields.io badge
2. a sticky PR comment with detailed metrics and file-by-file breakdown

The PR body block is managed with these markers:

```md
<!-- percentvibed:badge:start -->
![PercentVibed 77%](https://img.shields.io/badge/PercentVibed-77%25-yellow)
<!-- percentvibed:badge:end -->
```

The comment is managed with this marker:

```md
<!-- percentvibed:report -->
```

## Outputs

`report` writes these values to `GITHUB_OUTPUT`:

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

## Automation examples

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

## Cleanup behavior

After reporting, GitHub removes `.percentvibed` from the PR branch, commits the removal, and pushes it. This keeps the temporary transport bundle out of the long-lived branch after the report has been generated.

Disable cleanup for debugging:

```yaml
env:
  PERCENTVIBED_KEEP_BUNDLE: "1"
```

## Fork PR caveat

Some repositories restrict `GITHUB_TOKEN` write permissions for forked PRs. If cleanup or PR updates fail in that setup, use repository settings or an alternate workflow trigger appropriate for your security model.
