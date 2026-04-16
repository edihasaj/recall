import type { EmbeddingConfig } from "../../types.js";
import { createOpenAIProvider, type EmbeddingProvider } from "./openai.js";

export function resolveProvider(config: EmbeddingConfig): EmbeddingProvider {
  switch (config.provider) {
    case "openai":
      return createOpenAIProvider(config);
    default:
      throw new Error(`Unsupported embedding provider: ${config.provider}`);
  }
}
