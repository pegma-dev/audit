/**
 * Append-only audit records for Pegma components.
 *
 * The whole design follows from one constraint: an audit record almost always
 * has to land atomically with the state change it describes. A storage-core
 * transaction is scoped to one collection and one partition, so an audit
 * package that owned a store or a collection could never be atomic with the
 * caller's write — a separate collection is a separate partition, and the two
 * writes would commit separately or not at all.
 *
 * So this package owns no store, no collection, and no partition. It owns the
 * event shape, its encoding, and a {@link TransactionAction} the caller drops
 * into its own `transact` call.
 */

import type { IsoTimestamp, PrincipalId } from "@pegma/spine";
import type {
  CollectionDefinition,
  CollectionStore,
  StoredRecord,
  TransactionAction,
} from "@pegma/storage-core";

/**
 * Caller-supplied identifier for one audit event.
 *
 * It is opaque here and it is the whole of the idempotency contract: the
 * record id is derived from it and nothing else, so writing the same event id
 * twice is refused by the storage key rather than by any check in this
 * package. A caller that mints a fresh id on retry will write the event twice.
 */
export type AuditEventId = string;

/**
 * Who caused the event.
 *
 * Generalized from the actor shape authorization-core already used for role
 * assignments, so a component that audits both a human action and a background
 * job does not need two vocabularies.
 */
export type AuditActor =
  | { readonly kind: "principal"; readonly principalId: PrincipalId }
  | { readonly kind: "system"; readonly systemId: string };

/** A value the details bag may carry. Scalars only, deliberately. */
export type AuditDetail = string | number | boolean | null;

/**
 * A small bag of scalar context.
 *
 * Details are for a reader looking at one event, not for querying: they are
 * stored as one encoded field and no backend can filter on what is inside.
 * Keep them small, and keep secrets out of them.
 */
export type AuditDetails = Readonly<Record<string, AuditDetail>>;

/** One thing that happened, as it will be kept forever. */
export interface AuditEvent {
  readonly id: AuditEventId;
  readonly occurredAt: IsoTimestamp;
  readonly actor: AuditActor;
  /**
   * What was done, as a dotted name such as
   * `authorization.role_assignment.granted`.
   */
  readonly action: string;
  /**
   * What the event concerns: a ticket id, an assignment id, an account id.
   *
   * A subject's history is read from one partition, so the caller's partition
   * must already contain everything about this subject.
   */
  readonly subject: string;
  /**
   * Per-subject ordinal, when the caller has one.
   *
   * Supply it whenever the order of a subject's events matters more than the
   * wall clock that recorded them, which is most of the time: `occurredAt`
   * comes from whichever server handled the request, and two servers do not
   * agree. Events that carry a sequence sort by it first.
   */
  readonly sequence?: number;
  readonly details?: AuditDetails;
}

/** Thrown when an event or a record is not something this package can use. */
export class AuditError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "AuditError";
  }
}

/**
 * Characters that may not appear raw in a storage key.
 *
 * `|` is the separator record ids are composed with, and the others are
 * rejected outright by common key-value backends. Escaping rather than hashing
 * keeps the mapping injective, so two distinct event ids can never collide
 * onto one record and silently lose an event.
 */
const KEY_ESCAPES = /[%|/\\#?\u0000-\u001F\u007F-\u009F]/g;

/** Prefix on every record id this package produces. */
const RECORD_PREFIX = "audit";

/**
 * Prefix on every stored field this package produces.
 *
 * The record shares a row with whatever the caller's own encoding puts there,
 * so the field names have to be ones a caller would not choose by accident.
 */
const FIELD_PREFIX = "audit";

const ID_FIELD = `${FIELD_PREFIX}EventId`;
const OCCURRED_AT_FIELD = `${FIELD_PREFIX}OccurredAt`;
const ACTOR_KIND_FIELD = `${FIELD_PREFIX}ActorKind`;
const ACTOR_PRINCIPAL_FIELD = `${FIELD_PREFIX}ActorPrincipalId`;
const ACTOR_SYSTEM_FIELD = `${FIELD_PREFIX}ActorSystemId`;
const ACTION_FIELD = `${FIELD_PREFIX}Action`;
const SUBJECT_FIELD = `${FIELD_PREFIX}Subject`;
const SEQUENCE_FIELD = `${FIELD_PREFIX}Sequence`;
const DETAILS_FIELD = `${FIELD_PREFIX}Details`;

function encodeSegment(value: string): string {
  // `%` is escaped by the same rule, and because it is listed first in the
  // class it can never be produced by escaping something else, so the encoding
  // stays reversible even though nothing here reverses it.
  return value.replace(
    KEY_ESCAPES,
    (character) =>
      `%${character.charCodeAt(0).toString(16).padStart(2, "0").toUpperCase()}`,
  );
}

/**
 * Record id for one audit event, inside whatever partition the caller chose.
 *
 * Derived from the event id alone. That is what makes a replay idempotent: the
 * second write of the same event id targets the same key and is refused,
 * whether it arrives through {@link AuditLog.action} inside a transaction or
 * through {@link AuditLog.append} on its own.
 */
export function auditRecordId(id: AuditEventId): string {
  return `${RECORD_PREFIX}|${encodeSegment(requireText(id, "id"))}`;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AuditError(`${field} must be a non-empty string`);
  }
  return value;
}

