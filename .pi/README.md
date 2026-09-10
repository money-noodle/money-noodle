# Money Noodle Pi configuration

This directory is Pi-only project configuration. Start Pi at the checkout root. The pinned packages are `pi-subagents` 0.66.0, `pi-claude-code-provider` 0.2.0, and `pi-model-fallback` 0.3.7. The Claude provider requires Pi 0.85.1+, Claude Code 2.1.261+, and an eligible first-party Claude subscription. npm-hosted Pi also needs Node.js 22.19+. Each developer authenticates privately; never add credentials, account identifiers, recovery state, or absolute machine paths to this repository.

The delegation package is the unscoped [nicobailon `pi-subagents`](https://github.com/nicobailon/pi-subagents), not [`@tintinweb/pi-subagents`](https://pi.dev/packages/@tintinweb/pi-subagents). Their tool names, configuration, and lifecycle contracts differ. Do not install both coordinators or apply the scoped package's `Agent` / `SubagentWorkflow` / `subagents.json` instructions to this setup; changing orchestrators requires a separately qualified migration.

Before a project package can load or install, inspect this configuration and explicitly trust the project. Pi project settings override global settings after trust. Missing pinned project packages install on startup after trust. Alternatively, install the reviewed provider at user scope:

```sh
pi install npm:pi-claude-code-provider@0.2.0
```

Settle active children before restarting or reloading Pi. Then inspect the loaded runtime:

```text
/reload
/pi-claude-code-provider-doctor
/model-fallback:status
/subagents-doctor
/subagents-models
/subagents-models reviewer
```

The provider doctor checks authentication, compatibility, and the proposal-bridge handshake without Claude inference. Embedded alias diagnostics are not actual served-model evidence. `pi auth check` does not load extension providers and cannot qualify this route. Review the [upstream provider design and limitations](https://github.com/chem/pi-claude-code-provider).

## Main-session fallback

The principal-approved main route is **Astra/max → Opus/max**, the reverse of the child defaults. [model-fallback/config.json](model-fallback/config.json) uses the upstream `version`, `enabled`, `rules`, `matchModels`, `statuses`, and `fallback` shape to match only `openai-codex/gpt-6-astra` on 429, 500, 502, 503, or 504. The fallback reference is the provider and bare `opus` ID, not a thinking-suffixed ID. `defaultThinkingLevel` and `modelThinkingLevels` in [settings.json](settings.json) set max for both main routes; explicit native child thinking still comes from each role.

The package entry has `extensions: []` to prevent unguarded automatic loading. [extensions/main-model-fallback.ts](extensions/main-model-fallback.ts) loads the unchanged package only outside marked native child processes. `pi-subagents@0.66.0` sets `PI_SUBAGENT_CHILD=1` before async ambient extensions load; the loader refuses any marker value. Foreground children do not load ambient extensions. Do not explicitly load the main-only loader or stock fallback entry in children, remove the package filter, or install an additional unguarded global copy. A child must retain its native candidate and resume contracts, not be switched back to Claude by the main-session extension.

As documented on the [package page](https://pi.dev/packages/pi-model-fallback), the extension changes the selected model and persists cooldown state; it does not itself replay the failed prompt. Pi's own retry/continuation behavior is separate. Verify the actual active model and thinking before continuing, preserve partial effects, and do not repeat completed mutations or recreate children. This main-session contingency does not change any child's retained model/tool contract.

Upstream defaults are 72 hours for 429 and 10 minutes for 5xx; recognized `Retry-After` or `x-ratelimit-reset*` headers take precedence. These are not verified subscription reset schedules. Active cooldowns can preselect Opus on later agent starts; expiry does not automatically switch an already-selected Opus session back to GPT. `/model-fallback:status` inspects state; `/model-fallback:reset` clears it and can restore the remembered original model. Do not clear known valid exhaustion evidence just to force another request.

The committed rules and ignored runtime state live at `.pi/model-fallback/config.json` and `.pi/model-fallback/state.json` when Pi starts at the checkout root. State is not source or authority; do not commit or publish it. Config saves through `model_fallback_config` are still source edits requiring an authorized isolated branch, never an integration-checkout shortcut. This installation is project-local so unrelated projects are not reconfigured.

The 0.3.7 error parser requires recognizable HTTP-status text or a response hook. For example, the observed plain `Codex error: The usage limit has been reached` message alone does **not** trigger fallback. Do not claim universal quota recovery or reclassify a safeguard refusal to force switching. Installation, offline hook tests, and catalog metadata do not establish live provider or child-lifecycle qualification.

## Mixed-provider routing

[APPEND_SYSTEM.md](APPEND_SYSTEM.md) owns the routing, capacity, and recovery policy. All six native child roles prefer Opus: scout uses low thinking with Luna as backup; worker, delegate, and researcher use medium with Astra as backup; reviewer uses the same order at high, and oracle at max. All six start fresh unless a launch explicitly needs a fork. These are native provider choices, not duplicate role profiles or a change of execution harness.

In `pi-subagents@0.66.0`, `model` must be a string, not an array. Use the ordered `fallbackModels` array for backups, as in the worker override:

```json
{
  "model": "pi-claude-code-provider/opus",
  "fallbackModels": ["openai-codex/gpt-6-astra"],
  "thinking": "medium",
  "defaultContext": "fresh"
}
```

The separate `thinking` key applies to every candidate. A thinking suffix on an individual model is only needed to override that candidate's default effort. Native fallback can skip unavailable or cached-excluded configured models and retry qualifying provider/model failures **before any tool activity**. It is not automatic cross-provider recovery after tools, a quota-only classifier, or proactive warning-based routing. A per-run model override does not clear the fallback chain or change the backups' thinking; verify every candidate still fits the assignment. Required model, tool, permission, and workflow preflight checks remain authoritative.

For example, select GPT for a new ordinary implementation task while Claude is exhausted:

```text
/run worker[model=openai-codex/gpt-5.6-terra:medium] "<bounded authorized assignment>"
```

Saved choices, CLI options, and resumed-session contracts can differ from startup settings. Per-run model selection uses the model suffix; tool-level `thinking` is watchdog-only, unlike the role setting above. No custom quota monitor, weekly-budget estimator, reset scheduler, or account-wide concurrency limiter is installed. The supervisor still selects capacity-aware routes and preserves state at handoff; changing settings does not reroute existing children.

Upstream caches model exclusions for 24 hours by default, independently of provider reset times. `modelExclusions.defaultTtlMs` in the private `~/.pi/agent/extensions/subagent/config.json` controls that global TTL, not a per-provider quota window; this change does not alter it. Skipped-candidate warnings include the cached reason and expiry. Inspect those diagnostics before assuming a replenished Claude subscription has reentered the chain. See the pinned package's [model selection](https://github.com/nicobailon/pi-subagents/blob/v0.66.0/docs/models.md) and [exclusion configuration](https://github.com/nicobailon/pi-subagents/blob/v0.66.0/docs/configuration.md#modelexclusions).

Use async native children for all six configured roles; every primary is extension-provided Opus. Their existing tool allowlists and permissions remain unchanged. Leave ambient extension discovery enabled, or explicitly load every required provider when using an extension allowlist; `extensions: []` disables ambient providers. The optional `pi_claude_code_provider_web_search` tool consumes Claude quota too and is not added to child allowlists by this configuration.

`pi-claude-code-provider/opus` uses Claude Code only as transport: Pi still owns tool execution and native lifecycle. It is different from the external `claude-code` / `claude-code-writer` profiles. Unmanaged Claude settings, hooks, and customizations are suppressed by the transport; editing `CLAUDE.md` or duplicating Pi prompts there is not how to configure native children. Organization-managed Claude policy remains trusted by the upstream package; this is not an OS sandbox.

## Opus 1M context opt-in

The provider's stock Opus catalog advertises 200K on Pro and 1M on Max, Team, and Enterprise. It intentionally keeps Pro at 200K even when Claude reports a 1M-capable model because it cannot determine usage-credit availability. For independently confirmed Opus 1M access, merge this provider entry into the developer's private `~/.pi/agent/models.json`, preserving any existing providers and overrides:

```json
{
  "providers": {
    "pi-claude-code-provider": {
      "modelOverrides": {
        "opus": {
          "contextWindow": 1000000
        }
      }
    }
  }
}
```

This is a local capacity declaration, not an entitlement check or billing authorization. It does not change the `opus` request alias, output-token limit, credentials, or Claude billing settings. Keep it user-local rather than assuming every contributor has the same access. Do not invent a versioned model ID or change `modelResponseAliases` to get a passing check.

Verify the effective catalog with `pi --list-models pi-claude-code-provider` from the trusted checkout. On an authorized small inference probe, inspect `responseModel` and reported `servedContextWindow` in content-free provider metrics. Confirmed metadata is not a full 1M-payload test. Use focused contexts: the provider serializes Pi's current history on each request, adding framing and output-reserve overhead. A 1M window does not promise 1M usable input tokens or reduce quota consumption.

Optional private metrics can be enabled for the Pi process and its children:

```sh
PI_CLAUDE_CODE_PROVIDER_METRICS_LOG="$HOME/.pi/agent/claude-provider-metrics.jsonl" pi
```

Upstream metrics exclude prompt/output payloads and credentials. Keep these diagnostics private and inspect before sharing. Reported $0 cost is not billing evidence; token counts are not remaining subscription quota. Never enable usage credits or paid API fallback implicitly.

## Qualification and recovery checks

The deterministic repository checks are `node --test tools/pi-routing.test.mjs tools/pi-main-model-fallback.test.mjs`; they validate configuration, main-loader child exclusion, and documented safety contracts without network access, credentials, inference, or child launches. They do not qualify provider behavior or prove prompt compliance.

After installation or upstream changes, separately authorize and bound live qualification:

- Check main-session fallback selection, max thinking on both routes, visible failures, cooldown/header handling, and no replay by the fallback extension. Keep simulated hooks distinct from real provider failures.
- Check the served model and effective effort, then a proposal-only tool round trip; a text-only hello does not qualify the bridge.
- Check actual async native child extension loading, tool ceilings, supervisor contact, inline output, and same-contract retained resume. A direct transport probe does not prove these lifecycle properties.
- Check pre-tool fallback and cached exclusion behavior, quota/error and reset reporting, cancellation, partial-work preservation, and a deliberate post-tool alternate-provider handoff. Do not exhaust a subscription to manufacture a test.
- Require an available authorized artifact delivery path before using file-only output. Strictly read-only reviewers can return inline; an invented file reference is not delivery.

Native lifecycle and claim recovery remain governed by the [delegation contract](../docs/development/parallel-work.md#native-lifecycle-and-recovery). No automatic post-tool cross-provider recovery is claimed. Local checks are neither hosted CI nor deployed validation. This configuration does not certify model quality, subscription entitlement, remaining capacity, billing, or deployment and grants no claim, integration, publication, or production authority.

## Shared session startup commands

Use `/start-work [task or issue]`, `/start-plan [goal or review target]`, or `/start-debug [symptom or goal]` in Pi or Claude Code. With no arguments, they initialize read-only and ask what to tackle. Prefer a fresh session; these commands do not create one or reset its authority.

Pi discovers the canonical skills in `.agents/skills/`. Thin `.pi/prompts/start-*.md` wrappers provide the same short command names as Claude Code; edit role instructions only in the shared skills. After trusting the project, start Pi at the checkout root and use `/reload` to discover the new files. The `start-` prefix avoids Pi's built-in `/debug` command.

See the [shared startup skill guide](../.agents/skills/README.md) for the command map, Claude discovery, optional arguments, manual-only behavior, symlink requirements, and validation limits. Startup commands themselves do not change settings or model defaults.
