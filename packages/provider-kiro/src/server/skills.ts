// Kiro lists skills only inside a session, whose start also starts its MCP servers,
// so the composer's list is read from the folders Kiro loads them from.

import type { ServerProviderSkill } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SKILL_MENTION_PATTERN } from "@t3tools/shared/composerInlineTokens";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseYamlDocument } from "yaml";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
// The composer's chip rule, anchored to the message start, so `$25` never names a skill.
const LEADING_SKILL_MENTION = new RegExp(`^\\s*${SKILL_MENTION_PATTERN.source}`, "u");

/** A message opening with a mention, such as `deploy` and ` ship it` for `$deploy ship it`. */
export function leadingKiroSkillMention(
  text: string,
): { readonly name: string; readonly rest: string } | undefined {
  const match = LEADING_SKILL_MENTION.exec(text);
  if (match?.[2] === undefined) return undefined;
  return { name: match[2], rest: text.slice(match[0].length) };
}

function skillDescription(contents: string): string | undefined {
  const frontmatter = FRONTMATTER_PATTERN.exec(contents)?.[1];
  if (frontmatter === undefined) return undefined;
  try {
    const parsed: unknown = parseYamlDocument(frontmatter);
    const description =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>).description
        : undefined;
    return typeof description === "string" && description.trim() ? description.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Skills Kiro loads, with a workspace skill beating a global one of the same
 * name: `<cwd>/.kiro/skills`, `~/.kiro/skills`, and each installed power's `skills`.
 */
export const discoverKiroSkills = Effect.fn("discoverKiroSkills")(function* (
  cwd: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home =
    environment.HOME?.trim() ||
    environment.USERPROFILE?.trim() ||
    (yield* HostProcess.HomeDirectory);
  const readNames = (directory: string) =>
    fileSystem.readDirectory(directory).pipe(Effect.orElseSucceed(() => [] as Array<string>));
  const powersRoot = path.join(home, ".kiro", "powers", "installed");
  const powerRoots = (yield* readNames(powersRoot)).map((power) => ({
    directory: path.join(powersRoot, power, "skills"),
    scope: "power",
  }));
  const roots = [
    ...(cwd ? [{ directory: path.join(cwd, ".kiro", "skills"), scope: "project" }] : []),
    { directory: path.join(home, ".kiro", "skills"), scope: "user" },
    ...powerRoots,
  ];

  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const root of roots) {
    for (const name of [...(yield* readNames(root.directory))].sort()) {
      if (skillsByName.has(name)) continue;
      const skillPath = path.join(root.directory, name, "SKILL.md");
      const contents = yield* fileSystem
        .readFileString(skillPath)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (contents === undefined) continue;
      const description = skillDescription(contents);
      skillsByName.set(name, {
        name,
        path: skillPath,
        scope: root.scope,
        enabled: true,
        ...(description ? { description } : {}),
      });
    }
  }
  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
});