/**
 * ISO 8601 calendar date and time, with a UTC designator or a numeric offset.
 *
 * `Date.parse` is not this check on its own: it also accepts
 * implementation-defined formats such as `March 3, 2020`, which would be kept
 * verbatim in a record nothing in this package can correct afterwards, and
 * which a consumer parsing strictly as ISO 8601 would reject. Both checks run,
 * so a value that is the right shape but not a real instant, such as
 * `2026-13-01T00:00:00Z`, is still refused.
 */
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

function requireTimestamp(value: unknown, field: string): IsoTimestamp {
  const text = requireText(value, field);
  if (!ISO_TIMESTAMP.test(text) || Number.isNaN(Date.parse(text))) {
    throw new AuditError(`${field} must be an ISO 8601 timestamp`);
  }
  return text;
}

function requireActor(actor: AuditActor): AuditActor {
  if (actor === null || typeof actor !== "object") {
    throw new AuditError("actor must be a principal or a system");
  }
  if (actor.kind === "principal") {
    return Object.freeze({
      kind: "principal",
      principalId: requireText(actor.principalId, "actor.principalId"),
    });
  }
  if (actor.kind === "system") {
    return Object.freeze({
      kind: "system",
      systemId: requireText(actor.systemId, "actor.systemId"),
    });
  }
  throw new AuditError("actor must be a principal or a system");
}

function requireSequence(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AuditError("sequence must be a non-negative safe integer");
  }
  return value;
}

function requireDetails(details: AuditDetails): AuditDetails {
  const copied: Record<string, AuditDetail> = {};
  for (const key of Object.keys(details).sort()) {
    const value = details[key];
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      throw new AuditError(
        `details.${key} must be a string, number, boolean, or null`,
      );
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new AuditError(`details.${key} must be a finite number`);
    }
    // Not `copied[key] = value`: for a key that names an inherited accessor,
    // notably `__proto__`, plain assignment calls the setter instead of
    // storing the detail, so the key vanishes and the event round-trips as
    // different bytes than were submitted. `JSON.parse` produces exactly that
    // key as an own property, so the decode path reaches this too. Defining
    // the property keeps every own key, whatever it is called.
    Object.defineProperty(copied, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return Object.freeze(copied);
}

/**
 * Validates an event and returns an immutable copy of it.
 *
 * Every write path runs this, so a caller never has to. Call it directly when
 * you want a malformed event rejected at the edge of your own code rather than
 * at the moment you build a transaction.
 *
 * Keys are sorted while copying the details bag, so the encoded form of an
 * event does not depend on the order its fields were written in.
 */
export function auditEvent(event: AuditEvent): AuditEvent {
  return Object.freeze({
    id: requireText(event.id, "id"),
    occurredAt: requireTimestamp(event.occurredAt, "occurredAt"),
    actor: requireActor(event.actor),
    action: requireText(event.action, "action"),
    subject: requireText(event.subject, "subject"),
    ...(event.sequence === undefined
      ? {}
      : { sequence: requireSequence(event.sequence) }),
    ...(event.details === undefined
      ? {}
      : { details: requireDetails(event.details) }),
  });
}

/**
 * The stored fields for one event, to be spread into the caller's encoding.
 *
 * Every name is prefixed so it cannot collide with a field the caller's own
 * codec writes onto the same row. Details are encoded as one JSON field: a
 * details bag is read, never queried, and flattening it would put
 * caller-chosen names into the backend's property namespace, where several
 * backends have rules about what a property may be called.
 */
export function encodeAuditEvent(event: AuditEvent): StoredRecord {
  const checked = auditEvent(event);
  return {
    [ID_FIELD]: checked.id,
    [OCCURRED_AT_FIELD]: checked.occurredAt,
    [ACTOR_KIND_FIELD]: checked.actor.kind,
    [ACTOR_PRINCIPAL_FIELD]:
      checked.actor.kind === "principal" ? checked.actor.principalId : null,
    [ACTOR_SYSTEM_FIELD]:
      checked.actor.kind === "system" ? checked.actor.systemId : null,
    [ACTION_FIELD]: checked.action,
    [SUBJECT_FIELD]: checked.subject,
    [SEQUENCE_FIELD]: checked.sequence ?? null,
    [DETAILS_FIELD]:
      checked.details === undefined ? null : JSON.stringify(checked.details),
  };
}

function decodeDetails(value: unknown): AuditDetails | undefined {
  if (value == null) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value));
  } catch (error) {
    throw new AuditError("stored audit details are not valid JSON", {
      cause: error,
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AuditError("stored audit details are not an object");
  }
  return requireDetails(parsed as AuditDetails);
}

/**
 * Reads a stored field that {@link encodeAuditEvent} always writes as a string.
 *
 * Deliberately not `String(...)`: coercion turns a missing or null field into
 * the strings `"undefined"` and `"null"`, which then pass the non-empty-string
 * check and produce a plausible-looking event out of a corrupt row. An audit
 * record is read to establish what happened, so failing is the only honest
 * answer.
 */
function requireStoredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AuditError(`stored audit ${field} must be a non-empty string`);
  }
  return value;
}

