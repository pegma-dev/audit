# Audit Project Plan

## Status

**Stage:** Phase 1 complete; awaiting the first real consumer
(`0.1.0` published, public API unstable)

**Initial reference application:** RetireGolden, through
`@pegma/authorization-core` and the Pegma support desk

**License:** MIT

**Naming and origin:** This component was extracted on 2026-07-26 because
`@pegma/authorization-core` and the Pegma support desk had each independently
built the same thing. Authorization Core kept a `StoredAudit` position beside
every role assignment, in the same partition, so an audited grant or revoke
committed in one transaction. The support desk kept ticket events and
documented that persistence layers "should record the event in an append-only
audit log". Two implementations of the same idea, differing in field names
rather than in substance, is the signal that it belongs in one place. The git
history begins at that extraction, and nothing was ever published under another
name.

**Storage:** `@pegma/audit` declares no collection of its own. It depends on
`@pegma/storage-core` for the transaction action type and the store interfaces
its readers take, and on `@pegma/spine` for `PrincipalId` and `IsoTimestamp`.
Both dependencies are pinned exactly.

Audit will stay an embedded TypeScript library. A separate audit service is not
in scope and probably never will be: the whole point of this design is that an
audit record is written by the component that made the change, in the same
transaction, and a service call cannot be part of that transaction.

## Vision

Every Pegma component eventually needs to answer "who did this, when, and
what did it change?" Each one should answer it the same way, with the same
field names, the same idempotency rule, and the same honest limits — so that a
host application reading two components' histories is reading one thing.

An audit record should be as reliable as the change it describes. Not more
reliable, which is impossible, and not less, which is what happens when audit
is a second write that can fail on its own.

## Problem statement

Components that keep state also need to keep a record of how it got that way.
Written naively, that record is a second write after the first, and the gap
between them is where the interesting failures live: the change commits, the
process dies, and nothing says what happened. Or the record commits, the change
is rolled back, and history claims something that never occurred.

The obvious fix — put both writes in one transaction — collides with the
obvious factoring. An audit package that owns its own store or its own
collection cannot be in the caller's transaction, because a
`@pegma/storage-core` transaction is scoped to one collection and one
partition. So the two components that needed audit each solved it locally, by
putting an audit record in their own partition, and ended up with two
vocabularies for one concept:

- different names for the actor, the time, and the thing acted upon;
- different idempotency rules, one keyed on a caller-supplied event id and one
  not;
- different ordering stories, one per-assignment sequence and one wall clock;
- retention implemented in neither.

A host application that composes both then has two audit trails it cannot read
together, and any third component starts the same exercise from scratch.

## Core model

### Event

An event is one thing that happened, kept forever (or until retention removes
it whole). It carries:

| Field        | Meaning                                                              |
| ------------ | -------------------------------------------------------------------- |
| `id`         | Caller-supplied, opaque. The entire idempotency contract.            |
| `occurredAt` | `IsoTimestamp` from `@pegma/spine`, from the caller's clock.         |
| `actor`      | A principal or a system.                                             |
| `action`     | Dotted name, e.g. `authorization.role_assignment.granted`.           |
| `subject`    | What the event concerns: a ticket id, an assignment id, a member id. |
| `sequence`   | Optional per-subject ordinal, when the caller has one.               |
| `details`    | Optional small bag of scalars, for a reader rather than a query.     |

### Event id and idempotency

The record id derives from the event id and nothing else. A replay is therefore
refused by the storage key rather than by a check inside this package, which
means idempotency holds identically whether the write arrived inside a
transaction or on its own.

This puts a real obligation on the caller: an id must be stable across retries
of the same logical operation. A caller that mints a fresh id per attempt gets
duplicate events, and nothing here can detect that.

### Actor

Generalized from `RoleAssignmentActor`, which Authorization Core already used:
a principal (carrying a `PrincipalId` from `@pegma/spine`) or a system
(carrying an opaque `systemId` for a background job, a migration, or a
webhook processor).

### Subject and partition

A subject's history is read from one partition. That is the only access path,
and it is the reason the caller chooses the partition rather than this package:
the audit record has to live where everything else about the subject already
lives.

### Ordering

Events sort by `sequence` when they carry one, then `occurredAt`, then `id`.
Sorting happens in this package, not the backend: `storage-core` `list` is
explicitly unordered and there is no server-side sort to ask for.

