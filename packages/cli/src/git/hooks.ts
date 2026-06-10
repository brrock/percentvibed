export const hookBlock = `# percentvibed:start
if command -v percentvibed >/dev/null 2>&1; then
  percentvibed hook pre-push "$@" || true
fi
# percentvibed:end
`;
export async function installPrePush(root: string) {
  const path = `${root}/.git/hooks/pre-push`;
  let cur = (await Bun.file(path).exists()) ? await Bun.file(path).text() : "#!/usr/bin/env bash\n";
  if (cur.includes("# percentvibed:start"))
    cur = cur.replace(/# percentvibed:start[\s\S]*?# percentvibed:end\n?/m, hookBlock);
  else {
    const lines = cur.split(/\n/);
    if (lines[0]?.startsWith("#!")) cur = lines[0] + "\n" + hookBlock + lines.slice(1).join("\n");
    else cur = "#!/usr/bin/env bash\n" + hookBlock + cur;
  }
  await Bun.write(path, cur);
  await Bun.$`chmod +x ${path}`;
}
export async function hasHook(root: string) {
  const p = `${root}/.git/hooks/pre-push`;
  return (await Bun.file(p).exists()) && (await Bun.file(p).text()).includes("percentvibed:start");
}
