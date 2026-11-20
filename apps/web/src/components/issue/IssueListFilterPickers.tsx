import {
  issueInvolvementSelected,
  toggleIssueInvolvement,
} from "@t3tools/client-runtime/issue-list";
import type { IssueCandidatesTarget } from "@t3tools/client-runtime/state/issues";
import type {
  EnvironmentId,
  IssueInvolvement,
  IssueListState,
  ProjectId,
} from "@t3tools/contracts";
import {
  FolderGit2Icon,
  LayersIcon,
  ListChecksIcon,
  ListFilterIcon,
  TagIcon,
  UserIcon,
} from "lucide-react";
import { T, useGT } from "gt-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSearchInput,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { useIssueFilterCandidates } from "~/state/issues";
import { useDebouncedValue } from "~/state/queries";

import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";

import {
  PullRequestFilterRadioSubmenu,
  pullRequestProjectKey,
  type PullRequestFilterOption,
} from "../pullRequest/PullRequestListFilters";
import { pullRequestLabelColor } from "../pullRequest/pullRequestList.logic";
import {
  issueFilterAssigneeChoices,
  issueFilterLabelChoices,
  matchesIssueFilterQuery,
} from "./IssueListFilterPickers.logic";

const VISIBLE_CHOICES = 30;
const CANDIDATE_QUERY_LIMIT = 200;

/** Every issue list filter behind one button, as the pull request page keeps its own. */
export function IssueFiltersMenu(props: {
  state: IssueListState;
  stateOptions: ReadonlyArray<PullRequestFilterOption<IssueListState>>;
  onState: (state: IssueListState) => void;
  involvement: IssueInvolvement;
  involvementOptions: ReadonlyArray<PullRequestFilterOption<IssueInvolvement>>;
  onInvolvement: (involvement: IssueInvolvement) => void;
  scopes: ReadonlyArray<IssueCandidatesTarget>;
  labels: ReadonlyArray<string>;
  onLabels: (labels: ReadonlyArray<string>) => void;
  issueTypes: ReadonlyArray<string>;
  onIssueTypes: (types: ReadonlyArray<string>) => void;
  assignee: string | undefined;
  assigneeId: string | undefined;
  onAssignee: (assignee: string | undefined, assigneeId: string | undefined) => void;
  projects: ReadonlyArray<ProjectFaviconProject & { readonly id: ProjectId }>;
  hiddenProjects: ReadonlySet<string>;
  onHiddenProjects: (hidden: ReadonlyArray<readonly [EnvironmentId, ProjectId]>) => void;
}) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const count = [
    props.state !== "open",
    props.involvement !== "all",
    props.hiddenProjects.size > 0,
    props.assignee ?? props.assigneeId,
    ...props.issueTypes,
    ...props.labels,
  ].filter(Boolean).length;
  // Read when the menu opens, not with every listing: one request per scope.
  const scopes = open ? props.scopes : [];
  const jiraScopes = scopes.filter(({ input }) => input.tracker === "jira");
  const multipleInvolvement =
    props.scopes.some(({ input }) => input.tracker === "jira") ||
    props.involvement === "assigned-or-authored";
  return (
    <Menu onOpenChange={setOpen}>
      <MenuTrigger render={<Button variant="outline" />}>
        <ListFilterIcon className="size-4" />
        <span>
          <T>Filters</T>
        </span>
        {count > 0 ? (
          <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground tabular-nums">
            {count}
          </span>
        ) : null}
      </MenuTrigger>
      <MenuPopup align="end" side="bottom">
        <PullRequestFilterRadioSubmenu
          label={gt("State", { $context: "issue state filter" })}
          value={props.state}
          options={props.stateOptions}
          onChange={props.onState}
        />
        {multipleInvolvement ? (
          <MenuSub>
            <MenuSubTrigger>
              <UserIcon aria-hidden className="size-3.5" />
              <span className="flex-1">{gt("Involvement")}</span>
              <span className="min-w-0 max-w-32 truncate text-xs text-muted-foreground">
                {props.involvementOptions
                  .filter(({ value }) => issueInvolvementSelected(props.involvement, value))
                  .map(({ label }) => label)
                  .join(", ")}
              </span>
            </MenuSubTrigger>
            <MenuSubPopup>
              {props.involvementOptions.map((option) => (
                <MenuCheckboxItem
                  key={option.value}
                  closeOnClick={false}
                  checked={issueInvolvementSelected(props.involvement, option.value)}
                  onCheckedChange={() =>
                    props.onInvolvement(toggleIssueInvolvement(props.involvement, option.value))
                  }
                >
                  <span className="flex items-center gap-2">
                    <option.Icon aria-hidden className="size-3.5" />
                    {option.label}
                  </span>
                </MenuCheckboxItem>
              ))}
            </MenuSubPopup>
          </MenuSub>
        ) : (
          <PullRequestFilterRadioSubmenu
            label={gt("Involvement")}
            value={props.involvement}
            options={props.involvementOptions}
            onChange={props.onInvolvement}
          />
        )}
        {props.projects.length > 0 || props.hiddenProjects.size > 0 ? (
          <MenuSub>
            <MenuSubTrigger>
              <FolderGit2Icon aria-hidden className="size-3.5" />
              <span className="flex-1">{gt("Projects")}</span>
              <span className="min-w-0 max-w-32 truncate text-xs text-muted-foreground">
                {props.hiddenProjects.size === 0
                  ? gt("All projects")
                  : gt("{hidden} hidden", { hidden: props.hiddenProjects.size })}
              </span>
            </MenuSubTrigger>
            <MenuSubPopup>
              <ProjectChoices
                projects={props.projects}
                hidden={props.hiddenProjects}
                onChange={props.onHiddenProjects}
              />
            </MenuSubPopup>
          </MenuSub>
        ) : null}
        <MenuSeparator />
        <MenuSub>
          <MenuSubTrigger>
            <TagIcon aria-hidden className="size-3.5" />
            <span className="flex-1">
              <T>Labels</T>
            </span>
            <span className="min-w-0 max-w-32 truncate text-xs text-muted-foreground">
              {props.labels.length === 0
                ? gt("Any", { $context: "no label filter" })
                : props.labels.length === 1
                  ? props.labels[0]
                  : gt("{count, plural, one {{count} label} other {{count} labels}}", {
                      count: props.labels.length,
                    })}
            </span>
          </MenuSubTrigger>
          <MenuSubPopup>
            <LabelChoices scopes={scopes} value={props.labels} onChange={props.onLabels} />
          </MenuSubPopup>
        </MenuSub>
        {props.scopes.some(({ input }) => input.tracker === "jira") ||
        props.issueTypes.length > 0 ? (
          <MenuSub>
            <MenuSubTrigger>
              <ListChecksIcon aria-hidden className="size-3.5" />
              <span className="flex-1">
                <T>Issue types</T>
              </span>
              <span className="min-w-0 max-w-32 truncate text-xs text-muted-foreground">
                {props.issueTypes.join(", ") || gt("Any", { $context: "no issue type filter" })}
              </span>
            </MenuSubTrigger>
            <MenuSubPopup>
              <IssueTypeChoices
                scopes={jiraScopes}
                value={props.issueTypes}
                onChange={props.onIssueTypes}
              />
            </MenuSubPopup>
          </MenuSub>
        ) : null}
        <MenuSub>
          <MenuSubTrigger>
            <UserIcon aria-hidden className="size-3.5" />
            <span className="flex-1">
              <T>Assignee</T>
            </span>
            <span className="min-w-0 max-w-32 truncate text-xs text-muted-foreground">
              {props.assignee ??
                props.assigneeId ??
                gt("Anyone", { $context: "no assignee filter" })}
            </span>
          </MenuSubTrigger>
          <MenuSubPopup>
            <AssigneeChoices
              scopes={scopes}
              value={props.assignee}
              id={props.assigneeId}
              onChange={props.onAssignee}
            />
          </MenuSubPopup>
        </MenuSub>
      </MenuPopup>
    </Menu>
  );
}

