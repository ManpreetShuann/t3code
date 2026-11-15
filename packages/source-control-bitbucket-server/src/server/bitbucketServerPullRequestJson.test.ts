import * as Result from "effect/Result";
import { assert, describe, expect, it } from "vite-plus/test";

import {
  bitbucketServerCommentAnchor,
  decodeActivitiesJson,
  decodeCommentVersionJson,
  decodeParticipantSlugJson,
  decodeUserSlugJson,
  decodeUsersPageJson,
  decodeBuildStatsJson,
  decodeBuildStatusesJson,
  decodeChangesPageJson,
  withholdTruncatedPatch,
  decodeCommitParentJson,
  decodeCommitsJson,
  decodeMergeCheckJson,
  decodePullRequestJson,
  decodePullRequestPageJson,
  decodeRepositoryPermissionJson,
  normalizeUnifiedDiff,
} from "./bitbucketServerPullRequestJson.ts";

const PR_URL = "https://bitbucket.example.com/users/jdoe/repos/testing-repo/pull-requests/2";

/** Captured from a Data Center 9.4 host; the token's account is a repository access token. */
const tokenUser = {
  name: "access-token-user/2/11754",
  active: true,
  displayName: "Access Token User - Doe, Jane testing-repo",
  id: 59666,
  slug: "access-token-user_2_11754",
  type: "SERVICE",
  links: { self: [{ href: "https://bitbucket.example.com/bots/access-token-user_2_11754" }] },
};

const jdoe = {
  name: "jdoe",
  emailAddress: "jane.doe@example.com",
  active: true,
  displayName: "Doe, Jane",
  id: 30567,
  slug: "jdoe",
  type: "NORMAL",
  links: { self: [{ href: "https://bitbucket.example.com/users/jdoe" }] },
};

const repository = {
  slug: "testing-repo",
  id: 11754,
  name: "testing-repo",
  scmId: "git",
  state: "AVAILABLE",
  project: { key: "~JDOE", id: 277, name: "Doe, Jane", type: "PERSONAL" },
};

const pullRequest = {
  id: 2,
  version: 1,
  title: "Live verification PR",
  description: "Created by the T3 Code Data Center adapter (live verification).",
  state: "OPEN",
  open: true,
  closed: false,
  draft: false,
  createdDate: 1789242749816,
  updatedDate: 1789245012563,
  closedDate: null,
  fromRef: {
    id: "refs/heads/feature/dc-live",
    displayId: "feature/dc-live",
    latestCommit: "5e8770617aea7591ffda6a0fbe82149cf9a739a8",
    type: "BRANCH",
    repository,
  },
  toRef: {
    id: "refs/heads/main",
    displayId: "main",
    latestCommit: "a35a529320a97c51808f6647eb1f59518371b3e9",
    type: "BRANCH",
    repository,
  },
  locked: false,
  author: { user: tokenUser, role: "AUTHOR", approved: false, status: "UNAPPROVED" },
  reviewers: [{ user: jdoe, role: "REVIEWER", approved: false, status: "UNAPPROVED" }],
  participants: [],
  properties: null,
  links: { self: [{ href: PR_URL }] },
};

function page(values: ReadonlyArray<unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    size: values.length,
    limit: 25,
    isLastPage: true,
    start: 0,
    values,
    ...extra,
  });
}

function success<A>(result: Result.Result<A, unknown>): A {
  assert.isTrue(Result.isSuccess(result));
  return (result as Result.Success<A, unknown>).success;
}

