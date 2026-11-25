/**
 * Jira Cloud's REST API (v3), signed with the account email and API token saved in Settings and
 * sent to the site saved beside them. Jira writes its refusals for people, so they pass through.
 */
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import type { IssueCommentAudience } from "@t3tools/contracts";
import {
  IssueTrackerError,
  type IssueTrackerCredential,
} from "@t3tools/source-control-core/server/IssueTracker";
import * as IssueTrackerHost from "@t3tools/source-control-core/server/IssueTrackerHost";

import { JIRA_KIND } from "../shared/issueUrl.ts";
import type { AdfNode } from "./adf.ts";

export const KIND = JIRA_KIND;
const REQUEST_TIMEOUT = "30 seconds";
const PAGE = 100;
/** Pages read of a list that only feeds a picker; past it the list is reported truncated. */
const MAX_PAGES = 5;

const User = Schema.Struct({
  accountId: Schema.String,
  displayName: Schema.optional(Schema.NullOr(Schema.String)),
  emailAddress: Schema.optional(Schema.NullOr(Schema.String)),
  accountType: Schema.optional(Schema.NullOr(Schema.String)),
  avatarUrls: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
});
export type JiraUser = typeof User.Type;

const Status = Schema.Struct({
  name: Schema.String,
  statusCategory: Schema.optional(Schema.NullOr(Schema.Struct({ key: Schema.String }))),
});
export type JiraStatus = typeof Status.Type;

const Transition = Schema.Struct({ id: Schema.String, name: Schema.String, to: Status });
export type JiraTransition = typeof Transition.Type;

const History = Schema.Struct({
  id: Schema.String,
  author: Schema.optional(Schema.NullOr(User)),
  created: Schema.String,
  items: Schema.Array(
    Schema.Struct({
      field: Schema.String,
      fromString: Schema.optional(Schema.NullOr(Schema.String)),
      toString: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});
export type JiraHistory = typeof History.Type;

const IssueProject = Schema.Struct({
  key: Schema.String,
  projectTypeKey: Schema.optional(Schema.String),
});

const Named = Schema.Struct({ name: Schema.String });

const RelatedIssue = Schema.Struct({
  key: Schema.String,
  fields: Schema.optional(
    Schema.Struct({
      summary: Schema.optional(Schema.String),
      status: Schema.optional(Status),
    }),
  ),
});
export type JiraRelatedIssue = typeof RelatedIssue.Type;

const IssueLink = Schema.Struct({
  type: Schema.Struct({
    name: Schema.String,
    inward: Schema.optional(Schema.String),
    outward: Schema.optional(Schema.String),
  }),
  inwardIssue: Schema.optional(RelatedIssue),
  outwardIssue: Schema.optional(RelatedIssue),
});
export type JiraIssueLink = typeof IssueLink.Type;

const Attachment = Schema.Struct({
  id: Schema.String,
  filename: Schema.String,
  content: Schema.String,
  mimeType: Schema.optional(Schema.NullOr(Schema.String)),
  size: Schema.optional(Schema.NullOr(Schema.Number)),
});
export type JiraAttachment = typeof Attachment.Type;

const Issue = Schema.Struct({
  id: Schema.String,
  key: Schema.String,
  fields: Schema.Struct({
    summary: Schema.String,
    status: Status,
    project: Schema.optional(IssueProject),
    reporter: Schema.optional(Schema.NullOr(User)),
    assignee: Schema.optional(Schema.NullOr(User)),
    labels: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
    created: Schema.String,
    updated: Schema.String,
    resolutiondate: Schema.optional(Schema.NullOr(Schema.String)),
    description: Schema.optional(Schema.Unknown),
    issuetype: Schema.optional(Schema.NullOr(Named)),
    priority: Schema.optional(Schema.NullOr(Named)),
    parent: Schema.optional(Schema.NullOr(RelatedIssue)),
    subtasks: Schema.optional(Schema.NullOr(Schema.Array(RelatedIssue))),
    issuelinks: Schema.optional(Schema.NullOr(Schema.Array(IssueLink))),
    attachment: Schema.optional(Schema.NullOr(Schema.Array(Attachment))),
  }),
  transitions: Schema.optional(Schema.Array(Transition)),
  changelog: Schema.optional(Schema.Struct({ histories: Schema.Array(History) })),
});
export type JiraIssue = typeof Issue.Type;

const Comment = Schema.Struct({
  id: Schema.String,
  author: Schema.optional(Schema.NullOr(User)),
  body: Schema.optional(Schema.Unknown),
  created: Schema.String,
  /** False on a Service Management internal note. */
  jsdPublic: Schema.optional(Schema.NullOr(Schema.Boolean)),
});
export type JiraComment = typeof Comment.Type;

const ISSUE_FIELDS = [
  "summary",
  "status",
  "project",
  "reporter",
  "assignee",
  "labels",
  "created",
  "updated",
  "resolutiondate",
];

/** Only an issue's own page shows these. */
const DETAIL_FIELDS = [
  "description",
  "issuetype",
  "priority",
  "parent",
  "subtasks",
  "issuelinks",
  "attachment",
];

const IssueType = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  subtask: Schema.optional(Schema.Boolean),
});
export interface JiraIssueType {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly subtask: boolean;
}
const toIssueType = (type: typeof IssueType.Type): JiraIssueType => ({
  id: type.id,
  name: type.name,
  description: type.description ?? null,
  subtask: type.subtask === true,
});

export const JiraPullRequest = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
  status: Schema.optional(Schema.String),
});
export type JiraPullRequest = typeof JiraPullRequest.Type;

