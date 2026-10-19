---
summary: How Recall's UMP server persists and queries dated UMP records.
read_when:
  - Changing the Recall UMP backend or its direct-write mapping
  - Adding UMP temporal retrieval, revision, or ownership behavior
  - Testing `recall ump` through MCP
---

# UMP temporal records

`recall ump` accepts UMP records through the UMP MCP binding. Direct writes
preserve the complete UMP record in `capture_context.ump_record`; the ordinary
Recall row supplies the existing hybrid FTS/vector retrieval index.

```text
UMP record
  ├─ complete body, scope, time, provenance, relations → capture_context.ump_record
  └─ text, kind, project, confidence                  → Recall search indexes
```

The UMP record is canonical at the protocol boundary. Recall assigns its native
UUID, encodes it as the canonical UMP id, and removes a supplied integrity
signature because that signature covered the old id. Recall runs at UMP L1 and
does not re-sign the record.

## Temporal reads

Agents make historical reads with an explicit `filter.valid_at` RFC 3339
instant. An omitted value means now. Validity is inclusive at both endpoints;
future-effective and expired records are excluded from ordinary current reads.

The backend applies owner, project, full scope, kind, lifecycle status, and
validity before applying the requested result limit. It asks its hybrid index
for the complete candidate population and has an exhaustive lexical fallback,
so irrelevant high-ranked rows cannot hide an eligible temporal record.

Every direct UMP record has `auto_inject: false`. It remains available through
UMP recall, but cannot become an ordinary Recall automatic instruction. This
conservative boundary keeps future and historical assertions out of a path that
does not yet understand their source or validity. Direct UMP records are also
local-only: Recall excludes them from Cloud push and ignores incoming UMP
source records until Cloud can preserve the complete record and source
boundary. It does not enable conversational temporal extraction or automatic
capture.

## Revision and forgetting

A revision creates a successor and closes the predecessor's validity window.
The predecessor stays a native active/candidate Recall row so historical queries
can retrieve it. A UMP forget tombstones the native row; tombstoned records are
excluded at every validity instant.

Native rejection also overrides an otherwise active persisted UMP lifecycle.
This makes local user deletion authoritative.

## Identity

The server persists one random Ed25519 seed beside `recall.db` as
`ump-operator-ed25519.seed`, mode `0600`. It is created with exclusive file
creation and malformed seed material fails closed. The seed is never logged or
included in record exports. The resulting DID is stable across `recall ump`
restarts, so private owner scope remains meaningful. Keep this seed with a
database backup when moving or restoring the server; the database-only daily
snapshot does not include the separate identity file. Record exports do not
contain private key material.

The MCP server advertises this DID in initialization instructions, tool-schema
hints, and the MCP capability response's `scope_hint`. This supports hosts
that do not forward initialization instructions to their models. Clients must
still set `scope.owner` explicitly; the server does not fill or relax scope
fields on their behalf.