function ProjectChoices(props: {
  projects: ReadonlyArray<ProjectFaviconProject & { readonly id: ProjectId }>;
  hidden: ReadonlySet<string>;
  onChange: (hidden: ReadonlyArray<readonly [EnvironmentId, ProjectId]>) => void;
}) {
  const gt = useGT();
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const visible = props.projects.filter((project) =>
    matchesIssueFilterQuery(needle, project.title),
  );
  const pairsOf = (keys: Iterable<string>) =>
    [...keys].map((key) => JSON.parse(key) as readonly [EnvironmentId, ProjectId]);
  const allShown = props.hidden.size === 0;
  return (
    <>
      {props.projects.length > 8 ? (
        <MenuSearchInput
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder={gt("Search projects")}
          aria-label={gt("Search projects")}
        />
      ) : null}
      <MenuCheckboxItem
        checked={allShown}
        onCheckedChange={(shown) =>
          props.onChange(
            shown ? [] : pairsOf(props.projects.map((project) => pullRequestProjectKey(project))),
          )
        }
      >
        <span className="flex min-w-0 items-center gap-2">
          <LayersIcon aria-hidden className="size-3.5" />
          <span className="min-w-0 flex-1 truncate">{gt("Show all")}</span>
        </span>
      </MenuCheckboxItem>
      <MenuSeparator />
      {visible.length === 0 ? <MenuItem disabled>{gt("No matching projects.")}</MenuItem> : null}
      {visible.map((project) => {
        const key = pullRequestProjectKey(project);
        return (
          <MenuCheckboxItem
            key={key}
            checked={!props.hidden.has(key)}
            onCheckedChange={(shown) => {
              const next = new Set(props.hidden);
              if (shown) next.delete(key);
              else next.add(key);
              props.onChange(pairsOf(next));
            }}
          >
            <span className="flex min-w-0 items-center gap-2">
              <ProjectFavicon project={project} className="size-3.5" />
              <span className="min-w-0 flex-1 truncate">{project.title}</span>
            </span>
          </MenuCheckboxItem>
        );
      })}
    </>
  );
}