function decodeActor(record: StoredRecord): AuditActor {
  const kind = record[ACTOR_KIND_FIELD];
  if (kind === "principal") {
    return {
      kind: "principal",
      principalId: requireStoredText(
        record[ACTOR_PRINCIPAL_FIELD],
        "actor principal id",
      ),
    };
  }
  if (kind === "system") {
    return {
      kind: "system",
      systemId: requireStoredText(
        record[ACTOR_SYSTEM_FIELD],
        "actor system id",
      ),
    };
  }
  // Anything else is a row this package did not write, or one that was
  // changed underneath it. Treating an unrecognized kind as a principal
  // invents an actor, which is the one thing an audit reader must not be
  // handed.
  throw new AuditError("stored audit actor kind must be principal or system");
}

/** Reads an event back out of a stored row written by {@link encodeAuditEvent}. */
export function decodeAuditEvent(record: StoredRecord): AuditEvent {
  const sequence = record[SEQUENCE_FIELD];
  const details = decodeDetails(record[DETAILS_FIELD]);
  return auditEvent({
    id: requireStoredText(record[ID_FIELD], "id"),
    occurredAt: requireStoredText(record[OCCURRED_AT_FIELD], "occurredAt"),
    actor: decodeActor(record),
    action: requireStoredText(record[ACTION_FIELD], "action"),
    subject: requireStoredText(record[SUBJECT_FIELD], "subject"),
    ...(sequence == null ? {} : { sequence: Number(sequence) }),
    ...(details === undefined ? {} : { details }),
  });
}

/**
 * How one component's records carry an audit event.
 *
 * This is the whole coupling between this package and its caller, and it goes
 * one way: the caller says which collection its records live in and how an
 * event becomes one of them. Nothing here creates a collection, because a
 * collection of our own would be a partition of our own, and a write there
 * could not commit with the caller's state change.
 */
export interface AuditProjection<TRecord> {
  /**
   * The caller's collection. Audit records are members of the caller's record
   * union and land in the caller's partitions.
   */
  readonly collection: CollectionDefinition<TRecord>;

  /**
   * Builds the caller's record for one event.
   *
   * The returned record must key into the partition holding everything else
   * about `event.subject`, and its id must be
   * {@link auditRecordId}`(event.id)`.
   */
  toRecord(event: AuditEvent): TRecord;

  /** Reads the event back, or null when the record is not an audit record. */
  toEvent(record: TRecord): AuditEvent | null;
}

export interface AuditAppendResult {
  /** False when this event id was already recorded. */
  readonly appended: boolean;
  /** The event as it is stored, which on a replay is the first one written. */
  readonly event: AuditEvent;
}

export interface AuditHistoryOptions {
  /** Keep only events concerning this subject. */
  readonly subject?: string;
}

export interface AuditSweepOptions {
  /** Delete events that occurred strictly before this instant. */
  readonly before: IsoTimestamp;
  /** Sweep only events concerning this subject. */
  readonly subject?: string;
  /**
   * Stop after this many deletions, so one call has a bounded cost.
   *
   * A positive safe integer. Omit it to sweep everything expired in one call.
   */
  readonly limit?: number;
}

export interface AuditSweepResult {
  /** Audit records seen in the partition, before the retention filter. */
  readonly examined: number;
  /** Records actually removed. */
  readonly deleted: number;
  /**
   * True when `limit` stopped the sweep with expired events still in the
   * partition. Call again to continue.
   */
  readonly more: boolean;
}

/** Reading and writing one component's audit events. */
export interface AuditLog<TRecord> {
  /**
   * The transaction action that records `event`.
   *
   * Put it in the same `transact` call as the state change it describes, on
   * the caller's own collection and partition. That is the only way the two
   * commit together, and it is the reason this package has no `append` against
   * a store of its own.
   */
  action(event: AuditEvent): TransactionAction<TRecord>;

