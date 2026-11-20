import { expect, it } from "vite-plus/test";

import { unofferedIssueFilters } from "./issueListFilters";

it("keeps the picks the listed scopes no longer offer", () => {
  const offered = {
    labels: [{ name: "bug" }],
    issueTypes: ["Task"],
    assignees: [{ login: "alice" }, { login: "Bob", id: "jira-2", tracker: "jira" as const }],
  };
  expect(
    unofferedIssueFilters(
      {
        labels: ["bug", "gone"],
        issueTypes: ["Task", "Bug"],
        assignee: { login: "Bob", name: "Bob", accountId: "jira-1" },
      },
      offered,
    ),
  ).toEqual({
    labels: ["gone"],
    issueTypes: ["Bug"],
    assignee: { login: "Bob", name: "Bob", accountId: "jira-1" },
  });
  expect(
    unofferedIssueFilters(
      { labels: ["bug"], issueTypes: [], assignee: { login: "alice", name: null } },
      offered,
    ),
  ).toEqual({ labels: [], issueTypes: [], assignee: null });
});