function usePickerCandidates(
  scopes: ReadonlyArray<IssueCandidatesTarget>,
  kind: "labels" | "assignees" | "issue-types",
  query: string,
  offset = 0,
) {
  const typed = query.trim().slice(0, CANDIDATE_QUERY_LIMIT);
  const sent = useDebouncedValue(typed, 250);
  const known = useIssueFilterCandidates(
    scopes.map((target) =>
      target.input.tracker === "jira"
        ? {
            ...target,
            input: {
              ...target.input,
              kind,
              ...(sent ? { query: sent } : {}),
              ...(offset && sent === typed ? { offset } : {}),
            },
          }
        : target,
    ),
  );
  return sent === typed
    ? known
    : {
        ...known,
        labels: [],
        assignees: [],
        issueTypes: [],
        hasMore: false,
        isPending: true,
        truncated: false,
      };
}

const JIRA_CANDIDATE_PAGE_SIZE = 100;

function PickerPageItems(props: {
  offset: number;
  hasMore: boolean;
  onOffset: (offset: number) => void;
}) {
  return (
    <>
      {props.offset > 0 ? (
        <MenuItem
          closeOnClick={false}
          onClick={() => props.onOffset(props.offset - JIRA_CANDIDATE_PAGE_SIZE)}
        >
          <T>Previous page</T>
        </MenuItem>
      ) : null}
      {props.hasMore ? (
        <MenuItem
          closeOnClick={false}
          onClick={() => props.onOffset(props.offset + JIRA_CANDIDATE_PAGE_SIZE)}
        >
          <T>Next page</T>
        </MenuItem>
      ) : null}
    </>
  );
}

function LabelChoices(props: {
  scopes: ReadonlyArray<IssueCandidatesTarget>;
  value: ReadonlyArray<string>;
  onChange: (value: ReadonlyArray<string>) => void;
}) {
  const gt = useGT();
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const known = usePickerCandidates(props.scopes, "labels", query, offset);
  const exact = query.trim().slice(0, CANDIDATE_QUERY_LIMIT);
  const needle = exact.toLowerCase();
  const hasJira = props.scopes.some(({ input }) => input.tracker === "jira");
  const found = known.labels.filter((label) =>
    matchesIssueFilterQuery(needle, label.name, label.description),
  );
  // Chosen labels lead, so one the tracker's first page lacks can still be seen and cleared.
  const visible = hasJira
    ? [
        ...props.value
          .filter((name) => !found.some((label) => label.name === name))
          .map((name) => ({ name, color: null })),
        ...(exact &&
        !/\s/.test(exact) &&
        !props.value.includes(exact) &&
        !found.some((label) => label.name === exact)
          ? [{ name: exact, color: null }]
          : []),
        ...found,
      ]
    : issueFilterLabelChoices(known.labels, props.value, query);
  return (
    <>
      <MenuSearchInput
        autoFocus
        busy={known.isPending}
        value={query}
        onChange={(event) => {
          setOffset(0);
          setQuery(event.currentTarget.value);
        }}
        placeholder={gt("Search labels")}
        aria-label={gt("Search labels")}
      />
      {visible.length === 0 && !known.isPending ? (
        <MenuItem disabled>
          {known.error === null ? <T>No labels found</T> : <T>The labels could not be read</T>}
        </MenuItem>
      ) : null}
      {visible.map((label) => {
        const dot = pullRequestLabelColor(label.color);
        return (
          <MenuCheckboxItem
            key={label.name}
            checked={props.value.includes(label.name)}
            onCheckedChange={(next) =>
              props.onChange(
                next
                  ? [...props.value, label.name].slice(0, 20)
                  : props.value.filter((name) => name !== label.name),
              )
            }
          >
            <span className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden
                className="size-2.5 shrink-0 rounded-full bg-muted-foreground"
                {...(dot ? { style: { backgroundColor: dot } } : {})}
              />
              <span className="min-w-0 flex-1 truncate">{label.name}</span>
            </span>
          </MenuCheckboxItem>
        );
      })}
      <PickerPageItems offset={offset} hasMore={known.hasMore} onOffset={setOffset} />
      {known.truncated && !known.hasMore ? (
        <MenuItem disabled>
          <T>More labels exist than are listed here.</T>
        </MenuItem>
      ) : null}
    </>
  );
}