`sequence` dominates deliberately. `occurredAt` comes from whichever server
handled the request, and two servers do not agree; a caller that has a real
per-subject ordinal should not have it overridden by clock skew.

## Design decisions

### Atomicity: this package owns no store, no collection, and no partition

**Decided 2026-07-26, and the reason the package has the shape it has.**

An audit record almost always has to be written atomically with the state
change it describes. A `@pegma/storage-core` transaction is scoped to one
collection and one partition — not as an implementation detail, but because
that is the guarantee every backend worth targeting actually offers, from Azure
entity-group transactions to a SQL statement batch.

It follows directly that `@pegma/audit` cannot own a store or a collection and
still be atomic. A collection of its own would be a partition of its own, and a
write there would commit separately from the caller's change, or not at all.
There is no clever arrangement that recovers this: it is a property of the
storage port, and the storage port is honest about what backends can do.

So the package does not expose `append()` against a store of its own. It
exposes:

1. the event type and its codec, `encodeAuditEvent` / `decodeAuditEvent`,
   which the caller splices into its own collection codec;
2. `defineAudit(projection)`, binding the package to the caller's collection
   and to how an event becomes one of the caller's records;
3. `log.action(event)`, returning a `TransactionAction<TRecord>` the caller
   includes in its **own** `transact` call, on its own collection and
   partition;
4. readers that list a partition, filter to audit records, and sort in code;
5. `sweep`, built on `listVersioned` and `deleteIfUnchanged`;
6. `append`, for the genuinely non-atomic case only, using `insertIfAbsent`.

The cost is that the caller does more work: it declares the audit member of its
own record union, splices the codec, and routes the record id through
`auditRecordId`. That is the correct trade. The alternative buys a slightly
smaller integration in exchange for the one property the package exists to
provide.

The consequence worth stating plainly: **a component cannot adopt this package
without putting audit records in a partition it already writes to.** If a
component has no such partition, it does not yet have a place where audit can
be atomic, and adding this package will not give it one.

### Stored fields are prefixed

Audit fields share a row with whatever the caller's own codec writes there, so
every field this package produces is prefixed (`auditEventId`, `auditActorKind`,
and so on). Without that, a caller with its own `action` or `subject` column
would silently overwrite one of ours or have one overwritten.

### Details are one encoded field, not flattened

`details` is stored as a single JSON field. Flattening caller-chosen keys into
backend property names would put arbitrary names into a namespace several
backends have rules about, and would buy nothing: details are explicitly not
queryable, because querying by anything other than the subject partition is a
non-goal.

### Retention deletes conditionally

`sweep` reads versions and deletes with `deleteIfUnchanged`. Listing a
partition is not a snapshot, so a record can change between being enumerated
and being deleted; an unconditional delete would discard whatever landed in
between. This mirrors the reasoning `@pegma/storage-core` documents on
`deleteIfUnchanged` itself.

## Scope

### In scope

- One provider-neutral audit event type, shared across Pegma components
- A codec between that type and a flat `StoredRecord`
- A transaction action the caller commits with its own state change
- Idempotency keyed on a caller-supplied event id
- Per-subject history reads with in-code ordering
- A bounded, conditional retention sweep
- A convenience append for events that accompany no state change

### Non-goals

- **Tamper-evidence or signing.** No hash chain, no signature, no detection of
  a record edited directly in the backend. Anyone with write access to the
  store can rewrite history. A `sequence` gap proves nothing. Adding a chain
  would require a per-subject head record updated on every append, which is a
  second write with its own atomicity problem, and would still not survive an
  operator with backend access.
- **Global ordering across subjects.** Events are ordered within one subject.
  There is no cross-subject or cross-partition sequence, because there is no
  cross-partition transaction to mint one under.
- **Log shipping or SIEM integration.** Nothing forwards records to object
  storage, a warehouse, Splunk, or a managed SIEM. That is a host concern, and
  it belongs to whatever durable outbox the ecosystem eventually grows rather
  than to this package.
- **Querying by anything other than the subject partition.** No search by
  actor, action, time range, or detail value. `storage-core` offers no
  server-side filtering and a secondary index would be a second collection with
  exactly the atomicity problem this package exists to avoid.
- **Owning a store, a collection, or a partition.** See the decision above.
- **A retention policy or scheduler.** The caller supplies the bound and runs
  the sweep.
