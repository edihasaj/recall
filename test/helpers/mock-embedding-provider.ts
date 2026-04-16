import { vi } from "vitest";
import * as providerRegistry from "../../src/embeddings/providers/index.js";
import type { EmbeddingPurpose, EmbeddingProvider } from "../../src/embeddings/providers/types.js";

type VectorForText = (
  text: string,
  purpose: EmbeddingPurpose,
  config: Parameters<typeof providerRegistry.resolveProvider>[0],
) => number[];

export function installMockEmbeddingProvider(vectorForText: VectorForText) {
  return vi.spyOn(providerRegistry, "resolveProvider").mockImplementation((config) => {
    const provider: EmbeddingProvider = {
      async embed(text: string, purpose: EmbeddingPurpose = "document") {
        return Float32Array.from(vectorForText(text, purpose, config));
      },
      async embedBatch(texts: string[], purpose: EmbeddingPurpose = "document") {
        return texts.map((text) => Float32Array.from(vectorForText(text, purpose, config)));
      },
      metadata() {
        return {
          model: config.model,
          dimensions: config.dimensions,
          version: config.version,
        };
      },
    };
    return provider;
  });
}