function IssueTypeChoices(props: {
  scopes: ReadonlyArray<IssueCandidatesTarget>;
  value: ReadonlyArray<string>;
  onChange: (value: ReadonlyArray<string>) => void;
}) {
  const gt = useGT();
  const [query, setQuery] = useState("");
  const known = usePickerCandidates(props.scopes, "issue-types", "");
  const needle = query.trim().toLowerCase();
  const visible = [
    ...new Set([
      ...props.value,
      ...known.issueTypes.filter((name) => matchesIssueFilterQuery(needle, name)),
    ]),
  ];
  return (
    <>
      <MenuSearchInput
        autoFocus
        busy={known.isPending}
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        placeholder={gt("Search issue types")}
        aria-label={gt("Search issue types")}
      />
      {visible.length === 0 && !known.isPending ? (
        <MenuItem disabled>
          {known.error === null ? (
            <T>No issue types found</T>
          ) : (
            <T>The issue types could not be read</T>
          )}
        </MenuItem>
      ) : null}
      {visible.map((name) => (
        <MenuCheckboxItem
          key={name}
          checked={props.value.includes(name)}
          onCheckedChange={(checked) =>
            props.onChange(
              checked
                ? [...props.value, name].slice(0, 20)
                : props.value.filter((type) => type !== name),
            )
          }
        >
          <span className="truncate">{name}</span>
        </MenuCheckboxItem>
      ))}
    </>
  );
}

function AssigneeChoices(props: {
  scopes: ReadonlyArray<IssueCandidatesTarget>;
  value: string | undefined;
  id: string | undefined;
  onChange: (value: string | undefined, id: string | undefined) => void;
}) {
  const gt = useGT();
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const known = usePickerCandidates(props.scopes, "assignees", query, offset);
  const hasJira = props.scopes.some(({ input }) => input.tracker === "jira");
  const needle = query.trim().slice(0, CANDIDATE_QUERY_LIMIT).toLowerCase();
  const found = known.assignees.filter(
    (actor) =>
      actor.tracker === "jira" || matchesIssueFilterQuery(needle, actor.login, actor.name),
  );
  const selected = props.id ? `jira:${props.id}` : props.value;
  const foundOptions = hasJira
    ? found.map((actor) => ({
        key: actor.tracker === "jira" ? `jira:${actor.id}` : actor.login,
        login: actor.login,
        name: actor.name,
        id: actor.tracker === "jira" ? actor.id : undefined,
      }))
    : issueFilterAssigneeChoices(known.assignees, props.value, query).map((actor) => ({
        key: actor.login,
        login: actor.login,
        name: actor.name,
        id: undefined,
      }));
  const visible = [
    ...(selected && !foundOptions.some((actor) => actor.key === selected)
      ? [{ key: selected, login: props.value ?? props.id ?? selected, name: null, id: props.id }]
      : []),
    ...foundOptions,
  ].slice(0, hasJira ? undefined : VISIBLE_CHOICES);
  return (
    <>
      <MenuSearchInput
        autoFocus
        busy={known.isPending}
        value={query}
        onChange={(event) => {
          setOffset(0);
          setQuery(event.currentTarget.value);
        }}
        placeholder={gt("Search people")}
        aria-label={gt("Search people")}
      />
      <MenuRadioGroup
        value={selected ?? ""}
        onValueChange={(next) => {
          const actor = visible.find(({ key }) => key === next);
          props.onChange(actor?.login, actor?.id);
        }}
      >
        <MenuRadioItem value="">
          <span className="flex min-w-0 items-center gap-2">
            <LayersIcon aria-hidden className="size-3.5" />
            <T context="no assignee filter">Anyone</T>
          </span>
        </MenuRadioItem>
        {visible.map((actor) => (
          <MenuRadioItem key={actor.key} value={actor.key}>
            <span className="min-w-0 flex-1 truncate">
              {actor.login}
              {actor.name && actor.name !== actor.login ? (
                <span className="text-muted-foreground"> · {actor.name}</span>
              ) : null}
            </span>
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
      {visible.length === 0 && !known.isPending && known.error !== null ? (
        <MenuItem disabled>
          <T>The people could not be read</T>
        </MenuItem>
      ) : null}
      <PickerPageItems offset={offset} hasMore={known.hasMore} onOffset={setOffset} />
      {known.truncated && !known.hasMore ? (
        <MenuItem disabled>
          <T>More people exist than are listed here.</T>
        </MenuItem>
      ) : null}
    </>
  );
}
