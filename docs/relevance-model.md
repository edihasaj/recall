---
summary: Optional Recall 2 local relevance model, download verification, benchmark results and limitations.
read_when:
  - Installing the Recall-trained local relevance model
  - Comparing local and connected-model relevance
  - Packaging a relevance model for release
---

# Recall 2 local relevance model

The `recall-relevance-2.0.0.tar.gz` release asset contains an optional
149M-parameter relevance model, tokenizer, config, attribution and checksums.
The graph is about 144 MiB. It derives from
[Alibaba-NLP/gte-reranker-modernbert-base](https://huggingface.co/Alibaba-NLP/gte-reranker-modernbert-base),
under Apache 2.0, with additional synthetic action-applicability training and
weight-only compression. Full-precision calculations may expand weights in
RAM; the measured process used about 1.1 to 1.2 GiB.

On the reused benchmark's 60-case test half, the stricter profile produced
44 useful packs at 180 memories and 36 at 1,000. Control packs with a wrong or
unreviewed memory were 5/75 at both sizes. The reference model produced 47/60
and 25/60 useful packs at its own development-fitted cutoffs. These are
exploratory benchmark results, with synthetic cases and agent-reviewed labels.
They do not establish real-session accuracy.

General explanation questions remain a weakness: a 48-control stress set
still admitted wrong or unreviewed memories on 29 requests at 180 and 26 at
1,000. The stricter companion rule helps extra memories, not a high-scoring
irrelevant first match. The evaluated store sizes are 180 and 1,000.

## Install

Download the archive and its `.sha256` asset from the
[2.0.0 release](https://github.com/edihasaj/recall/releases/tag/v2.0.0).
Verify the archive in the download directory, then extract it:

```bash
shasum -a 256 -c recall-relevance-2.0.0.tar.gz.sha256
mkdir -p ~/.recall/models
tar -xzf recall-relevance-2.0.0.tar.gz -C ~/.recall/models
cd ~/.recall/models/recall-relevance-2.0.0
shasum -a 256 -c SHA256SUMS
```

Select it for a Recall process with:

```bash
export RECALL_RERANK=true
export RECALL_RERANK_MODEL="$HOME/.recall/models/recall-relevance-2.0.0"
export RECALL_RERANK_MAX_LENGTH=128
```

The config fixes batching at 16, the store-size cutoff curve and the companion
ratio at 0.9. Keep those settings together. CPU inference measured about 1.3
to 1.7 seconds per query on the development machine. Other machines need
their own latency checks. The shipped default remains reranking off.

To use an already connected model for final relevance decisions, enable
`RECALL_RELEVANCE_LLM=true`. A missing provider, timeout or failure falls back
to local selection. This opt-in path sends the query and candidate memory
texts to that provider. The hosted Recall Cloud service has its own API and
deployment settings; it is separate from this local connected-provider option.
