/**
 * Deterministic, offline embedding provider for the eval harness.
 *
 * The production provider calls the OpenAI embeddings API, which makes it
 * unusable as a CI baseline: it needs a key, it costs money per run, and the
 * numbers drift when the upstream model changes. An eval you cannot run on every
 * commit is an eval nobody runs.
 *
 * This is a hashed bag-of-words projection: tokens are hashed into buckets with
 * sub-linear term-frequency weighting, then L2-normalised so cosine similarity
 * behaves. It captures lexical overlap only — no synonymy, no word order — so
 * its absolute scores are a *floor*, not a prediction of production quality.
 *
 * What it is good for: a fast, free, perfectly reproducible baseline that makes
 * retrieval regressions visible. Use `--provider openai` for real numbers.
 */

import type { EmbeddingProvider } from "@/be/memory/types";

const DEFAULT_DIMENSIONS = 512;

/** FNV-1a. Cheap, well-distributed, and stable across processes and platforms. */
function hashToken(token: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly name = "hash-bow-v1";
  readonly dimensions: number;

  constructor(dimensions: number = DEFAULT_DIMENSIONS) {
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<Float32Array | null> {
    return this.embedSync(text);
  }

  async embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
    return texts.map((t) => this.embedSync(t));
  }

  /** Synchronous variant — the harness embeds thousands of documents in a loop. */
  embedSync(text: string): Float32Array {
    const vector = new Float32Array(this.dimensions);
    const tokens = tokenize(text);

    const counts = new Map<string, number>();
    for (const token of tokens) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }

    for (const [token, count] of counts) {
      const bucket = hashToken(token) % this.dimensions;
      // Sub-linear TF: a term repeated 10x is more important than one repeated
      // once, but not 10x more. Standard log-scaled term frequency.
      const weight = 1 + Math.log(count);
      // A second hash decides the sign, so unrelated tokens colliding in the
      // same bucket tend to cancel rather than compound into false similarity.
      const sign = hashToken(`${token}#sign`) % 2 === 0 ? 1 : -1;
      vector[bucket] = vector[bucket]! + sign * weight;
    }

    let norm = 0;
    for (let i = 0; i < vector.length; i++) norm += vector[i]! * vector[i]!;
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < vector.length; i++) vector[i] = vector[i]! / norm;
    }

    return vector;
  }
}