  /**
   * Records an event that accompanies no state change.
   *
   * A sign-in, a failed permission check, an export — things worth keeping
   * that change nothing. This writes on its own with `insertIfAbsent`, so a
   * replay of the same event id is a no-op rather than a duplicate. When there
   * *is* a state change, use {@link action} instead: this call cannot be part
   * of the caller's transaction and a crash between the two leaves them
   * disagreeing.
   */
  append(
    records: CollectionStore<TRecord>,
    event: AuditEvent,
  ): Promise<AuditAppendResult>;

  /**
   * Every audit event in one partition, oldest first.
   *
   * Ordering is done here rather than by the backend: storage-core `list` is
   * explicitly unordered, and there is no server-side sort to ask for. Events
   * sort by `sequence` first when they carry one, then `occurredAt`, then id,
   * so the result is total and stable.
   */
  history(
    records: CollectionStore<TRecord>,
    partition: string,
    options?: AuditHistoryOptions,
  ): Promise<readonly AuditEvent[]>;

  /**
   * Removes audit events that have outlived their retention.
   *
   * The only operation in this package that deletes anything. It reads
   * versions and deletes conditionally, because listing a partition is not a
   * snapshot: a record can be rewritten between being enumerated and being
   * deleted, and an unconditional delete would discard whatever landed in
   * between.
   */
  sweep(
    records: CollectionStore<TRecord>,
    partition: string,
    options: AuditSweepOptions,
  ): Promise<AuditSweepResult>;
}

function compareEvents(left: AuditEvent, right: AuditEvent): number {
  const bySequence = (left.sequence ?? 0) - (right.sequence ?? 0);
  if (bySequence !== 0) {
    return bySequence;
  }
  const byTime = Date.parse(left.occurredAt) - Date.parse(right.occurredAt);
  if (byTime !== 0) {
    return byTime;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * Binds this package to one component's records.
 *
 * Mirrors `defineCollection` from storage-core: it validates nothing at
 * definition time and returns the operations bound to the projection, so a
 * component declares the coupling once and calls `action`, `history`, and
 * `sweep` without repeating it.
 */
export function defineAudit<TRecord>(
  projection: AuditProjection<TRecord>,
): AuditLog<TRecord> {
  const build = (event: AuditEvent): TRecord =>
    projection.toRecord(auditEvent(event));

  const select = (
    values: readonly TRecord[],
    subject: string | undefined,
  ): AuditEvent[] => {
    const found: AuditEvent[] = [];
    for (const value of values) {
      const event = projection.toEvent(value);
      if (
        event !== null &&
        (subject === undefined || event.subject === subject)
      ) {
        found.push(event);
      }
    }
    return found;
  };

  return {
    action(event) {
      return { action: "insert", value: build(event) };
    },

    async append(records, event) {
      const result = await records.insertIfAbsent(build(event));
      const stored = projection.toEvent(result.value);
      if (stored === null) {
        throw new AuditError(
          `the record at ${auditRecordId(event.id)} is not an audit record`,
        );
      }
      return { appended: result.inserted, event: stored };
    },

    async history(records, partition, options) {
      return Object.freeze(
        select(await records.list(partition), options?.subject).sort(
          compareEvents,
        ),
      );
    },

    async sweep(records, partition, options) {
      const before = Date.parse(
        requireTimestamp(options.before, "options.before"),
      );
      // Validated as a count rather than by comparison: `NaN <= 0` is false,
      // so a comparison guard passes `NaN` through, and `deleted >= NaN` is
      // also false, so the limit would never bind and one call would delete
      // the whole partition. `limit` is the only bound on a permanent
      // deletion, and it has to hold against a caller's arithmetic mistake.
      if (
        options.limit !== undefined &&
        (!Number.isSafeInteger(options.limit) || options.limit <= 0)
      ) {
        throw new AuditError("options.limit must be a positive safe integer");
      }
      const limit = options.limit ?? Number.POSITIVE_INFINITY;

      let examined = 0;
      let deleted = 0;
      let more = false;

      for (const versioned of await records.listVersioned(partition)) {
        const event = projection.toEvent(versioned.value);
        if (
          event === null ||
          (options.subject !== undefined && event.subject !== options.subject)
        ) {
          continue;
        }
        examined += 1;
        if (Date.parse(event.occurredAt) >= before) {
          continue;
        }
        if (deleted >= limit) {
          more = true;
          continue;
        }
        const removed = await records.deleteIfUnchanged(
          projection.collection.key(versioned.value),
          versioned.version,
        );
        if (removed) {
          deleted += 1;
        }
      }

      return { examined, deleted, more };
    },
  };
}
