import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  PullRequestChecksState,
  PullRequestActor,
  PullRequestReviewCommentDraft,
  PullRequestReviewerCandidate,
  PullRequestCheck,
  PullRequestCheckStatus,
  PullRequestComment,
  PullRequestCommit,
  PullRequestMergeability,
  PullRequestReaction,
  PullRequestReactionContent,
  PullRequestReviewPosition,
  PullRequestConversationThread,
  PullRequestState,
  PullRequestThreadComment,
} from "@t3tools/contracts";
import { TrimmedNonEmptyString } from "@t3tools/contracts";
import { quoteGitPatchPath, unquoteGitPatchPath } from "@t3tools/shared/gitPatchPath";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import { dedupeChecks } from "@t3tools/source-control-core/server/pullRequestChecks";
import { withAttachmentUrls } from "../shared/definition.ts";

/**
 * Data Center's enums are decoded as plain strings and normalized here, in the same tolerant
 * style as the other hosts' decoders: a new state or build status must not fail a whole payload.
 */
const RawUserSchema = Schema.Struct({
  /** The account's username, which is also what `role.1`/`username.1` listing filters take. */
  name: Schema.optional(Schema.NullOr(Schema.String)),
  displayName: Schema.optional(Schema.NullOr(Schema.String)),
  emailAddress: Schema.optional(Schema.NullOr(Schema.String)),
  /** How the host spells the account in a URL path, which is not the name once it holds a slash. */
  slug: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawParticipantSchema = Schema.Struct({
  user: Schema.optional(Schema.NullOr(RawUserSchema)),
  role: Schema.optional(Schema.NullOr(Schema.String)),
  approved: Schema.optional(Schema.Boolean),
  status: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawRefSchema = Schema.Struct({
  displayId: TrimmedNonEmptyString,
  latestCommit: Schema.optional(Schema.NullOr(Schema.String)),
  repository: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        slug: TrimmedNonEmptyString,
        project: Schema.Struct({ key: TrimmedNonEmptyString }),
      }),
    ),
  ),
});

const RawPullRequestSchema = Schema.Struct({
  id: Schema.Int,
  version: Schema.Int,
  title: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  draft: Schema.optional(Schema.Boolean),
  createdDate: Schema.Number,
  updatedDate: Schema.Number,
  closedDate: Schema.optional(Schema.NullOr(Schema.Number)),
  author: Schema.optional(Schema.NullOr(RawParticipantSchema)),
  reviewers: Schema.optional(Schema.NullOr(Schema.Array(RawParticipantSchema))),
  fromRef: RawRefSchema,
  toRef: RawRefSchema,
  links: Schema.Struct({
    self: Schema.NonEmptyArray(Schema.Struct({ href: TrimmedNonEmptyString })),
  }),
});

/** One page of any Data Center collection: an offset cursor rather than a next URL. */
const RawPageSchema = Schema.Struct({
  values: Schema.Array(Schema.Unknown),
  isLastPage: Schema.optional(Schema.Boolean),
  nextPageStart: Schema.optional(Schema.NullOr(Schema.Int)),
});

const RawAnchorSchema = Schema.Struct({
  path: Schema.optional(Schema.NullOr(Schema.String)),
  /** The path before a rename, which is the one a comment on the removed side belongs to. */
  srcPath: Schema.optional(Schema.NullOr(Schema.String)),
  line: Schema.optional(Schema.NullOr(Schema.Int)),
  /** ADDED, REMOVED or CONTEXT: which kind of diff line the comment sits on. */
  lineType: Schema.optional(Schema.NullOr(Schema.String)),
  /** FROM or TO: which side of the diff the line number counts in. */
  fileType: Schema.optional(Schema.NullOr(Schema.String)),
  /** The line is no longer in the diff, after a rescope. */
  orphaned: Schema.optional(Schema.NullOr(Schema.Boolean)),
});

const RawReactionSchema = Schema.Struct({
  emoticon: Schema.optional(Schema.NullOr(Schema.Struct({ shortcut: Schema.String }))),
  users: Schema.optional(Schema.NullOr(Schema.Array(RawUserSchema))),
});

