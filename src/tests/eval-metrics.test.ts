import { describe, expect, test } from "bun:test";
import {
  firstRelevantRank,
  hitAtK,
  mean,
  ndcgAtK,
  percentile,
  precisionAtK,
  recallAtK,
  reciprocalRank,
} from "../eval/metrics";

const rel = (...ids: string[]) => new Set(ids);

describe("retrieval metrics", () => {
  describe("firstRelevantRank", () => {
    test("is 1-indexed", () => {
      expect(firstRelevantRank(["a", "b", "c"], rel("a"))).toBe(1);
      expect(firstRelevantRank(["a", "b", "c"], rel("c"))).toBe(3);
    });

    test("is null when nothing relevant was retrieved", () => {
      expect(firstRelevantRank(["a", "b"], rel("z"))).toBeNull();
      expect(firstRelevantRank([], rel("a"))).toBeNull();
    });
  });

  describe("hitAtK", () => {
    test("respects the k window boundary", () => {
      const ranked = ["x", "x", "a"];
      expect(hitAtK(ranked, rel("a"), 2)).toBe(false);
      expect(hitAtK(ranked, rel("a"), 3)).toBe(true);
    });
  });

  describe("recallAtK", () => {
    test("is the fraction of relevant docs found", () => {
      // 2 of 4 relevant docs are inside the top 3.
      expect(recallAtK(["a", "x", "b"], rel("a", "b", "c", "d"), 3)).toBeCloseTo(0.5);
    });

    test("is 1 when every relevant doc is inside the window", () => {
      expect(recallAtK(["a", "b"], rel("a", "b"), 5)).toBe(1);
    });

    test("is 0 with no relevant docs, rather than dividing by zero", () => {
      expect(recallAtK(["a"], rel(), 5)).toBe(0);
    });
  });

  describe("precisionAtK", () => {
    test("divides by the window, not by the relevant set", () => {
      expect(precisionAtK(["a", "x", "x", "x"], rel("a"), 4)).toBeCloseTo(0.25);
    });

    test("divides by actual results when fewer than k were returned", () => {
      // Only two results exist, one relevant — that is 50%, not 20%.
      expect(precisionAtK(["a", "x"], rel("a"), 10)).toBeCloseTo(0.5);
    });

    test("is 0 for an empty ranking", () => {
      expect(precisionAtK([], rel("a"), 5)).toBe(0);
    });
  });

  describe("reciprocalRank", () => {
    test("is the inverse of the first relevant rank", () => {
      expect(reciprocalRank(["a"], rel("a"))).toBe(1);
      expect(reciprocalRank(["x", "a"], rel("a"))).toBeCloseTo(0.5);
      expect(reciprocalRank(["x", "x", "a"], rel("a"))).toBeCloseTo(1 / 3);
    });

    test("is 0 on a complete miss", () => {
      expect(reciprocalRank(["x", "y"], rel("a"))).toBe(0);
    });
  });

  describe("ndcgAtK", () => {
    test("is 1 for a perfect ranking", () => {
      expect(ndcgAtK(["a", "b"], rel("a", "b"), 5)).toBeCloseTo(1);
    });

    test("is 0 when nothing relevant is retrieved", () => {
      expect(ndcgAtK(["x", "y"], rel("a"), 5)).toBe(0);
    });

    test("rewards ranking the relevant result higher", () => {
      const top = ndcgAtK(["a", "x", "x"], rel("a"), 3);
      const bottom = ndcgAtK(["x", "x", "a"], rel("a"), 3);
      expect(top).toBeGreaterThan(bottom);
      expect(top).toBeCloseTo(1);
    });

    test("normalises so queries with different relevant-set sizes stay comparable", () => {
      // One relevant of one found at rank 1, and two relevant of two found at
      // ranks 1-2, are both perfect rankings and must both score 1.
      expect(ndcgAtK(["a"], rel("a"), 3)).toBeCloseTo(1);
      expect(ndcgAtK(["a", "b"], rel("a", "b"), 3)).toBeCloseTo(1);
    });
  });

  describe("mean and percentile", () => {
    test("mean of an empty list is 0, not NaN", () => {
      expect(mean([])).toBe(0);
    });

    test("percentile uses nearest-rank", () => {
      const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      expect(percentile(values, 0.5)).toBe(5);
      expect(percentile(values, 0.95)).toBe(10);
    });

    test("percentile of an empty list is 0", () => {
      expect(percentile([], 0.5)).toBe(0);
    });
  });
});
