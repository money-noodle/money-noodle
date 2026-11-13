# API and web image package pins — repair qualification (November 13, 2026)

## Scope and authority

Rai approved this bounded repair on 2026-11-13T01:40:27Z: update the API and web image pins to patched packages, rebuild, re-run the required scans; no scanner exceptions, unrelated upgrades, merge or deployment. It repairs the `Scan image` failures on PR #275 and changes nothing about #243's forecast work. Head `133c32c` on `claim-v1/issue-243`; PR #275 still draft; #243 still open. No deployment, publication or provider effect: this record is build-and-scan evidence, not deployed evidence.

## Before

CI run [43344689328](https://github.com/money-noodle/money-noodle/actions/runs/43344689328) (head `bfb7577`), `container platform-api` and `container web`, step `Scan image` — three HIGH findings per image, `ignore-unfixed: true`, `severity: HIGH,CRITICAL`:

| Package | Advisory | Installed | Fixed (as trivy stated it) |
| --- | --- | --- | --- |
| `musl` | CVE-2026-107891 | 1.2.5-r12 | 1.2.5-r13 |
| `musl-utils` | CVE-2026-107891 | 1.2.5-r12 | 1.2.5-r13 |
| `zlib` | CVE-2026-85091 | 1.3.2-r0 | 1.3.2-r1 |

## Why the fix is a package pin, not a base-image digest

The pinned base `node:22.22.3-alpine3.22@sha256:cd7807368cf24826297cbad5dca1a44972ccfd770647db52a8c7589eb4599ac8` was verified current on Docker Hub and has no rebuilt digest available: the tags `22.22.3-alpine3.22`, `22.22-alpine3.22`, `22-alpine3.22` and `jod-alpine3.22` all resolve to that same digest, last pushed 2026-05-14T20:38Z, and the most recently rebuilt `*-alpine3.22` tag of any Node line is `26.3.0-alpine3.22` (2026-06-02), so the whole Alpine 3.22 line predates these advisories. A patched digest exists only on another Alpine line and only at a newer Node minor — `22.23.5-alpine3.23` (`sha256:6868d469…`, 2026-11-11) or `22.23.5-alpine3.24` (`sha256:1314fb30…`, 2026-11-12) — which is a broader change and would put the image's runtime ahead of `.nvmrc` and `engines.node`, both 22.22.3.

It is also not where these versions come from. Each runtime stage already installs an exact-version set (`apk add --no-cache --upgrade 'libcrypto3=…' 'libssl3=…' 'musl=…' 'musl-utils=…' 'zlib=…'`), which is why trivy reported exactly those versions rather than the base image's. The repair takes the patched versions in that same list, in `services/platform-api/Dockerfile` and `apps/web/Dockerfile` only.

## The version correction, measured

`zlib=1.3.2-r1`, the version trivy named, is no longer what the branch serves. The build measured it (run [43347793182](https://github.com/money-noodle/money-noodle/actions/runs/43347793182), identically in both jobs):

```
ERROR: unable to select packages:
  zlib-1.4-r0:
    breaks: world[zlib=1.3.2-r1]
    satisfies: libapk2-2.14.9-r3[so:libz.so.1]
               apk-tools-2.14.9-r3[so:libz.so.1]
```

So v3.22 serves zlib 1.4-r0, which supersedes the 1.3.2-r1 that fixes CVE-2026-85091, and apk states in the same message that it still provides `so:libz.so.1`, so the soname the image links against is unchanged. `musl` and `musl-utils` 1.2.5-r13 drew no complaint and resolved. The pin took 1.4-r0.

## After

CI run [43348432335](https://github.com/money-noodle/money-noodle/actions/runs/43348432335) (head `133c32c`): `container platform-api` **success**, `container web` **success**, `affected projects and repository gates` **success**, `secret scan` **success**. Delivery run [43348432334](https://github.com/money-noodle/money-noodle/actions/runs/43348432334): **success**.

Package versions actually installed, from the build log of both images (identical in each):

```
(1/5) Upgrading musl (1.2.5-r12 -> 1.2.5-r13)
(2/5) Upgrading libcrypto3 (3.5.6-r0 -> 3.5.9-r0)
(3/5) Upgrading libssl3 (3.5.6-r0 -> 3.5.9-r0)
(4/5) Upgrading zlib (1.3.2-r0 -> 1.4-r0)
(5/5) Upgrading musl-utils (1.2.5-r12 -> 1.2.5-r13)
```

Scan result, same settings as before, both images:

```
Detected OS  family="alpine" version="3.22.4"
[alpine] Detecting vulnerabilities...  os_version="3.22" repository="3.22" pkg_num=18
│ money-noodle/platform-api:local (alpine 3.22.4) │ alpine │ 0 │ - │
│ money-noodle/web:local (alpine 3.22.4)          │ alpine │ 0 │ - │
```

Zero findings, with the base image still `node:22.22.3-alpine3.22@sha256:cd7807368cf24826297cbad5dca1a44972ccfd770647db52a8c7589eb4599ac8` in the build log. No scanner, severity threshold, ignore file or suppression was touched, and no waiver was used.

## Not measured here

No build or scan ran in this session: no Docker daemon is reachable in it, and the Alpine package hosts (`dl-cdn.alpinelinux.org`, `pkgs.alpinelinux.org`, `secdb.alpinelinux.org` and a public mirror) are all refused by its network proxy, so package availability could not be checked ahead of the build. Every version fact above is from the hosted CI build and scan logs. Image-layer contents of the alternative base-image candidates were not inspected either: the registry rate-limited unauthenticated manifest pulls after the tag resolution above, and the candidates were ruled out on the digest and date evidence rather than on their contents.

## Pin consistency

`services/engine-jobs/Dockerfile` still pins `musl=1.2.5-r12`, `musl-utils=1.2.5-r12` and `zlib=1.3.2-r0` and was deliberately left alone: it is not built by the CI container matrix, so it is not part of this failure, and this run had no authority for a change beyond the two failing images. That is a known divergence. The engine-jobs image is built and scanned by `delivery.yml`'s publication path (`Scan the candidate digest before publication`, same trivy settings), whose jobs are skipped on a pull request, so the same two advisories will stop the engine-jobs image at publication until that file takes the same pins. Extending the repair there needs its own approval.
