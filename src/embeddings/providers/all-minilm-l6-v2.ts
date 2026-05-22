import { pipeline, type FeatureExtractionPipeline, type Tensor } from "@huggingface/transformers";
import type { EmbeddingConfig } from "../../types.js";
import { ensureEmbeddingCachePath } from "../cache.js";
import type { EmbeddingPurpose, EmbeddingProvider } from "./types.js";

const MINILM_MODEL = "Xenova/all-MiniLM-L6-v2";
const MINILM_DIMENSIONS = 384;

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

function getModel(config: EmbeddingConfig): string {
  return config.model || MINILM_MODEL;
}

function getDimensions(config: EmbeddingConfig): number {
  const dimensions = config.dimensions || MINILM_DIMENSIONS;
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(`Invalid all-MiniLM-L6-v2 embedding dimensions: ${dimensions}`);
  }
  if (dimensions > MINILM_DIMENSIONS) {
    throw new Error(`all-MiniLM-L6-v2 embeddings support at most ${MINILM_DIMENSIONS} dimensions`);
  }
  return dimensions;
}

async function getExtractor(config: EmbeddingConfig): Promise<FeatureExtractionPipeline> {
  const cacheDir = ensureEmbeddingCachePath({
    provider: config.provider,
    model: getModel(config),
  });
  extractorPromise ??= pipeline("feature-extraction", getModel(config), {
    cache_dir: cacheDir,
    dtype: "q8",
  });
  return extractorPromise;
}

function tensorToEmbeddings(tensor: Tensor): Float32Array[] {
  const [rows, columns] = tensor.dims.length === 1
    ? [1, tensor.dims[0]]
    : tensor.dims;
  if (!rows || !columns) {
    throw new Error(`Unexpected all-MiniLM-L6-v2 tensor shape: [${tensor.dims.join(", ")}]`);
  }

  const embeddings: Float32Array[] = [];
  for (let row = 0; row < rows; row++) {
    const start = row * columns;
    const end = start + columns;
    embeddings.push(Float32Array.from(tensor.data.subarray(start, end)));
  }
  return embeddings;
}

async function embedTexts(
  texts: string[],
  config: EmbeddingConfig,
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];

  const extractor = await getExtractor(config);
  const embeddings = await extractor(texts, {
    pooling: "mean",
    normalize: true,
  });

  return tensorToEmbeddings(
    embeddings.dims.at(-1) === getDimensions(config)
      ? embeddings
      : embeddings.slice(null, [0, getDimensions(config)]).normalize(2, -1),
  );
}

export function createAllMiniLmL6V2Provider(config: EmbeddingConfig): EmbeddingProvider {
  return {
    async embed(text: string, _purpose: EmbeddingPurpose = "document"): Promise<Float32Array> {
      const [embedding] = await embedTexts([text], config);
      return embedding;
    },

    async embedBatch(texts: string[], _purpose: EmbeddingPurpose = "document"): Promise<Float32Array[]> {
      return embedTexts(texts, config);
    },

    async prepare(): Promise<void> {
      await getExtractor(config);
    },

    metadata() {
      const dims = getDimensions(config);
      return {
        model: getModel(config),
        dimensions: dims,
        canonical_dimensions: dims,
        index_dimensions: dims,
        version: config.version,
        estimated_size_mb: 23,
      };
    },
  };
}
