---
summary: Import experimental Harness2 EXPERIENCE.md documents as quarantined, repo-scoped gotcha candidates.
read_when:
  - Importing or reviewing Harness2 experience data
  - Troubleshooting an experimental Harness2 candidate
---

# Harness2 experience import

Harness2 imports one complete `EXPERIENCE.md` document as one repo-scoped
`gotcha` candidate. The importer normalizes line endings, trims the document,
and derives a stable UUID from `SHA-256(repo + newline + content)`. Copying the
same document from another path returns the existing memory, including when it
has been rejected; imports never alter a retained duplicate. Pruning or erasing
that memory also erases its identity, so a later import creates a new candidate.

```sh
recall harness2 import EXPERIENCE.md --repo edihasaj/recall
recall harness2 import EXPERIENCE.md --repo edihasaj/recall --source-ref harness2://run/123 --apply
```

The default command is a pure preview: it reads and validates the file but does
not initialize or migrate Recall's database, load a model, or make a network
request. Add `--json` for a payload with `provider`, `project`, `content`, and
`sourceRef` nested under `preview.cloudImport` for a cloud importer. The preview
retains the proposed candidate separately; an applied command also returns the
actual stored `memory`, which may be an already confirmed or rejected duplicate.
Without `--source-ref`, `sourceRef` is the absolute path to the input file so
the stored provenance remains traceable; the digest remains path-independent.

Imported candidates have confidence `0.4`, `auto_inject=false`, and generated
Harness2 provenance. They are deliberately excluded from compilation,
promotion, and feedback effects until a person reviews and confirms them:

```sh
recall confirm <candidate-id>
```

If an applied duplicate is already rejected, it remains rejected and is never
updated or auto-injected. Reactivate it before reviewing or confirming it:

```sh
recall reactivate <candidate-id>
```

The importer accepts only a single regular, non-symlink UTF-8 file up to 128
KiB. It rejects pipes, invalid UTF-8, NUL bytes, empty documents, and documents
over 20,000 Unicode code points. Raw input is byte-limited before normalization
and must not contain an unpaired UTF-16 surrogate. A repository key is at most
255 characters, contains no NUL or line break, and is always a single line.