interface RawComment {
  readonly id: number;
  readonly properties?:
    | { readonly reactions?: ReadonlyArray<typeof RawReactionSchema.Type> | null | undefined }
    | null
    | undefined;
  readonly version?: number | null | undefined;
  readonly text?: string | null | undefined;
  readonly author?: typeof RawUserSchema.Type | null | undefined;
  readonly createdDate: number;
  /** OPEN or RESOLVED, which a task and a thread both use. */
  readonly state?: string | null | undefined;
  /** BLOCKER marks a task. */
  readonly severity?: string | null | undefined;
  readonly threadResolved?: boolean | null | undefined;
  readonly anchor?: typeof RawAnchorSchema.Type | null | undefined;
  /** Replies, nested under the remark they answer, to any depth. */
  readonly comments?: ReadonlyArray<RawComment> | null | undefined;
}

const RawCommentSchema = Schema.Struct({
  id: Schema.Int,
  version: Schema.optional(Schema.NullOr(Schema.Int)),
  text: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.NullOr(RawUserSchema)),
  createdDate: Schema.Number,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  severity: Schema.optional(Schema.NullOr(Schema.String)),
  threadResolved: Schema.optional(Schema.NullOr(Schema.Boolean)),
  anchor: Schema.optional(Schema.NullOr(RawAnchorSchema)),
  properties: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        reactions: Schema.optional(Schema.NullOr(Schema.Array(RawReactionSchema))),
      }),
    ),
  ),
  comments: Schema.optional(
    Schema.NullOr(Schema.Array(Schema.suspend((): Schema.Codec<RawComment> => RawCommentSchema))),
  ),
});

/**
 * One row of the activities feed. Only a root comment arrives as `COMMENTED`/`ADDED` — its
 * replies travel nested inside it rather than as rows of their own — and a verdict is a row
 * with no comment at all.
 */
const RawActivitySchema = Schema.Struct({
  id: Schema.Int,
  createdDate: Schema.Number,
  user: Schema.optional(Schema.NullOr(RawUserSchema)),
  action: Schema.optional(Schema.NullOr(Schema.String)),
  commentAction: Schema.optional(Schema.NullOr(Schema.String)),
  comment: Schema.optional(Schema.NullOr(RawCommentSchema)),
});

const RawCommitSchema = Schema.Struct({
  id: TrimmedNonEmptyString,
  message: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.NullOr(RawUserSchema)),
  authorTimestamp: Schema.optional(Schema.NullOr(Schema.Number)),
  committerTimestamp: Schema.optional(Schema.NullOr(Schema.Number)),
  parents: Schema.optional(
    Schema.NullOr(
      Schema.Array(Schema.Struct({ id: Schema.optional(Schema.NullOr(Schema.String)) })),
    ),
  ),
});

const RawBuildStatusSchema = Schema.Struct({
  key: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  dateAdded: Schema.optional(Schema.NullOr(Schema.Number)),
});

/** `/pull-requests/{id}/merge`: whether the host would merge this now, and what stands in the way. */
const RawMergeCheckSchema = Schema.Struct({
  canMerge: Schema.optional(Schema.Boolean),
  conflicted: Schema.optional(Schema.Boolean),
  vetoes: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          summaryMessage: Schema.optional(Schema.NullOr(Schema.String)),
          detailedMessage: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
  ),
});

/** `/repos?permission=…` rows, each naming the repository it grants that permission on. */
const RawRepositorySchema = Schema.Struct({
  slug: TrimmedNonEmptyString,
  project: Schema.Struct({ key: TrimmedNonEmptyString }),
});

const RawCommitDetailSchema = Schema.Struct({
  id: TrimmedNonEmptyString,
  parents: Schema.optional(
    Schema.NullOr(
      Schema.Array(Schema.Struct({ id: Schema.optional(Schema.NullOr(Schema.String)) })),
    ),
  ),
});

export interface BitbucketServerPullRequest {
  readonly number: number;
  /** Optimistic-concurrency token every write sends back. */
  readonly version: number;
  readonly title: string;
  readonly url: string;
  readonly author: PullRequestActor | null;
  readonly headBranch: string;
  readonly headCommit: string | null;
  readonly headRepositoryNameWithOwner: string | null;
  readonly baseBranch: string;
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
  readonly body: string;
  readonly reviewers: ReadonlyArray<PullRequestActor>;
  readonly reviewRequestLogins: ReadonlyArray<string>;
}

export interface BitbucketServerPage<A> {
  readonly items: ReadonlyArray<A>;
  /** The offset of the next page, or null on the last one. */
  readonly nextPageStart: number | null;
  /** Rows on the page before any were skipped, which an offset cursor has to count. */
  readonly rawCount: number;
}

