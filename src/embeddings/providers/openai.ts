import type { EmbeddingConfig } from "../../types.js";
import type { EmbeddingPurpose, EmbeddingProvider } from "./types.js";

function getOpenAIApiKey(config: EmbeddingConfig): string {
  const apiKey = config.api_key ?? process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OpenAI API key required for embeddings");
  return apiKey;
}

async function requestOpenAIEmbeddings(
  input: string | string[],
  config: EmbeddingConfig,
): Promise<Array<{ embedding: number[]; index: number }>> {
  const resp = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getOpenAIApiKey(config)}`,
    },
    body: JSON.stringify({
      input,
      model: config.model,
      dimensions: config.dimensions,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenAI embedding failed: ${err}`);
  }

  const data = (await resp.json()) as {
    data: Array<{ embedding: number[]; index: number }>;
  };
  return data.data;
}

export function createOpenAIProvider(config: EmbeddingConfig): EmbeddingProvider {
  return {
    async embed(text: string, _purpose?: EmbeddingPurpose): Promise<Float32Array> {
      const [item] = await requestOpenAIEmbeddings(text, config);
      return new Float32Array(item.embedding);
    },

    async embedBatch(texts: string[], _purpose?: EmbeddingPurpose): Promise<Float32Array[]> {
      if (texts.length === 0) return [];

      const items = await requestOpenAIEmbeddings(texts, config);
      return items
        .sort((a, b) => a.index - b.index)
        .map((item) => new Float32Array(item.embedding));
    },

    metadata() {
      return {
        model: config.model,
        dimensions: config.dimensions,
        version: config.version,
      };
    },
  };
}
