import { z } from "zod";

/**
 * A golden set is a corpus of memories plus queries with hand-labelled relevance.
 *
 * Documents carry stable string keys rather than generated UUIDs so a golden set
 * stays readable and diffable in review, and so relevance labels survive being
 * re-seeded into a fresh database.
 */

export const GoldenDocumentSchema = z.object({
  /** Stable key used by relevance labels, e.g. "pg-pool-exhaustion". */
  key: z.string().min(1),
  name: z.string().min(1),
  content: z.string().min(1),
  tags: z.array(z.string()).default([]),
});

export const GoldenQuerySchema = z.object({
  id: z.string().min(1),
  query: z.string().min(1),
  /** Document keys that a useful retriever must surface for this query. */
  relevant: z.array(z.string().min(1)).min(1),
  /** Optional note explaining *why* these are the right answers. */
  rationale: z.string().optional(),
});

export const GoldenSetSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  documents: z.array(GoldenDocumentSchema).min(1),
  queries: z.array(GoldenQuerySchema).min(1),
});

export type GoldenDocument = z.infer<typeof GoldenDocumentSchema>;
export type GoldenQuery = z.infer<typeof GoldenQuerySchema>;
export type GoldenSet = z.infer<typeof GoldenSetSchema>;

export interface QueryResult {
  queryId: string;
  query: string;
  /** Retrieved document keys, best first. */
  ranked: string[];
  relevant: string[];
  reciprocalRank: number;
  latencyMs: number;
}

export interface EvalMetrics {
  queries: number;
  documents: number;
  /** hit@k keyed by k — the headline number for agent memory. */
  hitAtK: Record<number, number>;
  recallAtK: Record<number, number>;
  precisionAtK: Record<number, number>;
  ndcgAtK: Record<number, number>;
  mrr: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
}

export interface EvalReport {
  goldenSet: string;
  embeddingProvider: string;
  dimensions: number;
  metrics: EvalMetrics;
  results: QueryResult[];
}

/** Validate a parsed golden set, surfacing label errors as readable messages. */
export function parseGoldenSet(raw: unknown): GoldenSet {
  const set = GoldenSetSchema.parse(raw);

  const keys = new Set(set.documents.map((d) => d.key));
  if (keys.size !== set.documents.length) {
    throw new Error("Golden set has duplicate document keys");
  }

  // A relevance label pointing at a document that isn't in the corpus silently
  // caps every metric below 1.0 and is almost always a typo, so fail loudly.
  for (const query of set.queries) {
    for (const key of query.relevant) {
      if (!keys.has(key)) {
        throw new Error(`Query "${query.id}" marks unknown document "${key}" as relevant`);
      }
    }
  }

  return set;
}
