# Contributing to Audit

Thank you for helping improve Audit.

## Before opening an issue

- Search existing issues for related work.
- Use GitHub's private vulnerability reporting flow for security concerns.
- Describe the record you need to keep and when it must be durable, not only
  the API shape you would like.
- If a proposal needs this package to own a store, a collection, or a
  partition, say so explicitly — that is the one change the design cannot
  absorb, and it deserves a direct argument rather than an incidental one.

## Local development

Audit requires Node.js 22 or newer. Enable Corepack so the pinned pnpm is
used.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm run check
pnpm test
pnpm run format:check
```

## Pull requests

Keep pull requests focused. Include:

- the problem being solved;
- the intended component behavior;
- tests for new behavior;
- documentation for public API changes;
- the atomicity consequence, if there is one.

Any change to how records are written must include a test that refuses the
caller's transaction and asserts that no audit record survives. That is the
property this package exists to provide, and it is the one that fails silently.

Changes to public contracts should explain their migration impact while the
project is in `0.x`.

## Project conventions

- This package owns no store, no collection, and no partition. Records live in
  the caller's collection and the caller's partition.
- Append-only means append-only: nothing updates or deletes an event except the
  retention sweep.
- The record id derives from the caller-supplied event id and nothing else.
- Shared types come from `@pegma/spine`. Never redeclare `PrincipalId` or
  `IsoTimestamp` locally.
- Sibling `@pegma` dependencies are pinned exactly, not with a range.
- Never claim tamper-evidence, signing, or gapless ordering.
- Never write literal control characters into source; use escape sequences and
  verify the bytes after any tool-assisted edit.
- Avoid adding a production dependency when a small local implementation is
  sufficient.

## Commits

Use concise, imperative commit subjects. The project uses pull requests and
squash merging, so a clean pull-request description matters more than an
elaborate local commit history.

By contributing, you agree that your contributions are licensed under the
project's MIT License.
