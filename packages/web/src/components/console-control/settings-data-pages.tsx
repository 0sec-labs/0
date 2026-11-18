import { RepositoriesSettings } from "./repositories-control";
import { GitHubPublicationControl } from "./github-publication-control";
import { GitHubWebhookControl } from "./github-webhook-control";

/** The one GitHub connection and the repositories it can reach. */
export function GitSettings() {
  return <div className="flex flex-col gap-10">
    <GitHubPublicationControl secondary />
    <GitHubWebhookControl />
    <RepositoriesSettings embedded />
  </div>;
}
