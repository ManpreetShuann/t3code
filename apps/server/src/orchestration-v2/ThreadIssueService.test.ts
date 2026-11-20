import {
  EventId,
  IssueOperationError,
  IssueTrackerKind,
  MessageId,
  RunId,
  ThreadId,
  type IssueDetail,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import { JIRA_HOST, JIRA_KIND } from "@t3tools/issue-tracker-jira/shared/issueUrl";
import { describe, expect, it } from "@effect/vitest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { IssueService } from "../issue/IssueService.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadIssueService from "./ThreadIssueService.ts";

const THREAD_ID = ThreadId.make("thread-1");

describe("ThreadIssueService", () => {
  it.effect("attaches readable Jira mentions from sent prompts and completed answers", () =>
    Effect.gen(function* () {
      const completed = yield* Deferred.make<void>();
      const { thread } = idleThreadProjection(liveThreadShell(THREAD_ID));
      const now = DateTime.makeUnsafe("2026-01-01T00:00:00Z");
      const iso = DateTime.formatIso(now);
      const ref = {
        projectId: thread.projectId,
        tracker: JIRA_KIND,
        host: JIRA_HOST,
        scope: "DEVX",
      };
      const issue = (key: string): IssueDetail => ({
        ...ref,
        key,
        displayKey: key,
        url: `https://work.atlassian.net/browse/${key}`,
        title: `Title of ${key}`,
        author: null,
        state: { name: "Open", category: "open" },
        createdAt: iso,
        updatedAt: iso,
        closedAt: null,
        assignees: [],
        labels: [],
        commentCount: 0,
        projectTitle: thread.title,
        writable: true,
        capabilities: {
          create: true,
          edit: true,
          comment: true,
          labels: true,
          assignees: true,
          reactions: false,
          templates: false,
          linkedPullRequests: true,
          events: true,
          search: true,
        },
        viewerPermissions: {
          setState: true,
          comment: true,
          edit: true,
          labels: true,
          assignees: true,
        },
        states: [],
        viewer: null,
        body: "",
        comments: [],
        commentsCursor: null,
        events: [],
        linkedPullRequests: [],
      });
      const event = (
        id: string,
        role: "user" | "assistant",
        text: string,
        options: { streaming?: boolean; queued?: boolean } = {},
      ): OrchestrationV2DomainEvent => ({
        id: EventId.make(id),
        type: "message.updated",
        threadId: THREAD_ID,
        occurredAt: now,
        payload: {
          id: MessageId.make(id),
          threadId: THREAD_ID,
          runId: options.queued ? null : RunId.make("jira-mention-run"),
          nodeId: null,
          createdBy: role === "user" ? "user" : "agent",
          creationSource: role === "user" ? "web" : "provider",
          role,
          text,
          attachments: [],
          streaming: options.streaming ?? false,
          createdAt: now,
          updatedAt: now,
        },
      });
      const inputs: ThreadIssueService.LinkThreadIssueInput[] = [];
      const lookedUp: string[] = [];
      const events = Stream.fromIterable([
        event("queued", "user", "DEVX-10", { queued: true }),
        event("streaming", "assistant", "DEVX-20", { streaming: true }),
        event("sent", "user", "Please check DEVX-1, DEVX-1 and DEVX-3."),
        event(
          "answered",
          "assistant",
          "See [DEVX-2](https://work.atlassian.net/browse/DEVX-2), plus https://other.atlassian.net/browse/DEVX-4.",
        ),
        event("answered", "assistant", "https://other.atlassian.net/browse/DEVX-4"),
        event("many", "user", Array.from({ length: 11 }, (_, i) => `DEVX-${100 + i}`).join(" ")),
      ]).pipe(Stream.concat(Stream.fromEffectDrain(Deferred.succeed(completed, undefined))));
      const unavailable = new IssueOperationError({
        operation: "detail",
        reason: "not-found",
        detail: "Not available on the connected Jira site.",
      });
      const dependencies = Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({
          streamDomainEvents: events,
          getThreadRecords: () => Effect.succeed(idleThreadProjection(liveThreadShell(THREAD_ID))),
        }),
        Layer.mock(IssueService)({
          projectScope: () => Effect.succeed(ref),
          detail: (input) =>
            Effect.sync(() => lookedUp.push(input.key)).pipe(
              Effect.andThen(
                input.key === "DEVX-1"
                  ? Effect.succeed(issue(input.key))
                  : Effect.fail(unavailable),
              ),
            ),
          resolveUrl: (url, projectId) =>
            Effect.sync(() => {
              expect(projectId).toBe(thread.projectId);
              lookedUp.push(url);
            }).pipe(
              Effect.andThen(
                url === "https://work.atlassian.net/browse/DEVX-2"
                  ? Effect.succeed({
                      ...ref,
                      key: "DEVX-2",
                      writable: true,
                      issue: issue("DEVX-2"),
                    })
                  : Effect.fail(unavailable),
              ),
            ),
        }),
        Layer.mock(ThreadIssueService.ThreadIssueService)({
          link: (input) =>
            Effect.sync(() => {
              inputs.push(input);
              return { alreadyLinked: false };
            }),
        }),
      );
      yield* Deferred.await(completed).pipe(
        Effect.provide(ThreadIssueService.layerMentionObserver.pipe(Layer.provide(dependencies))),
      );
      expect(lookedUp).toEqual([
        "DEVX-1",
        "DEVX-3",
        "https://work.atlassian.net/browse/DEVX-2",
        "https://other.atlassian.net/browse/DEVX-4",
        ...Array.from({ length: 10 }, (_, i) => `DEVX-${100 + i}`),
      ]);
      expect(inputs.map(({ ref, source, title }) => [ref.key, source, title])).toEqual([
        ["DEVX-1", "automatic", "Title of DEVX-1"],
        ["DEVX-2", "automatic", "Title of DEVX-2"],
      ]);
    }),
  );

  it.effect("fails an unlink whose thread cannot be read instead of reporting it unlinked", () =>
    Effect.gen(function* () {
      const service = yield* ThreadIssueService.ThreadIssueService;
      const error = yield* service
        .unlink({
          threadId: THREAD_ID,
          key: {
            tracker: IssueTrackerKind.make("github"),
            host: "github.com",
            scope: "t3tools/t3code",
            key: "7",
          },
        })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "OrchestratorProjectionError", threadId: THREAD_ID });
    }).pipe(
      Effect.provide(
        ThreadIssueService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              SqlitePersistence.layerMemory,
              Layer.mock(Orchestrator.OrchestratorV2)({
                getThreadShell: (threadId) =>
                  Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId })),
              }),
              Layer.succeed(
                SecureRandom.SecureRandom,
                SecureRandom.make((size) => new Uint8Array(size).fill(7)),
              ),
            ),
          ),
        ),
      ),
    ),
  );
});