describe("decodePullRequestJson", () => {
  it("reads the account name as the login, and reviewers as review requests", () => {
    const decoded = success(decodePullRequestJson(JSON.stringify(pullRequest)));

    expect(decoded).toEqual({
      number: 2,
      version: 1,
      title: "Live verification PR",
      url: PR_URL,
      author: {
        login: "access-token-user/2/11754",
        name: "Access Token User - Doe, Jane testing-repo",
        avatarUrl: null,
      },
      headBranch: "feature/dc-live",
      headCommit: "5e8770617aea7591ffda6a0fbe82149cf9a739a8",
      headRepositoryNameWithOwner: "~JDOE/testing-repo",
      baseBranch: "main",
      state: "open",
      isDraft: false,
      createdAt: "2026-09-12T19:52:29.816Z",
      updatedAt: "2026-09-12T20:30:12.563Z",
      closedAt: null,
      body: "Created by the T3 Code Data Center adapter (live verification).",
      reviewers: [{ login: "jdoe", name: "Doe, Jane", avatarUrl: null }],
      reviewRequestLogins: ["jdoe"],
    });
  });

  it("maps DECLINED to closed with its closing instant, and honours the draft flag", () => {
    const decoded = success(
      decodePullRequestJson(
        JSON.stringify({
          ...pullRequest,
          state: "DECLINED",
          draft: true,
          closedDate: 1789245100000,
        }),
      ),
    );

    expect(decoded.state).toBe("closed");
    expect(decoded.isDraft).toBe(true);
    expect(decoded.closedAt).toBe("2026-09-12T20:31:40.000Z");
  });

  it("skips a malformed row on a page and reports the next offset", () => {
    const decoded = success(
      decodePullRequestPageJson(
        page([pullRequest, { id: "not a pull request" }], { isLastPage: false, nextPageStart: 25 }),
      ),
    );

    expect(decoded.items.map((item) => item.number)).toEqual([2]);
    expect(decoded.rawCount).toBe(2);
    expect(decoded.nextPageStart).toBe(25);
  });
});

describe("decodeRepositoryPermissionJson", () => {
  it("grants only when the row names this project and slug, whatever the case", () => {
    const locator = { projectKey: "~jdoe", repoSlug: "testing-repo" };
    expect(success(decodeRepositoryPermissionJson(page([repository]), locator)).granted).toBe(true);
    expect(
      success(
        decodeRepositoryPermissionJson(
          page([{ ...repository, project: { key: "OTHER" } }]),
          locator,
        ),
      ).granted,
    ).toBe(false);
    expect(success(decodeRepositoryPermissionJson(page([]), locator)).granted).toBe(false);
  });
});

describe("decodeMergeCheckJson", () => {
  it("reads a conflict as conflicting and any other veto as a mergeable branch", () => {
    expect(
      success(
        decodeMergeCheckJson(
          JSON.stringify({ canMerge: true, conflicted: false, outcome: "CLEAN", vetoes: [] }),
        ),
      ),
    ).toBe("mergeable");
    expect(
      success(
        decodeMergeCheckJson(
          JSON.stringify({
            canMerge: false,
            conflicted: false,
            outcome: "UNKNOWN",
            vetoes: [{ summaryMessage: "Requires approvals" }],
          }),
        ),
      ),
    ).toBe("mergeable");
    expect(
      success(
        decodeMergeCheckJson(JSON.stringify({ canMerge: false, conflicted: true, vetoes: [] })),
      ),
    ).toBe("conflicting");
  });
});

