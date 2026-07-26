# Security Policy

An audit trail is often the evidence used to investigate everything else, so
please report suspected vulnerabilities privately.

## Reporting a vulnerability

Use
[GitHub private vulnerability reporting](https://github.com/pegma-dev/audit/security/advisories/new).
Do not open a public issue.

Include, when possible:

- the affected package and version or commit;
- the expected and observed behavior;
- a minimal reproduction;
- the potential impact;
- any suggested mitigation.

We will acknowledge a complete report as soon as practical, investigate it, and
coordinate remediation and disclosure with the reporter. Please avoid accessing
data that is not yours or disrupting production systems while researching a
report.

## Supported versions

Audit is currently pre-release software. Until the first stable release, only
the latest commit on the default branch is supported.

## What this package does not provide

These are design decisions, not gaps to be reported:

- **No tamper-evidence.** There is no signing, no hash chain, and no detection
  of a record edited or removed directly in the backend. Anyone with write
  access to the store can rewrite history, and a gap in `sequence` proves
  nothing. Treat backend credentials as the actual control.
- **No global ordering.** Events are ordered within one subject only.
  `occurredAt` comes from the caller's clock, so timestamps from two servers
  are two clocks and not a sequence.
- **No delivery guarantee.** Nothing forwards records off the store. If an
  investigation must survive the store being compromised, the records must be
  shipped somewhere the same credentials cannot reach, and that is a host
  responsibility.
- **No access control.** Reading a partition returns every audit event in it.
  Authorizing who may read history is the host's job, as is deciding which
  partitions a given reader may name.

## Security expectations

Applications using Audit remain responsible for:

- generating `occurredAt` from a trusted server clock, never from a client;
- generating each event `id` server-side, stably across retries of one logical
  operation, and never from client input that an attacker could replay or
  collide;
- treating `actor` as a fact already established by authentication and
  authorization, not as something the request asserted;
- keeping secrets, credentials, tokens, and unnecessary personal data out of
  `details`, which is stored in plain form and returned to anyone allowed to
  read the partition;
- using `action` inside the caller's own `transact` whenever there is a state
  change, and reserving `append` for events that genuinely accompany none — a
  separate `append` beside a state change reintroduces exactly the gap this
  package exists to close;
- authorizing history reads and choosing which partition a reader may name,
  since a partition name supplied by a caller is a caller-chosen query;
- setting and running retention deliberately, and understanding that `sweep`
  is a permanent deletion with no recovery path in this package;
- supplying a genuinely durable `@pegma/storage-core` `Store` with the
  deployment's intended access control, backup, and monitoring. Atomicity,
  durability, and restart recovery are properties of that store, not of this
  package.

The in-memory store from `@pegma/storage-core` used in this package's tests is
ephemeral and single-process. Do not infer durability, cross-process
transaction safety, or audit completeness from its behavior.
