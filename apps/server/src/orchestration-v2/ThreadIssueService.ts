/**
 * Issues linked to threads: the link and unlink commands the server's own surfaces (MCP) go
 * through. A link records how the tracker named the issue when it was made; nothing refreshes
 * it, and opening the issue reads its live state.
 *
 * @module orchestration-v2/ThreadIssueService
 */
import {
  CommandId,
  type IssueDetail,
  type MessageId,
  type OrchestrationV2DomainEvent,
  threadIssueKeysEqual,
  type IssueLinkedThreadsResult,
  type IssueOperationError,
  type IssueRef,
  type ThreadId,
  type ThreadIssueKey,
  type ThreadIssueLinkSource,
} from "@t3tools/contracts";
import { JIRA_KIND, parseJiraIssueUrl } from "@t3tools/issue-tracker-jira/shared/issueUrl";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { IssueService } from "../issue/IssueService.ts";
import { listLinkedIssueThreads } from "../issue/linkedThreads.ts";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";

export interface LinkThreadIssueInput {
  readonly threadId: ThreadId;
  readonly ref: IssueRef & { readonly host: string };
  readonly url: string;
  readonly displayKey: string;
  readonly title: string;
  readonly source: ThreadIssueLinkSource;
}

export interface UnlinkThreadIssueInput {
  readonly threadId: ThreadId;
  readonly key: ThreadIssueKey;
}

export class ThreadIssueService extends Context.Service<
  ThreadIssueService,
  {
    /** Linking a linked issue is a no-op. */
    readonly link: (
      input: LinkThreadIssueInput,
    ) => Effect.Effect<{ readonly alreadyLinked: boolean }, Orchestrator.OrchestratorV2Error>;
    readonly unlink: (
      input: UnlinkThreadIssueInput,
    ) => Effect.Effect<{ readonly wasLinked: boolean }, Orchestrator.OrchestratorV2Error>;
    /** Every thread the issue is linked to, most recently active first. */
    readonly linkedThreads: (
      key: ThreadIssueKey,
    ) => Effect.Effect<IssueLinkedThreadsResult, IssueOperationError>;
  }
>()("t3/orchestration-v2/ThreadIssueService") {}

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const random = yield* SecureRandom.SecureRandom;
  const sql = yield* SqlClient.SqlClient;

  const commandId = (tag: string, threadId: ThreadId) =>
    random.uuidV4().pipe(
      Effect.orDie,
      Effect.map((uuid) => CommandId.make(`server:thread-issue-${tag}:${threadId}:${uuid}`)),
    );

  const isLinked = (threadId: ThreadId, key: ThreadIssueKey) =>
    orchestrator
      .getThreadShell(threadId)
      .pipe(
        Effect.map(
          (thread) => thread?.issues?.some((link) => threadIssueKeysEqual(link, key)) === true,
        ),
      );

  const link: ThreadIssueService["Service"]["link"] = Effect.fn("ThreadIssueService.link")(
    function* (input) {
      if (yield* isLinked(input.threadId, input.ref)) return { alreadyLinked: true };
      yield* orchestrator.dispatch({
        type: "thread.issue.link",
        commandId: yield* commandId("link", input.threadId),
        threadId: input.threadId,
        tracker: input.ref.tracker,
        host: input.ref.host,
        scope: input.ref.scope,
        key: input.ref.key,
        projectId: input.ref.projectId,
        url: input.url,
        displayKey: input.displayKey,
        title: input.title,
        source: input.source,
      });
      return { alreadyLinked: false };
    },
  );

  const unlink: ThreadIssueService["Service"]["unlink"] = Effect.fn("ThreadIssueService.unlink")(
    function* (input) {
      if (!(yield* isLinked(input.threadId, input.key))) return { wasLinked: false };
      yield* orchestrator.dispatch({
        type: "thread.issue.unlink",
        commandId: yield* commandId("unlink", input.threadId),
        threadId: input.threadId,
        tracker: input.key.tracker,
        host: input.key.host,
        scope: input.key.scope,
        key: input.key.key,
      });
      return { wasLinked: true };
    },
  );

  const linkedThreads: ThreadIssueService["Service"]["linkedThreads"] = (key) =>
    listLinkedIssueThreads(key).pipe(Effect.provideService(SqlClient.SqlClient, sql));

  return ThreadIssueService.of({ link, unlink, linkedThreads });
});

export const layer = Layer.effect(ThreadIssueService, make);

