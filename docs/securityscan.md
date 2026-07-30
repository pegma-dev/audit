# Security Scan

Repository-wide security review of `@pegma/audit`, conducted 2026-07-28.
Findings were appended as they were discovered during the scan.

## Scope

- `packages/audit/src/` — library source (event codec, `defineAudit`, `action`, `append`, `history`, `sweep`)
- `scripts/` — release tooling
- `tests/` — release tooling tests
- `.github/workflows/` — CI / publish workflows
- Packaging and dependency configuration

## Summary

| #   | Severity      | Finding                                                                                        | Disposition |
| --- | ------------- | ---------------------------------------------------------------------------------------------- | ----------- |
| 1   | Low           | `__proto__` keys in `details` are silently dropped by the codec                                | ✅ Resolved |
| 2   | Low           | `occurredAt` accepts non-ISO-8601 strings despite the `IsoTimestamp` contract                  | ✅ Resolved |
| 3   | Low           | `decodeAuditEvent` decodes malformed records into plausible events instead of failing          | ✅ Resolved |
| 4   | Low           | Release validation requires `prepack` but does not forbid other install-time lifecycle scripts | ✅ Resolved |
| 5   | Low           | Windows fallback in `runNpm` uses `shell: true` with unescaped arguments                       | ✅ Resolved |
| 6   | Low           | Release workflow installs `npm@11.18.0` without an integrity pin                               | ✅ Resolved |
| 7   | Informational | `sweep` `limit` of `NaN` bypasses the positive-number guard                                    | ✅ Resolved |
| 8   | Informational | Smoke test installs sibling dependencies from the registry without a lockfile                  | ⚠️ Disputed |
| 9   | Informational | Unbounded in-memory partition reads in `history` and `sweep`; unbounded `details` size         | ⚠️ Disputed |
| 10  | Informational | `exports` target recursion in release validation is unbounded                                  | ⚠️ Disputed |

