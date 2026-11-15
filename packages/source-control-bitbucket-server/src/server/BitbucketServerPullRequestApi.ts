import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  PullRequestAction,
  PullRequestActor,
  PullRequestReactionContent,
  PullRequestCheck,
  PullRequestChecksState,
  PullRequestComment,
  PullRequestCommit,
  PullRequestInvolvement,
  PullRequestListState,
  PullRequestMergeMethod,
  PullRequestMergeability,
  PullRequestReviewCommentDraft,
  PullRequestConversationThread,
  PullRequestReviewVerdict,
  PullRequestReviewerCandidateList,
} from "@t3tools/contracts";

import {
  parseDiffFileRevisions,
  truncateLongDiffLines,
} from "@t3tools/source-control-core/server/diffFileRevisions";
import type { ProviderListCursor } from "@t3tools/source-control-core/server/PullRequestProvider";

import * as BitbucketServerApi from "./BitbucketServerApi.ts";
import type { BitbucketServerRepositoryLocator } from "./bitbucketServerPullRequests.ts";
import {
  bitbucketServerCommentAnchor,
  decodeActivitiesJson,
  decodeAutoMergeSettingsJson,
  decodeBuildStatsJson,
  decodeBuildStatusesJson,
  decodeCommentVersionJson,
  decodeCommitIdJson,
  decodeCommitParentJson,
  decodeChangesPageJson,
  decodeCommitsJson,
  decodeDiffStatsSummaryJson,
  decodeMergeCheckJson,
  decodeParticipantSlugJson,
  decodePullRequestJson,
  decodePullRequestPageJson,
  decodeRepositoryPermissionJson,
  decodeUserSlugJson,
  decodeUsersPageJson,
  markViewerReactions,
  normalizeUnifiedDiff,
  patchFileStats,
  withholdTruncatedPatch,
  BITBUCKET_SERVER_EMOTICONS,
  type BitbucketServerPage,
  type BitbucketServerPullRequest,
} from "./bitbucketServerPullRequestJson.ts";

/**
 * Names the read that produced unusable output, so a failure reports the call it came from
 * rather than borrowing another operation's message.
 */
export class BitbucketServerPullRequestReadError extends Schema.TaggedError<BitbucketServerPullRequestReadError>()(
  "BitbucketServerPullRequestReadError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return `Bitbucket Data Center returned an unreadable ${this.operation} response.`;
  }

  override get message(): string {
    return `Bitbucket Data Center failed in ${this.operation}: ${this.detail}`;
  }
}

/**
 * The auth probe could not name an account. `unauthenticated` is the host or the configuration
 * refusing the token; `unknown` is the host being unreachable or answering without a name.
 */
