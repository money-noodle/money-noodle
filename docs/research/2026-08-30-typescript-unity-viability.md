# TypeScript with Unity viability assessment

> **Status:** Dated research evidence; not requirement or decision authority
> **As of:** 2026-08-30
> **Scope:** PuerTS, unity-jsb, TypeScript Importer for Unity, OneJS, and cross-cutting viability for Money Noodle
> **Method:** Public repository, source, release, issue, and documentation review plus official Unity and Apple documentation
> **Largest validity threat:** No hands-on IL2CPP, player, or physical-device validation and no confidential console-platform evidence; repository claims may not match production behavior

## Question and boundaries

Can TypeScript be a viable Unity implementation language for Money Noodle, and what role—if any—should each reviewed framework have?

No Unity editor, player build, physical-device test, profiler run, console SDK or documentation, or Money Noodle integration was exercised. This is not deployment, target-platform, performance, security, or policy validation. It is dated evidence under the [`research convention`](README.md), not a technology decision.

Labels used below:

- **Fact** means directly observed in a cited public source.
- **Reported** means a project or GitHub reports the claim; Money Noodle did not reproduce it.
- **Derived** means arithmetic over cited reported values.
- **Assessment** means reasoned interpretation or recommendation.
- **Unknown** means the reviewed public evidence is insufficient.

## Conclusion and recommendation

**Assessment:** TypeScript in Unity is technically viable, but it is not native Unity scripting. In the reviewed approaches it is transpiled to JavaScript or Lua and needs a runtime plus a C# bridge. C# remains necessary for the Unity shell and lifecycle, platform integrations, IL2CPP/AOT and stripping control, performance-sensitive work, and security boundaries. Do not replace C# platform-wide; C# should be Money Noodle's Unity baseline.

| Option | Recommendation | Reason |
| --- | --- | --- |
| C# | **Baseline** | Native Unity lifecycle, platform, AOT, and performance path; keeps the trusted shell small. |
| PuerTS | **Only credible broad TypeScript candidate; spike before any commitment** | Largest and most active reviewed ecosystem, but broad interop and native backends create substantial platform, stripping, footprint, lifecycle, and security work. |
| OneJS v3 | **Consider a bounded UI-only spike** | React/TypeScript authoring may have material UI value, but the replacement runtime was only weeks old and had recent cross-platform regressions. |
| unity-jsb | **Reject for new production work** | Archived and stale; adoption would make Money Noodle the effective bridge and native-binary maintainer. |
| TypeScript Importer | **Prototype/editor convenience only** | Transpiles assets but supplies neither a runtime nor a Unity bridge. |
| PuerTS plus OneJS v3 | **Do not combine** | OneJS v3 replaced PuerTS with its own QuickJS bridge; two scripting stacks would duplicate runtime, native-plugin, lifecycle, debugging, and security burden without an established integration contract. |

## Sources and quantitative method

### Exact snapshots inspected

All snapshots were retrieved on 2026-08-30. Commit links are immutable; release, issue, and official-document pages were also retrieved on that date and may later change.

