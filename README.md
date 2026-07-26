# Audit

[![CI](https://github.com/pegma-dev/audit/actions/workflows/ci.yml/badge.svg)](https://github.com/pegma-dev/audit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Append-only audit records for [Pegma](https://pegma.dev) components, written in
the same transaction as the change they describe.

> [!IMPORTANT]
> Audit is in early `0.x` development. Its public API is not stable, its
> package is not published, and it is not ready for production use.

## Why it exists

Two components built this independently. `@pegma/authorization-core` needed to
record who granted a role and when, and put the audit record in the same
single-partition transaction as the assignment so the two could never disagree.
The support desk needed the same thing for ticket events, and wrote its own.
Two implementations of the same idea, differing in field names rather than in
substance, is the signal that it belongs in one place.

## The constraint that shapes everything

An audit record has to land atomically with the state change it describes. If
the change commits and the record does not, history is wrong in the direction
that matters: something happened and nothing says so.

A `@pegma/storage-core` transaction is scoped to **one collection and one
partition**. That is not an implementation detail — it is the guarantee every
backend worth targeting actually offers, from Azure entity-group transactions
to a SQL statement batch.

So an audit package that owned a store, or even just a collection, could not be
atomic with anything. A separate collection is a separate partition, and the
two writes would commit separately or not at all.

This package therefore owns **no store, no collection, and no partition**. It
owns the event type, its encoding, and a transaction action you drop into your
own `transact` call.

## Using it

Declare an audit member in your own record union, in the collection you already
have, keyed into the partition that already holds everything about the subject.

```ts
import {
  auditRecordId,
  decodeAuditEvent,
  defineAudit,
  encodeAuditEvent,
  type AuditEvent,
} from "@pegma/audit";
import { defineCollection } from "@pegma/storage-core";

type AccountRecord =
  | { kind: "member"; accountId: string; memberId: string; role: string }
  | { kind: "audit"; accountId: string; event: AuditEvent };

const accountRecords = defineCollection<AccountRecord>({
  name: "account_records",
  key: (record) => ({
    partition: `account|${record.accountId}`,
    id:
      record.kind === "member"
        ? `member|${record.memberId}`
        : auditRecordId(record.event.id),
  }),
  codec: {
    encode: (record) =>
      record.kind === "member"
        ? { ...record }
        : {
            kind: "audit",
            accountId: record.accountId,
            ...encodeAuditEvent(record.event),
          },
    decode: (record) =>
      record["kind"] === "member"
        ? {
            kind: "member",
            accountId: String(record["accountId"]),
            memberId: String(record["memberId"]),
            role: String(record["role"]),
          }
        : {
            kind: "audit",
            accountId: String(record["accountId"]),
            event: decodeAuditEvent(record),
          },
  },
});

const audit = (accountId: string) =>
  defineAudit<AccountRecord>({
    collection: accountRecords,
    toRecord: (event) => ({ kind: "audit", accountId, event }),
    toEvent: (record) => (record.kind === "audit" ? record.event : null),
  });
```

Then the membership change and the record of it commit together, or neither
does:

```ts
const records = store.collection(accountRecords);
const log = audit("acct_1");

const outcome = await records.transact("account|acct_1", [
  {
    action: "insert",
    value: {
      kind: "member",
      accountId: "acct_1",
      memberId: "mem_1",
      role: "support",
    },
  },
  log.action({
    id: requestId, // yours, and the whole of the idempotency contract
    occurredAt: clock.now(),
    actor: { kind: "principal", principalId: "prn_admin" },
    action: "account.member.added",
    subject: "mem_1",
    details: { role: "support" },
  }),
]);
```

If the transaction is refused, there is no orphan audit record. That is the
only thing this package really promises, and it is tested directly.

## Reading and sweeping

```ts
// Oldest first: by sequence when events carry one, then by occurredAt, then id.
const history = await log.history(records, "account|acct_1", {
  subject: "mem_1",
});

// The only operation here that deletes anything.
const swept = await log.sweep(records, "account|acct_1", {
  before: "2026-01-01T00:00:00.000Z",
  limit: 500,
});
```

For an event with no accompanying state change — a sign-in, a failed permission
check — `append` writes on its own with `insertIfAbsent`, so a replay of the
same event id is a no-op. Use it only when there really is no state change; it
cannot be part of your transaction.

## What it deliberately does not do

- **No tamper-evidence.** No signing, no hash chain, no detection of a record
  edited directly in the backend. Anyone with write access to the store can
  rewrite history. This is a record of what happened, useful because writing it
  is atomic — not a proof that nobody changed it.
- **No global ordering.** Events are ordered within one subject. There is no
  cross-subject or cross-partition sequence, and comparing timestamps from two
  servers compares two clocks.
- **No log shipping.** Nothing forwards to SIEM, object storage, or a
  warehouse. Records sit in your collection and are read from it.
- **No query but the subject partition.** No search by actor, action, or time
  range, because storage-core offers no server-side filter and a secondary
  index would be a second collection with the atomicity problem this package
  exists to avoid.
- **No retention policy.** You pass `sweep` a bound and own the schedule.

## Development

Audit requires Node.js 22 or newer.

```sh
npm ci
npm run format:check
npm run check
npm test
```

## License

MIT. Copyright (c) 2026 RetireGolden, LLC.