export class BitbucketServerViewerUnavailableError extends Schema.TaggedError<BitbucketServerViewerUnavailableError>()(
  "BitbucketServerViewerUnavailableError",
  {
    reason: Schema.Literals(["unauthenticated", "unknown"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Bitbucket Data Center failed in getViewer: ${this.detail}`;
  }
}

/** A repository that is not `PROJECTKEY/repo-slug`, which is the only form Data Center addresses. */
export class BitbucketServerRepositoryUnsupportedError extends Schema.TaggedError<BitbucketServerRepositoryUnsupportedError>()(
  "BitbucketServerRepositoryUnsupportedError",
  {
    repository: Schema.String,
  },
) {
  get detail(): string {
    return "A Bitbucket Data Center repository is addressed as PROJECTKEY/repo-slug.";
  }

  override get message(): string {
    return `Bitbucket Data Center failed in resolveRepository: ${this.detail}`;
  }
}

/** Not a decode failure: the reader named a commit that is not a sha this repository could hold. */
export class BitbucketServerCommitShaError extends Schema.TaggedError<BitbucketServerCommitShaError>()(
  "BitbucketServerCommitShaError",
  {},
) {
  get detail(): string {
    return "The named commit was not a commit sha.";
  }

  override get message(): string {
    return `Bitbucket Data Center refused the request: ${this.detail}`;
  }
}

/** Comment ids go into request paths, and anything but a number could address another resource. */
export class BitbucketServerCommentIdError extends Schema.TaggedError<BitbucketServerCommentIdError>()(
  "BitbucketServerCommentIdError",
  {},
) {
  get detail(): string {
    return "The named comment was not a comment id.";
  }

  override get message(): string {
    return `Bitbucket Data Center refused the request: ${this.detail}`;
  }
}

/**
 * A verdict is written to the participant addressed by slug, and neither the user resource nor
 * the pull request's participants named one for the token's account.
 */
export class BitbucketServerAccountSlugError extends Schema.TaggedError<BitbucketServerAccountSlugError>()(
  "BitbucketServerAccountSlugError",
  {
    account: Schema.String,
  },
) {
  get detail(): string {
    return `Bitbucket Data Center did not say how it addresses the account ${this.account}, so its review status cannot be set.`;
  }

  override get message(): string {
    return `Bitbucket Data Center failed in submitReview: ${this.detail}`;
  }
}

/** An action the provider never offers on this host, so nothing on the page can ask for it. */
export class BitbucketServerActionUnsupportedError extends Schema.TaggedError<BitbucketServerActionUnsupportedError>()(
  "BitbucketServerActionUnsupportedError",
  {
    action: Schema.String,
  },
) {
  get detail(): string {
    return `Bitbucket Data Center does not support ${this.action} from here.`;
  }

  override get message(): string {
    return `Bitbucket Data Center failed in runAction: ${this.detail}`;
  }
}

export type BitbucketServerPullRequestApiError =
  | BitbucketServerApi.BitbucketServerApiError
  | BitbucketServerPullRequestReadError
  | BitbucketServerViewerUnavailableError
  | BitbucketServerRepositoryUnsupportedError
  | BitbucketServerCommitShaError
  | BitbucketServerCommentIdError
  | BitbucketServerAccountSlugError
  | BitbucketServerActionUnsupportedError;

/** The same ceiling the other hosts' diff reads use. */
const DIFF_MAX_BYTES = 8 * 1024 * 1024;
const WITHHELD_FILE_DIFF_MAX_BYTES = 32 * 1024 * 1024;
// Withheld files are mostly minified bundles; megabyte lines would freeze the client's layout.
const WITHHELD_FILE_MAX_LINE_LENGTH = 1_000;

export interface BitbucketServerPullRequestBatch {
  readonly items: ReadonlyArray<BitbucketServerPullRequest>;
  readonly truncated: boolean;
  /** Raw rows consumed for the items handed over, which an offset cursor has to count. */
  readonly cursorAdvance: number;
  readonly resumeAfter: string;
}

export class BitbucketServerPullRequestApi extends Context.Service<
  BitbucketServerPullRequestApi,
  {
    /** The token's account name, which is also the login the host writes on its own rows. */
    readonly getViewer: () => Effect.Effect<string, BitbucketServerPullRequestApiError>;

    readonly listPullRequests: (input: {
      readonly repository: string;
      readonly state: PullRequestListState;
      readonly involvement: PullRequestInvolvement;
      readonly viewer: string;
      readonly limit: number;
      /** Free text the host matches against title and description. */
      readonly query?: string | undefined;
      readonly draft?: boolean | undefined;
      /** A user slug; dropped under a narrower involvement, which the host would OR with it. */
      readonly author?: string | undefined;
      /** Where to carry on from, which for an offset-paged host is how many rows to skip. */
      readonly cursor?: ProviderListCursor | undefined;
    }) => Effect.Effect<BitbucketServerPullRequestBatch, BitbucketServerPullRequestApiError>;

    readonly getPullRequest: (input: {
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<BitbucketServerPullRequest, BitbucketServerPullRequestApiError>;

    /** True where the token can write to the repository, which is what merging needs. */
    readonly getRepositoryPermission: (input: {
      readonly repository: string;
    }) => Effect.Effect<boolean, BitbucketServerPullRequestApiError>;

    readonly getMergeability: (input: {
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<PullRequestMergeability, BitbucketServerPullRequestApiError>;

    /**
     * Build statuses on one commit. The repository-scoped `/commits/{id}/builds` only reads a
     * single build by key, so the list comes from the global build-status endpoint.
     */
    readonly listChecks: (input: {
      readonly repository: string;
      readonly commit: string;
    }) => Effect.Effect<ReadonlyArray<PullRequestCheck>, BitbucketServerPullRequestApiError>;

    readonly listActivities: (input: {
      readonly repository: string;
      readonly number: number;
      readonly pullRequestUrl: string;
    }) => Effect.Effect<
      {
        readonly comments: ReadonlyArray<PullRequestComment>;
        readonly threads: ReadonlyArray<PullRequestConversationThread>;
        readonly truncated: boolean;
      },
      BitbucketServerPullRequestApiError
    >;

    readonly listCommits: (input: {
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<ReadonlyArray<PullRequestCommit>, BitbucketServerPullRequestApiError>;

    readonly getPullRequestDiff: (input: {
      readonly repository: string;
      readonly number: number;
      /** One commit's own changes, rather than everything the pull request carries. */
      readonly commit?: string | undefined;
      /** One file's diff, for a file the whole patch withheld. */
      readonly path?: string | undefined;
    }) => Effect.Effect<
      {
        readonly patch: string;
        readonly truncated: boolean;
        readonly withheldPaths?: ReadonlyArray<string>;
      },
      BitbucketServerPullRequestApiError
    >;

    /**
     * The rolled-up build state of each commit, in one request. A commit missing from the map
     * has no builds reported.
     */
    readonly getBuildStates: (input: {
      readonly commits: ReadonlyArray<string>;
    }) => Effect.Effect<
      ReadonlyMap<string, PullRequestChecksState | null>,
      BitbucketServerPullRequestApiError
    >;

    /** Whether the repository allows auto-merge, and whether this pull request has it requested. */
    readonly getAutoMerge: (input: {
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<
      { readonly allowed: boolean; readonly enabled: boolean },
      BitbucketServerPullRequestApiError
    >;

    /** Truncated patches cannot identify absent paths as deleted. */
    readonly getFileRevisions: (input: {
      readonly repository: string;
      readonly number: number;
      readonly paths: ReadonlyArray<string>;
    }) => Effect.Effect<
      { readonly revisions: ReadonlyMap<string, string>; readonly complete: boolean },
      BitbucketServerPullRequestApiError
    >;

    /** Line counts per file, read off the patch; the host's own summary has only totals. */
    readonly getFileStats: (input: {
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<
      {
        readonly files: ReadonlyArray<{
          readonly path: string;
          readonly additions: number;
          readonly deletions: number;
        }>;
        readonly truncated: boolean;
      },
      BitbucketServerPullRequestApiError
    >;

    readonly getLineCounts: (input: {
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<
      { readonly additions: number; readonly deletions: number },
      BitbucketServerPullRequestApiError
    >;

    readonly getChangedFileCount: (input: {
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<number, BitbucketServerPullRequestApiError>;

    readonly getDiffFileContents: (input: {
      readonly repository: string;
      readonly number: number;
      readonly commit?: string | undefined;
      readonly changeType: "change" | "rename-pure" | "rename-changed" | "new" | "deleted";
      readonly oldPath: string;
      readonly newPath: string;
    }) => Effect.Effect<
      { readonly oldContents: string; readonly newContents: string },
      BitbucketServerPullRequestApiError
    >;

    /** Merge, decline, reopen or a draft switch, each sent with the pull request's current version. */
    readonly runAction: (input: {
      readonly repository: string;
      readonly number: number;
      readonly action: PullRequestAction;
      readonly mergeMethod?: PullRequestMergeMethod | undefined;
    }) => Effect.Effect<void, BitbucketServerPullRequestApiError>;

    readonly updateChangeRequest: (input: {
      readonly repository: string;
      readonly number: number;
      readonly title?: string | undefined;
      readonly body?: string | undefined;
    }) => Effect.Effect<void, BitbucketServerPullRequestApiError>;

    readonly comment: (input: {
      readonly repository: string;
      readonly number: number;
      readonly body: string;
    }) => Effect.Effect<void, BitbucketServerPullRequestApiError>;

    readonly replyToComment: (input: {
      readonly repository: string;
      readonly number: number;
      readonly commentId: string;
      readonly body: string;
    }) => Effect.Effect<void, BitbucketServerPullRequestApiError>;

    readonly updateComment: (input: {
      readonly repository: string;
      readonly number: number;
      readonly commentId: string;
      readonly body: string;
    }) => Effect.Effect<void, BitbucketServerPullRequestApiError>;

    readonly setCommentResolution: (input: {
      readonly repository: string;
      readonly number: number;
      readonly commentId: string;
      readonly resolved: boolean;
    }) => Effect.Effect<void, BitbucketServerPullRequestApiError>;

    /** Reactions sit on comments only; the description takes none. */
    readonly setReaction: (input: {
      readonly repository: string;
      readonly number: number;
      readonly commentId: string;
      readonly content: PullRequestReactionContent;
      readonly reacted: boolean;
    }) => Effect.Effect<void, BitbucketServerPullRequestApiError>;

    /** Active users whose name, username or email matches; the host searches its whole user base. */
    readonly searchUsers: (input: {
      readonly query?: string | undefined;
    }) => Effect.Effect<
      { readonly items: ReadonlyArray<PullRequestActor>; readonly truncated: boolean },
      BitbucketServerPullRequestApiError
    >;

    readonly submitReview: (input: {
      readonly repository: string;
      readonly number: number;
      readonly verdict: PullRequestReviewVerdict;
      readonly body: string;
      readonly comments: ReadonlyArray<PullRequestReviewCommentDraft>;
    }) => Effect.Effect<void, BitbucketServerPullRequestApiError>;

    /** Everyone with read access to the repository, less the author, with current reviewers marked. */
    readonly listReviewerCandidates: (input: {
      readonly repository: string;
      readonly number: number;
      readonly query?: string | undefined;
    }) => Effect.Effect<PullRequestReviewerCandidateList, BitbucketServerPullRequestApiError>;

    readonly setReviewerRequest: (input: {
      readonly repository: string;
      readonly number: number;
      readonly reviewers: ReadonlyArray<{ readonly id: string }>;
      readonly requested: boolean;
    }) => Effect.Effect<void, BitbucketServerPullRequestApiError>;
  }
>()("@t3tools/source-control-bitbucket-server/server/BitbucketServerPullRequestApi") {}

function repositoryPathOf(locator: BitbucketServerRepositoryLocator): string {
  return `${BitbucketServerApi.API_ROOT}/projects/${encodeURIComponent(locator.projectKey)}/repos/${encodeURIComponent(
    locator.repoSlug,
  )}`;
}

/** Rebasing lives under the git plugin's REST root rather than the core API's. */
function rebaseRoot(repositoryPath: string): string {
  return `/rest/git/1.0${repositoryPath.slice(BitbucketServerApi.API_ROOT.length)}`;
}

/** Reactions live under the comment-likes plugin's REST root. */
function reactionRoot(repositoryPath: string): string {
  return `/rest/comment-likes/1.0${repositoryPath.slice(BitbucketServerApi.API_ROOT.length)}`;
}

/** Branch deletion lives under the branch-utils plugin's REST root. */
function branchRoot(repositoryPath: string): string {
  return `/rest/branch-utils/1.0${repositoryPath.slice(BitbucketServerApi.API_ROOT.length)}`;
}

function isRepositoryRelativePath(filePath: string): boolean {
  return !filePath
    .split("/")
    .some((segment) => segment === "" || segment === "." || segment === "..");
}

const isNotFound = (error: BitbucketServerApi.BitbucketServerApiError) =>
  error._tag === "BitbucketServerResponseError" && error.status === 404;

/** Each path segment encoded on its own, so the slashes still address directories. */
function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/**
 * A commit sha arrives from the reader and goes straight into a request path, so it is checked
 * rather than trusted.
 */
function isCommitSha(value: string): boolean {
  return /^[0-9a-f]{7,64}$/i.test(value);
}

/** The host narrows by a participant's role; `role.1`/`username.1` are one such pair. */
function involvementParams(
  involvement: PullRequestInvolvement,
  viewer: string,
): Array<[string, string]> {
  switch (involvement) {
    case "authored":
      return [
        ["role.1", "AUTHOR"],
        ["username.1", viewer],
      ];
    case "reviewing":
      return [
        ["role.1", "REVIEWER"],
        ["username.1", viewer],
      ];
    case "all":
      return [];
  }
}

/** The host's own names for the three strategies offered; absent takes the repository default. */
function mergeStrategyId(method: PullRequestMergeMethod | undefined): string | undefined {
  switch (method) {
    case "merge":
      return "no-ff";
    case "squash":
      return "squash";
    case "rebase":
      return "rebase-no-ff";
    case undefined:
      return undefined;
  }
}

function participantStatus(verdict: PullRequestReviewVerdict): "APPROVED" | "NEEDS_WORK" | null {
  switch (verdict) {
    case "approve":
      return "APPROVED";
    case "request-changes":
      return "NEEDS_WORK";
    case "comment":
      return null;
  }
}

function withStart(url: string, start: number): string {
  return `${url}${url.includes("?") ? "&" : "?"}start=${start}`;
}

const make = Effect.gen(function* () {
  const bitbucket = yield* BitbucketServerApi.BitbucketServerApi;

  const withComment = <A>(
    input: { readonly repository: string; readonly number: number; readonly commentId: string },
    use: (
      url: string,
      id: number,
      path: string,
    ) => Effect.Effect<A, BitbucketServerPullRequestApiError>,
  ): Effect.Effect<A, BitbucketServerPullRequestApiError> =>
    /^\d{1,15}$/u.test(input.commentId)
      ? withRepository(input.repository, (path) =>
          use(
            `${path}/pull-requests/${input.number}/comments/${input.commentId}`,
            Number(input.commentId),
            path,
          ),
        )
      : Effect.fail(new BitbucketServerCommentIdError());

  const withRepository = <A>(
    repository: string,
    use: (
      path: string,
      locator: BitbucketServerRepositoryLocator,
    ) => Effect.Effect<A, BitbucketServerPullRequestApiError>,
  ): Effect.Effect<A, BitbucketServerPullRequestApiError> => {
    const locator = BitbucketServerApi.parseRepositoryName(repository);
    return locator === null
      ? Effect.fail(new BitbucketServerRepositoryUnsupportedError({ repository }))
      : use(repositoryPathOf(locator), locator);
  };

  const decodeOrFail = <A>(
    operation: string,
    response: { readonly body: string; readonly truncated: boolean },
    decode: (body: string) => Result.Result<A, unknown>,
  ): Effect.Effect<A, BitbucketServerPullRequestReadError> => {
    if (response.truncated) {
      return Effect.fail(
        new BitbucketServerPullRequestReadError({
          operation,
          cause: "Response exceeded the byte limit.",
        }),
      );
    }
    const decoded = decode(response.body);
    return Result.isSuccess(decoded)
      ? Effect.succeed(decoded.success)
      : Effect.fail(new BitbucketServerPullRequestReadError({ operation, cause: decoded.failure }));
  };

  const read = <A>(input: {
    readonly operation: string;
    readonly url: string;
    readonly decode: (body: string) => Result.Result<A, unknown>;
  }): Effect.Effect<A, BitbucketServerPullRequestApiError> =>
    bitbucket
      .request({ method: "GET", url: input.url })
      .pipe(Effect.flatMap((response) => decodeOrFail(input.operation, response, input.decode)));

  /**
   * Walks an offset-paged collection to its end or to the page cap, whichever comes first.
   * Anything but running out of pages means there is more to be had.
   */
  const readAllPages = Effect.fn("BitbucketServerPullRequestApi.readAllPages")(function* <
    A,
  >(input: {
    readonly operation: string;
    readonly url: string;
    readonly decode: (body: string) => Result.Result<BitbucketServerPage<A>, unknown>;
    readonly maxPages: number;
  }): Effect.fn.Return<
    { readonly items: ReadonlyArray<A>; readonly truncated: boolean },
    BitbucketServerPullRequestApiError
  > {
    const items: A[] = [];
    let start = 0;
    for (let page = 1; page <= input.maxPages; page += 1) {
      const decoded = yield* read({
        operation: input.operation,
        url: withStart(input.url, start),
        decode: input.decode,
      });
      items.push(...decoded.items);
      if (decoded.nextPageStart === null) return { items, truncated: false };
      start = decoded.nextPageStart;
    }
    return { items, truncated: true };
  });

  const autoMergeRequested = (
    url: string,
  ): Effect.Effect<boolean, BitbucketServerApi.BitbucketServerApiError> =>
    bitbucket.request({ method: "GET", url }).pipe(
      Effect.as(true),
      Effect.catchIf(isNotFound, () => Effect.succeed(false)),
    );

  const listChanges = (operation: string, base: string) =>
    readAllPages({
      operation,
      url: `${base}/changes?limit=${BitbucketServerApi.MAX_PAGE_SIZE}`,
      decode: (body) =>
        Result.map(decodeChangesPageJson(body), (page) => ({
          items: page.files,
          nextPageStart: page.nextPageStart,
          rawCount: page.count,
        })),
      maxPages: BitbucketServerApi.MAX_PAGES,
    });

  const getPullRequest = (path: string, number: number) =>
    read({
      operation: "getPullRequest",
      url: `${path}/pull-requests/${number}`,
      decode: decodePullRequestJson,
    });

  const getPullRequestDiff: BitbucketServerPullRequestApi["Service"]["getPullRequestDiff"] =
    Effect.fn("BitbucketServerPullRequestApi.getPullRequestDiff")((input) => {
      if (input.commit !== undefined && !isCommitSha(input.commit)) {
        return Effect.fail(new BitbucketServerCommitShaError());
      }
      return withRepository(input.repository, (path) => {
        const base =
          input.commit === undefined
            ? `${path}/pull-requests/${input.number}`
            : `${path}/commits/${input.commit}`;
        if (input.path !== undefined) {
          const filePath = input.path;
          if (!isRepositoryRelativePath(filePath)) {
            return Effect.fail(
              new BitbucketServerPullRequestReadError({
                operation: "getPullRequestDiff",
                cause: "Expected a repository-relative file path.",
              }),
            );
          }
          return bitbucket
            .request({
              method: "GET",
              url: `${base}/diff/${encodePath(filePath)}`,
              accept: "text/plain",
              maxBytes: WITHHELD_FILE_DIFF_MAX_BYTES,
            })
            .pipe(
              Effect.flatMap((response) =>
                response.truncated
                  ? Effect.fail(
                      new BitbucketServerPullRequestReadError({
                        operation: "getPullRequestDiff",
                        cause: `The diff for ${filePath} is too large to load.`,
                      }),
                    )
                  : Effect.succeed({
                      patch: truncateLongDiffLines(
                        normalizeUnifiedDiff(response.body),
                        WITHHELD_FILE_MAX_LINE_LENGTH,
                      ),
                      truncated: false,
                    }),
              ),
            );
        }
        return bitbucket
          .request(
            // `.diff` is the pull request's own raw patch. A commit's has no raw spelling of
            // its own, but its JSON endpoint answers with the same patch when asked for text.
            input.commit === undefined
              ? { method: "GET", url: `${base}.diff`, maxBytes: DIFF_MAX_BYTES }
              : {
                  method: "GET",
                  url: `${base}/diff`,
                  accept: "text/plain",
                  maxBytes: DIFF_MAX_BYTES,
                },
          )
          .pipe(
            Effect.flatMap((response) => {
              const patch = normalizeUnifiedDiff(response.body);
              if (!response.truncated) return Effect.succeed({ patch, truncated: false });
              // The cut leaves the files past it unnamed, so the change list names them; if that
              // read fails the cut patch still goes out, marked truncated.
              return listChanges("getPullRequestDiff", base).pipe(
                Effect.map((changes) => {
                  const whole = withholdTruncatedPatch(patch, changes.items);
                  return { patch: whole.patch, truncated: true, withheldPaths: whole.withheld };
                }),
                Effect.orElseSucceed(() => ({ patch, truncated: true })),
              );
            }),
          );
      });
    });

  /**
   * The revisions either side of the patch: the merge base and the source tip for the pull
   * request, or a commit's first parent and itself. Null on the old side where there is no
   * commit there, which is a root commit.
   */
  const diffRevisions = Effect.fn("BitbucketServerPullRequestApi.diffRevisions")((input: {
    readonly path: string;
    readonly number: number;
    readonly commit: string | undefined;
  }): Effect.Effect<
    { readonly oldCommit: string | null; readonly newCommit: string },
    BitbucketServerPullRequestApiError
  > => {
    const commit = input.commit;
    return commit === undefined
      ? Effect.all(
          [
            getPullRequest(input.path, input.number),
            read({
              operation: "getMergeBase",
              url: `${input.path}/pull-requests/${input.number}/merge-base`,
              decode: decodeCommitIdJson,
            }),
          ],
          { concurrency: 2 },
        ).pipe(
          Effect.flatMap(([pullRequest, mergeBase]) =>
            pullRequest.headCommit === null
              ? Effect.fail(
                  new BitbucketServerPullRequestReadError({
                    operation: "getPullRequest",
                    cause: new Error("The pull request named no source commit."),
                  }),
                )
              : Effect.succeed({ oldCommit: mergeBase, newCommit: pullRequest.headCommit }),
          ),
        )
      : read({
          operation: "getCommit",
          url: `${input.path}/commits/${commit}`,
          decode: decodeCommitParentJson,
        }).pipe(Effect.map((parent) => ({ oldCommit: parent, newCommit: commit })));
  });

  const rawFile = (path: string, filePath: string, commit: string) => {
    if (!isRepositoryRelativePath(filePath)) {
      return Effect.fail(
        new BitbucketServerPullRequestReadError({
          operation: "getDiffFileContents",
          cause: "Expected a repository-relative file path.",
        }),
      );
    }
    return bitbucket
      .request({
        method: "GET",
        url: `${path}/raw/${encodePath(filePath)}?at=${encodeURIComponent(commit)}`,
        maxBytes: DIFF_MAX_BYTES,
      })
      .pipe(
        Effect.flatMap((response) =>
          response.truncated
            ? Effect.fail(
                new BitbucketServerPullRequestReadError({
                  operation: "getDiffFileContents",
                  cause: "File exceeded the byte limit.",
                }),
              )
            : Effect.succeed(response.body),
        ),
      );
  };

  // The probe is the one request whose answer carries the account: Data Center names the
  // caller in a response header rather than at any endpoint of its own.
  const getViewer: Effect.Effect<string, BitbucketServerPullRequestApiError> =
    bitbucket.probeAuth.pipe(
      Effect.flatMap((auth) => {
        const detail = Option.getOrElse(
          auth.detail,
          () => "Bitbucket Data Center did not name the configured token's account.",
        );
        if (auth.status === "unauthenticated") {
          return Effect.fail(
            new BitbucketServerViewerUnavailableError({ reason: "unauthenticated", detail }),
          );
        }
        return Effect.fromOption(
          auth.status === "authenticated" ? auth.account : Option.none(),
          () => new BitbucketServerViewerUnavailableError({ reason: "unknown", detail }),
        );
      }),
    );

  const write = (input: {
    readonly method: "POST" | "PUT" | "DELETE";
    readonly url: string;
    readonly body?: Record<string, unknown>;
  }): Effect.Effect<void, BitbucketServerPullRequestApiError> =>
    bitbucket
      .request({
        method: input.method,
        url: input.url,
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      })
      .pipe(Effect.asVoid);

  /**
   * Rewrites the pull request. Left out of the PUT, the host reads the reviewer list as emptied,
   * so it always travels — the current one unless the patch names another.
   */
  const putPullRequest = Effect.fn("BitbucketServerPullRequestApi.putPullRequest")(
    (
      path: string,
      number: number,
      patch: (current: BitbucketServerPullRequest) => {
        readonly reviewers?: Iterable<string>;
        readonly title?: string;
        readonly description?: string;
        readonly draft?: boolean;
      },
    ): Effect.Effect<void, BitbucketServerPullRequestApiError> =>
      getPullRequest(path, number).pipe(
        Effect.flatMap((current) => {
          const { reviewers, ...fields } = patch(current);
          return write({
            method: "PUT",
            url: `${path}/pull-requests/${number}`,
            body: {
              version: current.version,
              ...fields,
              reviewers: [...(reviewers ?? current.reviewRequestLogins)].map((name) => ({
                user: { name },
              })),
            },
          });
        }),
      ),
  );

  // A comment carries a version of its own, read back just before it is rewritten.
  const putComment = (
    url: string,
    patch: (comment: { readonly isTask: boolean }) => Record<string, unknown>,
  ) =>
    read({ operation: "getComment", url, decode: decodeCommentVersionJson }).pipe(
      Effect.flatMap((comment) =>
        write({ method: "PUT", url, body: { version: comment.version, ...patch(comment) } }),
      ),
    );

  /** The host answered for the name, but not with a user: a redirect's page, or nothing at all. */
  const isNotAUser = (error: BitbucketServerPullRequestApiError) =>
    error._tag === "BitbucketServerPullRequestReadError" ||
    (error._tag === "BitbucketServerResponseError" &&
      (error.status === 404 || (error.status >= 300 && error.status < 400)));

  /**
   * The slug a participant is addressed by in a path. The user resource answers for a person,
   * whose slug is their name; a service account's name holds slashes and the host redirects it
   * away, so the pull request's own participants are searched for it next.
   */
  const accountSlug = Effect.fn("BitbucketServerPullRequestApi.accountSlug")(
    (
      path: string,
      number: number,
      account: string,
    ): Effect.Effect<string, BitbucketServerPullRequestApiError> =>
      read({
        operation: "getUser",
        url: `${BitbucketServerApi.API_ROOT}/users/${encodeURIComponent(account)}`,
        decode: decodeUserSlugJson,
      }).pipe(
        Effect.catchIf(isNotAUser, () => Effect.succeed(null)),
        Effect.filterOrElse(
          (slug): slug is string => slug !== null,
          () =>
            Effect.gen(function* () {
              const url = `${path}/pull-requests/${number}/participants?limit=${BitbucketServerApi.MAX_PAGE_SIZE}`;
              let start = 0;
              for (let page = 1; page <= BitbucketServerApi.MAX_PAGES; page += 1) {
                const decoded = yield* read({
                  operation: "listParticipants",
                  url: withStart(url, start),
                  decode: (body) => decodeParticipantSlugJson(body, account),
                });
                if (decoded.slug !== null) return decoded.slug;
                if (decoded.nextPageStart === null) break;
                start = decoded.nextPageStart;
              }
              return yield* new BitbucketServerAccountSlugError({ account });
            }),
        ),
      ),
  );

  return BitbucketServerPullRequestApi.of({
    getViewer: Effect.fn("BitbucketServerPullRequestApi.getViewer")(() => getViewer),

    listPullRequests: Effect.fn("BitbucketServerPullRequestApi.listPullRequests")((input) =>
      withRepository(input.repository, (path) =>
        Effect.gen(function* () {
          const params = new URLSearchParams([
            ["state", BitbucketServerApi.toBitbucketServerState(input.state)] as [string, string],
            ["order", "NEWEST"],
            ...(input.involvement === "all" && input.author !== undefined
              ? [
                  ["role.1", "AUTHOR"] as [string, string],
                  ["username.1", input.author] as [string, string],
                ]
              : involvementParams(input.involvement, input.viewer)),
          ]);
          const search = input.query?.trim() ?? "";
          if (search.length > 0) params.set("filterText", search);
          if (input.draft !== undefined) params.set("draft", String(input.draft));

          const collected: BitbucketServerPullRequest[] = [];
          let start =
            input.cursor?.resumeAfter !== undefined && /^\d+$/u.test(input.cursor.resumeAfter)
              ? Number(input.cursor.resumeAfter)
              : (input.cursor?.delivered ?? 0);
          let cursorAdvance = 0;
          for (let page = 1; page <= BitbucketServerApi.MAX_PAGES; page += 1) {
            // Only the rows still wanted are asked for, so a page is never read to be dropped,
            // and every raw row it holds — malformed ones included — is one the cursor steps past.
            const room = input.limit - collected.length;
            params.set("limit", String(Math.min(room, BitbucketServerApi.MAX_PAGE_SIZE)));
            params.set("start", String(start));
            const decoded = yield* read({
              operation: "listPullRequests",
              url: `${path}/pull-requests?${params.toString()}`,
              decode: decodePullRequestPageJson,
            });
            if (decoded.items.length > room) {
              // The host answered with more than was asked for. The rows kept are the advance:
              // the ones dropped are still to come, and the next cursor must land on them.
              collected.push(...decoded.items.slice(0, room));
              return {
                items: collected,
                truncated: true,
                cursorAdvance: cursorAdvance + room,
                resumeAfter: String(start + room),
              };
            }
            collected.push(...decoded.items);
            cursorAdvance += decoded.rawCount;
            if (decoded.nextPageStart === null) {
              return {
                items: collected,
                truncated: false,
                cursorAdvance,
                resumeAfter: String(start + decoded.rawCount),
              };
            }
            if (collected.length >= input.limit) {
              return {
                items: collected,
                truncated: true,
                cursorAdvance,
                resumeAfter: String(decoded.nextPageStart),
              };
            }
            start = decoded.nextPageStart;
          }
          return { items: collected, truncated: true, cursorAdvance, resumeAfter: String(start) };
        }),
      ),
    ),

    getPullRequest: Effect.fn("BitbucketServerPullRequestApi.getPullRequest")((input) =>
      withRepository(input.repository, (path) => getPullRequest(path, input.number)),
    ),

    // Nothing on the repository or the pull request states what the token may do, but the
    // repository search takes a permission to narrow by, and answers with the repositories the
    // caller holds at least that permission on. The name filter is a substring across every
    // project, so the pages are walked until this repository turns up or they run out.
    getRepositoryPermission: Effect.fn("BitbucketServerPullRequestApi.getRepositoryPermission")(
      (input) =>
        withRepository(input.repository, (_, locator) =>
          Effect.gen(function* () {
            const url = `${BitbucketServerApi.API_ROOT}/repos?${new URLSearchParams([
              ["name", locator.repoSlug],
              ["permission", "REPO_WRITE"],
              ["limit", String(BitbucketServerApi.MAX_PAGE_SIZE)],
            ]).toString()}`;
            let start = 0;
            for (let page = 1; page <= BitbucketServerApi.MAX_PAGES; page += 1) {
              const decoded = yield* read({
                operation: "getRepositoryPermission",
                url: withStart(url, start),
                decode: (body) => decodeRepositoryPermissionJson(body, locator),
              });
              if (decoded.granted) return true;
              if (decoded.nextPageStart === null) return false;
              start = decoded.nextPageStart;
            }
            return false;
          }),
        ),
    ),

    getMergeability: Effect.fn("BitbucketServerPullRequestApi.getMergeability")((input) =>
      withRepository(input.repository, (path) =>
        read({
          operation: "getMergeability",
          url: `${path}/pull-requests/${input.number}/merge`,
          decode: decodeMergeCheckJson,
        }),
      ),
    ),

    listChecks: Effect.fn("BitbucketServerPullRequestApi.listChecks")((input) =>
      withRepository(input.repository, () =>
        readAllPages({
          operation: "listChecks",
          url: `/rest/build-status/1.0/commits/${encodeURIComponent(input.commit)}?limit=${BitbucketServerApi.MAX_PAGE_SIZE}`,
          decode: decodeBuildStatusesJson,
          maxPages: BitbucketServerApi.MAX_PAGES,
        }).pipe(Effect.map((page) => page.items)),
      ),
    ),

    listActivities: Effect.fn("BitbucketServerPullRequestApi.listActivities")((input) =>
      withRepository(input.repository, (path) =>
        // The viewer marks their own reactions; without it reactions still show, unmarked.
        Effect.all(
          [
            getViewer.pipe(Effect.orElseSucceed(() => null)),
            readAllPages({
              operation: "listActivities",
              url: `${path}/pull-requests/${input.number}/activities?limit=${BitbucketServerApi.MAX_PAGE_SIZE}`,
              decode: (body) => decodeActivitiesJson(body, input.pullRequestUrl),
              maxPages: BitbucketServerApi.MAX_PAGES,
            }),
          ],
          { concurrency: 2 },
        ).pipe(
          Effect.map(([viewer, page]) => ({
            comments: page.items
              .flatMap((activity) => activity.comments)
              .map((comment) => markViewerReactions(comment, viewer))
              .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)),
            threads: page.items
              .flatMap((activity) => activity.threads)
              .map((thread) => ({
                ...thread,
                comments: thread.comments.map((comment) => markViewerReactions(comment, viewer)),
              })),
            truncated: page.truncated,
          })),
        ),
      ),
    ),

    // The host lists a pull request's commits newest first; the timeline reads oldest first.
    listCommits: Effect.fn("BitbucketServerPullRequestApi.listCommits")((input) =>
      withRepository(input.repository, (path) =>
        readAllPages({
          operation: "listCommits",
          url: `${path}/pull-requests/${input.number}/commits?limit=${BitbucketServerApi.MAX_PAGE_SIZE}`,
          decode: decodeCommitsJson,
          maxPages: BitbucketServerApi.MAX_PAGES,
        }).pipe(Effect.map((page) => page.items.toReversed())),
      ),
    ),

    getPullRequestDiff,

    getFileRevisions: Effect.fn("BitbucketServerPullRequestApi.getFileRevisions")(
      function* (input) {
        if (input.paths.length === 0)
          return { revisions: new Map<string, string>(), complete: false };
        const diff = yield* getPullRequestDiff(input);
        const revisions = new Map(parseDiffFileRevisions(diff.patch));
        if (!diff.truncated) {
          for (const path of input.paths) {
            if (!revisions.has(path)) revisions.set(path, "");
          }
        }
        return { revisions, complete: !diff.truncated };
      },
    ),

    getFileStats: Effect.fn("BitbucketServerPullRequestApi.getFileStats")((input) =>
      getPullRequestDiff(input).pipe(
        Effect.map((diff) => ({ files: patchFileStats(diff.patch), truncated: diff.truncated })),
      ),
    ),

    getLineCounts: Effect.fn("BitbucketServerPullRequestApi.getLineCounts")((input) =>
      withRepository(input.repository, (path) =>
        read({
          operation: "getLineCounts",
          url: `${path}/pull-requests/${input.number}/diff-stats-summary`,
          decode: decodeDiffStatsSummaryJson,
        }),
      ),
    ),

    getBuildStates: Effect.fn("BitbucketServerPullRequestApi.getBuildStates")((input) =>
      input.commits.length === 0
        ? Effect.succeed(new Map<string, PullRequestChecksState | null>())
        : bitbucket
            .request({
              // Read-only despite the verb: the commits travel in the body.
              method: "POST",
              url: "/rest/build-status/1.0/commits/stats",
              body: JSON.stringify(input.commits),
            })
            .pipe(
              Effect.flatMap((response) =>
                decodeOrFail("getBuildStates", response, decodeBuildStatsJson),
              ),
            ),
    ),

    getAutoMerge: Effect.fn("BitbucketServerPullRequestApi.getAutoMerge")((input) =>
      withRepository(input.repository, (path) =>
        Effect.all(
          [
            read({
              operation: "getAutoMerge",
              url: `${path}/settings/auto-merge`,
              decode: decodeAutoMergeSettingsJson,
            }).pipe(Effect.map((settings) => settings.enabled === true)),
            // The request is a resource of its own, absent until somebody asks for auto-merge.
            autoMergeRequested(`${path}/pull-requests/${input.number}/auto-merge`),
          ],
          { concurrency: 2 },
        ).pipe(Effect.map(([allowed, enabled]) => ({ allowed, enabled }))),
      ),
    ),

    getChangedFileCount: Effect.fn("BitbucketServerPullRequestApi.getChangedFileCount")((input) =>
      withRepository(input.repository, (path) =>
        listChanges("getChangedFileCount", `${path}/pull-requests/${input.number}`).pipe(
          Effect.map((changes) => changes.items.length),
        ),
      ),
    ),

    getDiffFileContents: Effect.fn("BitbucketServerPullRequestApi.getDiffFileContents")((input) =>
      input.commit !== undefined && !isCommitSha(input.commit)
        ? Effect.fail(new BitbucketServerCommitShaError())
        : withRepository(input.repository, (path) =>
            diffRevisions({ path, number: input.number, commit: input.commit }).pipe(
              Effect.flatMap(({ oldCommit, newCommit }) =>
                Effect.all(
                  [
                    input.changeType === "new" || oldCommit === null
                      ? Effect.succeed("")
                      : rawFile(path, input.oldPath, oldCommit),
                    input.changeType === "deleted"
                      ? Effect.succeed("")
                      : rawFile(path, input.newPath, newCommit),
                  ],
                  { concurrency: 2 },
                ),
              ),
              Effect.map(([oldContents, newContents]) => ({ oldContents, newContents })),
            ),
          ),
    ),

    // Every write that changes the pull request itself sends its current version back, so a
    // change somebody else made in between is refused by the host rather than overwritten.
    runAction: Effect.fn("BitbucketServerPullRequestApi.runAction")((input) =>
      withRepository(input.repository, (path) => {
        if (input.action === "update-branch") {
          return getPullRequest(path, input.number).pipe(
            Effect.flatMap((current) =>
              write({
                method: "POST",
                url: `${rebaseRoot(path)}/pull-requests/${input.number}/rebase`,
                body: { version: current.version },
              }),
            ),
          );
        }
        if (input.action === "ready" || input.action === "draft") {
          const draft = input.action === "draft";
          return putPullRequest(path, input.number, () => ({ draft }));
        }
        if (input.action === "disable-auto-merge") {
          return write({
            method: "DELETE",
            url: `${path}/pull-requests/${input.number}/auto-merge`,
          });
        }
        if (input.action === "delete-branch") {
          return getPullRequest(path, input.number).pipe(
            Effect.flatMap((current) => {
              const source =
                current.headRepositoryNameWithOwner === null
                  ? null
                  : BitbucketServerApi.parseRepositoryName(current.headRepositoryNameWithOwner);
              // Without the source commit the host would delete the branch wherever it now points.
              if (current.state === "open" || source === null || current.headCommit === null) {
                return Effect.fail(
                  new BitbucketServerActionUnsupportedError({
                    action: "deleting the source branch of an open or unresolved pull request",
                  }),
                );
              }
              // `endPoint` makes the host refuse when the branch has moved past the pull request.
              return write({
                method: "DELETE",
                url: `${branchRoot(repositoryPathOf(source))}/branches`,
                body: {
                  name: `refs/heads/${current.headBranch}`,
                  endPoint: current.headCommit,
                  dryRun: false,
                },
              });
            }),
          );
        }
        const endpoint =
          input.action === "merge" || input.action === "enable-auto-merge"
            ? "merge"
            : input.action === "close"
              ? "decline"
              : input.action === "reopen"
                ? "reopen"
                : null;
        if (endpoint === null) {
          return Effect.fail(new BitbucketServerActionUnsupportedError({ action: input.action }));
        }
        // A strategy the repository has disabled is refused by the host with its own words,
        // which is what reaches the user; nothing is pre-read to second-guess it.
        const strategyId = endpoint === "merge" ? mergeStrategyId(input.mergeMethod) : undefined;
        return getPullRequest(path, input.number).pipe(
          Effect.flatMap((current) =>
            write({
              method: "POST",
              url: `${path}/pull-requests/${input.number}/${endpoint}`,
              body: {
                version: current.version,
                ...(strategyId === undefined ? {} : { strategyId }),
                // With nothing in the way the host merges at once, as GitHub does.
                ...(input.action === "enable-auto-merge" ? { autoMerge: true } : {}),
              },
            }),
          ),
        );
      }),
    ),

    updateChangeRequest: Effect.fn("BitbucketServerPullRequestApi.updateChangeRequest")((input) =>
      withRepository(input.repository, (path) =>
        putPullRequest(path, input.number, () => ({
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.body === undefined ? {} : { description: input.body }),
        })),
      ),
    ),

    comment: Effect.fn("BitbucketServerPullRequestApi.comment")((input) =>
      withRepository(input.repository, (path) =>
        write({
          method: "POST",
          url: `${path}/pull-requests/${input.number}/comments`,
          body: { text: input.body },
        }),
      ),
    ),

    replyToComment: Effect.fn("BitbucketServerPullRequestApi.replyToComment")((input) =>
      withComment(input, (_url, id, path) =>
        write({
          method: "POST",
          url: `${path}/pull-requests/${input.number}/comments`,
          body: { text: input.body, parent: { id } },
        }),
      ),
    ),

    updateComment: Effect.fn("BitbucketServerPullRequestApi.updateComment")((input) =>
      withComment(input, (url) => putComment(url, () => ({ text: input.body }))),
    ),

    setCommentResolution: Effect.fn("BitbucketServerPullRequestApi.setCommentResolution")((input) =>
      // A task opens and closes through its own state; its thread follows it.
      withComment(input, (url) =>
        putComment(url, (comment) =>
          comment.isTask
            ? { state: input.resolved ? "RESOLVED" : "OPEN" }
            : { threadResolved: input.resolved },
        ),
      ),
    ),

    setReaction: Effect.fn("BitbucketServerPullRequestApi.setReaction")((input) =>
      withComment(input, (_url, id, path) =>
        write({
          method: input.reacted ? "PUT" : "DELETE",
          url: `${reactionRoot(path)}/pull-requests/${input.number}/comments/${id}/reactions/${BITBUCKET_SERVER_EMOTICONS[input.content]}`,
        }),
      ),
    ),

    searchUsers: Effect.fn("BitbucketServerPullRequestApi.searchUsers")((input) => {
      const params = new URLSearchParams([["limit", String(BitbucketServerApi.MAX_PAGE_SIZE)]]);
      const query = input.query?.trim() ?? "";
      if (query.length > 0) params.set("filter", query);
      return read({
        operation: "searchUsers",
        url: `${BitbucketServerApi.API_ROOT}/users?${params.toString()}`,
        decode: decodeUsersPageJson,
      }).pipe(
        Effect.map((users) => ({
          items: users.items.map(({ login, name, avatarUrl }) => ({ login, name, avatarUrl })),
          truncated: users.nextPageStart !== null,
        })),
      );
    }),

    // Data Center has no pending review, so one is replayed as the requests it is made of: the
    // line comments, then the summary, then the verdict — last, so a review that fails part-way
    // is never left standing as an approval.
    submitReview: Effect.fn("BitbucketServerPullRequestApi.submitReview")((input) =>
      withRepository(input.repository, (path) =>
        Effect.gen(function* () {
          const pullRequest = `${path}/pull-requests/${input.number}`;
          yield* Effect.forEach(
            input.comments,
            (comment) =>
              write({
                method: "POST",
                url: `${pullRequest}/comments`,
                body: { text: comment.body, anchor: bitbucketServerCommentAnchor(comment) },
              }),
            { discard: true },
          );
          if (input.body.trim().length > 0) {
            yield* write({
              method: "POST",
              url: `${pullRequest}/comments`,
              body: { text: input.body },
            });
          }
          const status = participantStatus(input.verdict);
          if (status === null) return;
          const viewer = yield* getViewer;
          const slug = yield* accountSlug(path, input.number, viewer);
          yield* write({
            method: "PUT",
            url: `${pullRequest}/participants/${encodeURIComponent(slug)}`,
            body: { status },
          });
        }),
      ),
    ),

    listReviewerCandidates: Effect.fn("BitbucketServerPullRequestApi.listReviewerCandidates")(
      (input) =>
        withRepository(input.repository, (path, locator) =>
          Effect.all(
            [
              getPullRequest(path, input.number),
              read({
                operation: "listReviewerCandidates",
                url: `${BitbucketServerApi.API_ROOT}/users?${new URLSearchParams([
                  ["permission.1", "REPO_READ"],
                  ["permission.1.projectKey", locator.projectKey],
                  ["permission.1.repositorySlug", locator.repoSlug],
                  ["limit", String(BitbucketServerApi.MAX_PAGE_SIZE)],
                  ...(input.query?.trim()
                    ? [["filter", input.query.trim()] as [string, string]]
                    : []),
                ]).toString()}`,
                decode: decodeUsersPageJson,
              }),
            ],
            { concurrency: 2 },
          ).pipe(
            Effect.map(([pullRequest, users]) => {
              const requested = new Set(pullRequest.reviewRequestLogins);
              const author = pullRequest.author?.login;
              return {
                // The author is dropped rather than shown unusable: the host refuses to make the
                // person who opened a pull request its reviewer.
                candidates: users.items.flatMap((candidate) =>
                  candidate.login === author
                    ? []
                    : [{ ...candidate, isRequested: requested.has(candidate.id) }],
                ),
                truncated: users.nextPageStart !== null,
              };
            }),
          ),
        ),
    ),

    // No endpoint adds or removes one reviewer by name: the list is written whole, so the set
    // that is there is read first and the change applied to it.
    setReviewerRequest: Effect.fn("BitbucketServerPullRequestApi.setReviewerRequest")((input) =>
      withRepository(input.repository, (path) =>
        putPullRequest(path, input.number, (current) => {
          const reviewers = new Set(current.reviewRequestLogins);
          for (const reviewer of input.reviewers) {
            if (input.requested) reviewers.add(reviewer.id);
            else reviewers.delete(reviewer.id);
          }
          return { reviewers };
        }),
      ),
    ),
  });
});

export const layer = Layer.effect(BitbucketServerPullRequestApi, make);
