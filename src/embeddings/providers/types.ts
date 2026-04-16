export type EmbeddingPurpose = "document" | "query";

export type EmbeddingProvider = {
  embed(text: string, purpose?: EmbeddingPurpose): Promise<Float32Array>;
  embedBatch(texts: string[], purpose?: EmbeddingPurpose): Promise<Float32Array[]>;
  prepare?(): Promise<void>;
  metadata(): {
    model: string;
    dimensions: number;
    canonical_dimensions: number;
    index_dimensions: number;
    version: string;
    task_prefix?: string;
    estimated_size_mb?: number;
  };
};
