import { BertTokenizer } from "@huggingface/transformers";
import { expect, it } from "vitest";
import { tokenizeRerankPairs } from "../src/embeddings/tokenize-pairs.js";

function tokenizer() {
  return new BertTokenizer({
    model: { type: "WordPiece", unk_token: "[UNK]", vocab: {
      "[PAD]": 0, "[UNK]": 1, "[CLS]": 2, "[SEP]": 3, query: 4, memory: 5,
    } },
    pre_tokenizer: { type: "Whitespace" },
    normalizer: null,
    decoder: { type: "WordPiece", prefix: "##", cleanup: true },
    post_processor: { type: "BertProcessing", cls: ["[CLS]", 2], sep: ["[SEP]", 3] },
    added_tokens: [
      { id: 0, content: "[PAD]", special: true },
      { id: 1, content: "[UNK]", special: true },
      { id: 2, content: "[CLS]", special: true },
      { id: 3, content: "[SEP]", special: true },
    ],
  }, { tokenizer_class: "BertTokenizer", pad_token: "[PAD]", unk_token: "[UNK]",
    cls_token: "[CLS]", sep_token: "[SEP]", model_max_length: 512 });
}

it("keeps both pair separators when a long memory is truncated", () => {
  const tok = tokenizer();
  const memory = "memory ".repeat(20);
  const native = tok("query", { text_pair: memory, truncation: true, max_length: 8 });
  expect(Number(native.input_ids.data.at(-1))).toBe(5); // old path loses the closing separator
  const encoded = tokenizeRerankPairs(tok, "query", [memory], 8);
  expect(Array.from(encoded.input_ids.data, Number)).toEqual([2, 4, 3, 5, 5, 5, 5, 3]);
  expect(Array.from(encoded.token_type_ids.data, Number)).toEqual([0, 0, 0, 1, 1, 1, 1, 1]);
});

it("retains the memory when the query exceeds the token budget", () => {
  const encoded = tokenizeRerankPairs(tokenizer(), "query ".repeat(20), ["memory memory"], 8);
  expect(Array.from(encoded.input_ids.data, Number)).toEqual([2, 4, 4, 4, 3, 5, 5, 3]);
});

it("matches native untruncated pairs, including batch padding and segment ids", () => {
  const tok = tokenizer();
  const documents = ["memory", "memory memory memory"];
  const native = tok(documents.map(() => "query"), { text_pair: documents, padding: true, truncation: true, max_length: 64 });
  const encoded = tokenizeRerankPairs(tok, "query", documents, 64);
  for (const name of ["input_ids", "attention_mask", "token_type_ids"] as const) {
    expect(encoded[name].dims).toEqual(native[name]!.dims);
    expect(Array.from(encoded[name].data)).toEqual(Array.from(native[name]!.data));
  }
});

it("respects a tokenizer configured for left padding", () => {
  const tok = tokenizer();
  tok.padding_side = "left";
  const documents = ["memory", "memory memory memory"];
  const native = tok(documents.map(() => "query"), { text_pair: documents, padding: true, truncation: true, max_length: 64 });
  const encoded = tokenizeRerankPairs(tok, "query", documents, 64);
  expect(Array.from(encoded.input_ids.data)).toEqual(Array.from(native.input_ids.data));
  expect(Array.from(encoded.attention_mask.data)).toEqual(Array.from(native.attention_mask.data));
});