describe("decodeActivitiesJson", () => {
  const anchor = {
    fromHash: "a35a529320a97c51808f6647eb1f59518371b3e9",
    toHash: "5e8770617aea7591ffda6a0fbe82149cf9a739a8",
    line: 1,
    lineType: "ADDED",
    fileType: "TO",
    path: "LIVE.md",
    diffType: "EFFECTIVE",
    orphaned: false,
  };
  const comment = (
    id: number,
    text: string,
    createdDate: number,
    extra: Record<string, unknown> = {},
  ) => ({
    properties: { repositoryId: 11754 },
    id,
    version: 0,
    text,
    author: tokenUser,
    createdDate,
    updatedDate: createdDate,
    comments: [],
    threadResolved: false,
    severity: "NORMAL",
    state: "OPEN",
    permittedOperations: { editable: true, transitionable: true, deletable: true },
    ...extra,
  });
  const activities = [
    {
      id: 3798424,
      createdDate: 1789245012573,
      user: tokenUser,
      action: "UPDATED",
      addedReviewers: [jdoe],
      removedReviewers: [],
    },
    {
      id: 3798420,
      createdDate: 1789244976383,
      user: tokenUser,
      action: "COMMENTED",
      commentAction: "ADDED",
      comment: comment(211902, "Inline fixture comment on line 1", 1789244976377, {
        anchor,
        comments: [
          comment(211904, "Reply to the inline fixture comment", 1789245011190, { anchor }),
        ],
      }),
      commentAnchor: anchor,
    },
    {
      id: 3798421,
      createdDate: 1789244977595,
      user: tokenUser,
      action: "COMMENTED",
      commentAction: "ADDED",
      comment: comment(211903, "Task fixture comment", 1789244977593, { severity: "BLOCKER" }),
    },
    {
      id: 3798419,
      createdDate: 1789244975716,
      user: tokenUser,
      action: "COMMENTED",
      commentAction: "ADDED",
      comment: comment(211901, "General fixture comment", 1789244975713),
    },
    { id: 3798409, createdDate: 1789242750427, user: tokenUser, action: "OPENED" },
  ];

  it("flattens roots and nested replies into comments, and anchors threads to file and line", () => {
    const decoded = success(decodeActivitiesJson(page(activities), PR_URL));
    const comments = decoded.items.flatMap((item) => item.comments);
    const threads = decoded.items.flatMap((item) => item.threads);

    expect(comments.map((entry) => [entry.id, entry.kind, entry.path])).toEqual([
      ["211902", "review-comment", "LIVE.md"],
      ["211904", "review-comment", "LIVE.md"],
      ["211903", "issue-comment", null],
      ["211901", "issue-comment", null],
    ]);
    expect(comments[0]?.url).toBe(`${PR_URL}/overview?commentId=211902`);
    // A task is a comment with a severity, and nothing in the conversation is hidden.
    expect(comments[2]?.body).toBe("Task fixture comment");
    // Every general root opens a thread too, so it can be replied to and resolved.
    expect(
      threads.map((thread) => [thread.id, thread.path, thread.line, thread.isResolved]),
    ).toEqual([
      ["211902", "LIVE.md", 1, false],
      ["211903", null, null, false],
      ["211901", null, null, false],
    ]);
    expect(threads.filter((thread) => thread.path !== null)).toEqual([
      {
        id: "211902",
        path: "LIVE.md",
        line: 1,
        side: "right",
        isResolved: false,
        isOutdated: false,
        comments: [
          {
            id: "211902",
            author: {
              login: "access-token-user/2/11754",
              name: "Access Token User - Doe, Jane testing-repo",
              avatarUrl: null,
            },
            body: "Inline fixture comment on line 1",
            createdAt: "2026-09-12T20:29:36.377Z",
            url: `${PR_URL}/overview?commentId=211902`,
          },
          {
            id: "211904",
            author: {
              login: "access-token-user/2/11754",
              name: "Access Token User - Doe, Jane testing-repo",
              avatarUrl: null,
            },
            body: "Reply to the inline fixture comment",
            createdAt: "2026-09-12T20:30:11.190Z",
            url: `${PR_URL}/overview?commentId=211904`,
          },
        ],
      },
    ]);
  });

  it("pins a removed-side comment to the left at its old path, and marks orphaned and resolved threads", () => {
    const decoded = success(
      decodeActivitiesJson(
        page([
          {
            id: 1,
            createdDate: 1789244976383,
            user: tokenUser,
            action: "COMMENTED",
            commentAction: "ADDED",
            comment: comment(10, "Gone", 1789244976377, {
              anchor: {
                ...anchor,
                line: 4,
                lineType: "REMOVED",
                fileType: "FROM",
                srcPath: "OLD.md",
                orphaned: true,
              },
              state: "RESOLVED",
            }),
          },
        ]),
        PR_URL,
      ),
    );

    // A comment on the removed side of a renamed file belongs to the name the file had.
    expect(decoded.items[0]?.comments[0]?.path).toBe("OLD.md");
    expect(decoded.items[0]?.threads[0]).toMatchObject({
      path: "OLD.md",
      line: 4,
      side: "left",
      isResolved: true,
      isOutdated: true,
    });
  });

  it("resolves a task's thread by the task, and points uploads at the repository's attachments", () => {
    const entry = (id: number, extra: Record<string, unknown>) => ({
      id,
      createdDate: 1789244976383,
      user: tokenUser,
      action: "COMMENTED",
      commentAction: "ADDED",
      comment: comment(id, "See ![shot.png](attachment:11754/220976)", 1789244976377, extra),
    });
    const decoded = success(
      decodeActivitiesJson(
        page([
          entry(1, { severity: "BLOCKER", state: "RESOLVED" }),
          entry(2, { severity: "BLOCKER", threadResolved: true }),
          entry(3, { threadResolved: true }),
        ]),
        PR_URL,
      ),
    );

    expect(decoded.items.map((item) => item.threads[0]?.isResolved)).toEqual([true, false, true]);
    expect(decoded.items[0]?.threads[0]?.comments[0]?.body).toBe(
      "See ![shot.png](https://bitbucket.example.com/rest/api/latest/projects/~jdoe/repos/testing-repo/attachments/220976)",
    );
    expect(decoded.items[0]?.comments[0]?.body).toBe(
      decoded.items[0]?.threads[0]?.comments[0]?.body,
    );
  });

  it("reads verdict activities as reviews and ignores the rest of the feed", () => {
    const decoded = success(
      decodeActivitiesJson(
        page([
          { id: 5, createdDate: 1789245100000, user: jdoe, action: "APPROVED" },
          { id: 6, createdDate: 1789245200000, user: jdoe, action: "REVIEWED" },
          { id: 7, createdDate: 1789245300000, user: jdoe, action: "UNAPPROVED" },
          { id: 8, createdDate: 1789245400000, user: jdoe, action: "RESCOPED" },
        ]),
        PR_URL,
      ),
    );

    expect(
      decoded.items.flatMap((item) => item.comments).map((entry) => [entry.id, entry.reviewState]),
    ).toEqual([
      ["activity:5", "approved"],
      ["activity:6", "changes_requested"],
      ["activity:7", "dismissed"],
    ]);
  });
});

