# Working in this repository

Read this before changing anything. It is short on purpose.

## What this is part of

Audit is a component of **Pegma**, a family of MIT-licensed packages a host
application composes. Shared contracts live in `@pegma/spine`; persistence in
`@pegma/storage-core`; identity and permissions in
`@pegma/authorization-core`; a support desk and other components follow. They
publish under the `@pegma` scope, one repository per component.

The governing principle, which every rule below follows from:

> **Optimize for a fresh agent context window.** How much must be read to make
> a correct change, and how does the change prove itself correct? Minimize the
> first, mechanize the second.

This package is small and its whole value is a promise about atomicity. A
change that quietly weakens that promise is worse than no package at all,
because every component that adopted it believed the promise.

## Hard rules

**Never own a store, a collection, or a partition.** Audit records live in the
caller's collection, in the caller's partition, written by the caller's
`transact`. A storage-core transaction is scoped to one collection and one
partition, so the moment this package writes somewhere of its own, an audit
record no longer commits with the change it describes. There is no version of
"a collection just for audit" that keeps the guarantee. If a change here needs
a `Store`, the design is wrong; take a `CollectionStore` the caller already
built and act on the partition the caller names.

**Append-only means append-only.** Nothing in this package may update or delete
an event, with exactly one exception: the retention sweep, which removes whole
events that have outlived a caller-declared bound. There is no correction, no
redaction, no edit-in-place. A mistaken event is followed by a compensating
event, never overwritten.

**The event id is caller-supplied and idempotency depends on it.** The record
id derives from the event id and nothing else, so a replay is refused by the
storage key rather than by a check here. Never fold a timestamp, a sequence, or
a hash of the payload into the record id: the moment the id depends on anything
but `event.id`, a retry with the same id writes a second copy. Say this in the
documentation of anything that mints ids on a caller's behalf, because a caller
that generates a fresh id per attempt gets duplicates and it is not this
package's fault or its problem to detect.

**Promise no tamper-evidence.** There is no signing, no hash chain, no
append-only enforcement below this package, and no detection of a record edited
directly in the backend. Anyone with write access to the store can rewrite
history. Do not add a field, a name, or a sentence that implies otherwise —
`sequence` is an ordering hint, not a gapless-chain guarantee, and a gap in it
proves nothing.

**Import shared types from spine, never redeclare.** `PrincipalId` and
`IsoTimestamp` come from `@pegma/spine`. A principal that
`@pegma/authorization-core` resolved has to be the same value this package
audits, and a local `type PrincipalId = string` makes that agreement a
coincidence rather than something the compiler checks.

**Never write literal control characters into source.** Write them as escape
sequences such as backslash-u-0000 through backslash-u-001F, and verify the
bytes after any tool-assisted edit. Tooling has silently turned those escapes
into actual control characters more than once across this ecosystem, and it
happened again while writing `KEY_ESCAPES` in this package's first commit,
producing a regex that reads correctly and matches the wrong thing. After
editing anything containing an escape sequence, run a byte check rather than
trusting what the editor renders.

## Packaging traps already paid for

Each published package needs its **own** README and LICENSE inside the package
directory; npm ignores files at the repository root, and the package page
renders blank without them. Each needs `prepack` running the build, or a stale
`dist` ships silently. Each package `tsconfig.json` must exclude
`src/**/*.test.ts`, or compiled tests are published to consumers.

Dependencies on sibling `@pegma` packages are pinned exactly, not with a range.
The ecosystem is `0.x` and a minor bump is allowed to break; a caret would let
CI resolve a version nobody tested against.

## Workflow

Work on a `claude/*` branch and open a pull request. The gate is
`npm run format:check`, `npm run check`, `npm test` — all three, on Node 22 and 24. Tests run against `createMemoryStore()` from `@pegma/storage-core`, which
enforces the same transaction and concurrency rules a real backend does, so a
behaviour proved there holds in production.

Every test that matters here is a test about atomicity. When adding behaviour,
ask what happens when the caller's transaction is refused, and assert that this
package left nothing behind.

Publishing is trusted-publisher only; no tokens exist. Follow
`docs/RELEASING.md`: create and push a signed annotated version tag already on
`origin/main`, then publish the GitHub release for that existing tag. The
workflow prepares and verifies the package without OIDC, and the minimal
environment-scoped publish job receives OIDC only for the exact prepared
tarball. Never add a token fallback or an unprotected manual publish path.

## Where things stand

`@pegma/audit` is published at `0.1.0`. It offers the event type and its codec,
`defineAudit` binding the package to a caller's records, `action` for the
atomic case, `append` for the case with no accompanying state change, `history`,
and `sweep`.

Known gaps, in the order they are likely to matter:

- No consumer has migrated onto it yet. `@pegma/authorization-core` and the
  support desk each built this independently; until at least one of them is
  actually using this package, the shape is a hypothesis.
- Reads are one partition at a time. There is no query by actor, action, or
  time range, because storage-core offers no server-side filter and a secondary
  index would be a second collection with its own atomicity problem.
- No retention policy type. A caller passes a bound to `sweep` and owns the
  schedule.

Siblings: [spine](https://github.com/pegma-dev/spine),
[storage-core](https://github.com/pegma-dev/storage-core),
[authorization-core](https://github.com/pegma-dev/authorization-core), and the
organization profile at [github.com/pegma-dev](https://github.com/pegma-dev).
