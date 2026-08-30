/**
 * Memory retrieval eval runner.
 *
 * Upstream's headline claim is that agents "remember everything, learn from
 * every mistake, and get better with every task", with nothing anywhere in the
 * project that measures it. This turns that claim into numbers.
 *
 * The harness seeds a golden corpus into a real memory store, embeds it with a
 * chosen provider, runs each labelled query through the same retrieval path the
 * agents use, and scores the ranking. Because it drives the production
 * SqliteMemoryStore rather than a mock, a regression in retrieval shows up here.
 */

import type { EmbeddingProvider, MemoryStore } from "@/be/memory/types";
import {
  hitAtK,
  mean,
  ndcgAtK,
  percentile,
  precisionAtK,
  recallAtK,
  reciprocalRank,
} from "./metrics.ts";
import type { EvalMetrics, EvalReport, GoldenSet, QueryResult } from "./types.ts";

export const DEFAULT_K_VALUES = [1, 3, 5, 10];

export interface RunEvalOptions {
  goldenSet: GoldenSet;
  store: MemoryStore;
  embeddings: EmbeddingProvider;
  /** Agent the memories are stored against. */
  agentId: string;
  kValues?: number[];
  /** How many candidates to ask the store for. Defaults to max(kValues). */
  retrievalLimit?: number;
}

export async function runEval(options: RunEvalOptions): Promise<EvalReport> {
  const { goldenSet, store, embeddings, agentId } = options;
  const kValues = options.kValues ?? DEFAULT_K_VALUES;
  const retrievalLimit = options.retrievalLimit ?? Math.max(...kValues);

  // --- Seed the corpus -----------------------------------------------------
  // Map golden keys to the ids the store assigns, so relevance labels can be
  // compared against retrieval output.
  const keyById = new Map<string, string>();

  for (const doc of goldenSet.documents) {
    const stored = store.store({
      agentId,
      scope: "agent",
      name: doc.name,
      // Embed name and content together: that is what the retriever sees at
      // write time in production, so the eval must match it.
      content: doc.content,
      source: "manual",
      tags: doc.tags,
    });

    const vector = await embeddings.embed(`${doc.name}\n${doc.content}`);
    if (!vector) {
      throw new Error(`Embedding provider returned null for document "${doc.key}"`);
    }
    store.updateEmbedding(stored.id, vector, embeddings.name);
    keyById.set(stored.id, doc.key);
  }

  // --- Run the queries -----------------------------------------------------
  const results: QueryResult[] = [];

  for (const query of goldenSet.queries) {
    const vector = await embeddings.embed(query.query);
    if (!vector) {
      throw new Error(`Embedding provider returned null for query "${query.id}"`);
    }

    const startedAt = performance.now();
    const candidates = store.search(vector, agentId, {
      scope: "agent",
      limit: retrievalLimit,
    });
    const latencyMs = performance.now() - startedAt;

    // Retrieval returns store ids; translate back to golden keys. A candidate
    // with no mapping would mean the store leaked rows across runs.
    const ranked = candidates
      .map((c) => keyById.get(c.id))
      .filter((key): key is string => key !== undefined);

    results.push({
      queryId: query.id,
      query: query.query,
      ranked,
      relevant: query.relevant,
      reciprocalRank: reciprocalRank(ranked, new Set(query.relevant)),
      latencyMs,
    });
  }

  return {
    goldenSet: goldenSet.name,
    embeddingProvider: embeddings.name,
    dimensions: embeddings.dimensions,
    metrics: computeMetrics(results, goldenSet.documents.length, kValues),
    results,
  };
}

export function computeMetrics(
  results: QueryResult[],
  documentCount: number,
  kValues: number[] = DEFAULT_K_VALUES,
): EvalMetrics {
  const hit: Record<number, number> = {};
  const recall: Record<number, number> = {};
  const precision: Record<number, number> = {};
  const ndcg: Record<number, number> = {};

  for (const k of kValues) {
    hit[k] = mean(results.map((r) => (hitAtK(r.ranked, new Set(r.relevant), k) ? 1 : 0)));
    recall[k] = mean(results.map((r) => recallAtK(r.ranked, new Set(r.relevant), k)));
    precision[k] = mean(results.map((r) => precisionAtK(r.ranked, new Set(r.relevant), k)));
    ndcg[k] = mean(results.map((r) => ndcgAtK(r.ranked, new Set(r.relevant), k)));
  }

  const latencies = results.map((r) => r.latencyMs);

  return {
    queries: results.length,
    documents: documentCount,
    hitAtK: hit,
    recallAtK: recall,
    precisionAtK: precision,
    ndcgAtK: ndcg,
    mrr: mean(results.map((r) => r.reciprocalRank)),
    latencyP50Ms: percentile(latencies, 0.5),
    latencyP95Ms: percentile(latencies, 0.95),
  };
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

/** Human-readable report for the terminal. */
export function formatReport(report: EvalReport, kValues: number[] = DEFAULT_K_VALUES): string {
  const { metrics } = report;
  const lines: string[] = [];

  lines.push("");
  lines.push(`  Golden set    ${report.goldenSet}`);
  lines.push(`  Embeddings    ${report.embeddingProvider} (${report.dimensions}d)`);
  lines.push(`  Corpus        ${metrics.documents} documents, ${metrics.queries} queries`);
  lines.push("");
  lines.push("  k      hit@k    recall@k  prec@k   nDCG@k");
  lines.push("  ----   ------   --------  ------   ------");
  for (const k of kValues) {
    lines.push(
      `  ${String(k).padEnd(4)}   ${pct(metrics.hitAtK[k] ?? 0).padStart(6)}   ` +
        `${pct(metrics.recallAtK[k] ?? 0).padStart(8)}  ` +
        `${pct(metrics.precisionAtK[k] ?? 0).padStart(6)}   ` +
        `${pct(metrics.ndcgAtK[k] ?? 0).padStart(6)}`,
    );
  }
  lines.push("");
  lines.push(`  MRR           ${metrics.mrr.toFixed(3)}`);
  lines.push(
    `  Latency       p50 ${metrics.latencyP50Ms.toFixed(2)}ms · p95 ${metrics.latencyP95Ms.toFixed(2)}ms`,
  );

  const misses = report.results.filter((r) => r.reciprocalRank === 0);
  if (misses.length > 0) {
    lines.push("");
    lines.push(`  Complete misses (${misses.length}):`);
    for (const miss of misses) {
      lines.push(`    · ${miss.queryId} — "${miss.query}"`);
      lines.push(`      expected one of: ${miss.relevant.join(", ")}`);
      lines.push(`      got: ${miss.ranked.slice(0, 3).join(", ") || "(nothing)"}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}