type DecodeFailure = Cause.Cause<Schema.SchemaError>;

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : null;
}

/** Data Center stamps every instant as epoch milliseconds. */
function toIso(millis: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(millis));
}

function toActor(raw: typeof RawUserSchema.Type | null | undefined): PullRequestActor | null {
  const login = trimmed(raw?.name) ?? trimmed(raw?.emailAddress);
  return login === null ? null : { login, name: trimmed(raw?.displayName), avatarUrl: null };
}

function toState(state: string | null | undefined): PullRequestState {
  switch (state?.trim().toUpperCase()) {
    case "MERGED":
      return "merged";
    case "DECLINED":
      return "closed";
    default:
      return "open";
  }
}

function toPullRequest(raw: typeof RawPullRequestSchema.Type): BitbucketServerPullRequest {
  const reviewers = (raw.reviewers ?? []).flatMap((reviewer) => {
    const actor = toActor(reviewer.user);
    return actor === null ? [] : [actor];
  });
  const headRepository = raw.fromRef.repository;
  return {
    number: raw.id,
    version: raw.version,
    title: raw.title,
    url: raw.links.self[0].href,
    author: toActor(raw.author?.user),
    headBranch: raw.fromRef.displayId,
    headCommit: trimmed(raw.fromRef.latestCommit),
    headRepositoryNameWithOwner: headRepository
      ? `${headRepository.project.key}/${headRepository.slug}`
      : null,
    baseBranch: raw.toRef.displayId,
    state: toState(raw.state),
    isDraft: raw.draft === true,
    createdAt: toIso(raw.createdDate),
    updatedAt: toIso(raw.updatedDate),
    closedAt:
      raw.closedDate === null || raw.closedDate === undefined ? null : toIso(raw.closedDate),
    body: withAttachmentUrls(raw.description ?? "", raw.links.self[0].href),
    reviewers,
    reviewRequestLogins: reviewers.map((reviewer) => reviewer.login),
  };
}

const decodePage = decodeJsonResult(RawPageSchema);
const decodePullRequest = decodeJsonResult(RawPullRequestSchema);
const decodePullRequestEntry = Schema.decodeUnknownExit(RawPullRequestSchema);
const decodeActivityEntry = Schema.decodeUnknownExit(RawActivitySchema);
const decodeCommitEntry = Schema.decodeUnknownExit(RawCommitSchema);
const decodeBuildStatusEntry = Schema.decodeUnknownExit(RawBuildStatusSchema);
const decodeRepositoryEntry = Schema.decodeUnknownExit(RawRepositorySchema);
const decodeUserEntry = Schema.decodeUnknownExit(RawUserSchema);
const decodeParticipantEntry = Schema.decodeUnknownExit(RawParticipantSchema);
const decodeUser = decodeJsonResult(RawUserSchema);
const decodeComment = decodeJsonResult(RawCommentSchema);
const decodeMergeCheck = decodeJsonResult(RawMergeCheckSchema);
const decodeCommitDetail = decodeJsonResult(RawCommitDetailSchema);

