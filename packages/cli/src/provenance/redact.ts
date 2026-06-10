const patterns = [
  /BEGIN (?:RSA |EC |OPENSSH |)?PRIVATE KEY/i,
  /AWS_ACCESS_KEY_ID/i,
  /SECRET_ACCESS_KEY/i,
  /GITHUB_TOKEN/i,
  /OPENAI_API_KEY/i,
  /ANTHROPIC_API_KEY/i,
  /api[_-]?key\s*[:=]/i,
  /password\s*=/i,
  /secret\s*=/i,
  /token\s*=/i,
];
export function unsafePaths(files: string[]) {
  return files.filter((f) => f === ".env" || f.endsWith("/.env") || /\.pem$/i.test(f));
}
export function findSecretHits(text: string) {
  return patterns.filter((p) => p.test(text)).map((p) => p.source);
}
export function redactText(text: string) {
  let out = text;
  for (const p of patterns) out = out.replace(p, "[REDACTED_PATTERN]");
  return out;
}
