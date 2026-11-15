import {
  makeProviderSettingsSchema,
  SettingsSecretValue,
  SourceControlProviderKind,
  TrimmedString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  defineSourceControl,
  isChangeRequestInProjectRepository,
  projectChangeRequestHost,
  type ChangeRequestHostIdentity,
  type ChangeRequestLink,
  type ChangeRequestUrlInput,
  type CommitLink,
  type ParsedChangeRequestUrl,
  type SourceControlMediaUrl,
} from "@t3tools/source-control-core/shared/definition";

import { icon } from "./icon.ts";

const KIND = SourceControlProviderKind.make("bitbucket-server");
const PR_PATH = /^(.*?)\/(projects|users)\/([^/]+)\/repos\/([^/]+)\/pull-requests\/(\d+)(?:\/|$)/u;
const COMMIT_PATH =
  /^(.*?)\/(projects|users)\/([^/]+)\/repos\/([^/]+)\/commits\/([0-9a-f]{40}|[0-9a-f]{64})\/?$/iu;
const REPOSITORY_PAGE_PATH = /^(.*?)\/(projects|users)\/([^/]+)\/repos\/([^/]+)(?:\/|$)/u;
const FULL_COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const ATTACHMENT_PATH =
  /^((?:\/[^/]+)*?)\/rest\/api\/(?:latest|1\.0)\/projects\/([^/]+)\/repos\/([^/]+)\/attachments\/(\d+)$/u;
const ATTACHMENT_LINK = /\(attachment:\d+\/(\d+)(?=[\s)])/gu;

export function repositoryNameFromRemoteUrl(value: string): string | null {
  const path = URL.parse(value)?.pathname ?? /^[^@/]+@[^:]+:(.+)$/u.exec(value)?.[1];
  const match = path && /(?:^|\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/u.exec(path);
  return match ? `${match[1]}/${match[2]}` : null;
}

function parseChangeRequestUrl(url: URL): ParsedChangeRequestUrl | null {
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const match = PR_PATH.exec(url.pathname);
  if (!match || !Number.isSafeInteger(Number(match[5])) || Number(match[5]) < 1) return null;
  return {
    host: url.hostname.toLowerCase(),
    ...(url.port ? { authority: url.host.toLowerCase() } : {}),
    repository: `${match[2] === "users" ? "~" : ""}${match[3]}/${match[4]}`.toLowerCase(),
    number: Number(match[5]),
    repositoryUrl: `${url.origin}${match[1]}/${match[2]}/${match[3]}/repos/${match[4]}`,
  };
}

function parseCommitUrl(url: URL): CommitLink | null {
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const match = COMMIT_PATH.exec(url.pathname);
  if (!match?.[5]) return null;
  return {
    host: url.hostname.toLowerCase(),
    ...(url.port ? { authority: url.host.toLowerCase() } : {}),
    repository: `${match[2] === "users" ? "~" : ""}${match[3]}/${match[4]}`.toLowerCase(),
    sha: match[5].toLowerCase(),
  };
}

/** A browser page inside a repository names its HTTPS clone URL, which lives under `/scm`. */
function repositoryUrlFromPage(url: URL): string | null {
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const match = REPOSITORY_PAGE_PATH.exec(url.pathname);
  if (!match) return null;
  // Keeps the credentials and port a private clone relies on.
  const cloneUrl = new URL(url);
  cloneUrl.pathname = `${match[1]}/scm/${match[2] === "users" ? "~" : ""}${match[3]}/${match[4]}.git`;
  cloneUrl.search = "";
  cloneUrl.hash = "";
  return cloneUrl.href;
}

/**
 * Markdown names an upload `attachment:{repository id}/{id}`, which only the host's own pages
 * resolve. Pointed at the repository's REST attachment instead, `mediaUrl` claims it.
 */
export function withAttachmentUrls(markdown: string, pullRequestUrl: string): string {
  const url = URL.parse(pullRequestUrl);
  const match = url && PR_PATH.exec(url.pathname);
  if (!url || !match) return markdown;
  const project = match[2] === "users" ? `~${match[3]}` : match[3];
  const base = `${url.origin}${match[1]}/rest/api/latest/projects/${project}/repos/${match[4]}/attachments/`;
  return markdown.replace(ATTACHMENT_LINK, (_link, id: string) => `(${base}${id}`);
}

/** An upload is served only to a request carrying the token, so the server fetches it. */
function mediaUrl(url: URL): SourceControlMediaUrl | null {
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.search) return null;
  const match = ATTACHMENT_PATH.exec(url.pathname);
  if (!match) return null;
  return {
    fetchUrl: `${url.origin}${match[1]}/rest/api/latest/projects/${match[2]}/repos/${match[3]}/attachments/${match[4]}`,
    fileName: `attachment-${match[4]}`,
    immutable: true,
  };
}

