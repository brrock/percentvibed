export async function updateComment(file: string) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!token || !repo || !eventPath)
    throw new Error("GITHUB_TOKEN, GITHUB_REPOSITORY and GITHUB_EVENT_PATH required");
  const body = await Bun.file(file).text();
  const event = await Bun.file(eventPath).json();
  const issue = event.pull_request?.number;
  if (!issue) throw new Error("Not a pull_request event");
  const api = `https://api.github.com/repos/${repo}/issues/${issue}/comments`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
  const comments = (await (await fetch(api, { headers })).json()) as any[];
  const existing = comments.find((c) =>
    String(c.body || "").includes("<!-- percentvibed:report -->"),
  );
  if (existing)
    await fetch(existing.url, { method: "PATCH", headers, body: JSON.stringify({ body }) });
  else await fetch(api, { method: "POST", headers, body: JSON.stringify({ body }) });
  console.log(existing ? "Updated PercentVibed PR comment" : "Created PercentVibed PR comment");
}
