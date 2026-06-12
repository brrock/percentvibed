# Local demo

This demo uses local preview mode and makes no GitHub API calls.

```bash
rm -rf /tmp/pv-demo
mkdir /tmp/pv-demo
cd /tmp/pv-demo

git init
git config user.email test@example.com
git config user.name test

mkdir src
cat > src/calc.ts <<'TS'
export function add(a: number, b: number): number {
  return a + b;
}
TS

git add src/calc.ts
git commit -m init

percentvibed init
percentvibed start
```

Ask your coding agent to edit the file from inside `/tmp/pv-demo`:

```txt
Edit src/calc.ts. Add an exported multiply(a: number, b: number): number function. Do not modify anything else.
```

Then capture and preview. If your agent runs a formatter or lint fixer, wrap it first with `percentvibed run -- <command>` so AI attribution is preserved for files the agent edited.

```bash
git add src/calc.ts
percentvibed capture
git add .percentvibed
git commit -m "add multiply"

percentvibed report --local --base HEAD~1
```

If matching agent edit evidence was found, the preview should show a non-zero PercentVibed percentage and a file breakdown.

If it shows 0%, inspect:

```bash
cat .git/percentvibed/debug.log
jq . .percentvibed/v1/sessions/*.json
```

Common reasons for 0%:

- the agent edited before `percentvibed start`
- the native scanner addon is missing
- the agent used an unsupported edit mechanism
- the changed file path did not match the staged diff
