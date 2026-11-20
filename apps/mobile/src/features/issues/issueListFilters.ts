import { Atom } from "effect/reactivity";

export interface IssueListFilters {
  readonly labels: ReadonlyArray<string>;
  readonly issueTypes: ReadonlyArray<string>;
  /** Kept with the name the picker showed, so the chip can say who without the candidates. */
  readonly assignee: {
    readonly login: string;
    readonly name: string | null;
    readonly accountId?: string;
  } | null;
}

export const issueListFiltersAtom = Atom.make<IssueListFilters>({
  labels: [],
  issueTypes: [],
  assignee: null,
}).pipe(Atom.keepAlive, Atom.withLabel("mobile:issues:list-filters"));

/** The picker keeps selected filters visible even when the tracker omits them. */
export function unofferedIssueFilters(
  filters: IssueListFilters,
  offered: {
    readonly labels: ReadonlyArray<{ readonly name: string }>;
    readonly issueTypes: ReadonlyArray<string>;
    readonly assignees: ReadonlyArray<{
      readonly login: string;
      readonly id?: string;
      readonly tracker?: "jira";
    }>;
  },
): IssueListFilters {
  return {
    labels: filters.labels.filter((name) => !offered.labels.some((label) => label.name === name)),
    issueTypes: filters.issueTypes.filter((name) => !offered.issueTypes.includes(name)),
    assignee: offered.assignees.some((actor) =>
      actor.tracker === "jira"
        ? actor.id === filters.assignee?.accountId
        : !filters.assignee?.accountId && actor.login === filters.assignee?.login,
    )
      ? null
      : filters.assignee,
  };
}
