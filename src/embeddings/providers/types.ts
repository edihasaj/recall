export type EmbeddingPurpose = "document" | "query";

export type EmbeddingProvider = {
  embed(text: string, purpose?: EmbeddingPurpose): Promise<Float32Array>;
  embedBatch(texts: string[], purpose?: EmbeddingPurpose): Promise<Float32Array[]>;
  metadata(): {
    model: string;
    dimensions: number;
    version: string;
    task_prefix?: string;
  };
};
