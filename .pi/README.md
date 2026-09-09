# Money Noodle Pi configuration

This directory is Pi-only project configuration. Start Pi at the checkout root. The pinned packages are `pi-subagents` 0.66.0 and `pi-claude-code-provider` 0.2.0; the provider requires Pi 0.85.1+, Claude Code 2.1.261+, and an eligible first-party Claude subscription. npm-hosted Pi also needs Node.js 22.19+. Each developer authenticates privately; never add credentials, account identifiers, recovery state, or absolute machine paths to this repository.

Before a project package can load or install, inspect this configuration and explicitly trust the project. Pi project settings override global settings after trust. Missing pinned project packages install on startup after trust. Alternatively, install the reviewed provider at user scope:

```sh
pi install npm:pi-claude-code-provider@0.2.0
```

Settle active children before restarting or reloading Pi. Then inspect the loaded runtime:

```text
/reload
/pi-claude-code-provider-doctor
/subagents-doctor
/subagents-models
/subagents-models reviewer
```

The provider doctor checks authentication, compatibility, and the proposal-bridge handshake without Claude inference. Embedded alias diagnostics are not actual served-model evidence. `pi auth check` does not load extension providers and cannot qualify this route. Review the [upstream provider design and limitations](https://github.com/chem/pi-claude-code-provider).

## Mixed-provider routing

[APPEND_SYSTEM.md](APPEND_SYSTEM.md) owns the routing, capacity, and recovery policy. The root stays on Astra/max. Scout defaults to Luna/low with Opus as backup; worker, delegate, and researcher default to Opus/medium with Astra as backup; reviewer uses the same order at high, and oracle at max. All six start fresh unless a launch explicitly needs a fork. These are native provider choices, not duplicate role profiles or a change of execution harness.

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

Use async native children whenever any candidate uses an extension-provided model, including the GPT-first scout. Their existing tool allowlists and permissions remain unchanged. Leave ambient extension discovery enabled, or explicitly load every required provider when using an extension allowlist; `extensions: []` disables ambient providers. The optional `pi_claude_code_provider_web_search` tool consumes Claude quota too and is not added to child allowlists by this configuration.

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

The deterministic repository check is `node --test tools/pi-routing.test.mjs`; it validates configuration and documented safety contracts without network access, credentials, inference, or child launches. It does not qualify provider behavior or prove prompt compliance.

After installation or upstream changes, separately authorize and bound live qualification:

- Check the served model and effective effort, then a proposal-only tool round trip; a text-only hello does not qualify the bridge.
- Check actual async native child extension loading, tool ceilings, supervisor contact, inline output, and same-contract retained resume. A direct transport probe does not prove these lifecycle properties.
- Check pre-tool fallback and cached exclusion behavior, quota/error and reset reporting, cancellation, partial-work preservation, and a deliberate post-tool alternate-provider handoff. Do not exhaust a subscription to manufacture a test.
- Require an available authorized artifact delivery path before using file-only output. Strictly read-only reviewers can return inline; an invented file reference is not delivery.

Native lifecycle and claim recovery remain governed by the [delegation contract](../docs/development/parallel-work.md#native-lifecycle-and-recovery). No automatic post-tool cross-provider recovery is claimed. Local checks are neither hosted CI nor deployed validation. This configuration does not certify model quality, subscription entitlement, remaining capacity, billing, or deployment and grants no claim, integration, publication, or production authority.

## Shared session startup commands

Use `/start-work [task or issue]`, `/start-plan [goal or review target]`, or `/start-debug [symptom or goal]` in Pi or Claude Code. With no arguments, they initialize read-only and ask what to tackle. Prefer a fresh session; these commands do not create one or reset its authority.

Pi discovers the canonical skills in `.agents/skills/`. Thin `.pi/prompts/start-*.md` wrappers provide the same short command names as Claude Code; edit role instructions only in the shared skills. After trusting the project, start Pi at the checkout root and use `/reload` to discover the new files. The `start-` prefix avoids Pi's built-in `/debug` command.

See the [shared startup skill guide](../.agents/skills/README.md) for the command map, Claude discovery, optional arguments, manual-only behavior, symlink requirements, and validation limits. Startup commands themselves do not change settings or model defaults.
