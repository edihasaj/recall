export const BACKGROUND_EMBEDDING_BATCH_SIZE = 8;

export interface ResponsiveBatchOptions {
  batchSize?: number;
  yieldControl?: () => Promise<void>;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Keep daemon HTTP/hooks responsive between CPU-heavy native inference batches. */
export async function processInResponsiveBatches<T>(
  items: T[],
  processBatch: (batch: T[]) => Promise<void>,
  options: ResponsiveBatchOptions = {},
): Promise<void> {
  const batchSize = options.batchSize ?? BACKGROUND_EMBEDDING_BATCH_SIZE;
  const yieldControl = options.yieldControl ?? yieldToEventLoop;
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error(`Invalid background embedding batch size: ${batchSize}`);
  }

  for (let i = 0; i < items.length; i += batchSize) {
    await processBatch(items.slice(i, i + batchSize));
    if (i + batchSize < items.length) await yieldControl();
  }
}
