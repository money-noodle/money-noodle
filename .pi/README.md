# Money Noodle Pi configuration

This directory is Pi-only project configuration. Start Pi at the repository root. It was tested with Pi 0.85.1 and `pi-subagents` 0.66.0.

Before a project package can load or install, inspect this configuration and explicitly trust the project. Pi project settings override global settings after trust. Each developer authenticates approved model access privately; do not add credentials or absolute machine paths to this repository.

Restart or reload Pi after configuration changes. Use `/subagents-models` (or `/subagents-models <role>`) to inspect the mappings the loaded extension actually sees.

The settings provide startup defaults only. Saved model choices, CLI options, and resumed-session choices can differ from startup defaults; inspect the active session and runtime mapping for effective settings. Native child selection uses the model suffix, while tool-level thinking is watchdog-only. An unsupported or unavailable requested route requires a supervisor decision rather than silent fallback.

Other harnesses and external CLI runner defaults are unchanged. This configuration does not certify model access, quality, cost, or deployment, and it grants no claim, integration, publication, or production authority.

## Shared session startup commands

Use `/start-work [task or issue]`, `/start-plan [goal or review target]`, or `/start-debug [symptom or goal]` in Pi or Claude Code. With no arguments, they initialize read-only and ask what to tackle. Prefer a fresh session; these commands do not create one or reset its authority.

Pi discovers the canonical skills in `.agents/skills/`. Thin `.pi/prompts/start-*.md` wrappers provide the same short command names as Claude Code; edit role instructions only in the shared skills. After trusting the project, start Pi at the checkout root and use `/reload` to discover the new files. The `start-` prefix avoids Pi's built-in `/debug` command.

See the [shared startup skill guide](../.agents/skills/README.md) for the command map, Claude discovery, optional arguments, manual-only behavior, symlink requirements, and validation limits. No Pi settings or model defaults change.