/** The repository's browser URL, from the project's web URL or else its HTTPS remote. */
function repositoryWebUrl({
  host,
  repository,
  remoteUrl,
  webUrl,
}: Omit<ChangeRequestUrlInput, "number">): string | null {
  if (webUrl) return webUrl.replace(/\/(browse)?$/u, "");
  const [project, slug, ...rest] = repository.split("/");
  if (!project || !slug || rest.length > 0) return null;
  const remote = URL.parse(remoteUrl ?? "");
  if (!remote || !/^https?:$/u.test(remote.protocol)) return null;
  if (
    remote.hostname.toLowerCase() !== host.toLowerCase() &&
    remote.host.toLowerCase() !== host.toLowerCase()
  )
    return null;
  const root = `${remote.origin}${/^(.*?)\/scm\//u.exec(remote.pathname)?.[1] ?? ""}`;
  return `${root}/projects/${encodeURIComponent(project)}/repos/${encodeURIComponent(slug)}`;
}

function changeRequestHost(identity: ChangeRequestHostIdentity): string {
  for (const value of [identity?.webUrl, identity?.locator?.remoteUrl]) {
    const url = URL.parse(value ?? "");
    if (url && /^https?:$/u.test(url.protocol)) return url.host.toLowerCase();
  }
  return projectChangeRequestHost(identity, KIND);
}

function canReadChangeRequestOnHost(
  identity: ChangeRequestHostIdentity,
  link: Pick<ChangeRequestLink, "host" | "authority">,
) {
  return changeRequestHost(identity) === (link.authority ?? link.host).toLowerCase();
}

export const settings = makeProviderSettingsSchema(
  {
    url: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Host URL",
        description: "Include the context path if Bitbucket is served under one.",
        providerSettingsForm: { placeholder: "https://bitbucket.example.com" },
      }),
    ),
    token: SettingsSecretValue.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "HTTP access token",
        description:
          "A Data Center token with repository read access; repository write access is required to merge.",
        providerSettingsForm: { control: "password" },
      }),
    ),
  },
  { order: ["url", "token"] },
);
export type BitbucketServerSettings = typeof settings.Type;

export const definition = defineSourceControl({
  kind: KIND,
  label: "Bitbucket Data Center",
  pickerLabel: "Bitbucket Data Center",
  icon,
  changeRequest: {
    shortLabel: "PR",
    shortLabelWithArticle: "a PR",
    singular: "pull request",
    plural: "pull requests",
  },
  repositoryPathHint: "PROJECTKEY/repo-slug",
  publicHost: null,
  publishDescription: "Your configured Data Center instance",
  publishHost: (signedInHost) => signedInHost ?? "your server",
  newRepositoryOwner: () => null,
  defaultCloneTransport: "https",
  changeRequestUrl: (input) => {
    const base = repositoryWebUrl(input);
    return base === null ? null : `${base}/pull-requests/${input.number}`;
  },
  commitUrl: (input) => {
    const base = FULL_COMMIT_SHA.test(input.sha) ? repositoryWebUrl(input) : null;
    return base === null ? null : `${base}/commits/${input.sha.toLowerCase()}`;
  },
  parseCommitUrl,
  parseChangeRequestUrl,
  repositoryUrlFromPage,
  mediaUrl,
  changeRequestUrlFromReferenceAutolink: () => null,
  changeRequestActions: new Set([
    "merge",
    "ready",
    "draft",
    "close",
    "reopen",
    "delete-branch",
    "update-branch",
    "enable-auto-merge",
    "disable-auto-merge",
  ] as const),
  changeRequestHeadRef: (number) => `refs/pull-requests/${number}/from`,
  checkoutCommand: () => null,
  authorProfileUrl: () => null,
  reviewSummaryRequired: () => false,
  checkoutCommandArgument: () => null,
  isChangeRequestReference: (value) => {
    const url = URL.parse(value);
    return url !== null && parseChangeRequestUrl(url) !== null;
  },
  checkoutChangeRequestHost: () => null,
  recognizeRemote: ({ remoteUrl, host, hostname }) => {
    if (hostname === "bitbucket.org" || hostname.endsWith(".bitbucket.org")) return null;
    const url = URL.parse(remoteUrl);
    const mount =
      url && /^https?:$/u.test(url.protocol)
        ? /^(.*?)\/scm\/[^/]+\/[^/]+$/u.exec(url.pathname)
        : null;
    return hostname.split(".").includes("bitbucket") || mount !== null
      ? {
          kind: KIND,
          name: "Bitbucket Data Center",
          baseUrl: mount && url ? `${url.origin}${mount[1]}` : `https://${host}`,
        }
      : null;
  },
  changeRequestHost,
  isChangeRequestInRepository: (identity, link) =>
    canReadChangeRequestOnHost(identity, link) &&
    isChangeRequestInProjectRepository(changeRequestHost(identity), identity, link),
  canReadChangeRequestOnHost,
  settings,
});
