import { createMemoryStore, defineCollection } from "@pegma/storage-core";
import { describe, expect, it } from "vitest";

import {
  auditEvent,
  auditRecordId,
  decodeAuditEvent,
  defineAudit,
  encodeAuditEvent,
  type AuditDetails,
  type AuditEvent,
} from "./index.js";

/**
 * A stand-in consumer, shaped like the real ones.
 *
 * Members and audit records share one collection and one partition per
 * account, which is the only arrangement in which a membership change and the
 * record of it can commit together.
 */
interface StoredMember {
  readonly kind: "member";
  readonly accountId: string;
  readonly memberId: string;
  readonly role: string;
}

interface StoredAuditEntry {
  readonly kind: "audit";
  readonly accountId: string;
  readonly event: AuditEvent;
}

type AccountRecord = StoredMember | StoredAuditEntry;

const accountPartition = (accountId: string): string => `account|${accountId}`;

const accountRecords = defineCollection<AccountRecord>({
  name: "account_records",
  key: (record) => ({
    partition: accountPartition(record.accountId),
    id:
      record.kind === "member"
        ? `member|${record.memberId}`
        : auditRecordId(record.event.id),
  }),
  codec: {
    encode: (record) =>
      record.kind === "member"
        ? {
            kind: "member",
            accountId: record.accountId,
            memberId: record.memberId,
            role: record.role,
          }
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

const auditFor = (accountId: string) =>
  defineAudit<AccountRecord>({
    collection: accountRecords,
    toRecord: (event) => ({ kind: "audit", accountId, event }),
    toEvent: (record) => (record.kind === "audit" ? record.event : null),
  });

const ACCOUNT = "acct_1";
const PARTITION = accountPartition(ACCOUNT);

const audit = auditFor(ACCOUNT);

const records = () => createMemoryStore().collection(accountRecords);

const event = (overrides: Partial<AuditEvent> = {}): AuditEvent =>
  auditEvent({
    id: "evt_1",
    occurredAt: "2026-07-26T12:00:00.000Z",
    actor: { kind: "principal", principalId: "prn_admin" },
    action: "account.member.added",
    subject: "mem_1",
    ...overrides,
  });

describe("the event shape", () => {
  it("survives a round trip through a flat record", () => {
    const original = event({
      sequence: 2,
      details: { role: "support", previousRole: null, seatsUsed: 4 },
    });

    expect(decodeAuditEvent(encodeAuditEvent(original))).toEqual(original);
  });

  it("keeps a system actor distinct from a principal", () => {
    const bySystem = event({
      actor: { kind: "system", systemId: "billing-sync" },
    });

    expect(decodeAuditEvent(encodeAuditEvent(bySystem)).actor).toEqual({
      kind: "system",
      systemId: "billing-sync",
    });
  });

  it("rejects an event that could not be read back faithfully", () => {
    expect(() => event({ occurredAt: "yesterday" })).toThrow(
      /ISO 8601 timestamp/,
    );
    expect(() => event({ id: "" })).toThrow(/non-empty string/);
    expect(() =>
      event({ details: { nested: {} as unknown as string } }),
    ).toThrow(/details.nested/);
  });

  it("rejects a timestamp only Date.parse would accept", () => {
    // `Date.parse` accepts implementation-defined formats, so it cannot be the
    // whole check: the value is kept forever exactly as it was submitted, and
    // a consumer parsing strictly as ISO 8601 would reject it.
    expect(Date.parse("March 3, 2020")).not.toBeNaN();
    expect(() => event({ occurredAt: "March 3, 2020" })).toThrow(
      /ISO 8601 timestamp/,
    );
    expect(() => event({ occurredAt: "2026-07-26" })).toThrow(
      /ISO 8601 timestamp/,
    );
    expect(() => event({ occurredAt: "2026-13-01T00:00:00Z" })).toThrow(
      /ISO 8601 timestamp/,
    );
    // `Date.parse` normalizes a day past the end of its month instead of
    // refusing it, so an impossible date would be kept forever as a day
    // nothing happened on.
    expect(Date.parse("2026-02-30T00:00:00Z")).not.toBeNaN();
    expect(() => event({ occurredAt: "2026-02-30T00:00:00Z" })).toThrow(
      /ISO 8601 timestamp/,
    );
    expect(() => event({ occurredAt: "2026-04-31T00:00:00Z" })).toThrow(
      /ISO 8601 timestamp/,
    );
    expect(() => event({ occurredAt: "2100-02-29T00:00:00Z" })).toThrow(
      /ISO 8601 timestamp/,
    );
    expect(event({ occurredAt: "2024-02-29T00:00:00Z" }).occurredAt).toBe(
      "2024-02-29T00:00:00Z",
    );
    expect(event({ occurredAt: "2000-02-29T00:00:00Z" }).occurredAt).toBe(
      "2000-02-29T00:00:00Z",
    );
    expect(event({ occurredAt: "2026-12-31T23:59:59.999Z" }).occurredAt).toBe(
      "2026-12-31T23:59:59.999Z",
    );
    expect(event({ occurredAt: "2026-07-26T12:00:00Z" }).occurredAt).toBe(
      "2026-07-26T12:00:00Z",
    );
    expect(event({ occurredAt: "2026-07-26T14:00:00+02:00" }).occurredAt).toBe(
      "2026-07-26T14:00:00+02:00",
    );
  });

  it("keeps a details key that names an inherited accessor", () => {
    // `__proto__` is an own property when it arrives from `JSON.parse`, which
    // is how a stored record comes back. Copying with plain assignment calls
    // the inherited setter instead of storing it, so the key disappears and the
    // event no longer round-trips as the bytes that were submitted.
    const details = JSON.parse(
      '{"__proto__":"inherited","safe":2}',
    ) as AuditDetails;
    const original = event({ details });

    expect(Object.keys(original.details ?? {})).toEqual(["__proto__", "safe"]);
    expect(
      Object.keys(decodeAuditEvent(encodeAuditEvent(original)).details ?? {}),
    ).toEqual(["__proto__", "safe"]);
    // The transient copy never becomes anyone's prototype.
    expect(Object.getPrototypeOf(original.details)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)["safe"]).toBeUndefined();
  });

  it("refuses a stored row it cannot read faithfully", () => {
    const stored = encodeAuditEvent(event());

    // An unrecognized kind used to decode as a principal, inventing an actor.
    expect(() =>
      decodeAuditEvent({ ...stored, auditActorKind: "operator" }),
    ).toThrow(/actor kind/);
    // `String(null)` used to pass the non-empty-string check as `"null"`.
    expect(() =>
      decodeAuditEvent({ ...stored, auditActorPrincipalId: null }),
    ).toThrow(/actor principal id/);
    expect(() => decodeAuditEvent({ ...stored, auditSubject: null })).toThrow(
      /stored audit subject/,
    );
    expect(() => decodeAuditEvent({ ...stored, auditEventId: 7 })).toThrow(
      /stored audit id/,
    );
  });
});

describe("an audit action inside the caller's transaction", () => {
  it("commits atomically with the state change it describes", async () => {
    const collection = records();

    const outcome = await collection.transact(PARTITION, [
      {
        action: "insert",
        value: {
          kind: "member",
          accountId: ACCOUNT,
          memberId: "mem_1",
          role: "support",
        },
      },
      audit.action(event({ details: { role: "support" } })),
    ]);

    expect(outcome.committed).toBe(true);
    expect(
      await collection.get({ partition: PARTITION, id: "member|mem_1" }),
    ).toMatchObject({ kind: "member", role: "support" });
    expect(await audit.history(collection, PARTITION)).toHaveLength(1);
  });

  it("leaves no orphan audit record when the transaction rolls back", async () => {
    const collection = records();
    const member: AccountRecord = {
      kind: "member",
      accountId: ACCOUNT,
      memberId: "mem_1",
      role: "support",
    };
    await collection.put(member);

    // The insert is refused because the member already exists. The audit
    // action is perfectly valid on its own, and must still not land.
    const outcome = await collection.transact(PARTITION, [
      { action: "insert", value: member },
      audit.action(event({ id: "evt_orphan" })),
    ]);

    expect(outcome).toMatchObject({ committed: false, reason: "exists" });
    expect(
      await collection.get({
        partition: PARTITION,
        id: auditRecordId("evt_orphan"),
      }),
    ).toBeNull();
    expect(await audit.history(collection, PARTITION)).toEqual([]);
  });

  it("refuses a replayed event id rather than recording it twice", async () => {
    const collection = records();
    const replayed = event({ id: "evt_replay" });

    const first = await collection.transact(PARTITION, [
      audit.action(replayed),
    ]);
    const second = await collection.transact(PARTITION, [
      audit.action(replayed),
    ]);

    expect(first.committed).toBe(true);
    expect(second).toMatchObject({ committed: false, reason: "exists" });
    expect(await audit.history(collection, PARTITION)).toHaveLength(1);
  });
});

describe("appending without a state change", () => {
  it("records an event that accompanies nothing", async () => {
    const collection = records();

    const result = await audit.append(
      collection,
      event({ id: "evt_signin", action: "account.session.started" }),
    );

    expect(result.appended).toBe(true);
    expect(result.event.action).toBe("account.session.started");
  });

  it("is idempotent on the caller-supplied event id", async () => {
    const collection = records();
    const first = await audit.append(collection, event({ id: "evt_once" }));

    // Same id, different payload: the first write is authoritative and the
    // second is a no-op, because the record id derives from the id alone.
    const second = await audit.append(
      collection,
      event({ id: "evt_once", action: "account.member.removed" }),
    );

    expect(first.appended).toBe(true);
    expect(second.appended).toBe(false);
    expect(second.event.action).toBe("account.member.added");
    expect(await audit.history(collection, PARTITION)).toHaveLength(1);
  });
});

describe("reading a subject's history", () => {
  it("returns events in order however they were written", async () => {
    const collection = records();
    for (const sequence of [3, 1, 2]) {
      await audit.append(
        collection,
        event({ id: `evt_${sequence}`, sequence, subject: "mem_1" }),
      );
    }

    const history = await audit.history(collection, PARTITION);

    expect(history.map((found) => found.sequence)).toEqual([1, 2, 3]);
  });

  it("falls back to the clock when no sequence was supplied", async () => {
    const collection = records();
    await audit.append(
      collection,
      event({ id: "evt_late", occurredAt: "2026-07-26T18:00:00.000Z" }),
    );
    await audit.append(
      collection,
      event({ id: "evt_early", occurredAt: "2026-07-26T06:00:00.000Z" }),
    );

    const history = await audit.history(collection, PARTITION);

    expect(history.map((found) => found.id)).toEqual(["evt_early", "evt_late"]);
  });

  it("ignores the caller's own records and other subjects", async () => {
    const collection = records();
    await collection.put({
      kind: "member",
      accountId: ACCOUNT,
      memberId: "mem_1",
      role: "support",
    });
    await audit.append(collection, event({ id: "evt_a", subject: "mem_1" }));
    await audit.append(collection, event({ id: "evt_b", subject: "mem_2" }));

    expect(await audit.history(collection, PARTITION)).toHaveLength(2);
    expect(
      await audit.history(collection, PARTITION, { subject: "mem_2" }),
    ).toMatchObject([{ id: "evt_b" }]);
  });
});

describe("the retention sweep", () => {
  const seed = async (collection: ReturnType<typeof records>) => {
    await collection.put({
      kind: "member",
      accountId: ACCOUNT,
      memberId: "mem_1",
      role: "support",
    });
    await audit.append(
      collection,
      event({ id: "evt_old_1", occurredAt: "2026-01-01T00:00:00.000Z" }),
    );
    await audit.append(
      collection,
      event({ id: "evt_old_2", occurredAt: "2026-02-01T00:00:00.000Z" }),
    );
    await audit.append(
      collection,
      event({ id: "evt_recent", occurredAt: "2026-07-01T00:00:00.000Z" }),
    );
    return collection;
  };

  it("removes expired events and nothing else", async () => {
    const collection = await seed(records());

    const result = await audit.sweep(collection, PARTITION, {
      before: "2026-06-01T00:00:00.000Z",
    });

    expect(result).toEqual({ examined: 3, deleted: 2, more: false });
    expect(await audit.history(collection, PARTITION)).toMatchObject([
      { id: "evt_recent" },
    ]);
    // The caller's own record is not this package's to delete.
    expect(
      await collection.get({ partition: PARTITION, id: "member|mem_1" }),
    ).not.toBeNull();
  });

  it("reports that more remain when a limit stops it early", async () => {
    const collection = await seed(records());

    const first = await audit.sweep(collection, PARTITION, {
      before: "2026-06-01T00:00:00.000Z",
      limit: 1,
    });
    const second = await audit.sweep(collection, PARTITION, {
      before: "2026-06-01T00:00:00.000Z",
      limit: 1,
    });

    expect(first).toMatchObject({ deleted: 1, more: true });
    expect(second).toMatchObject({ deleted: 1, more: false });
    expect(await audit.history(collection, PARTITION)).toHaveLength(1);
  });

  it("sweeps one subject without touching another", async () => {
    const collection = records();
    await audit.append(
      collection,
      event({
        id: "evt_a",
        subject: "mem_1",
        occurredAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await audit.append(
      collection,
      event({
        id: "evt_b",
        subject: "mem_2",
        occurredAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const result = await audit.sweep(collection, PARTITION, {
      before: "2026-06-01T00:00:00.000Z",
      subject: "mem_1",
    });

    expect(result).toEqual({ examined: 1, deleted: 1, more: false });
    expect(await audit.history(collection, PARTITION)).toMatchObject([
      { id: "evt_b" },
    ]);
  });

  it("rejects a retention bound it cannot compare against", async () => {
    const collection = records();

    await expect(
      audit.sweep(collection, PARTITION, { before: "last week" }),
    ).rejects.toThrow(/ISO 8601 timestamp/);
  });

  it("rejects a limit that would not bound the deletion", async () => {
    const collection = await seed(records());

    // `NaN` passed a `<= 0` guard and then never bound against `deleted`, so
    // a caller's arithmetic mistake swept the whole partition instead of one
    // page of it. This is a permanent deletion, so it fails closed.
    await expect(
      audit.sweep(collection, PARTITION, {
        before: "2026-06-01T00:00:00.000Z",
        limit: Number.NaN,
      }),
    ).rejects.toThrow(/positive safe integer/);
    await expect(
      audit.sweep(collection, PARTITION, {
        before: "2026-06-01T00:00:00.000Z",
        limit: 1.5,
      }),
    ).rejects.toThrow(/positive safe integer/);
    await expect(
      audit.sweep(collection, PARTITION, {
        before: "2026-06-01T00:00:00.000Z",
        limit: 0,
      }),
    ).rejects.toThrow(/positive safe integer/);
    // A refused sweep deleted nothing.
    expect(await audit.history(collection, PARTITION)).toHaveLength(3);
  });
});
