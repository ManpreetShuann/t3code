import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverKiroSkills, leadingKiroSkillMention } from "./skills.ts";

describe("Kiro skills", () => {
  it.effect("lists project, user and power skills, the project's winning a shared name", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const write = (directory: string, name: string, contents: string) =>
        fileSystem
          .makeDirectory(path.join(root, directory, name), { recursive: true })
          .pipe(
            Effect.andThen(
              fileSystem.writeFileString(path.join(root, directory, name, "SKILL.md"), contents),
            ),
          );
      yield* write(
        "project/.kiro/skills",
        "deploy",
        "---\nname: deploy\ndescription: Project deploy\n---\n",
      );
      yield* write("home/.kiro/skills", "deploy", "---\ndescription: User deploy\n---\n");
      yield* write(
        "home/.kiro/skills",
        "review",
        "---\ndescription: >\n  Reviews\n  a diff\n---\n",
      );
      yield* write("home/.kiro/powers/installed/pstack/skills", "architect", "no frontmatter");
      yield* fileSystem.makeDirectory(path.join(root, "home/.kiro/skills/not-a-skill"), {
        recursive: true,
      });

      const skills = yield* discoverKiroSkills(path.join(root, "project"), {
        HOME: path.join(root, "home"),
      });
      expect(skills.map(({ name, scope, description }) => [name, scope, description])).toEqual([
        ["architect", "power", undefined],
        ["deploy", "project", "Project deploy"],
        ["review", "user", "Reviews a diff\n".trimEnd()],
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("reads only a leading $name as a mention", () => {
    expect(leadingKiroSkillMention("$deploy now")).toEqual({ name: "deploy", rest: " now" });
    expect(leadingKiroSkillMention("run $deploy")).toBeUndefined();
    expect(leadingKiroSkillMention("$25 please")).toBeUndefined();
  });
});
