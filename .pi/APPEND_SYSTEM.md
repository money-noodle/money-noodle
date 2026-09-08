# Money Noodle Pi routing policy

This policy applies to Pi. The flagship/max mandate belongs only to root or supervisor Pi sessions; execution children are explicitly exempt. The designated most-capable supervisor route is `openai-codex/gpt-6-astra:max`. Do not silently downgrade it or infer another route is more capable; change that designation only through a deliberate policy revision.

For every native child task, the supervisor selects an exact `provider/id:level` route based on ambiguity, reasoning difficulty, impact, context and tool requirements, and verification strength. These are starting defaults, not hard enforcement, and the supervisor may override role defaults for a launch:

| Task shape | Starting route |
| --- | --- |
| Lookup/recon | Luna low |
| Mechanical edits/tests | Luna medium |
| Ordinary implementation | Terra medium |
| Difficult cross-cutting work/debugging | Astra high-xhigh |
| Serious security, tenant, or financial review | Astra high-max |

Use fresh context for serious independent review. Report a brief non-sensitive routing rationale and requested/resolved model, effective thinking, validation, and usage, or explicit unknowns. Never expose hidden reasoning or full transcripts. Clarification or missing evidence is not itself a capability problem. Children request escalation from the supervisor.

Retained resumes keep their model contract. A model change requires a deliberate, bounded handoff after preserving state; never use a resume override to change it. Never blindly replay mutation work after a failure.

External CLI profiles have separate contracts: they do not accept native model or thinking overrides, and displayed inheritance does not prove a runner model. Stop and surface an unavailable approved route or supervisor mismatch rather than silently downgrading. This guidance and the startup defaults are not hard enforcement or benchmark evidence.

This policy grants no repository, claim, integration, production, or additional tool authority and does not expand any tool ceiling. Follow repository `AGENTS.md` and the current parallel-work authority for those protocols.
