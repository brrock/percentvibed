import { repoRoot } from "../git/repo";
import { installPrePush } from "../git/hooks";
export async function installHooks() {
  const root = repoRoot();
  await installPrePush(root);
  console.log("Installed PercentVibed pre-push hook managed block.");
}