/** Walks one page, skipping rows that do not decode, as the other hosts' decoders do. */
function decodeItems<Raw, A>(
  raw: string,
  decodeEntry: (entry: unknown) => Exit.Exit<Raw, Schema.SchemaError>,
  convert: (entry: Raw) => A | null,
): Result.Result<BitbucketServerPage<A>, DecodeFailure> {
  const decoded = decodePage(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  const items: A[] = [];
  for (const entry of decoded.success.values) {
    const item = decodeEntry(entry);
    if (Exit.isFailure(item)) continue;
    const converted = convert(item.value);
    if (converted !== null) items.push(converted);
  }
  const next = decoded.success.nextPageStart;
  return Result.succeed({
    items,
    nextPageStart:
      decoded.success.isLastPage === true || next === null || next === undefined ? null : next,
    rawCount: decoded.success.values.length,
  });
}

export function decodePullRequestPageJson(
  raw: string,
): Result.Result<BitbucketServerPage<BitbucketServerPullRequest>, DecodeFailure> {
  return decodeItems(raw, decodePullRequestEntry, toPullRequest);
}

export function decodePullRequestJson(
  raw: string,
): Result.Result<BitbucketServerPullRequest, DecodeFailure> {
  const decoded = decodePullRequest(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed(toPullRequest(decoded.success))
    : Result.fail(decoded.failure);
}

/**
 * Whether `/repos?permission=REPO_WRITE&name=…` named this repository. The name filter is a
 * substring match across every project, so the row has to be checked against both halves of
 * the locator rather than trusted for being on the page.
 */
export function decodeRepositoryPermissionJson(
  raw: string,
  repository: { readonly projectKey: string; readonly repoSlug: string },
): Result.Result<
  { readonly granted: boolean; readonly nextPageStart: number | null },
  DecodeFailure
> {
  const decoded = decodeItems(raw, decodeRepositoryEntry, (entry) => entry);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  const granted = decoded.success.items.some(
    (entry) =>
      entry.project.key.toLowerCase() === repository.projectKey.toLowerCase() &&
      entry.slug.toLowerCase() === repository.repoSlug.toLowerCase(),
  );
  return Result.succeed({ granted, nextPageStart: decoded.success.nextPageStart });
}

/**
 * A conflict is the one veto the page has a word for. Every other veto — approvals, builds,
 * tasks — is a merge requirement the host refuses over, so each is listed as a required check
 * that is still pending until the host clears it.
 */
export function decodeMergeCheckJson(raw: string): Result.Result<
  {
    readonly mergeability: PullRequestMergeability;
    readonly blockers: ReadonlyArray<PullRequestCheck>;
  },
  DecodeFailure
> {
  const decoded = decodeMergeCheck(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  const { canMerge, conflicted, vetoes } = decoded.success;
  const mergeability: PullRequestMergeability =
    conflicted === true ? "conflicting" : canMerge === true ? "mergeable" : "unknown";
  const blockers: PullRequestCheck[] = [];
  for (const veto of vetoes ?? []) {
    const name = trimmed(veto.summaryMessage) ?? trimmed(veto.detailedMessage);
    if (name === null) continue;
    blockers.push({
      name,
      status: "pending",
      description: trimmed(veto.detailedMessage),
      url: null,
      required: true,
    });
  }
  return Result.succeed({ mergeability, blockers });
}

/** The commit's first parent, which is the old side of its own diff. Null on a root commit. */
export function decodeCommitParentJson(raw: string): Result.Result<string | null, DecodeFailure> {
  const decoded = decodeCommitDetail(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed(trimmed(decoded.success.parents?.[0]?.id))
    : Result.fail(decoded.failure);
}

/** A commit resource's own sha, which is what `/merge-base` answers with. */
export function decodeCommitIdJson(raw: string): Result.Result<string, DecodeFailure> {
  const decoded = decodeCommitDetail(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed(decoded.success.id)
    : Result.fail(decoded.failure);
}

export interface BitbucketServerActivity {
  readonly comments: ReadonlyArray<PullRequestComment>;
  readonly threads: ReadonlyArray<PullRequestConversationThread>;
}

function toReviewState(action: string | null | undefined): string | null {
  switch (action?.trim().toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "REVIEWED":
      return "changes_requested";
    case "UNAPPROVED":
      return "dismissed";
    default:
      return null;
  }
}

/** Data Center's emoticon shortcut for each reaction a client offers. */
export const BITBUCKET_SERVER_EMOTICONS: Record<PullRequestReactionContent, string> = {
  "thumbs-up": "thumbsup",
  "thumbs-down": "thumbsdown",
  laugh: "laughing",
  hooray: "tada",
  confused: "confused",
  heart: "heart",
  rocket: "rocket",
  eyes: "eyes",
};

const REACTION_OF_EMOTICON = new Map(
  Object.entries(BITBUCKET_SERVER_EMOTICONS).map(
    ([content, shortcut]) => [shortcut, content as PullRequestReactionContent] as const,
  ),
);

/** Decoded before the viewer is known; `markViewerReactions` lifts the viewer out after. */
function toReactions(comment: RawComment): ReadonlyArray<PullRequestReaction> | undefined {
  const reactions = (comment.properties?.reactions ?? []).flatMap((reaction) => {
    const content = REACTION_OF_EMOTICON.get(reaction.emoticon?.shortcut ?? "");
    const logins = (reaction.users ?? []).flatMap((user) => toActor(user)?.login ?? []);
    if (content === undefined || logins.length === 0) return [];
    return [{ content, count: logins.length, actors: logins, viewerHasReacted: false }];
  });
  return reactions.length === 0 ? undefined : reactions;
}

export function markViewerReactions<
  A extends { readonly reactions?: ReadonlyArray<PullRequestReaction> | undefined },
>(item: A, viewer: string | null): A {
  if (viewer === null || item.reactions === undefined) return item;
  return {
    ...item,
    reactions: item.reactions.map((reaction) =>
      reaction.actors.includes(viewer)
        ? {
            ...reaction,
            actors: reaction.actors.filter((login) => login !== viewer),
            viewerHasReacted: true,
          }
        : reaction,
    ),
  };
}

function isTask(comment: Pick<RawComment, "severity">): boolean {
  return comment.severity?.toUpperCase() === "BLOCKER";
}

/** A root and every reply under it, however deep, oldest first. */
function flattenComment(comment: RawComment): ReadonlyArray<RawComment> {
  return [comment, ...(comment.comments ?? []).flatMap(flattenComment)].toSorted(
    (left, right) => left.createdDate - right.createdDate,
  );
}

function commentUrl(pullRequestUrl: string, id: number): string {
  return `${pullRequestUrl}/overview?commentId=${id}`;
}

/**
 * The conversation out of the activities feed. Every root comment opens a thread, on a line or
 * on the pull request as a whole; its replies belong to the same thread whatever they say. A
 * root task's thread is resolved when the task is, so resolving it completes the task. A verdict — approve, needs work, approval
 * withdrawn — is an activity of its own with nothing said, and reads as a review.
 */
export function decodeActivitiesJson(
  raw: string,
  pullRequestUrl: string,
): Result.Result<BitbucketServerPage<BitbucketServerActivity>, DecodeFailure> {
  return decodeItems(raw, decodeActivityEntry, (activity): BitbucketServerActivity | null => {
    const reviewState = toReviewState(activity.action);
    if (reviewState !== null) {
      const author = toActor(activity.user);
      if (author === null) return null;
      return {
        comments: [
          {
            id: `activity:${activity.id}`,
            kind: "review",
            author,
            body: "",
            createdAt: toIso(activity.createdDate),
            url: null,
            path: null,
            reviewState,
          },
        ],
        threads: [],
      };
    }
    if (
      activity.action?.toUpperCase() !== "COMMENTED" ||
      activity.commentAction?.toUpperCase() !== "ADDED" ||
      activity.comment === null ||
      activity.comment === undefined
    ) {
      return null;
    }
    const root = activity.comment;
    const anchor = root.anchor;
    // `TO` counts lines in the file as it is now, `FROM` as it was. An anchor that names no
    // side sits on the removed side only when it is on a removed line.
    const fileType = anchor?.fileType?.trim().toUpperCase();
    const side =
      fileType === "FROM" || (fileType !== "TO" && anchor?.lineType?.toUpperCase() === "REMOVED")
        ? "left"
        : "right";
    const path = (side === "left" ? trimmed(anchor?.srcPath) : null) ?? trimmed(anchor?.path);
    const entries = flattenComment(root);
    const comments = entries.map((comment): PullRequestComment => ({
      id: String(comment.id),
      kind: path === null ? "issue-comment" : "review-comment",
      author: toActor(comment.author),
      body: withAttachmentUrls(comment.text ?? "", pullRequestUrl),
      createdAt: toIso(comment.createdDate),
      url: commentUrl(pullRequestUrl, comment.id),
      path,
      reviewState: null,
      reactions: toReactions(comment),
    }));
    const line = anchor?.line;
    const resolved = root.state?.toUpperCase() === "RESOLVED";
    const thread: Omit<PullRequestConversationThread, "path" | "line"> = {
      id: String(root.id),
      side,
      isResolved: isTask(root) ? resolved : root.threadResolved === true || resolved,
      isOutdated: anchor?.orphaned === true,
      comments: entries.map((comment): PullRequestThreadComment => ({
        id: String(comment.id),
        author: toActor(comment.author),
        body: withAttachmentUrls(comment.text ?? "", pullRequestUrl),
        createdAt: toIso(comment.createdDate),
        url: commentUrl(pullRequestUrl, comment.id),
        reactions: toReactions(comment),
      })),
    };
    return {
      comments,
      threads: [
        path === null
          ? { ...thread, path, line: null }
          : { ...thread, path, line: typeof line === "number" && line > 0 ? line : null },
      ],
    };
  });
}

export function decodeCommitsJson(
  raw: string,
): Result.Result<BitbucketServerPage<PullRequestCommit>, DecodeFailure> {
  return decodeItems(raw, decodeCommitEntry, (commit): PullRequestCommit | null => {
    const committedAt = commit.committerTimestamp ?? commit.authorTimestamp;
    if (committedAt === null || committedAt === undefined) return null;
    const author = toActor(commit.author);
    return {
      oid: commit.id,
      messageHeadline: (commit.message ?? "").split("\n")[0] ?? "",
      committedDate: toIso(committedAt),
      authors: author === null ? [] : [author],
    };
  });
}

function toBuildStatus(value: string | null | undefined): PullRequestCheckStatus {
  switch (value?.trim().toUpperCase()) {
    case "SUCCESSFUL":
      return "success";
    case "FAILED":
      return "failure";
    case "CANCELLED":
      return "cancelled";
    case "INPROGRESS":
      return "pending";
    default:
      return "neutral";
  }
}

/**
 * Build statuses on one commit. A key is reused when a build is run again, so the newest run
 * under each key is the one kept, as the shared de-duplication does for every host.
 */
export function decodeBuildStatusesJson(
  raw: string,
): Result.Result<BitbucketServerPage<PullRequestCheck>, DecodeFailure> {
  const decoded = decodeItems(raw, decodeBuildStatusEntry, (status) => {
    const name = trimmed(status.name) ?? trimmed(status.key);
    if (name === null) return null;
    return {
      check: {
        name,
        status: toBuildStatus(status.state),
        description: trimmed(status.description),
        url: trimmed(status.url),
      },
      workflowName: trimmed(status.key),
      at:
        status.dateAdded === null || status.dateAdded === undefined
          ? null
          : toIso(status.dateAdded),
    };
  });
  return Result.map(decoded, (page) => ({ ...page, items: dedupeChecks(page.items) }));
}

/**
 * Data Center writes its own `src://` and `dst://` prefixes where git writes `a/` and `b/`. The
 * diff viewer reads the git spelling, so the headers are rewritten to it before the patch leaves
 * the server; hunk lines are left alone.
 */
export function normalizeUnifiedDiff(patch: string): string {
  let inHunk = false;
  return patch
    .split("\n")
    .map((line) => {
      if (line.startsWith("diff --git ")) {
        inHunk = false;
        return line.replaceAll(" src://", " a/").replaceAll(" dst://", " b/");
      }
      if (line.startsWith("@@ ")) inHunk = true;
      if (inHunk) return line;
      if (line.startsWith("--- src://")) return `--- a/${line.slice("--- src://".length)}`;
      if (line.startsWith("+++ dst://")) return `+++ b/${line.slice("+++ dst://".length)}`;
      if (line.startsWith("rename from src://")) {
        return `rename from ${line.slice("rename from src://".length)}`;
      }
      if (line.startsWith("rename to dst://"))
        return `rename to ${line.slice("rename to dst://".length)}`;
      return line;
    })
    .join("\n");
}

const RawChangeSchema = Schema.Struct({
  path: Schema.Struct({ toString: TrimmedNonEmptyString }),
  srcPath: Schema.optional(Schema.NullOr(Schema.Struct({ toString: TrimmedNonEmptyString }))),
  type: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeChangeEntry = Schema.decodeUnknownExit(RawChangeSchema);

export interface BitbucketServerChange {
  readonly path: string;
  readonly srcPath: string | null;
  readonly type: "add" | "delete" | "move" | "modify";
}

/** One page of `/changes`, which names the files but states no line counts. */
export function decodeChangesPageJson(raw: string): Result.Result<
  {
    readonly count: number;
    readonly files: ReadonlyArray<BitbucketServerChange>;
    readonly nextPageStart: number | null;
  },
  DecodeFailure
> {
  const decoded = decodePage(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  const next = decoded.success.nextPageStart;
  const files = decoded.success.values.flatMap((value): BitbucketServerChange[] => {
    const entry = decodeChangeEntry(value);
    if (Exit.isFailure(entry)) return [];
    const type = entry.value.type?.trim().toUpperCase();
    return [
      {
        path: entry.value.path.toString,
        srcPath: entry.value.srcPath?.toString ?? null,
        type:
          type === "ADD" || type === "COPY"
            ? "add"
            : type === "DELETE"
              ? "delete"
              : type === "MOVE"
                ? "move"
                : "modify",
      },
    ];
  });
  return Result.succeed({
    count: decoded.success.values.length,
    files,
    nextPageStart:
      decoded.success.isLastPage === true || next === null || next === undefined ? null : next,
  });
}

/**
 * A patch cut at the byte limit, made whole again: the file the cut landed in is dropped, and
 * every changed file the patch no longer carries gets a header with no hunks, which the client
 * offers to load one at a time.
 */
export function withholdTruncatedPatch(
  patch: string,
  changes: ReadonlyArray<BitbucketServerChange>,
): { readonly patch: string; readonly withheld: ReadonlyArray<string> } {
  const cut = patch.lastIndexOf("\ndiff --git ");
  const complete = cut === -1 ? "" : patch.slice(0, cut + 1);
  const carried = new Set(patchFileStats(complete).map((file) => file.path));
  const sections: string[] = [];
  const withheld: string[] = [];
  for (const change of changes) {
    if (carried.has(change.path)) continue;
    const oldPath = change.type === "move" ? (change.srcPath ?? change.path) : change.path;
    sections.push(
      [
        `diff --git ${quoteGitPatchPath(`a/${oldPath}`)} ${quoteGitPatchPath(`b/${change.path}`)}`,
        ...(change.type === "add" ? ["new file mode 100644"] : []),
        ...(change.type === "delete" ? ["deleted file mode 100644"] : []),
        ...(change.type === "move"
          ? [
              `rename from ${quoteGitPatchPath(oldPath)}`,
              `rename to ${quoteGitPatchPath(change.path)}`,
            ]
          : []),
        `--- ${change.type === "add" ? "/dev/null" : quoteGitPatchPath(`a/${oldPath}`)}`,
        `+++ ${change.type === "delete" ? "/dev/null" : quoteGitPatchPath(`b/${change.path}`)}`,
        "",
      ].join("\n"),
    );
    withheld.push(change.path);
  }
  return { patch: complete + sections.join(""), withheld };
}

const BuildCountsSchema = Schema.Struct({
  successful: Schema.optional(Schema.Int),
  failed: Schema.optional(Schema.Int),
  inProgress: Schema.optional(Schema.Int),
  cancelled: Schema.optional(Schema.Int),
  unknown: Schema.optional(Schema.Int),
});
const decodeBuildStats = decodeJsonResult(Schema.Record(Schema.String, BuildCountsSchema));

/**
 * `/build-status/1.0/commits/stats`: build counts by commit. A commit no build reported on is
 * left out of the answer, so it maps to none here as well.
 */
export function decodeBuildStatsJson(
  raw: string,
): Result.Result<ReadonlyMap<string, PullRequestChecksState | null>, DecodeFailure> {
  return Result.map(decodeBuildStats(raw), (byCommit) => {
    const states = new Map<string, PullRequestChecksState | null>();
    for (const [commit, counts] of Object.entries(byCommit)) {
      states.set(
        commit.toLowerCase(),
        (counts.failed ?? 0) + (counts.cancelled ?? 0) > 0
          ? "failing"
          : (counts.inProgress ?? 0) + (counts.unknown ?? 0) > 0
            ? "pending"
            : (counts.successful ?? 0) > 0
              ? "passing"
              : null,
      );
    }
    return states;
  });
}

/** `/settings/auto-merge`: whether the repository lets a pull request merge once its checks pass. */
export const decodeAutoMergeSettingsJson = decodeJsonResult(
  Schema.Struct({ enabled: Schema.optional(Schema.Boolean) }),
);

const DiffStatsSummarySchema = Schema.Struct({
  totalInsertions: Schema.Int,
  totalDeletions: Schema.Int,
});

export function decodeDiffStatsSummaryJson(
  raw: string,
): Result.Result<{ readonly additions: number; readonly deletions: number }, DecodeFailure> {
  return Result.map(decodeJsonResult(DiffStatsSummarySchema)(raw), (summary) => ({
    additions: summary.totalInsertions,
    deletions: summary.totalDeletions,
  }));
}

/**
 * One page of `/users?permission.1=REPO_READ&…`: everyone who may be asked to review. The
 * account name is both the handle shown and what the reviewer list is written with.
 */
export function decodeUsersPageJson(
  raw: string,
): Result.Result<
  BitbucketServerPage<Omit<PullRequestReviewerCandidate, "isRequested">>,
  DecodeFailure
> {
  return decodeItems(raw, decodeUserEntry, (user) => {
    const name = trimmed(user.name);
    return name === null
      ? null
      : { id: name, kind: "user", login: name, name: trimmed(user.displayName), avatarUrl: null };
  });
}

/** `/users/{slug}`: the slug the host addresses this account by in a path. */
export function decodeUserSlugJson(raw: string): Result.Result<string | null, DecodeFailure> {
  const decoded = decodeUser(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed(trimmed(decoded.success.slug))
    : Result.fail(decoded.failure);
}

/** One page of a pull request's participants, reduced to the slug of the named account. */
export function decodeParticipantSlugJson(
  raw: string,
  name: string,
): Result.Result<
  { readonly slug: string | null; readonly nextPageStart: number | null },
  DecodeFailure
> {
  const decoded = decodeItems(raw, decodeParticipantEntry, (participant) =>
    trimmed(participant.user?.name) === name ? trimmed(participant.user?.slug) : null,
  );
  return Result.map(decoded, (page) => ({
    slug: page.items[0] ?? null,
    nextPageStart: page.nextPageStart,
  }));
}

/** A comment resource's own version, which a rewrite of it has to send back. */
export function decodeCommentVersionJson(
  raw: string,
): Result.Result<{ readonly version: number; readonly isTask: boolean }, DecodeFailure> {
  const decoded = decodeComment(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed({ version: decoded.success.version ?? 0, isTask: isTask(decoded.success) })
    : Result.fail(decoded.failure);
}

/**
 * Where a draft remark sits, in the host's words: the line number counted on the side it was
 * written against, which kind of diff line that is, and the file's names either side of a rename.
 */
function anchorAt(position: PullRequestReviewPosition) {
  return position.kind === "added"
    ? { line: position.newLine, lineType: "ADDED" as const, fileType: "TO" as const }
    : position.kind === "deleted"
      ? { line: position.oldLine, lineType: "REMOVED" as const, fileType: "FROM" as const }
      : position.side === "left"
        ? { line: position.oldLine, lineType: "CONTEXT" as const, fileType: "FROM" as const }
        : { line: position.newLine, lineType: "CONTEXT" as const, fileType: "TO" as const };
}

function lineOn(position: PullRequestReviewPosition, side: "old" | "new"): number | undefined {
  if (position.kind === "added") return side === "new" ? position.newLine : undefined;
  if (position.kind === "deleted") return side === "old" ? position.oldLine : undefined;
  return side === "new" ? position.newLine : position.oldLine;
}

/**
 * A range needs `multilineMarker` (where it starts) and `multilineSpan` (the lines it covers on
 * each side the last line has); the host refuses a marker alone.
 */
export function bitbucketServerCommentAnchor(comment: PullRequestReviewCommentDraft) {
  const at = anchorAt(comment.position);
  const start = comment.startPosition;
  const span = (side: "old" | "new") => {
    const to = lineOn(comment.position, side);
    if (to === undefined) return null;
    return { from: (start === undefined ? undefined : lineOn(start, side)) ?? to, to };
  };
  const src = span("old");
  const dst = span("new");
  return {
    ...at,
    path: comment.path,
    ...(comment.oldPath === undefined ? {} : { srcPath: comment.oldPath }),
    diffType: "EFFECTIVE" as const,
    ...(start === undefined
      ? {}
      : {
          multilineMarker: {
            startLine: anchorAt(start).line,
            startLineType: anchorAt(start).lineType,
          },
          multilineSpan: {
            ...(src === null ? {} : { srcSpanStart: src.from, srcSpanEnd: src.to }),
            ...(dst === null ? {} : { dstSpanStart: dst.from, dstSpanEnd: dst.to }),
          },
        }),
  };
}

/** Added and deleted line counts per file, read off a patch already in git's spelling. */
export function patchFileStats(patch: string): ReadonlyArray<{
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}> {
  const files: Array<{ path: string; additions: number; deletions: number }> = [];
  let current: { path: string; additions: number; deletions: number } | null = null;
  let inBody = false;
  const pathOf = (token: string) => {
    const path = unquoteGitPatchPath(token);
    return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
  };
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = { path: "", additions: 0, deletions: 0 };
      files.push(current);
      inBody = false;
    } else if (current === null) {
      continue;
    } else if (!inBody && line.startsWith("--- ") && line !== "--- /dev/null") {
      current.path = pathOf(line.slice(4));
    } else if (!inBody && line.startsWith("+++ ") && line !== "+++ /dev/null") {
      current.path = pathOf(line.slice(4));
    } else if (line.startsWith("@@")) {
      inBody = true;
    } else if (inBody && line.startsWith("+")) {
      current.additions += 1;
    } else if (inBody && line.startsWith("-")) {
      current.deletions += 1;
    }
  }
  return files.filter((file) => file.path.length > 0);
}