describe("decodeCommitsJson", () => {
  it("reads the committer instant and the author account", () => {
    const decoded = success(
      decodeCommitsJson(
        JSON.stringify({
          values: [
            {
              id: "5e8770617aea7591ffda6a0fbe82149cf9a739a8",
              displayId: "5e8770617ae",
              author: jdoe,
              authorTimestamp: 1789242570000,
              committer: jdoe,
              committerTimestamp: 1789242570000,
              message: "Live verification branch\n\nWith a body.",
              parents: [
                { id: "a35a529320a97c51808f6647eb1f59518371b3e9", displayId: "a35a529320a" },
              ],
            },
          ],
          size: 1,
          isLastPage: true,
          start: 0,
          limit: 25,
          nextPageStart: null,
        }),
      ),
    );

    expect(decoded.items).toEqual([
      {
        oid: "5e8770617aea7591ffda6a0fbe82149cf9a739a8",
        messageHeadline: "Live verification branch",
        committedDate: "2026-09-12T19:49:30.000Z",
        authors: [{ login: "jdoe", name: "Doe, Jane", avatarUrl: null }],
      },
    ]);
    expect(decoded.nextPageStart).toBeNull();
  });
});

describe("decodeBuildStatusesJson", () => {
  it("maps build states and keeps the newest run under a reused key", () => {
    const decoded = success(
      decodeBuildStatusesJson(
        page([
          { state: "FAILED", key: "CI", name: "CI build", url: "https://ci/1", dateAdded: 1 },
          { state: "SUCCESSFUL", key: "CI", name: "CI build", url: "https://ci/2", dateAdded: 2 },
          { state: "INPROGRESS", key: "LINT", url: "https://ci/3", description: "Linting" },
        ]),
      ),
    );

    expect(decoded.items).toEqual([
      { name: "CI build", status: "success", description: null, url: "https://ci/2" },
      { name: "LINT", status: "pending", description: "Linting", url: "https://ci/3" },
    ]);
  });
});

describe("decodeCommitParentJson", () => {
  it("names the first parent, and none on a root commit", () => {
    expect(
      success(
        decodeCommitParentJson(
          JSON.stringify({ id: "5e87", parents: [{ id: "a35a" }, { id: "ffff" }] }),
        ),
      ),
    ).toBe("a35a");
    expect(success(decodeCommitParentJson(JSON.stringify({ id: "a35a", parents: [] })))).toBeNull();
  });
});

