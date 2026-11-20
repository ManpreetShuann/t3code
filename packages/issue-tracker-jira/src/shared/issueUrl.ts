import { IssueTrackerKind } from "@t3tools/contracts";

export const JIRA_KIND = IssueTrackerKind.make("jira");
/** Every Jira Cloud site is a subdomain of this; the site itself is the link's workspace. */
export const JIRA_HOST = "atlassian.net";

const SITE = /^([a-z0-9][a-z0-9-]*)\.atlassian\.net$/;
const KEY = /^([A-Z][A-Z0-9_]*)-[1-9][0-9]*$/;

/**
 * Recognizes Jira Cloud issue links on `<site>.atlassian.net`, keeping the site:
 * - `https://<site>.atlassian.net/browse/<PROJECT>-<n>`
 * - `https://<site>.atlassian.net/issues/<PROJECT>-<n>`
 * - `https://<site>.atlassian.net/...?selectedIssue=<PROJECT>-<n>` (boards, backlogs, filters)
 */
export function parseJiraIssueUrl(url: URL) {
  if (url.protocol !== "https:" || url.port !== "") return null;
  const site = SITE.exec(url.hostname.toLowerCase())?.[1];
  if (site === undefined) return null;

  const selected = url.searchParams.get("selectedIssue")?.trim();
  if (selected !== undefined && selected !== "") {
    const scope = KEY.exec(selected)?.[1];
    if (scope !== undefined) return { host: JIRA_HOST, workspace: site, scope, key: selected };
  }

  const [, resource, key, ...rest] = url.pathname.split("/");
  if ((resource !== "browse" && resource !== "issues") || key === undefined) return null;
  if (rest.some((segment) => segment !== "")) return null;
  const scope = KEY.exec(key)?.[1];
  return scope === undefined ? null : { host: JIRA_HOST, workspace: site, scope, key };
}
