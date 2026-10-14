---
summary: How applicability notes and cloud diagnostic annotations affect memory retrieval.
read_when:
  - Changing memory notes, keyword indexing, embeddings, or relevance scoring
  - Debugging retrieval after restoring a cloud-rejected memory
---

# Memory retrieval text

Keyword indexing, document embeddings, and relevance scoring share the same
retrieval text: the memory text followed by ` Affects: ` and its applicability
note. Whitespace in the note is collapsed to one line.

Cloud sync can attach a diagnostic segment to a rejected memory's note:

```text
load tests, reporting jobs | cloud-dreaming: semantic_duplicate of macbook:abc123
```

Segments separated by ` | ` that start with the reserved `cloud-dreaming:`
prefix are excluded from retrieval text. The example therefore becomes:

```text
Staging has no read replicas. Affects: load tests, reporting jobs
```

The stored note is preserved for inspection, including after explicit
reactivation. A literal mention of `cloud-dreaming:` inside an applicability
segment is preserved. This filter applies to rejected correction exemplars as
well as candidates and active memories.

Existing embeddings containing diagnostic text have a stale content hash and
are refreshed by the usual embedding bootstrap. Existing keyword index rows
are refreshed when their memory changes or when the index is rebuilt:

```bash
recall embeddings bootstrap
recall embeddings rebuild-index
```

These commands update derived indexes; they do not confirm or reactivate
memories.