describe("normalizeUnifiedDiff", () => {
  it("rewrites Data Center's src:// and dst:// headers to git's a/ and b/", () => {
    const patch = [
      "diff --git src://LIVE.md dst://LIVE.md",
      "new file mode 100644",
      "index 0000000..e23fe64",
      "--- /dev/null",
      "+++ dst://LIVE.md",
      "@@ -0,0 +1,2 @@",
      "+live",
      "+++ dst://literal",
      "diff --git src://old.md dst://new.md",
      "rename from src://old.md",
      "rename to dst://new.md",
      "--- src://old.md",
      "+++ dst://new.md",
      "@@ -1,2 +1,2 @@",
      "-src://kept",
      "--- src://literal",
      "+dst://kept",
      "+++ dst://literal",
    ].join("\n");

    expect(normalizeUnifiedDiff(patch).split("\n")).toEqual([
      "diff --git a/LIVE.md b/LIVE.md",
      "new file mode 100644",
      "index 0000000..e23fe64",
      "--- /dev/null",
      "+++ b/LIVE.md",
      "@@ -0,0 +1,2 @@",
      "+live",
      "+++ dst://literal",
      "diff --git a/old.md b/new.md",
      "rename from old.md",
      "rename to new.md",
      "--- a/old.md",
      "+++ b/new.md",
      "@@ -1,2 +1,2 @@",
      "-src://kept",
      "--- src://literal",
      "+dst://kept",
      "+++ dst://literal",
    ]);
  });
});

describe("decodeBuildStatsJson", () => {
  it("rolls each commit's build counts up to one state, failures first", () => {
    const counts = (over: Record<string, number>) => ({
      successful: 0,
      failed: 0,
      inProgress: 0,
      cancelled: 0,
      unknown: 0,
      ...over,
    });
    const states = success(
      decodeBuildStatsJson(
        JSON.stringify({
          AAA: counts({ successful: 2, failed: 1, inProgress: 1 }),
          bbb: counts({ successful: 1, cancelled: 1 }),
          ccc: counts({ successful: 1, inProgress: 1 }),
          ddd: counts({ successful: 3 }),
          eee: counts({}),
        }),
      ),
    );
    expect([...states]).toEqual([
      ["aaa", "failing"],
      ["bbb", "failing"],
      ["ccc", "pending"],
      ["ddd", "passing"],
      ["eee", null],
    ]);
  });
});

describe("decodeChangesPageJson", () => {
  it("counts the files on a page and reports the next offset", () => {
    expect(
      success(
        decodeChangesPageJson(
          page(
            [
              { type: "ADD", path: { toString: "new.ts" } },
              { type: "MOVE", path: { toString: "to.ts" }, srcPath: { toString: "from.ts" } },
              { type: "MODIFY" },
            ],
            { isLastPage: false, nextPageStart: 3 },
          ),
        ),
      ),
    ).toEqual({
      count: 3,
      files: [
        { path: "new.ts", srcPath: null, type: "add" },
        { path: "to.ts", srcPath: "from.ts", type: "move" },
      ],
      nextPageStart: 3,
    });
    expect(success(decodeChangesPageJson(page([])))).toEqual({
      count: 0,
      files: [],
      nextPageStart: null,
    });
  });
});

describe("withholdTruncatedPatch", () => {
  it("drops the file the cut landed in and heads every file past it with no hunks", () => {
    const patch = [
      "diff --git a/kept.ts b/kept.ts",
      "--- a/kept.ts",
      "+++ b/kept.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "diff --git a/cut.ts b/cut.ts",
      "--- a/cut.ts",
      "+++ b/cut.ts",
      "@@ -1,9 +1,9 @@",
      "+partial",
    ].join("\n");
    const result = withholdTruncatedPatch(patch, [
      { path: "kept.ts", srcPath: null, type: "modify" },
      { path: "cut.ts", srcPath: null, type: "modify" },
      { path: "added.ts", srcPath: null, type: "add" },
      { path: "gone.ts", srcPath: null, type: "delete" },
      { path: "to.ts", srcPath: "from.ts", type: "move" },
    ]);

    expect(result.withheld).toEqual(["cut.ts", "added.ts", "gone.ts", "to.ts"]);
    expect(result.patch.split("\n")).toEqual([
      "diff --git a/kept.ts b/kept.ts",
      "--- a/kept.ts",
      "+++ b/kept.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "diff --git a/cut.ts b/cut.ts",
      "--- a/cut.ts",
      "+++ b/cut.ts",
      "diff --git a/added.ts b/added.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/added.ts",
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "--- a/gone.ts",
      "+++ /dev/null",
      "diff --git a/from.ts b/to.ts",
      "rename from from.ts",
      "rename to to.ts",
      "--- a/from.ts",
      "+++ b/to.ts",
      "",
    ]);
  });
});

