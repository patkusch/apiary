import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { closeDb, createAgent, initDb } from "../be/db";
import { getMemoryStore } from "../be/memory";
import { HashEmbeddingProvider } from "../eval/providers/hash-embedding";
import { runEval } from "../eval/runner";
import { parseGoldenSet } from "../eval/types";

const TEST_DB_PATH = "./test-eval-harness.sqlite";
const FIXTURE = join(import.meta.dir, "../eval/fixtures/engineering-memories.json");

beforeAll(async () => {
  await unlink(TEST_DB_PATH).catch(() => {});
  initDb(TEST_DB_PATH);
});

/**
 * Each run gets its own agent. Memories are agent-scoped, so a shared agent
 * would leave the second run retrieving against both corpora and quietly
 * weaken every assertion that follows.
 */
function freshAgentId(): string {
  return createAgent({
    name: `eval-harness-${crypto.randomUUID()}`,
    isLead: false,
    status: "idle",
    capabilities: [],
  }).id;
}

afterAll(async () => {
  closeDb();
  await unlink(TEST_DB_PATH).catch(() => {});
});

describe("golden set validation", () => {
  test("the built-in golden set is valid", () => {
    const set = parseGoldenSet(JSON.parse(readFileSync(FIXTURE, "utf-8")));
    expect(set.documents.length).toBeGreaterThan(0);
    expect(set.queries.length).toBeGreaterThan(0);
  });

  test("rejects a relevance label pointing at a document not in the corpus", () => {
    // Silently capping every metric below 1.0 is worse than failing loudly:
    // this is nearly always a typo in the label.
    expect(() =>
      parseGoldenSet({
        name: "broken",
        documents: [{ key: "a", name: "A", content: "content a" }],
        queries: [{ id: "q1", query: "find a", relevant: ["typo-key"] }],
      }),
    ).toThrow(/unknown document "typo-key"/);
  });

  test("rejects duplicate document keys", () => {
    expect(() =>
      parseGoldenSet({
        name: "dupes",
        documents: [
          { key: "a", name: "A", content: "one" },
          { key: "a", name: "A again", content: "two" },
        ],
        queries: [{ id: "q1", query: "find a", relevant: ["a"] }],
      }),
    ).toThrow(/duplicate document keys/);
  });

  test("rejects a query with no relevant documents", () => {
    expect(() =>
      parseGoldenSet({
        name: "unanswerable",
        documents: [{ key: "a", name: "A", content: "one" }],
        queries: [{ id: "q1", query: "find nothing", relevant: [] }],
      }),
    ).toThrow();
  });
});

describe("hash embedding provider", () => {
  const provider = new HashEmbeddingProvider();

  test("is deterministic across calls", () => {
    const a = provider.embedSync("connection pool exhaustion under load");
    const b = provider.embedSync("connection pool exhaustion under load");
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  test("produces L2-normalised vectors", () => {
    const v = provider.embedSync("some memory about postgres indexes");
    const norm = Math.sqrt(Array.from(v).reduce((acc, x) => acc + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  test("an empty document yields a zero vector rather than NaN", () => {
    const v = provider.embedSync("");
    expect(Array.from(v).every((x) => x === 0)).toBe(true);
  });

  test("scores a lexical match above an unrelated document", () => {
    const query = provider.embedSync("postgres connection pool exhausted");
    const match = provider.embedSync("the postgres connection pool was exhausted under load");
    const unrelated = provider.embedSync("cors preflight options route returns 404");

    const dot = (a: Float32Array, b: Float32Array) =>
      Array.from(a).reduce((acc, x, i) => acc + x * b[i]!, 0);

    expect(dot(query, match)).toBeGreaterThan(dot(query, unrelated));
  });
});

describe("runEval", () => {
  test("scores the built-in golden set end to end", async () => {
    const goldenSet = parseGoldenSet(JSON.parse(readFileSync(FIXTURE, "utf-8")));

    const report = await runEval({
      goldenSet,
      store: getMemoryStore(),
      embeddings: new HashEmbeddingProvider(),
      agentId: freshAgentId(),
    });

    expect(report.metrics.queries).toBe(goldenSet.queries.length);
    expect(report.metrics.documents).toBe(goldenSet.documents.length);
    expect(report.results).toHaveLength(goldenSet.queries.length);

    // Every metric must be a real fraction, never NaN from a divide-by-zero.
    for (const k of [1, 3, 5, 10]) {
      for (const metric of [
        report.metrics.hitAtK[k],
        report.metrics.recallAtK[k],
        report.metrics.precisionAtK[k],
        report.metrics.ndcgAtK[k],
      ]) {
        expect(Number.isFinite(metric)).toBe(true);
        expect(metric).toBeGreaterThanOrEqual(0);
        expect(metric).toBeLessThanOrEqual(1);
      }
    }

    // hit@k is monotonically non-decreasing in k: a wider window cannot lose a
    // hit it already had. A violation means the ranking or slicing is wrong.
    expect(report.metrics.hitAtK[3]!).toBeGreaterThanOrEqual(report.metrics.hitAtK[1]!);
    expect(report.metrics.hitAtK[5]!).toBeGreaterThanOrEqual(report.metrics.hitAtK[3]!);
    expect(report.metrics.hitAtK[10]!).toBeGreaterThanOrEqual(report.metrics.hitAtK[5]!);

    // Regression floor. Deliberately well below the ~75% the hash provider
    // currently reaches at k=3, so this fails on a real retrieval break rather
    // than on ordinary scoring noise.
    expect(report.metrics.hitAtK[10]!).toBeGreaterThan(0.5);
    expect(report.metrics.mrr).toBeGreaterThan(0.25);
  });

  test("retrieval only returns documents from the golden corpus", async () => {
    const goldenSet = parseGoldenSet(JSON.parse(readFileSync(FIXTURE, "utf-8")));
    const keys = new Set(goldenSet.documents.map((d) => d.key));

    const report = await runEval({
      goldenSet,
      store: getMemoryStore(),
      embeddings: new HashEmbeddingProvider(),
      agentId: freshAgentId(),
    });

    for (const result of report.results) {
      for (const key of result.ranked) {
        expect(keys.has(key)).toBe(true);
      }
    }
  });
});