/** Jira's development panel: which connected tools (GitHub, GitLab, Bitbucket) hold PRs. */
const DevelopmentSummary = Schema.Struct({
  summary: Schema.Struct({
    pullrequest: Schema.optional(
      Schema.Struct({
        byInstanceType: Schema.Record(Schema.String, Schema.Struct({ count: Schema.Number })),
      }),
    ),
  }),
});

const DevelopmentDetail = Schema.Struct({
  detail: Schema.Array(
    Schema.Struct({ pullRequests: Schema.optional(Schema.Array(JiraPullRequest)) }),
  ),
});

const ErrorBody = Schema.fromJsonString(
  Schema.Struct({
    errorMessages: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
    errors: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
    message: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);
const decodeErrorBody = Schema.decodeUnknownOption(ErrorBody);

interface JiraSite {
  readonly origin: string;
  readonly email: string;
  readonly token: string;
}

export const fail = (
  operation: string,
  reason: IssueTrackerError["reason"],
  detail: string,
  extra: { readonly retryAt?: number | undefined; readonly cause?: unknown } = {},
) =>
  new IssueTrackerError({
    tracker: KIND,
    operation,
    reason,
    detail,
    ...(extra.retryAt === undefined ? {} : { retryAt: extra.retryAt }),
    ...(extra.cause === undefined ? {} : { cause: extra.cause }),
  });

/**
 * `acme`, `acme.atlassian.net` or any page of the site, as the origin requests go to. Https only:
 * the email and token ride on every request.
 */
export function siteOrigin(site: string): string | null {
  const trimmed = site.trim();
  const named = /^[a-z0-9-]+$/i.test(trimmed) ? `${trimmed}.atlassian.net` : trimmed;
  const url = URL.parse(/^[a-z][a-z0-9+.-]*:\/\//i.test(named) ? named : `https://${named}`);
  return url === null || url.protocol !== "https:" || !url.hostname.includes(".")
    ? null
    : url.origin;
}

const toSite = (operation: string, credential: IssueTrackerCredential) => {
  const origin = siteOrigin(credential.fields["site"] ?? "");
  const email = credential.fields["email"]?.trim() ?? "";
  if (origin === null) {
    return Effect.fail(
      fail(operation, "unauthenticated", "Enter the Jira site as yourteam.atlassian.net."),
    );
  }
  if (email.length === 0) {
    return Effect.fail(fail(operation, "unauthenticated", "Enter the Jira account's email."));
  }
  return Effect.succeed<JiraSite>({ origin, email, token: credential.token });
};

function retryAt(value: string | undefined, now: number): number | undefined {
  const seconds = /^\d+$/u.test(value?.trim() ?? "") ? Number(value) : Number.NaN;
  return Number.isSafeInteger(seconds) ? now + seconds * 1_000 : undefined;
}

type Query = Readonly<Record<string, string | number | undefined>>;

export class JiraApi extends Context.Service<
  JiraApi,
  {
    /** The site issues are linked on. Fails when Jira is not connected. */
    readonly origin: Effect.Effect<string, IssueTrackerError>;
    /** Takes the credential so it can vet a new one before it is stored. */
    readonly myself: (
      credential?: IssueTrackerCredential,
    ) => Effect.Effect<JiraUser, IssueTrackerError>;
    readonly projects: (
      credential?: IssueTrackerCredential,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly key: string; readonly name: string }>,
      IssueTrackerError
    >;
    readonly search: (input: {
      readonly jql: string;
      readonly limit: number;
      readonly pageToken?: string | undefined;
    }) => Effect.Effect<
      { readonly issues: ReadonlyArray<JiraIssue>; readonly nextPageToken: string | null },
      IssueTrackerError
    >;
    /** With the description, the transitions the account may make, and the change history. */
    readonly getIssue: (key: string) => Effect.Effect<JiraIssue, IssueTrackerError>;
    /** Newest first, `startAt` counting from the newest. */
    readonly getComments: (input: {
      readonly key: string;
      readonly startAt: number;
      readonly limit: number;
    }) => Effect.Effect<
      { readonly comments: ReadonlyArray<JiraComment>; readonly total: number },
      IssueTrackerError
    >;
    /** Which of the named permissions the account holds on the issue. */
    readonly permissions: (
      key: string,
      names: ReadonlyArray<string>,
    ) => Effect.Effect<Readonly<Record<string, boolean>>, IssueTrackerError>;
    /** The types this account can file in the project. */
    readonly issueTypes: (
      project: string,
    ) => Effect.Effect<ReadonlyArray<JiraIssueType>, IssueTrackerError>;
    /** Every type the project's issues can have, subtasks included, for filtering. */
    readonly projectIssueTypes: (
      project: string,
    ) => Effect.Effect<ReadonlyArray<JiraIssueType>, IssueTrackerError>;
    /** Every status the project's workflows use, once per issue type that uses it. */
    readonly projectStatuses: (
      project: string,
    ) => Effect.Effect<ReadonlyArray<JiraStatus>, IssueTrackerError>;
    /**
     * The pull requests Jira's development panel shows for an issue, from every connected tool.
     * Jira serves these from an undocumented API, so callers treat a failure as none.
     */
    readonly pullRequests: (
      issueId: string,
    ) => Effect.Effect<ReadonlyArray<JiraPullRequest>, IssueTrackerError>;
    readonly createIssue: (
      fields: Record<string, unknown>,
    ) => Effect.Effect<{ readonly key: string }, IssueTrackerError>;
    readonly updateIssue: (
      key: string,
      fields: Record<string, unknown>,
    ) => Effect.Effect<void, IssueTrackerError>;
    readonly transition: (key: string, id: string) => Effect.Effect<void, IssueTrackerError>;
    /** On a Service Management issue the comment is an internal note unless `audience` is public. */
    readonly addComment: (
      key: string,
      body: AdfNode,
      audience: IssueCommentAudience | undefined,
    ) => Effect.Effect<void, IssueTrackerError>;
    readonly labels: Effect.Effect<
      { readonly names: ReadonlyArray<string>; readonly truncated: boolean },
      IssueTrackerError
    >;
    /** One page of the site's labels from `startAt`, or those Jira suggests for `query`. */
    readonly labelPage: (input: {
      readonly startAt: number;
      readonly query?: string | undefined;
    }) => Effect.Effect<
      { readonly names: ReadonlyArray<string>; readonly hasMore: boolean },
      IssueTrackerError
    >;
    readonly assignable: (
      project: string,
      filter?: { readonly query: string } | { readonly accountId: string },
    ) => Effect.Effect<
      { readonly users: ReadonlyArray<JiraUser>; readonly truncated: boolean },
      IssueTrackerError
    >;
    /** One page of the project's assignable people from `startAt`, narrowed by `query`. */
    readonly assignablePage: (
      project: string,
      input: { readonly startAt: number; readonly query?: string | undefined },
    ) => Effect.Effect<
      { readonly users: ReadonlyArray<JiraUser>; readonly hasMore: boolean },
      IssueTrackerError
    >;
    /** People matching a name or email, for turning what a client sent into an account id. */
    readonly findUsers: (
      query: string,
    ) => Effect.Effect<ReadonlyArray<JiraUser>, IssueTrackerError>;
  }
>()("@t3tools/issue-tracker-jira/server/JiraApi") {}

export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const host = yield* IssueTrackerHost.IssueTrackerHost;

  const storedSite = (operation: string) =>
    host.credentials.get(KIND).pipe(
      Effect.flatMap(
        Effect.fromOption(() =>
          fail(operation, "unauthenticated", "Jira is not connected on this server."),
        ),
      ),
      Effect.flatMap((credential) => toSite(operation, credential)),
    );

  const refusal = Effect.fn("JiraApi.refusal")(function* (
    operation: string,
    response: HttpClientResponse.HttpClientResponse,
  ): Effect.fn.Return<never, IssueTrackerError> {
    const now = yield* Clock.currentTimeMillis;
    const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    const said = Option.match(decodeErrorBody(body), {
      onNone: () => undefined,
      onSome: (error) =>
        [...(error.errorMessages ?? []), ...Object.values(error.errors ?? {}), error.message]
          .find((message) => message != null && message.trim().length > 0)
          ?.trim(),
    });
    if (response.status === 429) {
      return yield* fail(operation, "rate-limited", "Jira's rate limit was reached.", {
        retryAt: retryAt(response.headers["retry-after"], now),
      });
    }
    if (response.status === 401) {
      return yield* fail(operation, "unauthenticated", "Jira rejected the email or API token.");
    }
    if (response.status === 404) {
      return yield* fail(operation, "not-found", said ?? "Jira has nothing at that address.");
    }
    return yield* fail(
      operation,
      "failed",
      said ??
        (response.status === 403
          ? "This Jira account is not allowed to do that."
          : `Jira returned HTTP ${response.status}.`),
    );
  });

  const send = Effect.fn("JiraApi.send")(function* <S extends Schema.Top>(
    operation: string,
    schema: S,
    request: {
      readonly method: "GET" | "POST" | "PUT";
      readonly path: string;
      readonly query?: Query;
      readonly body?: unknown;
      readonly credential?: IssueTrackerCredential | undefined;
    },
  ): Effect.fn.Return<S["Type"], IssueTrackerError, S["DecodingServices"]> {
    yield* Effect.annotateCurrentSpan({ "jira.operation": operation });
    const site =
      request.credential === undefined
        ? yield* storedSite(operation)
        : yield* toSite(operation, request.credential);
    const base = HttpClientRequest.make(request.method)(`${site.origin}${request.path}`, {
      urlParams: Object.entries(request.query ?? {}).flatMap(([key, value]) =>
        value === undefined ? [] : [[key, String(value)] as const],
      ),
    }).pipe(HttpClientRequest.acceptJson, HttpClientRequest.basicAuth(site.email, site.token));
    const unreachable = (cause: unknown) =>
      fail(operation, "failed", "Jira could not be reached.", { cause });
    // The deadline covers the body too: a site can send its headers and then stall.
    return yield* Effect.gen(function* () {
      const response = yield* httpClient
        .execute(
          request.body === undefined
            ? base
            : base.pipe(HttpClientRequest.bodyJsonUnsafe(request.body)),
        )
        .pipe(Effect.mapError(unreachable));
      if (response.status < 200 || response.status >= 300) {
        return yield* refusal(operation, response);
      }
      // A write answers 204 with no body; `Schema.Void` reads nothing.
      if (response.status === 204) return undefined as S["Type"];
      return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
        Effect.mapError((cause) =>
          fail(operation, "failed", "Jira returned an unexpected body.", { cause }),
        ),
      );
    }).pipe(
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.mapError((error) => (Cause.isTimeoutError(error) ? unreachable(error) : error)),
    );
  });

  /**
   * Reads `startAt` pages until Jira has no more or the cap is reached. A `filtered` endpoint
   * drops entries after paging, so only an empty page ends it.
   */
  const paged = Effect.fn("JiraApi.paged")(function* <A>(
    read: (startAt: number) => Effect.Effect<ReadonlyArray<A>, IssueTrackerError>,
    filtered = false,
  ): Effect.fn.Return<
    { readonly items: ReadonlyArray<A>; readonly truncated: boolean },
    IssueTrackerError
  > {
    const items: A[] = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const batch = yield* read(page * PAGE);
      items.push(...batch);
      if (filtered ? batch.length === 0 : batch.length < PAGE) return { items, truncated: false };
    }
    return { items, truncated: true };
  });

  const myself: JiraApi["Service"]["myself"] = (credential) =>
    send("myself", User, { method: "GET", path: "/rest/api/3/myself", credential });

  const projects: JiraApi["Service"]["projects"] = (credential) =>
    paged((startAt) =>
      send(
        "projects",
        Schema.Struct({
          values: Schema.Array(Schema.Struct({ key: Schema.String, name: Schema.String })),
        }),
        {
          method: "GET",
          path: "/rest/api/3/project/search",
          query: { startAt, maxResults: PAGE, orderBy: "name" },
          credential,
        },
      ).pipe(Effect.map((page) => page.values)),
    ).pipe(Effect.map((page) => page.items));

  const search: JiraApi["Service"]["search"] = (input) =>
    send(
      "search",
      Schema.Struct({
        issues: Schema.Array(Issue),
        nextPageToken: Schema.optional(Schema.NullOr(Schema.String)),
      }),
      {
        method: "POST",
        path: "/rest/api/3/search/jql",
        body: {
          jql: input.jql,
          maxResults: input.limit,
          fields: ISSUE_FIELDS,
          ...(input.pageToken === undefined ? {} : { nextPageToken: input.pageToken }),
        },
      },
    ).pipe(
      Effect.map((page) => ({ issues: page.issues, nextPageToken: page.nextPageToken ?? null })),
    );

  const getIssue: JiraApi["Service"]["getIssue"] = (key) =>
    send("getIssue", Issue, {
      method: "GET",
      path: `/rest/api/3/issue/${encodeURIComponent(key)}`,
      query: {
        fields: [...ISSUE_FIELDS, ...DETAIL_FIELDS].join(","),
        expand: "transitions,changelog",
      },
    });

  const getComments: JiraApi["Service"]["getComments"] = (input) =>
    send("getComments", Schema.Struct({ comments: Schema.Array(Comment), total: Schema.Number }), {
      method: "GET",
      path: `/rest/api/3/issue/${encodeURIComponent(input.key)}/comment`,
      query: { startAt: input.startAt, maxResults: input.limit, orderBy: "-created" },
    });

  const permissions: JiraApi["Service"]["permissions"] = (key, names) =>
    send(
      "permissions",
      Schema.Struct({
        permissions: Schema.Record(
          Schema.String,
          Schema.Struct({ havePermission: Schema.Boolean }),
        ),
      }),
      {
        method: "GET",
        path: "/rest/api/3/mypermissions",
        query: { issueKey: key, permissions: names.join(",") },
      },
    ).pipe(
      Effect.map((answer) =>
        Object.fromEntries(
          names.map((name) => [name, answer.permissions[name]?.havePermission === true]),
        ),
      ),
    );

  const issueTypes: JiraApi["Service"]["issueTypes"] = (project) =>
    send("issueTypes", Schema.Struct({ issueTypes: Schema.Array(IssueType) }), {
      method: "GET",
      path: `/rest/api/3/issue/createmeta/${encodeURIComponent(project)}/issuetypes`,
      query: { maxResults: PAGE },
    }).pipe(Effect.map((answer) => answer.issueTypes.map(toIssueType)));

  const projectIssueTypes: JiraApi["Service"]["projectIssueTypes"] = (project) =>
    send("projectIssueTypes", Schema.Struct({ issueTypes: Schema.Array(IssueType) }), {
      method: "GET",
      path: `/rest/api/3/project/${encodeURIComponent(project)}`,
    }).pipe(Effect.map((answer) => answer.issueTypes.map(toIssueType)));

  const projectStatuses: JiraApi["Service"]["projectStatuses"] = (project) =>
    send("projectStatuses", Schema.Array(Schema.Struct({ statuses: Schema.Array(Status) })), {
      method: "GET",
      path: `/rest/api/3/project/${encodeURIComponent(project)}/statuses`,
    }).pipe(Effect.map((types) => types.flatMap((type) => type.statuses)));

  const pullRequests: JiraApi["Service"]["pullRequests"] = Effect.fn("JiraApi.pullRequests")(
    function* (issueId) {
      const { summary } = yield* send("pullRequests", DevelopmentSummary, {
        method: "GET",
        path: "/rest/dev-status/latest/issue/summary",
        query: { issueId },
      });
      const tools = Object.entries(summary.pullrequest?.byInstanceType ?? {}).flatMap(
        ([applicationType, tool]) => (tool.count > 0 ? [applicationType] : []),
      );
      const details = yield* Effect.forEach(
        tools,
        (applicationType) =>
          send("pullRequests", DevelopmentDetail, {
            method: "GET",
            path: "/rest/dev-status/latest/issue/detail",
            query: { issueId, applicationType, dataType: "pullrequest" },
          }).pipe(Effect.orElseSucceed(() => ({ detail: [] }))),
        { concurrency: "unbounded" },
      );
      return details.flatMap(({ detail }) => detail.flatMap((entry) => entry.pullRequests ?? []));
    },
  );

  const createIssue: JiraApi["Service"]["createIssue"] = (fields) =>
    send("createIssue", Schema.Struct({ key: Schema.String }), {
      method: "POST",
      path: "/rest/api/3/issue",
      body: { fields },
    });

  const updateIssue: JiraApi["Service"]["updateIssue"] = (key, fields) =>
    send("updateIssue", Schema.Void, {
      method: "PUT",
      path: `/rest/api/3/issue/${encodeURIComponent(key)}`,
      body: { fields },
    });

  const transition: JiraApi["Service"]["transition"] = (key, id) =>
    send("transition", Schema.Void, {
      method: "POST",
      path: `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
      body: { transition: { id } },
    });

  const addComment: JiraApi["Service"]["addComment"] = Effect.fn("JiraApi.addComment")(
    function* (key, body, audience) {
      const issue = yield* send(
        "addComment",
        Schema.Struct({ fields: Schema.Struct({ project: Schema.optional(IssueProject) }) }),
        {
          method: "GET",
          path: `/rest/api/3/issue/${encodeURIComponent(key)}`,
          query: { fields: "project" },
        },
      );
      const serviceDesk = issue.fields.project?.projectTypeKey === "service_desk";
      if (!serviceDesk && audience === "internal") {
        return yield* fail(
          "addComment",
          "failed",
          `${key} is not in a Service Management project, so it has no internal notes.`,
        );
      }
      // A service desk comment is a reply the customer sees unless marked internal.
      yield* send("addComment", Schema.Unknown, {
        method: "POST",
        path: `/rest/api/3/issue/${encodeURIComponent(key)}/comment`,
        body: serviceDesk
          ? {
              body,
              properties: [
                { key: "sd.public.comment", value: { internal: audience !== "public" } },
              ],
            }
          : { body },
      });
    },
  );

  const labels: JiraApi["Service"]["labels"] = paged((startAt) =>
    send("labels", Schema.Struct({ values: Schema.Array(Schema.String) }), {
      method: "GET",
      path: "/rest/api/3/label",
      query: { startAt, maxResults: PAGE },
    }).pipe(Effect.map((page) => page.values)),
  ).pipe(Effect.map((page) => ({ names: page.items, truncated: page.truncated })));

  const labelPage: JiraApi["Service"]["labelPage"] = (input) =>
    input.query === undefined
      ? send(
          "labels",
          Schema.Struct({ values: Schema.Array(Schema.String), isLast: Schema.optional(Schema.Boolean) }),
          {
            method: "GET",
            path: "/rest/api/3/label",
            query: { startAt: input.startAt, maxResults: PAGE },
          },
        ).pipe(Effect.map((page) => ({ names: page.values, hasMore: page.isLast === false })))
      : send(
          "labels",
          Schema.Struct({ results: Schema.Array(Schema.Struct({ value: Schema.String })) }),
          {
            method: "GET",
            path: "/rest/api/3/jql/autocompletedata/suggestions",
            query: { fieldName: "labels", fieldValue: input.query },
          },
        ).pipe(
          Effect.map((page) => ({ names: page.results.map(({ value }) => value), hasMore: false })),
        );

  const assignablePage: JiraApi["Service"]["assignablePage"] = (project, input) =>
    send("assignable", Schema.Array(User), {
      method: "GET",
      path: "/rest/api/3/user/assignable/search",
      query: { project, startAt: input.startAt, maxResults: PAGE, query: input.query },
    }).pipe(
      // Jira drops people the caller may not see after paging, so only a full page promises more.
      Effect.map((users) => ({ users, hasMore: users.length === PAGE })),
    );

  const assignable: JiraApi["Service"]["assignable"] = (project, filter) =>
    paged(
      (startAt) =>
        send("assignable", Schema.Array(User), {
          method: "GET",
          path: "/rest/api/3/user/assignable/search",
          query: { project, startAt, maxResults: PAGE, ...filter },
        }),
      // Jira drops users the caller may not see after paging, so a short page is not the last.
      true,
    ).pipe(Effect.map((page) => ({ users: page.items, truncated: page.truncated })));

  const findUsers: JiraApi["Service"]["findUsers"] = (query) =>
    send("findUsers", Schema.Array(User), {
      method: "GET",
      path: "/rest/api/3/user/search",
      query: { query, maxResults: 20 },
    });

  return JiraApi.of({
    origin: storedSite("origin").pipe(Effect.map((site) => site.origin)),
    myself,
    projects,
    search,
    getIssue,
    getComments,
    permissions,
    issueTypes,
    projectIssueTypes,
    projectStatuses,
    pullRequests,
    createIssue,
    updateIssue,
    transition,
    addComment,
    labels,
    labelPage,
    assignable,
    assignablePage,
    findUsers,
  });
});

export const layer = Layer.effect(JiraApi, make);
