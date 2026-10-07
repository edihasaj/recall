import { Tensor, type PreTrainedTokenizer } from "@huggingface/transformers";

/**
 * Truncate pair content before inserting the model's special tokens, matching
 * Python's longest-first policy. Transformers.js truncates the already joined
 * sequence, which drops its closing separator and can remove the whole memory
 * when the query is long. Cross-encoders were trained on complete pair templates.
 */
export function tokenizeRerankPairs(
  tokenizer: PreTrainedTokenizer,
  query: string,
  documents: string[],
  maxLength: number,
): Record<string, Tensor> {
  const processor = tokenizer._tokenizer.post_processor;
  const specialCount = processor?.post_process([], [], true).tokens.length ?? 0;
  const limit = Math.min(maxLength, tokenizer.model_max_length);
  if (limit < specialCount) throw new Error("Reranker token limit cannot fit the pair's special tokens");
  const queryTokens = tokenizer.tokenize(query, { add_special_tokens: false });
  const rows = documents.map((document) => {
    const first = [...queryTokens];
    const second = tokenizer.tokenize(document, { add_special_tokens: false });
    while (first.length + second.length + specialCount > limit) {
      (first.length > second.length ? first : second).pop();
    }
    const processed = processor?.post_process(first, second, true)
      ?? { tokens: [...first, ...second] };
    return {
      ids: tokenizer.convert_tokens_to_ids(processed.tokens),
      types: "token_type_ids" in processed ? processed.token_type_ids : undefined,
    };
  });
  const width = Math.max(...rows.map((row) => row.ids.length));
  const ids = new BigInt64Array(rows.length * width);
  const mask = new BigInt64Array(ids.length);
  const types = new BigInt64Array(ids.length);
  ids.fill(BigInt(tokenizer.pad_token_id ?? 0));
  for (const [i, row] of rows.entries()) {
    const start = i * width + (tokenizer.padding_side === "left" ? width - row.ids.length : 0);
    for (const [j, id] of row.ids.entries()) {
      ids[start + j] = BigInt(id);
      mask[start + j] = 1n;
      types[start + j] = BigInt(row.types?.[j] ?? 0);
    }
  }
  const dims = [rows.length, width];
  return {
    input_ids: new Tensor("int64", ids, dims),
    attention_mask: new Tensor("int64", mask, dims),
    ...(tokenizer.return_token_type_ids ? { token_type_ids: new Tensor("int64", types, dims) } : {}),
  };
}
