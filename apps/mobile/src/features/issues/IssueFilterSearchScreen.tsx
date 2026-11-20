import { useAtom } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { IssueCandidatesTarget } from "@t3tools/client-runtime/state/issues";
import { useGT } from "gt-react-native";
import { useState } from "react";

import { refreshIssueFilterCandidates, useIssueFilterCandidates } from "../../state/issues";
import { useDebouncedValue } from "../../state/queries";
import { PullRequestLabelDot } from "../pull-requests/PullRequestLabelDot";
import { PullRequestAvatar } from "../pull-requests/PullRequestPresentation";
import { pullRequestLabelColor } from "../pull-requests/pullRequestList";
import { IssueCandidatesSheet } from "./IssueCandidatesSheet";
import { issueListFiltersAtom, unofferedIssueFilters } from "./issueListFilters";

const matches = (needle: string, ...fields: ReadonlyArray<string | null | undefined>) =>
  needle.length === 0 || fields.some((field) => field?.toLowerCase().includes(needle));

export function IssueFilterSearchScreen({
  route,
}: StaticScreenProps<{
  readonly kind: "labels" | "assignee" | "issue-types";
  readonly scopes: ReadonlyArray<IssueCandidatesTarget>;
}>) {
  const gt = useGT();
  const navigation = useNavigation();
  const { kind, scopes } = route.params;
  const [filters, setFilters] = useAtom(issueListFiltersAtom);
  const [query, setQuery] = useState("");
  const [pageCount, setPageCount] = useState(1);
  const term = query.trim().slice(0, 200);
  const needle = term.toLowerCase();
  const debouncedQuery = useDebouncedValue(term, 300);
  const labels = kind === "labels";
  const issueTypes = kind === "issue-types";
  const hasJira = scopes.some(({ input }) => String(input.tracker) === "jira");
  const targets = scopes.flatMap((scope): ReadonlyArray<IssueCandidatesTarget> => {
    if (String(scope.input.tracker) !== "jira") return issueTypes ? [] : [scope];
    return Array.from({ length: pageCount }, (_, page) => ({
      ...scope,
      input: {
        ...scope.input,
        kind: kind === "assignee" ? "assignees" : kind,
        ...(!issueTypes && debouncedQuery ? { query: debouncedQuery } : {}),
        ...(page > 0 ? { offset: page * 100 } : {}),
      },
    }));
  });
  const known = useIssueFilterCandidates(targets);
  const selectedAssignee = filters.assignee?.accountId ?? filters.assignee?.login;
  const unoffered = unofferedIssueFilters(filters, known);
  const labelCandidates = [
    ...unoffered.labels.map((name) => ({ name, description: null, color: null })),
    ...known.labels,
  ];
  const exactLabel =
    labels &&
    hasJira &&
    term !== "" &&
    !/\s/.test(term) &&
    !labelCandidates.some((label) => label.name === term);
  const assigneeCandidates = [
    ...(unoffered.assignee
      ? [
          {
            ...unoffered.assignee,
            id: unoffered.assignee.accountId,
            tracker: unoffered.assignee.accountId ? "jira" : undefined,
            avatarUrl: null,
          },
        ]
      : []),
    ...known.assignees,
  ];
  const candidates = labels
    ? [
        ...labelCandidates
          .filter((label) => matches(needle, label.name, label.description))
          .map((label) => ({
            key: label.name,
            title: label.name,
            ...(label.description ? { subtitle: label.description } : {}),
            leading: <PullRequestLabelDot color={pullRequestLabelColor(label.color)} />,
            selected: filters.labels.includes(label.name),
          })),
        ...(exactLabel
          ? [{ key: term, title: gt('Use label "{name}"', { name: term }), selected: false }]
          : []),
      ]
    : issueTypes
      ? [...unoffered.issueTypes, ...known.issueTypes]
          .filter((name) => matches(needle, name))
          .map((name) => ({ key: name, title: name, selected: filters.issueTypes.includes(name) }))
      : assigneeCandidates
          .filter(
            (actor) =>
              (actor.tracker === "jira" && term === debouncedQuery) ||
              matches(needle, actor.login, actor.name),
          )
          .map((actor) => ({
            key: actor.tracker === "jira" ? (actor.id ?? actor.login) : actor.login,
            title: actor.login,
            ...(actor.name && actor.name !== actor.login ? { subtitle: actor.name } : {}),
            leading: <PullRequestAvatar actor={actor} size={24} />,
            selected: selectedAssignee === (actor.tracker === "jira" ? actor.id : actor.login),
          }));
  const pending = known.isPending || (hasJira && !issueTypes && term !== debouncedQuery);
  return (
    <IssueCandidatesSheet
      title={
        labels
          ? gt("Filter by label")
          : issueTypes
            ? gt("Filter by issue type")
            : gt("Filter by assignee")
      }
      noun={labels ? "labels" : issueTypes ? "issue-types" : "people"}
      query={query}
      onQueryChange={(value) => {
        setQuery(value);
        setPageCount(1);
      }}
      candidates={candidates}
      allowed
      notice={candidates.length > 0 ? known.error : null}
      pending={pending}
      loadError={known.error}
      onRetry={() => refreshIssueFilterCandidates(targets)}
      truncated={known.truncated}
      onLoadMore={known.hasMore && !pending ? () => setPageCount(pageCount + 1) : undefined}
      onToggle={(key) => {
        if (labels || issueTypes) {
          const field = labels ? "labels" : "issueTypes";
          const selected = filters[field];
          setFilters({
            ...filters,
            [field]: selected.includes(key)
              ? selected.filter((name) => name !== key)
              : [...selected, key].slice(0, 20),
          });
          return;
        }
        const actor = known.assignees.find(
          (candidate) => (candidate.tracker === "jira" ? candidate.id : candidate.login) === key,
        );
        setFilters({
          ...filters,
          assignee:
            selectedAssignee === key || !actor
              ? null
              : {
                  login: actor.login,
                  name: actor.name,
                  ...(actor.tracker === "jira" && actor.id ? { accountId: actor.id } : {}),
                },
        });
        navigation.goBack();
      }}
    />
  );
}
