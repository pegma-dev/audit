# @pegma/audit

Append-only audit records for [Pegma](https://pegma.dev) components, written in
the same transaction as the change they describe.

> [!IMPORTANT]
> Audit is in early `0.x` development. Its public API is not stable and it is
> not ready for production use.

## The constraint that shapes everything

An audit record has to land atomically with the state change it describes. If
the change commits and the record does not, history is wrong in the direction
that matters.

A `@pegma/storage-core` transaction is scoped to **one collection and one
partition** — the guarantee every backend worth targeting actually offers. So
an audit package that owned a store, or even just a collection, could not be
atomic with anything: a separate collection is a separate partition.

This package therefore owns **no store, no collection, and no partition**. It
owns the event type, its encoding, and a `TransactionAction` you drop into your
own `transact` call.

## Install

```sh
npm install @pegma/audit
```

## Use

Declare an audit member in your own record union, keyed into the partition that
already holds everything about the subject.

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

const log = defineAudit<AccountRecord>({
  collection: accountRecords,
  toRecord: (event) => ({ kind: "audit", accountId: "acct_1", event }),
  toEvent: (record) => (record.kind === "audit" ? record.event : null),
});
```

The membership change and the record of it now commit together, or neither
does:

```ts
const records = store.collection(accountRecords);

await records.transact("account|acct_1", [
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

## Reading and sweeping

```ts
// Oldest first: by sequence when events carry one, then occurredAt, then id.
const history = await log.history(records, "account|acct_1", {
  subject: "mem_1",
});

// The only operation here that deletes anything.
await log.sweep(records, "account|acct_1", {
  before: "2026-01-01T00:00:00.000Z",
  limit: 500,
});
```

`append` covers the case with no accompanying state change — a sign-in, a
failed permission check. It writes on its own with `insertIfAbsent`, so a
replay of the same event id is a no-op. It cannot be part of your transaction,
so use `action` whenever there is a state change.

## Limits

No tamper-evidence, no signing, no hash chain: anyone with write access to the
store can rewrite history. No ordering across subjects. No log shipping or SIEM
integration. No query but the subject partition. No retention policy — you pass
`sweep` a bound and own the schedule.

## License

MIT. Copyright (c) 2026 RetireGolden, LLC.
