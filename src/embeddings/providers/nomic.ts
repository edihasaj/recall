import { layer_norm, pipeline, type FeatureExtractionPipeline, type Tensor } from "@huggingface/transformers";
import type { EmbeddingConfig } from "../../types.js";
import { ensureEmbeddingCachePath } from "../cache.js";
import type { EmbeddingPurpose, EmbeddingProvider } from "./types.js";

const NOMIC_MODEL = "nomic-ai/nomic-embed-text-v1.5";
const NOMIC_NATIVE_DIMENSIONS = 768;
const NOMIC_PREFIXES: Record<EmbeddingPurpose, string> = {
  document: "search_document: ",
  query: "search_query: ",
};

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

function getModel(config: EmbeddingConfig): string {
  return config.model || NOMIC_MODEL;
}

function getDimensions(config: EmbeddingConfig): number {
  const dimensions = config.dimensions || 512;
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(`Invalid nomic embedding dimensions: ${dimensions}`);
  }
  if (dimensions > NOMIC_NATIVE_DIMENSIONS) {
    throw new Error(`Nomic embeddings support at most ${NOMIC_NATIVE_DIMENSIONS} dimensions`);
  }
  return dimensions;
}

function prefixTexts(texts: string[], purpose: EmbeddingPurpose): string[] {
  const prefix = NOMIC_PREFIXES[purpose];
  return texts.map((text) => `${prefix}${text}`);
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
    throw new Error(`Unexpected nomic tensor shape: [${tensor.dims.join(", ")}]`);
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
  purpose: EmbeddingPurpose,
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];

  const extractor = await getExtractor(config);
  const rawEmbeddings = await extractor(prefixTexts(texts, purpose), {
    pooling: "mean",
  });

  const nativeDimensions = rawEmbeddings.dims.at(-1);
  if (!nativeDimensions) {
    throw new Error("Nomic extractor returned an embedding tensor without dimensions");
  }

  const normalized = layer_norm(rawEmbeddings, [nativeDimensions])
    .slice(null, [0, getDimensions(config)])
    .normalize(2, -1);

  return tensorToEmbeddings(normalized);
}

export function createNomicProvider(config: EmbeddingConfig): EmbeddingProvider {
  return {
    async embed(text: string, purpose: EmbeddingPurpose = "document"): Promise<Float32Array> {
      const [embedding] = await embedTexts([text], config, purpose);
      return embedding;
    },

    async embedBatch(texts: string[], purpose: EmbeddingPurpose = "document"): Promise<Float32Array[]> {
      return embedTexts(texts, config, purpose);
    },

    async prepare(): Promise<void> {
      await getExtractor(config);
    },

    metadata() {
      return {
        model: getModel(config),
        dimensions: getDimensions(config),
        version: config.version,
        task_prefix: `${NOMIC_PREFIXES.document.trim()} | ${NOMIC_PREFIXES.query.trim()}`,
        estimated_size_mb: 140,
      };
    },
  };
}
