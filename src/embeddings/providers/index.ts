import type { EmbeddingConfig } from "../../types.js";
import { createMultilingualE5Provider } from "./multilingual-e5.js";
import { createNomicProvider } from "./nomic.js";
import { createOpenAIProvider } from "./openai.js";
import type { EmbeddingProvider } from "./types.js";

export function resolveProvider(config: EmbeddingConfig): EmbeddingProvider {
  switch (config.provider) {
    case "multilingual-e5":
      return createMultilingualE5Provider(config);
    case "nomic":
      return createNomicProvider(config);
    case "openai":
      return createOpenAIProvider(config);
    default:
      throw new Error(`Unsupported embedding provider: ${config.provider}`);
  }
}
