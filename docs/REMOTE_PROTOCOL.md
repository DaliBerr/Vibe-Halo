# Remote protocol foundation

This is the M1 internal contract for the accepted [mobile plan](REMOTE_DECISIONS.md).
It does not expose a network endpoint or establish device trust. Dated test and
implementation status is recorded in [HANDOFF.md](../HANDOFF.md).

## Layout and build

- `packages/protocol/schemas/`: JSON Schema draft-07 for EventSummary,
  EventDetail and DecisionIntent. Objects reject unknown fields.
- `packages/protocol/src/index.js`: bounded JSON parsing, tree/UTF-8/date checks
  and schema validation. No Electron, Node built-ins, I/O or client codecs.
- `packages/protocol/generated/validators.js`: committed CommonJS validators,
  generated with development-only Ajv `8.20.0`. No runtime compilation, eval or
  dependency on Ajv is shipped. Worker bundlers can consume this CommonJS module;
  a deployed Worker build is still a separate verification gate.
- `packages/protocol/src/index.d.ts`: TypeScript-facing DTO types. Android must
  implement Kotlin DTOs and test the same fixtures, not execute this JS package.
- `packages/protocol/fixtures/`: public synthetic protocol vectors only. The
  initial Chinese/emoji/newline vector is not a cryptographic interoperability
  vector and contains no keys, tokens or pairing codes.

`npm run build:protocol` regenerates validators. `npm run test:protocol` first
checks generated-source freshness and then runs the isolated protocol suite.
`npm test` deliberately selects only `test/*.test.js` so later Android/relay test
frameworks cannot be accidentally picked up by the desktop runner.

Ajv's [official guide](https://ajv.js.org/guide/getting-started.html) describes
schema compilation and reuse. The package is pinned in the root lockfile and
used only at development/build time. Max string lengths deliberately count
UTF-16 code units, matching existing desktop and Kotlin bounds. UTF-8 byte
budgets are enforced separately, including Chinese and emoji.

## Validation contract

`parse(kind, jsonText)` returns `{ ok: true, value }` or a bounded error code:
`invalid_json`, `invalid_structure`, `too_large`, `upgrade_required`.
`validate(kind, value)` checks already parsed internal DTOs without coercion,
mutation, filling defaults or trimming values into acceptance.

Control messages are at most 16 KiB, detail plaintext at most 64 KiB; the future
encrypted envelope budget is 256 KiB. Tree depth is at most 12, with at most
4,096 nodes and 500 properties/items at any node. Reject cyclic/non-record
objects, getters, malformed UTF-16, unsafe integers and dangerous object keys
(`__proto__`, `prototype`, `constructor`). Times use canonical UTC ISO strings
with milliseconds. Issue time must precede expiry. Device clock skew up to five
seconds in the future is tolerated by the internal decision service; the PC
request deadline is never extended.

Schema validation alone does not authorize anything. Exact current question
IDs, closed-option membership, text permission, single/multi-select semantics
and duplicate answers are validated against the actual PC request. Errors leave
the pending request and its waiter untouched. Existing adapter codecs retain
their historical text normalization when producing the final client response.

## PC queue and event projection

ApprovalStore owns a random process epoch, an event ID per newly enqueued
request, absolute expiry, event revision and sequence watermark. Duplicate
waiters reuse the same event. Head promotion and finalization increase the
relevant event revision/sequence; animation, refresh and duplicate connections
do not. Promotion never changes expiry. Timers still expire non-head entries.
The stored business state advances on finalization; if its timer is delayed,
projection already makes an elapsed request non-actionable without inventing a
new stored revision.

`listPending({ offset, limit })` is a detached, bounded **internal** page. It may
contain desktop context and is not a network DTO. `queueView()` projects explicit
summary fields, limits each page to 64 KiB and returns `nextOffset`. Consumers
must compare epoch/watermark across pages and restart if it changes. M3 must add
the journal, stable snapshot/delta handover, finalized-event replay and the
unified stream for input/Stop/plan events; this approval-only watermark is not
yet the complete product event stream.

Queue summaries never contain commands, working directories, session IDs, PID
chains, forms or answers. `actionable` means current/unexpired on the PC, not
that a phone has authorization. `detail()` is plaintext **only for the future
authenticated sign-then-encrypt gateway**. It must never be passed directly to
a transport or push provider. Key-based redaction is not proof that command
strings contain no secrets; encryption remains mandatory.

Detail contains exact normalized tool input as JSON text, question/option IDs,
completeness flags, PC time and `sha256:` context digest. It excludes PC process
metadata and native protocol internals. Input changed by lossy normalization,
redaction or an excessive byte budget disables remote decisions. Persistent
options are withheld until a complete permission preview and local permission
flow are implemented. Digest calculation remains PC-local; phones echo the
signed digest and do not reconstruct or replace the approval context.

## Shared decision service and future gateway

Desktop IPC keeps its sender validation and calls `decideLocal`. Local explicit
close calls `returnToNative`. Store timeout/shutdown are independent native
fallback paths. Only the original PC waiter calls the adapter's codec.

`decideVerifiedRemote(intent, principal)` is an **internal post-verification
method**, not an HTTP authentication implementation. In production wiring it
is disabled and has no authorizer. Before enabling it, M2 must implement all of:

1. Decrypt recipient-bound JWE and verify the original JWS bytes using pinned,
   purpose-specific device keys; compare inner/outer routing fields.
2. Validate device/session identity, PC-local confirmed binding, current revision
   and scopes. Supply an opaque verified principal, never one reconstructed
   from attacker-provided intent fields alone.
3. Inject a synchronous authorizer that checks the verified principal against
   current local trust on every operation, including duplicate receipt queries.
4. Keep local remote/control switches and revocation state authoritative. No
   async work may occur between final trust/current-request checks and resolve.

The service then enforces PC/epoch/event/revision/context, absolute request and
intent deadlines (intent lifetime at most 30 seconds), FIFO, exact options,
complete details and semantic answers. `always` and `suggestion:N` remain
forbidden remotely even with a claimed persistent scope until their separate
preview/confirmation gate is implemented.

In-memory receipts are keyed by binding/mobile/decision ID and request digest.
Identical retries return the prior result; reused IDs with different content
return `decision_conflict`. Capacity is 500 entries, TTL ten minutes. At capacity
new work is rejected rather than evicting live deduplication records. Reentrant
or failed post-finalize observers produce `result_unknown`, never a retry
against another request. No active approval is restored after process restart.

`desktop_accepted` means the PC accepted a decision. It does not establish that
the Hook response was written, the client consumed it or a command executed.
Hook-write tracking, encrypted remote receipts and persistent relay receipt
queries belong to subsequent stages.
