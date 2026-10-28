---
summary: "Private encrypted device sync, local search, passphrase recovery, and the limits of the Cloud privacy boundary."
read_when:
  - Connecting private Cloud sync or restoring encrypted memories on another device.
  - Changing encryption, sync verification, recovery, or local indexing after Cloud pulls.
---

# Private Cloud sync

Private sync encrypts memory text, applicability notes, evidence, repository
names and capture context on the device before upload. Another device with
the same passphrase downloads and decrypts those records locally. The Recall
Cloud service does not receive the passphrase or content key.

| Connection | Content visible to Recall Cloud | Retrieval |
| --- | --- | --- |
| Private sync | Encrypted content; account, device, record identifiers, kinds, confidence, timestamps and traffic metadata remain visible | Local MCP and hooks after sync and indexing |
| Cloud-assisted search | Server-readable memories and question text | Local retrieval plus optional hosted retrieval and MCP |

The Mac connection form initially selects private sync. Existing running
connections keep their mode; upgrading does not migrate Cloud data or change
their retrieval preference. Older API clients that omit `privacyMode` retain
their previous behavior. Explicit `private` mode requires a passphrase;
explicit `searchable` mode cannot downgrade a device previously using E2EE.

## Connect and recover

1. Create a device token in the Cloud portal and open the Mac app's Cloud tab.
2. Choose **Private sync · local search**. On the first device, choose a strong
   passphrase, preferably at least four independently random words. On another
   device, enter the exact original passphrase.
3. Save it in a password manager outside Recall, enter it twice, and acknowledge
   that you saved it before connecting.
4. Wait for a successful sync. Keyword indexing and local semantic indexing run
   in the background; a model download may be needed on a fresh device. Local
   keyword retrieval remains usable when embeddings are disabled or unavailable.
5. Verify a known memory locally before relying on a replacement device or
   removing the original device's data.

Recall stores the device passphrase in a private local file, with the same
owner-only permissions as the sync token. Disconnect removes that saved copy.
Your separately saved passphrase is the recovery mechanism. Recall cannot
reset it or recover encrypted content after every local copy and the passphrase
are lost. The Connect form does not rotate keys; use the original passphrase.

## Failure handling and search

The existing AES-256-GCM format and scrypt-derived key remain compatible with
older encrypted records. Every encrypted watch startup verifies the remote
encrypted records before uploading, regardless of saved cursors. This key check
is independent of `--limit`; that option still bounds local pull/import batches.
Standalone encrypted push also
verifies accessible remote encrypted records before writing. The token therefore
needs both sync read and write permissions. Wrong passphrases, damaged ciphertext
and malformed encrypted payloads stop sync with a generic error. The pull's
database transaction rolls back and its cursor does not advance, allowing retry
with the correct key. Oversized verification sets stop safely instead of uploading
after a partial key check.

Successful pulls notify the daemon to refresh local search indexes, without
waiting for the normal maintenance interval. Repeated notifications share a
background job and serialize with scheduled maintenance; a new pull during
indexing schedules another pass. Missing or
changed embeddings regenerate locally. Failures leave local data intact and
retry on a later pull or maintenance cycle. This applies to both connection modes.

Foreign active memories still arrive as candidates. Encryption does not bypass
local review or promotion rules. E2EE disables online query enrichment, so this
retrieval path sends no questions to Cloud. Hosted search, profiles, remote MCP
answers and Cloud maintenance cannot use encrypted content.

## Privacy limits

- This protects encrypted content from the storage service, not from software
  running on an unlocked device. The local database, local backups and indexes
  remain readable to the local user and authorized agents.
- Agents and separately configured model providers can receive retrieved local
  context. E2EE sync does not make those providers private or disable optional
  model-assisted local features.
- Choosing private sync does not convert or erase earlier readable Cloud
  records, ingested transcripts, exports or recovery archives. Existing readable
  copies need a separate, explicit migration and retention review. A clean,
  private workspace is the clearest starting point for new encrypted data.
- The Cloud sync API rejects attempts to overwrite an existing encrypted record
  with a readable one, including alias merges across modes. Other readable
  records in a mixed workspace remain readable.
- The current passphrase format uses a compatibility salt shared across devices;
  strong, unique passphrases matter. There is no new cryptographic protocol or
  independent cryptographic audit in this change. Key rotation, managed recovery
  keys and browser-side private search are not implemented by this workflow.

See [configuration](configuration.md#recall-cloud-sync-optional) for process
ownership and credentials. The [Mac App Store edition](mac-app-store.md) remains
local-only and does not offer Cloud sync.
