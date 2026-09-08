# Shared session startup skills

Use the same commands in the **interactive input of Claude Code or Pi**:

| Command                               | Session role            | Shared skill                          |
| ------------------------------------- | ----------------------- | ------------------------------------- |
| `/start-work [task or issue]`         | Execution supervisor    | [`start-work`](start-work/SKILL.md)   |
| `/start-plan [goal or review target]` | Planning supervisor     | [`start-plan`](start-plan/SKILL.md)   |
| `/start-debug [symptom or goal]`      | Human-directed debugger | [`start-debug`](start-debug/SKILL.md) |

```text
/start-work Add regression coverage for the platform status response
/start-plan Review the platform status API contract
/start-debug Investigate why the focused platform API test fails
```

Arguments are optional. With no arguments, each skill performs read-only orientation and asks what to tackle; it does not choose or claim backlog work. These are harness slash commands, not bash/zsh executables. Prefer a fresh session: invoking a skill adds instructions to the current session, not a new process, model change, or authority reset.

## Discovery and one source of truth

- **Shared source:** edit only `.agents/skills/start-*/SKILL.md` for role instructions.
- **Claude Code:** `.claude/skills/start-*` are relative directory symlinks to those shared skills. Claude exposes them natively as `/start-*`. The current skill format is `.claude/skills/<name>/SKILL.md`, not a loose Markdown file. Keep Git symlinks intact; a checkout that materializes them as plain text files cannot load these skills.
- **Pi:** trusted projects discover `.agents/skills/` natively, so duplicate `.pi/skills/` copies and extra settings are unnecessary. The [thin prompt wrappers](../../.pi/prompts) expose `/start-*` and instruct Pi to read the shared skill with the supplied request. They do not rely on recursively expanding `/skill:*` inside a prompt. Pi's native `/skill:start-work`, `/skill:start-plan`, and `/skill:start-debug` also work when skill commands are enabled.

Start the harness at the root of the checkout containing these files. Review and trust project content through the harness's normal trust mechanism. Use `/reload` in Pi after adding them. Restart Claude Code when its top-level `.claude/skills/` directory is newly created; existing skill directories support live edits. Inspect the command's source if a personal, enterprise, or plugin command has the same name and shadows this project version.

Both harnesses support `disable-model-invocation: true`, so these startup skills are manual-only and run in the current session. They declare no fork, child agent, hook, tool grant, or model override. The shared bodies contain no argument-substitution variables: Claude appends supplied arguments, Pi's native skill command appends user input, and the Pi wrappers pass an explicit request. This keeps argument syntax out of the shared instructions.

## Boundaries and validation

These skills route to [AGENTS.md](../../AGENTS.md) and the current [session-role and delegation authority](../../docs/development/parallel-work.md); they do not replace it or implement policy enforcement. Delegated sessions remain bounded children. The debugger requires a direct human request, never a supervisor launch. Pi routing applies only in Pi; Claude follows its own actual tool/permission contract. Existing ownership, isolation, review/CI, and production controls remain in force. Use non-sensitive task descriptions and follow [SECURITY.md](../../SECURITY.md).

Run `node --test tools/session-startup.test.mjs` from the checkout root for source checks covering metadata, shared symlink targets, wrappers, document links, role-boundary guardrails, and Git visibility. These checks do not launch either agent or prove behavioral enforcement. For an interactive smoke check, start each harness in this checkout, invoke each command without arguments in a fresh session, and confirm its role statement and read-only orientation before giving it work. Loader checks, interactive behavior, hosted CI, and deployed validation are separate evidence.

Discovery and invocation references: [Claude Code skills](https://code.claude.com/docs/en/skills), [Pi skills](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/skills.md), and [Pi prompt templates](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/prompt-templates.md). Reverify the installed harness if its loading behavior differs; do not silently duplicate instructions or relax permissions to make a command appear.
