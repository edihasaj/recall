import type { EmbeddingConfig } from "../../types.js";
import { createBgeSmallEnV15Provider } from "./bge-small-en-v1.5.js";
import { createMultilingualE5Provider } from "./multilingual-e5.js";
import { createNomicProvider } from "./nomic.js";
import type { EmbeddingProvider } from "./types.js";

export function resolveProvider(config: EmbeddingConfig): EmbeddingProvider {
  switch (config.provider) {
    case "bge-small-en-v1.5":
      return createBgeSmallEnV15Provider(config);
    case "multilingual-e5":
      return createMultilingualE5Provider(config);
    case "nomic":
      return createNomicProvider(config);
    default:
      throw new Error(`Unsupported embedding provider: ${config.provider}`);
  }
}
