import { pipeline, type FeatureExtractionPipeline, type Tensor } from "@huggingface/transformers";
import type { EmbeddingConfig } from "../../types.js";
import type { EmbeddingPurpose, EmbeddingProvider } from "./types.js";

const MULTILINGUAL_E5_MODEL = "Xenova/multilingual-e5-small";
const MULTILINGUAL_E5_NATIVE_DIMENSIONS = 384;
const MULTILINGUAL_E5_PREFIXES: Record<EmbeddingPurpose, string> = {
  document: "passage: ",
  query: "query: ",
};

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

function getModel(config: EmbeddingConfig): string {
  return !config.model || config.model === "text-embedding-3-small"
    ? MULTILINGUAL_E5_MODEL
    : config.model;
}

function getDimensions(config: EmbeddingConfig): number {
  const dimensions = config.dimensions || MULTILINGUAL_E5_NATIVE_DIMENSIONS;
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(`Invalid multilingual-e5 embedding dimensions: ${dimensions}`);
  }
  if (dimensions > MULTILINGUAL_E5_NATIVE_DIMENSIONS) {
    throw new Error(`multilingual-e5 embeddings support at most ${MULTILINGUAL_E5_NATIVE_DIMENSIONS} dimensions`);
  }
  return dimensions;
}

function prefixTexts(texts: string[], purpose: EmbeddingPurpose): string[] {
  const prefix = MULTILINGUAL_E5_PREFIXES[purpose];
  return texts.map((text) => `${prefix}${text}`);
}

async function getExtractor(config: EmbeddingConfig): Promise<FeatureExtractionPipeline> {
  extractorPromise ??= pipeline("feature-extraction", getModel(config), {
    dtype: "q8",
  });
  return extractorPromise;
}

function tensorToEmbeddings(tensor: Tensor): Float32Array[] {
  const [rows, columns] = tensor.dims.length === 1
    ? [1, tensor.dims[0]]
    : tensor.dims;
  if (!rows || !columns) {
    throw new Error(`Unexpected multilingual-e5 tensor shape: [${tensor.dims.join(", ")}]`);
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
  const embeddings = await extractor(prefixTexts(texts, purpose), {
    pooling: "mean",
    normalize: true,
  });

  return tensorToEmbeddings(
    embeddings.dims.at(-1) === getDimensions(config)
      ? embeddings
      : embeddings.slice(null, [0, getDimensions(config)]).normalize(2, -1),
  );
}

export function createMultilingualE5Provider(config: EmbeddingConfig): EmbeddingProvider {
  return {
    async embed(text: string, purpose: EmbeddingPurpose = "document"): Promise<Float32Array> {
      const [embedding] = await embedTexts([text], config, purpose);
      return embedding;
    },

    async embedBatch(texts: string[], purpose: EmbeddingPurpose = "document"): Promise<Float32Array[]> {
      return embedTexts(texts, config, purpose);
    },

    metadata() {
      return {
        model: getModel(config),
        dimensions: getDimensions(config),
        version: config.version,
        task_prefix: `${MULTILINGUAL_E5_PREFIXES.document.trim()} | ${MULTILINGUAL_E5_PREFIXES.query.trim()}`,
      };
    },
  };
}
