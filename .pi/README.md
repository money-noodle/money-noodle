# Money Noodle Pi configuration

This directory is Pi-only project configuration. Start Pi at the repository root. It was tested with Pi 0.85.1 and `pi-subagents` 0.66.0.

Before a project package can load or install, inspect this configuration and explicitly trust the project. Pi project settings override global settings after trust. Each developer authenticates approved model access privately; do not add credentials or absolute machine paths to this repository.

Restart or reload Pi after configuration changes. Use `/subagents-models` (or `/subagents-models <role>`) to inspect the mappings the loaded extension actually sees.

The settings provide startup defaults only. Saved model choices, CLI options, and resumed-session choices can differ from startup defaults; inspect the active session and runtime mapping for effective settings. Native child selection uses the model suffix, while tool-level thinking is watchdog-only. An unsupported or unavailable requested route requires a supervisor decision rather than silent fallback.

Other harnesses and external CLI runner defaults are unchanged. This configuration does not certify model access, quality, cost, or deployment, and it grants no claim, integration, publication, or production authority.
