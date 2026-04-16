import type { EmbeddingConfig } from "../../types.js";
import { createNomicProvider } from "./nomic.js";
import { createOpenAIProvider } from "./openai.js";
import type { EmbeddingProvider } from "./types.js";

export function resolveProvider(config: EmbeddingConfig): EmbeddingProvider {
  switch (config.provider) {
    case "nomic":
      return createNomicProvider(config);
    case "openai":
      return createOpenAIProvider(config);
    default:
      throw new Error(`Unsupported embedding provider: ${config.provider}`);
  }
}