| Source | Snapshot |
| --- | --- |
| PuerTS | [`Tencent/puerts@2bb9988be008208a39d67dd11a9e5ddc2b248fb6`](https://github.com/Tencent/puerts/tree/2bb9988be008208a39d67dd11a9e5ddc2b248fb6) |
| unity-jsb | [`ialex32x/unity-jsb@2bcabe9da47a27eb0717db78f8b9710ba4476430`](https://github.com/ialex32x/unity-jsb/tree/2bcabe9da47a27eb0717db78f8b9710ba4476430) |
| TypeScript Importer | [`annulusgames/TypeScriptImporter@615db49348f181fa350cca71e6a319c8ce5ef4ce`](https://github.com/annulusgames/TypeScriptImporter/tree/615db49348f181fa350cca71e6a319c8ce5ef4ce) |
| OneJS | [`Singtaa/OneJS@ee9beb1bff916a38855b1c1d6efe270a3465afa9`](https://github.com/Singtaa/OneJS/tree/ee9beb1bff916a38855b1c1d6efe270a3465afa9) |
| Unity | [Scripting restrictions](https://docs.unity3d.com/6000.0/Documentation/Manual/ScriptingRestrictions.html), [managed-code stripping](https://docs.unity3d.com/Manual/managed-code-stripping.html), and [native plug-ins](https://docs.unity3d.com/Manual/plug-ins.html) |
| Apple | [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/), especially 2.5.2 |

**Reported repository quantities:** GitHub's public repository, commit-pagination, contributor, and release APIs were observed on 2026-08-30. The sample is each named repository at the snapshot above, with contributor queries including anonymous entries. Counts exclude forks, private work, unlinked identities, non-GitHub activity, and changes after the as-of time. Stars are popularity/maintenance signals, not proof of correctness or quality.

**Derived archive sizes:** MiB values below divide GitHub-reported compressed release-asset bytes by 1,048,576 and round to two decimals. They are not installed or final player sizes; archives contain multi-platform material. **Reported benchmark values** are project-owned measurements with their stated environment, not measurements by Money Noodle and not target-device results. This review made no measured, estimated, or simulated performance claim of its own.

## Framework evidence

### PuerTS

**Facts and reported evidence**

- GitHub reported about 6,193 stars, 5,045 commit pages, and 150 contributor entries including anonymous contributors. Two leading maintainers accounted for most reported contributions.
- The snapshot [`README`](https://github.com/Tencent/puerts/blob/2bb9988be008208a39d67dd11a9e5ddc2b248fb6/README.md) names `Unity_v3.0.2` as latest and `Unity_v2.2.3` as LTS. GitHub reports those releases as published 2026-04-01 and 2025-11-28 respectively.
- It generates C# `.d.ts` declarations for editor assistance and offers V8, QuickJS, and Node.js JavaScript backends plus a special WebGL path. Its own comparison says V8 supports debugging; QuickJS has lower performance and no PuerTS debugging; Node.js provides Node APIs with a larger footprint.
- GitHub reports compressed v3.0.2 archives of 4.67 MiB Core, 9.33 MiB QuickJS, 74.41 MiB V8, and 169.29 MiB Node.js (**derived** as described above). These are not additive final-player deltas.
- PuerTS's [performance documentation](https://github.com/Tencent/puerts/blob/2bb9988be008208a39d67dd11a9e5ddc2b248fb6/doc/unity/en/performance/index.md) reports backend-, wrapper-, platform-, and call-pattern-specific results. It does not establish general parity with C#.
- Its [IL2CPP guide](https://github.com/Tencent/puerts/blob/2bb9988be008208a39d67dd11a9e5ddc2b248fb6/doc/unity/en/performance/il2cpp.md) and [FAQ](https://github.com/Tencent/puerts/blob/2bb9988be008208a39d67dd11a9e5ddc2b248fb6/doc/unity/en/faq.md) document static/reflection wrapper modes, reflection cost, iOS-specific setup and build failures, and APIs disappearing after Unity stripping unless wrappers or `link.xml` preserve them. Delegate bridges, `ref`/`out`, generics, explicit interface implementations, and `ref struct` generation need special handling or have limitations. The [known-bugs page](https://github.com/Tencent/puerts/blob/2bb9988be008208a39d67dd11a9e5ddc2b248fb6/doc/unity/zhcn/bugs.md) links a memory-management problem when a TypeScript class extends C#.
- The core [license](https://github.com/Tencent/puerts/blob/2bb9988be008208a39d67dd11a9e5ddc2b248fb6/LICENSE) is BSD-3-Clause and lists third-party components separately.

**Assessment:** PuerTS is the only credible candidate reviewed for broad TypeScript scripting. Its scale and activity are maintenance evidence, not quality proof, while contributor concentration is a continuity risk. Production IL2CPP still requires generated-wrapper, `link.xml`, and stripping discipline. Performance claims must be remeasured for the selected backend, wrappers, target, and bridge-volume pattern. Full reflected C# access is capability, not a sandbox; a production design would need an allowlisted facade. Every bundled backend and dependency still needs license and SBOM review.

**Unknown:** Public evidence does not establish PlayStation, Xbox, or Switch readiness. Console support must not be inferred from desktop/mobile/WebGL claims.

### unity-jsb

**Facts and reported evidence**

- GitHub reported the repository archived, about 339 stars, source last updated 2023-09-01, and latest release `v1.7.4` published 2022-05-22.
- Its immutable [`README`](https://github.com/ialex32x/unity-jsb/blob/2bcabe9da47a27eb0717db78f8b9710ba4476430/README.md) describes QuickJS as primary, V8 as experimental and Windows x64 only, and debugging as experimental/V8-only. It claims broader Unity 2020.3+ platform support but says testing was only on Intel macOS with Unity 2020.3. Workers, C# hotfixing, and UIElement support are marked unfinished.
- The sample [`package.json`](https://github.com/ialex32x/unity-jsb/blob/2bcabe9da47a27eb0717db78f8b9710ba4476430/package.json) uses TypeScript 3.9 and Webpack 4. Open reports include [Unity 2021 binding failures](https://github.com/ialex32x/unity-jsb/issues/118), [Unity 2022 binding failures](https://github.com/ialex32x/unity-jsb/issues/95), and [WebGL out-of-bounds memory access](https://github.com/ialex32x/unity-jsb/issues/47).
- License is MIT.

**Assessment:** Historical bridge and code-generation ideas may be informative, but the project is unsuitable for new production work. Adopting it would mean owning its bridge, QuickJS/V8 integration, and native binaries.

### TypeScript Importer for Unity

**Facts and reported evidence**

- GitHub reported about 24 stars, 7 commits, 2 contributor entries, and one `v1.0.0` release published 2025-01-11. The snapshot has no visible CI or test suite beyond sandbox examples.
- The [`README`](https://github.com/annulusgames/TypeScriptImporter/blob/615db49348f181fa350cca71e6a319c8ce5ef4ce/README.md) says `.ts` assets are transpiled and the source plus emitted JavaScript are stored in a `ScriptableObject`; a separate extension invokes TypeScriptToLua. Its examples pass output to Jint or Lua-CSharp.
- Source [invokes `npx tsc` or `npx tstl`](https://github.com/annulusgames/TypeScriptImporter/blob/615db49348f181fa350cca71e6a319c8ce5ef4ce/src/TypeScriptImporter/Assets/TypeScriptImporter/Editor/TypeScriptAssetPostProcessorBase.cs) in the editor import path, while the documentation instructs installing global tools. It recognizes `.d.ts` assets but does not generate Unity API declarations. Its [process helper](https://github.com/annulusgames/TypeScriptImporter/blob/615db49348f181fa350cca71e6a319c8ce5ef4ce/src/TypeScriptImporter/Assets/TypeScriptImporter/Editor/ProcessHelper.cs) waits in a progress loop until compilation exits.
- License is MIT.

**Assessment:** This is an editor transpilation convenience, not a runtime, Unity bridge, or platform choice. A separate Jint, QuickJS, or Lua runtime and a C# binding/security design are still required. Global-tool documentation combined with `npx` execution is a reproducibility and supply-chain concern without strict local pins and a lockfile; blocking import and shell/path handling also need cross-platform scrutiny. Limit use to a prototype unless those gaps are deliberately solved.

### OneJS v3

**Facts and reported evidence**

- GitHub reported about 347 stars and active development. `v3.4.0` was published 2026-08-28. The [changelog](https://github.com/Singtaa/OneJS/blob/ee9beb1bff916a38855b1c1d6efe270a3465afa9/ChangeLog.md) says v3.1 replaced PuerTS with a purpose-built QuickJS bridge and Preact with React 19 on 2026-08-06, making the reviewed architecture only weeks old.
- The [`README`](https://github.com/Singtaa/OneJS/blob/ee9beb1bff916a38855b1c1d6efe270a3465afa9/README.md) requires Unity 6.3+ and describes React 19/TypeScript authoring, esbuild, generated typings, hot reload/edit preview, native UI Toolkit rendering without a DOM or webview, QuickJS on desktop/mobile, and browser JavaScript on WebGL.
- Public [CI](https://github.com/Singtaa/OneJS/blob/ee9beb1bff916a38855b1c1d6efe270a3465afa9/.github/workflows/ci.yml) uses Unity `6000.5.2f1` on Linux for EditMode and PlayMode and opens shipped desktop native libraries. It checks Android/iOS files statically but does not load or run their binaries.
- The changelog records that v3.2.0/v3.2.1 Windows binaries failed for every user because `libwinpthread-1.dll` was not shipped. Later releases fixed native buffer leaks, a Windows allocator mismatch, generation-tagged stale handles, WebGL task/lifecycle behavior, and timer teardown.
- React-shaped is not React DOM. Tailwind-style utilities produce USS; the [styling documentation](https://github.com/Singtaa/OneJS/blob/ee9beb1bff916a38855b1c1d6efe270a3465afa9/Runtime/Styling/README.md) lists missing `rem`, media-query, `:is()`, and other modern CSS behavior. Some runtime styling and editor code reflects Unity private/internal APIs.
- The project's [`DESIGN.md`](https://github.com/Singtaa/OneJS/blob/ee9beb1bff916a38855b1c1d6efe270a3465afa9/DESIGN.md) says “JavaScript orchestrates. C# computes,” reports interpreted QuickJS numeric loops as roughly one to two orders slower than JIT, and reports example crossings around 2–5 microseconds from 20,000-iteration tests in its Play/V8 environment. These are **project-reported** results, not target-device benchmarks.
- The [WebGL documentation](https://github.com/Singtaa/OneJS/blob/ee9beb1bff916a38855b1c1d6efe270a3465afa9/Plugins/WebGL/README.md) says code executes in the embedding page's shared global scope. Timer replacements capture page-global `setTimeout`, `setInterval`, and `requestAnimationFrame`, including Unity's main loop. Teardown mitigations exist, but the document says a real fix requires an isolated realm.
- The bridge exposes broad C# reach through generated types and reflection. License is MIT.

**Assessment:** OneJS merits a bounded UI-only spike only if React/TypeScript authoring has material value. The growing tests are positive evidence, while the recent native, memory, handle, and lifecycle fixes indicate runtime immaturity. DOM/Node-dependent packages will fail, and web components cannot be reused directly; share contracts and design tokens with web, not components or stylesheets by assumption. Reflection over private/internal Unity APIs creates upgrade fragility. Broad C# reach is not an untrusted-mod sandbox. Shared browser globals and timer capture are especially risky in Money Noodle's existing Next.js host. Keep computation and all trusted platform integration in C#. The v3 runtime is too new for immediate production commitment.

## Cross-cutting viability

### Facts

- Generated `.d.ts` files are compile-time assistance. They do not encode Unity main-thread restrictions, managed-code stripping, destroyed-object semantics, runtime permissions, or object lifetime.
- Unity's official documentation confirms IL2CPP/AOT restrictions, managed-code stripping behavior, and platform-specific native plug-in/ABI handling. Adding a scripting runtime adds native architecture maintenance, dual managed/JavaScript heaps and garbage collectors, callback handles, and reload/scene lifetime concerns.
- JavaScript's ordinary [`number`](https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-number.max_safe_integer) cannot exactly represent every 64-bit integer.
- Apple App Review Guideline 2.5.2 restricts downloading, installing, or executing code that introduces or changes app functionality, subject to narrow exceptions. Editor hot reload is not evidence that downloading executable scripts is acceptable in a shipped app. Console policy is unknown and may be confidential.
- `async` does not imply parallel Unity execution. Unity APIs remain main-thread constrained, and a QuickJS context is generally single-threaded. Debugging, profiling, and source-map behavior vary by backend and target.

### Assessments

- npm reuse is limited to pure portable logic, schemas, contracts, and tokens. DOM, Node, native-module, and browser-global assumptions fail in QuickJS or native UI Toolkit environments.
- Binary floating point is unsuitable for authoritative decimal financial arithmetic.
- Bundle reviewed scripts. Do not create a remote executable hotfix or mod path without explicit legal, platform-policy, security, signing, rollback, and audit design.
- Keep bridge calls coarse and lifecycle ownership explicit. Repeated scene load/unload and runtime reload testing are mandatory because stale callbacks and cross-heap references can survive ordinary happy-path tests.
- Treat a broad `CS.*` bridge as trusted application code only. Untrusted scripts require a separately designed capability sandbox; none of these frameworks supplies the Money Noodle boundary by default.

### Unknowns

Actual final-player size, cold start, memory, GC behavior, frame cost, IL2CPP stripping behavior, source-map quality, crash symbolization, and low-end-device behavior remain unknown for every candidate. Public evidence does not resolve console certification or runtime-code policy.

## Money Noodle implications

These are **reasoned applications of current Money Noodle authority**, not new requirements established by this assessment. Current architecture already says interfaces present state and submit intent, server state is authoritative across concurrent interfaces, and unknown data must not be invented; see [`architecture/principles.md`](../architecture/principles.md) and [`architecture/data-identity-observability.md`](../architecture/data-identity-observability.md).

- A Unity/TypeScript layer may present state and submit intent. It never owns canonical balances, ledger arithmetic, risk decisions, funded execution, provider credentials, or canonical state.
- Monetary contract values use contract-defined decimal strings or explicitly safe bounded representations and server validation. JavaScript floating point has no financial authority.
- Preferred boundary: a C# shell owns authentication/session, generated API transport, synchronization, Unity lifecycle, input, telemetry, platform adapters, performance-sensitive work, and an allowlisted presentation facade. An optional OneJS TypeScript UI stays behind that facade.
- Do not expose unrestricted `CS.*` in production. Do not download executable scripts. On timeout, offline state, incompatible contract, or runtime failure, report unknown or unavailable rather than inventing financial state.

## Minimum spike gates

A spike must define product frame/device objectives before numerical pass thresholds. Do not invent thresholds in advance. At minimum it must provide:

- exact pinned Unity, framework, Node.js, and package-manager versions plus a committed lockfile;
- IL2CPP CI builds and runtime tests for every intended target;
- physical low-end Android and representative iOS runs;
- cold-start, final-binary-delta, steady-memory, GC-pause, frame-time, and bridge-volume measurements;
- repeated scene load/unload and at least 100 runtime reload cycles;
- tests at the highest intended managed-code stripping level;
- verified source maps and crash symbols;
- offline, timeout, cancellation, stale-state, and incompatible-contract behavior;
- actual Next.js WebGL embedding with timer, router, mount, teardown, and repeated-reload tests;
- negative tests attempting to escape the C# allowlist;
- SBOM and license review for the framework, runtime, native binaries, and npm graph; and
- explicit platform-policy review before any downloaded-script or mod capability.

## Uncertainty, exclusions, and revisit triggers

The evidence is mostly maintainer documentation, repository source, issue reports, release metadata, and GitHub activity. Source inspection is stronger than marketing text but weaker than building and observing the software. Issue reports show possible failure modes, not prevalence. GitHub activity does not prove support quality. Apple guidance is public policy text, not legal advice; confidential console requirements were unavailable.

Revisit this assessment when any of the following occurs:

- Money Noodle accepts a Unity interface scope with measurable device, frame, size, memory, offline, and platform targets;
- PuerTS materially changes its Unity backend, LTS line, supported-platform evidence, or maintenance profile;
- OneJS v3 accumulates sustained releases and physical Android/iOS, IL2CPP, WebGL-host, and lifecycle evidence, or changes its bridge/realm design;
- a framework becomes archived, changes license, or resolves a blocking security/sandbox limitation;
- Apple or a target console changes runtime-code policy; or
- a bounded spike produces reproducible target-platform evidence.

Until then: use C# as the Unity baseline, reject unity-jsb, treat TypeScript Importer only as a prototype utility, do not combine PuerTS with OneJS v3, and require a substantial target-platform spike before adopting PuerTS or a bounded UI-only spike before adopting OneJS.