**No high, medium, or critical vulnerabilities were found.** `npm audit`
reports zero known vulnerabilities across 103 dependencies. All 24 tests passed
at scan time; the baseline after the 2026-07-29 fixes is 30/30, recorded under
[Test baseline](#test-baseline).

Every finding was re-examined against the code on 2026-07-29 and dispositioned
below: seven were fixed, three were disputed. Each disputed item says why the
observation, though accurate as a description, is not a weakness to close.

The package's central security claims were verified and held up:

- Record ids derive from the event id alone; `KEY_ESCAPES` escaping is
  single-pass with `%` in the escape class, so the mapping is injective — no
  key collision or key-injection path was found (verified by reading the
  escaping logic and by byte-checking the source, which contains the control
  ranges as `\uXXXX` escape sequences, not literal control characters).
- `sweep` deletes via `deleteIfUnchanged` (version-checked), so the
  list-then-delete window cannot discard a write that lands between
  enumeration and deletion.
- Nothing in the package updates an existing event; the only delete path is
  the retention sweep, as documented.
- The publish pipeline enforces a signed annotated tag, commit equality
  between checkout/tag/release event, ancestry on `origin/main`, an
  allowlisted tarball content set, hash equality between the tarball and both
  npm's pack metadata and the prepared manifest, and OIDC-only publishing from
  a protected environment with no token fallback. The workflow additionally
  has a regression test asserting the OIDC-enabled job never installs
  dependencies.

## Findings

### 1. Low — `__proto__` keys in `details` are silently dropped

✅ Resolved 2026-07-29 — `requireDetails` builds its copy with
`Object.defineProperty` instead of plain assignment, so a key that names an
inherited accessor is stored rather than swallowed by the setter.

**File:** `packages/audit/src/index.ts` — `requireDetails` (lines 189-209),
reached from both `auditEvent` (encode path) and `decodeDetails` (decode
path, lines 264-280).

**Evidence.** `requireDetails` copies the details bag with ordinary
assignment into a plain object:

```ts
const copied: Record<string, AuditDetail> = {};
for (const key of Object.keys(details).sort()) {
  ...
  copied[key] = value;
}
```

`JSON.parse` creates `__proto__` as an own enumerable property, and
`copied["__proto__"] = value` invokes the inherited `__proto__` setter on
`Object.prototype` instead of storing the key. Reproduced against the built
`dist/index.js`:

- `{"__proto__": "polluted", "safe": 2}` decodes to details with keys
  `["safe"]` — the `__proto__` key is silently lost (setter ignores
  primitives but still swallows the assignment).
- `{"__proto__": null, ...}` sets the intermediate copy's prototype to
  `null` before `Object.freeze`.
- `Object.prototype` is **not** polluted globally in any case (verified).

**Exploitability.** Not exploitable for prototype pollution: values are
validated as scalars before assignment, so an attacker cannot get an object
onto a prototype, and the affected object is a transient copy. The practical
impact is integrity: a caller (or a stored record) carrying a legitimate
`__proto__` detail key loses it silently, and the event round-trips with
different bytes than were submitted. Writing a crafted `details` field
directly requires backend write access, which `SECURITY.md` already places
outside the threat model; a caller can also hit this with no attacker
involved.

**Recommendation.** Build the copy with `Object.defineProperty`, or copy via
`Object.fromEntries` onto `Object.create(null)`, so every own key survives
regardless of name.

### 2. Low — `occurredAt` accepts non-ISO-8601 strings

✅ Resolved 2026-07-29 — `requireTimestamp` now requires an ISO 8601 date-time
shape (UTC designator or numeric offset), a day-of-month that exists in its
month, and a parsable instant, so `March 3, 2020`, `2026-07-26`, and
`2026-02-30T00:00:00Z` (which `Date.parse` silently normalizes to March 2) are
all refused.

**File:** `packages/audit/src/index.ts` — `requireTimestamp` (lines 155-161).

**Evidence.** Validation is `Number.isNaN(Date.parse(text))`. `Date.parse`
accepts implementation-specific formats, not just ISO 8601 — reproduced:
`auditEvent({ occurredAt: "March 3, 2020", ... })` is **accepted** and stored
verbatim, despite the `IsoTimestamp` type and the error message claiming
"must be an ISO 8601 timestamp".

**Exploitability.** No direct exploit; the value is caller-supplied and the
caller is trusted to generate timestamps from a server clock (`SECURITY.md`).
The risk is data quality in a permanent record: a caller bug produces
non-ISO timestamps that downstream consumers parsing strictly as ISO 8601
will reject or misread, and sorting still uses lenient `Date.parse`, masking
the problem. Because events are append-only, bad values cannot be corrected,
only compensated.

**Recommendation.** Validate against an ISO-8601 regex (or round-trip through
`Date#toISOString`) in addition to `Date.parse`.

### 3. Low — `decodeAuditEvent` decodes malformed records into plausible events

✅ Resolved 2026-07-29 — stored fields must be non-empty strings and the stored
actor kind must be exactly `principal` or `system`; a malformed row now raises
`AuditError` instead of being coerced with `String(...)`.

**File:** `packages/audit/src/index.ts` — `decodeAuditEvent` (lines 283-301).

**Evidence.** Two lenient coercions:

- `actor.kind` is treated as `"principal"` for **any** stored value other
  than `"system"` (lines 289-295) — a corrupted or unknown `auditActorKind`
  silently becomes a principal event.
- Fields are coerced with `String(...)` (lines 287-297), so a stored `null`
  actor id becomes the string `"null"`, which passes `requireText` as a
  non-empty string.

**Exploitability.** Producing such a record requires direct backend write
access, which `SECURITY.md` explicitly places outside the threat model ("no
detection of a record edited directly in the backend"). Within the stated
model the impact is limited to masking corruption: `history` and `sweep`
surface a fabricated-looking event rather than an `AuditError`, which can
mislead an investigation — the exact scenario audit records feed.

**Recommendation.** Reject unknown `auditActorKind` values and missing actor
id fields with `AuditError` instead of coercing.

### 4. Low — Release validation requires `prepack` but does not forbid other lifecycle scripts

✅ Resolved 2026-07-29 — `validateRepository` refuses a published manifest that
defines `preinstall`, `install`, or `postinstall`, via a `findInstallTimeScript`
helper with its own unit test.

**File:** `scripts/release-packages.mjs` — `validateRepository`
(lines 177-185).

**Evidence.** The validation asserts `manifest.scripts.prepack` exists and
includes `"build"`, but places no constraint on the rest of `scripts`. A
`postinstall` (or `preinstall`/`install`) entry added to
`packages/audit/package.json` would pass every check, ship inside the
tarball (`package.json` is always packed), and execute on every consumer's
`npm install`. The smoke test installs with `--ignore-scripts`
(line 292-302), so it would not execute or reveal such a script either.

**Exploitability.** Requires landing a malicious change on `main` and getting
it into a signed release — the pipeline's signed-tag and review controls are
the real barrier. But the purpose of `validateRepository` is to mechanically
reject unsafe package metadata, and it already inspects `scripts`; the
absence of a denylist for install-time hooks is a gap in that mechanical
net. Consumer impact of a successful insertion is arbitrary code execution
at install time across all downstream hosts.

**Recommendation.** Extend `validateRepository` to reject any lifecycle
script that runs at install time on consumers (`preinstall`, `install`,
`postinstall`), keeping only build-time hooks such as `prepack`.

### 5. Low — Windows fallback in `runNpm` uses `shell: true` with unescaped arguments

✅ Resolved 2026-07-29 — the fallback is removed rather than quoted: `runNpm`
requires `npm_execpath` (which every release entry point, being an npm script,
always sets) and never builds a shell command line. Note that the alternative
recommendation is not implementable — since the fix for CVE-2024-27980, Node
refuses to spawn `npm.cmd` without `shell: true` (`EINVAL`), and Node now
deprecates passing arguments alongside `shell: true` (DEP0190) for exactly the
reason given here.

**File:** `scripts/release-packages.mjs` — `runNpm` (lines 61-69), callers
pass operator-supplied paths (`--root` → `packageDirectory`, `--output`,
tarball paths).

**Evidence.** When `npm_execpath` is unset, Windows falls back to
`run("npm.cmd", args, { shell: true })`. With `shell: true`, Node concatenates
arguments into a `cmd.exe` command line without escaping, so `&`, `%`, `^`,
and quotes in an argument are interpreted by the shell.

**Exploitability.** Low. In CI the script is always invoked via
`npm run release:*`, which sets `npm_execpath`, taking the safe
`process.execPath` + no-shell path — and the runners are Linux anyway.
Locally, the arguments come from the operator running the release, so
exploitation means tricking a maintainer into copy-pasting a crafted
`--output`/`--root` value on Windows. No remote trigger exists.

**Recommendation.** Avoid the shell entirely: resolve `npm.cmd` and invoke it
via `execFileSync`-style spawn without `shell`, or drop the fallback and
require `npm_execpath`.

### 6. Low — Release workflow installs `npm@11.18.0` without an integrity pin

✅ Resolved 2026-07-29 — the workflow downloads the npm CLI tarball over HTTPS
and verifies its `sha512` against `REVIEWED_NPM_INTEGRITY` in
`scripts/release-packages.mjs` (`release-packages.mjs verify-npm`) before
installing it, so a substituted tarball fails before it can build anything. A
test asserts the workflow uses the reviewed constants and no longer installs the
bare registry spec.

**File:** `.github/workflows/publish.yml` line 57 (`npm install --global
npm@11.18.0`); `scripts/release-packages.mjs` lines 21, 157-161, 403-415.

**Evidence.** The npm CLI that builds the release tarball is fetched from the
registry at release time. The version is pinned and re-validated
(`REVIEWED_NPM_VERSION`, `requireTrustedPublishingNpm`), but no expected
`dist.integrity` is checked — a registry compromise or a poisoned registry
response serving a trojaned `npm@11.18.0` tarball would not be detected, and
that CLI produces the artifact the rest of the pipeline verifies (the hash
checks are self-consistent within metadata the same tool produced).

**Exploitability.** Requires compromise of, or MitM against, the npm registry
as seen by GitHub-hosted runners. The blast radius is bounded by the fact
that the tarball content still derives from the signed tag's source (a
trojaned npm would have to inject code during pack), and publishing still
requires the protected-environment OIDC identity — but a trojaned build tool
in the prepare job is precisely the supply-chain vector this pipeline
otherwise defends against.

**Recommendation.** Record the reviewed `dist.integrity` for `npm@11.18.0`
alongside `REVIEWED_NPM_VERSION` and verify the downloaded tarball against it
(e.g. `npm view npm@11.18.0 dist.integrity` compared to the reviewed constant
after install, or a corepack-style pinned installer).

### 7. Informational — `sweep` `limit` of `NaN` bypasses the guard

✅ Resolved 2026-07-29 — `sweep` validates a supplied `limit` as a positive safe
integer rather than by comparison, so `NaN` (and a fraction) is refused and the
bound on a permanent deletion always holds.

**File:** `packages/audit/src/index.ts` lines 493-496. `NaN <= 0` is `false`,
so `limit: NaN` passes validation; `deleted >= NaN` is always `false`, so the
limit never binds and one call sweeps the entire partition. Caller-supplied
and self-inflicted only; noted because `limit` exists to bound the cost of
one call, and a caller bug silently removes the bound. A
`Number.isFinite`/`Number.isInteger` check would close it.

### 8. Informational — Smoke test installs sibling dependencies without a lockfile

⚠️ Disputed 2026-07-29 — not a valid finding: the description is accurate but
there is no weakness to close, and the report itself recommends no change. The
prepare job holds no secrets and no OIDC token, `--ignore-scripts` blocks
install-time hooks, and — checked against the code — `prepareRelease` hashes the
tarball _before_ `smokeTestTarball` runs while `verifyPreparedManifest` re-hashes
it in the publish job, so code executed during the smoke test cannot alter what
is published without failing the release. A lockfile would also not add a
guarantee: the sibling versions are already exact-pinned in
`packages/audit/package.json`, and committing a second lockfile for a throwaway
temporary project would duplicate that pin without narrowing the trust in the
registry that `npm ci` already places one step earlier.

**File:** `scripts/release-packages.mjs` — `smokeTestTarball` (lines 285-319).
The temp project has no lockfile; `npm install <tarball>` resolves
`@pegma/spine` and `@pegma/storage-core` from the registry (exact-pinned, so
the version is deterministic, but the bytes are whatever the registry serves)
and the smoke test then imports the package, executing module top-level code.
Contained by design: the prepare job has no OIDC token and no secrets, and
`--ignore-scripts` blocks install-time hooks. No change recommended beyond
awareness that the smoke test is a registry-trust point.

### 9. Informational — Unbounded in-memory reads and `details` size

⚠️ Disputed 2026-07-29 — not a valid finding: neither quantity is
attacker-amplified, and neither can be bounded here without breaking a stated
design rule. `history` and `sweep` read one partition because storage-core's
`list` is explicitly unordered with no server-side filter or pagination;
bounding a read would require a secondary index, which is a second collection
with its own atomicity problem — the one change `AGENTS.md` says the design
cannot absorb. The partition name and the `details` contents are both chosen by
the trusted caller, and `SECURITY.md` already assigns partition choice, read
authorization, and `details` hygiene to the host. `AGENTS.md` documents
one-partition-at-a-time reads as a known gap, so this is a design consequence
already written down rather than an oversight.

**File:** `packages/audit/src/index.ts` — `history` (lines 481-487) and
`sweep` (lines 502-525) load an entire partition into memory; `details` has
no size bound before `JSON.stringify` (line 260). Both are caller-controlled
resources (the caller chooses partitions and writes details), and the
partition-scoped design is documented. Worth documenting that a very large
partition makes each `history`/`sweep` call O(partition) in memory, and that
oversized `details` bags are stored and returned whole to every reader.

### 10. Informational — Unbounded recursion in `exportTargets`

⚠️ Disputed 2026-07-29 — not a valid finding: `exportTargets` only ever walks
the `exports` object of `packages/audit/package.json`, a repository-controlled
file authored by maintainers and reviewed before merge, so no untrusted input
reaches it. A stack overflow would abort validation and fail the release closed,
which is the direction a release check should fail. The report classifies this as
a robustness note rather than a vulnerability, and adding a depth cap would add a
branch guarding against a manifest nobody can supply.

**File:** `scripts/release-packages.mjs` lines 82-88. A deeply nested
`exports` object could overflow the stack during validation. The manifest is
repository-controlled and validated in CI, so this is a robustness note only.

## Areas reviewed with no findings

- **Idempotency contract** — record id derives solely from `event.id`;
  `action` uses `insert` inside the caller's transaction, `append` uses
  `insertIfAbsent`. No timestamp/sequence/payload folds into the key.
- **Key escaping** — injective, single-pass; byte-check confirmed no literal
  control characters in `KEY_ESCAPES`.
- **Append-only guarantee** — no update path exists; `sweep` is the sole
  delete and is version-conditional.
- **No owned store/collection/partition** — the package acts only on the
  caller's `CollectionStore`, preserving atomicity.
- **Shared types** — `PrincipalId`/`IsoTimestamp` imported from
  `@pegma/spine`; no local redeclarations.
- **Packaging** — per-package README/LICENSE present; `prepack` builds;
  tests excluded from `tsconfig`; sibling deps pinned exactly; `files`
  allowlist and packed-file verification prevent shipping `src/`, tests, or
  secrets.
- **CI workflows** — actions pinned by SHA; least-privilege `permissions`;
  no script interpolation of event data (tag/commit flow through env vars);
  OIDC confined to the environment-scoped publish job; no token fallback;
  no `workflow_dispatch` publish path (asserted by test).
- **Release script core** — annotated-tag requirement, signature
  verification against an allowed-signers file, commit/tag/event equality,
  `origin/main` ancestry, tarball hash equality (timing-safe comparisons),
  tarball-name and path traversal checks in `verifyPreparedManifest`,
  registry-integrity comparison refusing to overwrite a differing published
  version.
- **Secrets sweep** — repository-wide scan for keys/tokens/credentials found
  only documentation references; `.gitignore` excludes `.env*`.
- **Dependencies** — `npm audit`: 0 vulnerabilities (103 deps); sibling
  `@pegma` packages resolve to exact pinned versions with registry integrity
  hashes in `package-lock.json`.
- **Tracked files** — `dist/`, `.release/`, and `*.tsbuildinfo` are
  gitignored, not committed.

## Test baseline

`npm test` at scan time: 24/24 passing (Node 24.18.0).

After the 2026-07-29 fixes: 30/30 passing (Node 24.18.0). The six added tests
cover the `__proto__` detail key round trip, a timestamp only `Date.parse` would
accept, a stored row that cannot be read faithfully, a `sweep` limit that would
not bound the deletion, install-time lifecycle scripts, and the npm CLI
integrity pin.