const MAX_JIRA_MENTIONS_PER_MESSAGE = 10;
const RECENT_MENTION_MESSAGES = 512;

function jiraMentions(text: string) {
  const keys = new Map<string, string>();
  const links = new Map<string, { readonly key: string; readonly url: string }>();
  for (const match of text.matchAll(
    /https?:\/\/[^\s<>()[\]"'`]+|\b([A-Z][A-Z0-9_]*)-([1-9][0-9]*)\b/gu,
  )) {
    const [mention, scope] = match;
    if (scope !== undefined) {
      keys.set(mention, scope);
      continue;
    }
    const url = URL.parse(mention.replace(/[.,!?;:]+$/u, ""));
    const link = url === null ? null : parseJiraIssueUrl(url);
    if (url !== null && link !== null) {
      links.set(`${link.workspace}/${link.key}`, {
        key: link.key,
        url: `${url.origin}/browse/${link.key}`,
      });
    }
  }
  for (const link of links.values()) keys.delete(link.key);
  return { keys, links };
}

function jiraMentionMessage(event: OrchestrationV2DomainEvent) {
  if (event.type !== "message.updated") return;
  const message = event.payload;
  if (message.streaming || message.runId === null) return;
  if (
    message.role === "assistant" ||
    (message.role === "user" &&
      message.createdBy === "user" &&
      message.workflowScript !== true &&
      message.idleCompaction === undefined)
  ) {
    return message;
  }
}

export const layerMentionObserver = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const issues = yield* IssueService;
    const threadIssues = yield* ThreadIssueService;
    const scanned = new Set<MessageId>();

    const attach = Effect.fn("ThreadIssueService.attachMentions")(function* (
      message: NonNullable<ReturnType<typeof jiraMentionMessage>>,
    ) {
      const { id, threadId, text } = message;
      if (scanned.has(id)) return;
      const { keys, links } = jiraMentions(text);
      if (keys.size === 0 && links.size === 0) return;
      if (scanned.size === RECENT_MENTION_MESSAGES) {
        const oldest = scanned.values().next();
        if (!oldest.done) scanned.delete(oldest.value);
      }
      scanned.add(id);
      const { thread } = yield* orchestrator.getThreadRecords(threadId, []);
      if (thread.deletedAt !== null) return;
      const dismissed = (key: string) => thread.dismissedJiraIssueKeys?.includes(key) === true;
      const alreadyLinked = (key: string, url?: string) =>
        thread.issues?.some(
          (link) =>
            link.tracker === JIRA_KIND &&
            link.key === key &&
            (url === undefined || URL.parse(link.url)?.hostname === URL.parse(url)?.hostname),
        ) === true;
      const linkIssue = (issue: IssueDetail) =>
        threadIssues.link({
          threadId,
          ref: issue,
          url: issue.url,
          displayKey: issue.displayKey,
          title: issue.title,
          source: "automatic",
        });

      let remaining = MAX_JIRA_MENTIONS_PER_MESSAGE;
      for (const { key, url } of links.values()) {
        if (remaining === 0) return;
        if (alreadyLinked(key, url) || dismissed(key)) continue;
        remaining--;
        const resolved = yield* issues.resolveUrl(url, thread.projectId).pipe(Effect.option);
        if (
          resolved._tag === "Some" &&
          resolved.value.tracker === JIRA_KIND &&
          resolved.value.issue !== undefined
        ) {
          yield* linkIssue(resolved.value.issue);
        }
      }
      if (keys.size === 0 || remaining === 0) return;
      const projectScope = yield* issues.projectScope(thread.projectId).pipe(Effect.option);
      if (projectScope._tag === "None" || projectScope.value.tracker !== JIRA_KIND) return;
      for (const [key, scope] of keys) {
        if (remaining === 0) return;
        if (alreadyLinked(key) || dismissed(key)) continue;
        remaining--;
        const issue = yield* issues
          .detail({ ...projectScope.value, scope, key })
          .pipe(Effect.option);
        if (issue._tag === "Some") yield* linkIssue(issue.value);
      }
    });

    yield* forkParked(
      orchestrator.streamDomainEvents.pipe(
        Stream.runForEach((event) => {
          const message = jiraMentionMessage(event);
          return message === undefined
            ? Effect.void
            : attach(message).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("Could not attach Jira issue mentions", {
                    threadId: event.threadId,
                    error,
                  }),
                ),
              );
        }),
        Effect.catch((error) => Effect.logWarning("Jira issue mention observer stopped", error)),
      ),
    );
  }),
);
