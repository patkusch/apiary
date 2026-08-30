/**
 * Information-retrieval metrics for the memory eval harness.
 *
 * All functions here are pure and take a ranked list of retrieved ids plus the
 * set of ids that are actually relevant for the query. Relevance is binary: a
 * memory is either useful for the query or it is not. Graded relevance would let
 * nDCG say more, but binary judgements are the ones a person can actually author
 * consistently for a golden set, and an honest cheap metric beats a rich one
 * built on guessed grades.
 */

/** Rank (1-indexed) of the first relevant result, or null if none was retrieved. */
export function firstRelevantRank(ranked: string[], relevant: Set<string>): number | null {
  for (let i = 0; i < ranked.length; i++) {
    if (relevant.has(ranked[i]!)) return i + 1;
  }
  return null;
}

/**
 * hit@k — did we surface *any* relevant memory in the top k?
 *
 * This is the metric that matters most for agent memory: the agent gets a
 * handful of memories injected into its prompt, and one genuinely relevant hit
 * is usually enough to change what it does.
 */
export function hitAtK(ranked: string[], relevant: Set<string>, k: number): boolean {
  const rank = firstRelevantRank(ranked.slice(0, k), relevant);
  return rank !== null;
}

/** recall@k — what fraction of all relevant memories made it into the top k? */
export function recallAtK(ranked: string[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return 0;
  const hits = ranked.slice(0, k).filter((id) => relevant.has(id)).length;
  return hits / relevant.size;
}

/** precision@k — what fraction of the top k results were relevant? */
export function precisionAtK(ranked: string[], relevant: Set<string>, k: number): number {
  if (k <= 0) return 0;
  const window = ranked.slice(0, k);
  if (window.length === 0) return 0;
  const hits = window.filter((id) => relevant.has(id)).length;
  return hits / window.length;
}

/** Reciprocal rank of the first relevant result; 0 if none was retrieved. */
export function reciprocalRank(ranked: string[], relevant: Set<string>): number {
  const rank = firstRelevantRank(ranked, relevant);
  return rank === null ? 0 : 1 / rank;
}

/**
 * nDCG@k with binary gains — rewards putting relevant memories near the top,
 * not merely somewhere in the window. Normalised against the ideal ranking so
 * queries with different numbers of relevant memories stay comparable.
 */
export function ndcgAtK(ranked: string[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0 || k <= 0) return 0;

  let dcg = 0;
  const window = ranked.slice(0, k);
  for (let i = 0; i < window.length; i++) {
    if (relevant.has(window[i]!)) {
      dcg += 1 / Math.log2(i + 2); // i is 0-indexed, so rank = i + 1
    }
  }

  // Ideal DCG: every relevant memory packed into the highest positions.
  let idcg = 0;
  const ideal = Math.min(relevant.size, k);
  for (let i = 0; i < ideal; i++) {
    idcg += 1 / Math.log2(i + 2);
  }

  return idcg === 0 ? 0 : dcg / idcg;
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Nearest-rank percentile. p is a fraction in [0, 1]. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index]!;
}