- **Redaction or correction of a recorded event.** A mistaken event is followed
  by a compensating event.
- **Being the transport for domain events.** `@pegma/spine` has an event bus
  for in-process notification. An audit record is a durable fact, not a
  notification, and the two should not be conflated.

## Package architecture

| Package        | Responsibility                                        | Earliest phase |
| -------------- | ----------------------------------------------------- | -------------- |
| `@pegma/audit` | Event type, codec, transaction action, readers, sweep | Phase 1        |

One package, deliberately. There is no contracts/core split because there is no
adapter: this package has no backend of its own to adapt to, and the storage
port it uses is already someone else's abstraction. Splitting now would create
a package before anything needs it to exist separately — a compatibility
promise with no implementation behind it.

A second package becomes justified only if something genuinely needs the types
without the behaviour, and no consumer has asked for that.

## Delivery phases

### Phase 1 — the atomic primitive

**Goal:** Make one component able to write an audit record that cannot
disagree with the change it describes.

- [x] MIT license, TypeScript workspace, CI on Node 22 and 24
- [x] Event type with caller-supplied id, ISO timestamp, actor, action,
      subject, optional sequence and scalar details
- [x] `PrincipalId` and `IsoTimestamp` imported from `@pegma/spine`, never
      redeclared
- [x] Codec to and from a flat `StoredRecord`, with every field prefixed
- [x] `auditRecordId` derived from the event id alone
- [x] `defineAudit` binding to a caller's collection and record union
- [x] `action(event)` returning a `TransactionAction` for the caller's own
      `transact`
- [x] `append` for the non-atomic case, idempotent through `insertIfAbsent`
- [x] `history` with in-code ordering and subject filtering
- [x] `sweep` over `listVersioned` and `deleteIfUnchanged`, with a limit
- [x] Tests against `createMemoryStore()` covering atomic commit, rollback with
      no orphan record, replay idempotency, ordering, and retention

### Phase 2 — first real consumer

**Goal:** Find out whether the shape survives contact with a component that
already solved this its own way.

- [ ] Migrate `@pegma/authorization-core` onto `@pegma/audit`, replacing
      `StoredAudit` and the `GRANT_SEQUENCE`/`REVOKE_SEQUENCE` constants.
- [ ] Decide what happens to Authorization Core's derived-payload trick, where
      audit payloads are reconstructed from the assignment record rather than
      stored twice so history cannot drift from the lifecycle. This package
      stores the payload; that is a real difference and it may be the right one
      or it may not.
- [x] Publish `0.1.0`; future releases use the trusted publisher and the
      signed-tag procedure in `RELEASING.md`.
- [ ] Record what the migration had to work around, in this document.

### Phase 3 — second consumer and the shape's verdict

**Goal:** Confirm the abstraction is reusable rather than
authorization-shaped.

- [ ] Adopt in the Pegma support desk for ticket events.
- [ ] Reconcile `action` naming across two components into a documented
      convention.
- [ ] Decide whether `details` needs a size bound, based on what two real
      consumers actually put in it.

### Phase 4 — retention in practice

**Goal:** Make the sweep something an operator can actually run.

- [ ] Document a sweep schedule pattern, including how a caller finds the
      partitions to sweep — this package cannot enumerate them.
- [ ] Decide whether a sweep needs a resume cursor rather than a limit and a
      repeat call.
- [ ] Establish whether a component should be able to declare a default
      retention bound, or whether that stays entirely a host decision.

## Open questions

These should be driven by real integrations rather than resolved
speculatively:

- Whether `sequence` should be required rather than optional, once two
  consumers have said what they actually order by.
- Whether the payload should be stored, or derived from the state record it
  describes as Authorization Core does today. Deriving cannot drift; storing
  survives the state record being deleted.
- Whether a component needs to audit something with no natural partition, and
  what the honest answer is when it does.
- Whether `details` should carry a schema per `action` name, or stay an
  untyped scalar bag.
- Whether anything in the ecosystem will genuinely need tamper-evidence, and
  if so whether that is this package extended or a different package
  altogether.

## Near-term backlog

1. Migrate `@pegma/authorization-core` onto this package and record what broke.

The backlog stays at one item until a real consumer has used this. Everything
else in this document is a hypothesis about a shape that has been tested
against a memory store and nothing else.
