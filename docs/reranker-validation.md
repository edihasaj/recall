---
summary: How local reranker experiments separate retrieval, tokenization, compression, and cutoff losses.
read_when:
  - Changing the local reranker or its tokenizer
  - Exporting a memory relevance model to ONNX
  - Comparing model training scores with Recall runtime scores
---

# Validating a local reranker

Compare the model on identical query and memory pairs before comparing whole
packs. A training result does not establish runtime accuracy. Candidate
retrieval, tokenization, compression and the injection cutoff can each lose
useful memories.

`relevance-lab/bench/recall-load.ts --trace --dump <file>` records every pair
Recall actually scores, its probability and the cutoff. The trace observer
uses the real model. Traced runs are for diagnosis rather than clean latency
measurement.

For long pairs, Recall shortens the longer content sequence first, then adds
the tokenizer's pair template. Both separators stay present, and the memory
remains visible when the query is long. Padding follows the tokenizer's
configured side. This matches the longest-first policy used in Python training.
The old JavaScript call cut the already joined token sequence, discarding its
closing separator and sometimes the entire memory.

The October 2026 check used 46 requests and their real candidate pools. With
full-precision ONNX weights, preserving the pair template reduced the largest
probability difference from the training evaluator from 0.86 to 0.000006.
Every request's top-two selection then agreed. This checks inference parity,
not general relevance accuracy.

Integer compression needs a separate check. In that sample, the original int8
export changed the top-two selection in 26 of 46 requests compared with full
precision. Per-channel quantization reduced that to 21, but that alone does
not prove better packs. Fit each artifact's cutoff on development controls,
freeze it, then evaluate held-out requests through Recall. Do not use hosted
teacher verdicts as unquestioned relevance labels.

Experiment scripts, reviewed labels, fresh fixtures and the full results live
in `~/Projects/relevance-lab`. These checks do not change the opt-in status of
reranking or install a new model into the running daemon.

A local model package may set `recall_rerank_batch_size` in `config.json` to an
integer from 1 to 64. Missing or invalid values use 16. Larger batches can trade
memory for throughput. Calibrate the exported artifact at its declared batch
size: dynamic int8 activation scales can depend on which pairs share a batch.
Full-precision activation calculations are much less sensitive, but still need
runtime verification at the chosen size.

A local package may also set `recall_rerank_companion_ratio` to a number from
0 to 1. Missing or invalid values use 0. After selecting the first query-driven
memory, Recall skips reranked companions whose probability is below that
fraction of the first memory's probability. Each memory must still pass the
absolute cutoff. A value of 0.9 requires a companion to score at least 90% of
the first selected memory. This is a score comparison, not a calibrated claim
that the companion has a 90% chance of applying.

The gate applies only to local query-driven selection. A successful connected
judge verdict replaces it; a failed judge call retains the local gate. Ambient
startup selection is unaffected. Fit the ratio on development requests and
report recall lost as well as companions removed. Separate reviewed mistakes
from unreviewed memories when assessing whether the resulting packs are clean.