describe("decodeUsersPageJson", () => {
  it("offers each account by name, skipping rows without one", () => {
    const decoded = decodeUsersPageJson(
      JSON.stringify({
        values: [
          { name: "ARoe", displayName: "Roe, Alex", slug: "aroe" },
          { displayName: "nameless" },
          jdoe,
        ],
        isLastPage: false,
        nextPageStart: 5,
      }),
    );

    assert.ok(Result.isSuccess(decoded));
    expect(decoded.success).toEqual({
      items: [
        {
          id: "ARoe",
          kind: "user",
          login: "ARoe",
          name: "Roe, Alex",
          avatarUrl: null,
        },
        { id: "jdoe", kind: "user", login: "jdoe", name: "Doe, Jane", avatarUrl: null },
      ],
      nextPageStart: 5,
      rawCount: 3,
    });
  });
});

describe("account slugs", () => {
  it("reads the slug off a user resource", () => {
    const decoded = decodeUserSlugJson(JSON.stringify(tokenUser));
    assert.ok(Result.isSuccess(decoded));
    expect(decoded.success).toBe("access-token-user_2_11754");
  });

  it("finds the named participant's slug and nobody else's", () => {
    const page = JSON.stringify({
      values: [
        { user: tokenUser, role: "AUTHOR", approved: false, status: "UNAPPROVED" },
        { user: jdoe, role: "REVIEWER", approved: false, status: "UNAPPROVED" },
      ],
      isLastPage: true,
    });

    const found = decodeParticipantSlugJson(page, "access-token-user/2/11754");
    assert.ok(Result.isSuccess(found));
    expect(found.success).toEqual({ slug: "access-token-user_2_11754", nextPageStart: null });

    const missing = decodeParticipantSlugJson(page, "nobody");
    assert.ok(Result.isSuccess(missing));
    expect(missing.success.slug).toBeNull();
  });
});

describe("decodeCommentVersionJson", () => {
  it("reads the version a rewrite must send back, and whether the comment is a task", () => {
    const decoded = decodeCommentVersionJson(
      JSON.stringify({ id: 211903, version: 3, text: "x", createdDate: 1789244977593 }),
    );
    assert.ok(Result.isSuccess(decoded));
    expect(decoded.success).toEqual({ version: 3, isTask: false });
    const task = decodeCommentVersionJson(
      JSON.stringify({ id: 1, version: 0, severity: "BLOCKER", createdDate: 1 }),
    );
    assert.ok(Result.isSuccess(task));
    expect(task.success.isTask).toBe(true);
  });
});

describe("bitbucketServerCommentAnchor", () => {
  it("counts an added line on the TO side and a removed one on the FROM side", () => {
    expect(
      bitbucketServerCommentAnchor({
        path: "LIVE.md",
        position: { kind: "added", newLine: 4 },
        body: "x",
      }),
    ).toEqual({
      line: 4,
      lineType: "ADDED",
      fileType: "TO",
      path: "LIVE.md",
      diffType: "EFFECTIVE",
    });
    expect(
      bitbucketServerCommentAnchor({
        path: "LIVE.md",
        position: { kind: "deleted", oldLine: 9 },
        body: "x",
      }),
    ).toEqual({
      line: 9,
      lineType: "REMOVED",
      fileType: "FROM",
      path: "LIVE.md",
      diffType: "EFFECTIVE",
    });
  });

  it("anchors a context line to whichever side was selected, naming both paths of a rename", () => {
    expect(
      bitbucketServerCommentAnchor({
        path: "new.md",
        oldPath: "old.md",
        position: { kind: "context", oldLine: 2, newLine: 3, side: "left" },
        body: "x",
      }),
    ).toEqual({
      line: 2,
      lineType: "CONTEXT",
      fileType: "FROM",
      path: "new.md",
      srcPath: "old.md",
      diffType: "EFFECTIVE",
    });
    expect(
      bitbucketServerCommentAnchor({
        path: "new.md",
        position: { kind: "context", oldLine: 2, newLine: 3, side: "right" },
        body: "x",
      }).line,
    ).toBe(3);
  });
});
