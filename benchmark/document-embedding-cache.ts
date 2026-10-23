import { createHash } from "node:crypto";

export interface DocumentEmbeddingCacheConfig {
  provider: string;
  model: string;
}

export interface DocumentEmbeddingCacheStats {
  hits: number;
  misses: number;
  entries: number;
}

/**
 * A single-run cache for document embeddings from one explicit provider/model.
 * Query embeddings deliberately do not pass through this cache.
 */
export class DocumentEmbeddingCache {
  private readonly values = new Map<string, Float32Array>();
  private hits = 0;
  private misses = 0;
  readonly config: Readonly<DocumentEmbeddingCacheConfig>;

  constructor(
    config: DocumentEmbeddingCacheConfig,
    private readonly generate: (text: string) => Promise<Float32Array>,
  ) {
    this.config = Object.freeze({ provider: config.provider, model: config.model });
  }

  async embed(text: string): Promise<Float32Array> {
    // Hash exact JavaScript UTF-16 code units. UTF-8 would replace an
    // unpaired surrogate with U+FFFD, incorrectly merging distinct inputs.
    const key = createHash("sha256").update(text, "utf16le").digest("hex");
    const cached = this.values.get(key);
    if (cached) {
      this.hits++;
      return new Float32Array(cached);
    }

    this.misses++;
    const generated = await this.generate(text);
    const stored = new Float32Array(generated);
    this.values.set(key, stored);
    return new Float32Array(stored);
  }

  stats(): DocumentEmbeddingCacheStats {
    return { hits: this.hits, misses: this.misses, entries: this.values.size };
  }
}
