/**
 * `apiary eval` — measure memory retrieval quality against a golden set.
 *
 * Runs entirely against a throwaway database so it never touches a live swarm's
 * memories, and defaults to a deterministic offline embedding provider so it can
 * run on every commit without a key or a bill.
 */

import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { closeDb, createAgent, initDb } from "@/be/db";
import { getMemoryStore } from "@/be/memory";
import type { EmbeddingProvider } from "@/be/memory/types";
import { HashEmbeddingProvider } from "./providers/hash-embedding.ts";
import { DEFAULT_K_VALUES, formatReport, runEval } from "./runner.ts";
import { parseGoldenSet } from "./types.ts";

const DEFAULT_GOLDEN_SET = join(import.meta.dir, "fixtures/engineering-memories.json");

interface EvalArgs {
  goldenSetPath: string;
  provider: "hash" | "openai";
  json: boolean;
  /** Fail with a non-zero exit code if hit@k for this k falls below the threshold. */
  minHitAtK?: { k: number; threshold: number };
}

function parseEvalArgs(argv: string[]): EvalArgs {
  const args: EvalArgs = {
    goldenSetPath: DEFAULT_GOLDEN_SET,
    provider: "hash",
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--set" || arg === "-s") {
      args.goldenSetPath = argv[++i] ?? args.goldenSetPath;
    } else if (arg === "--provider" || arg === "-p") {
      const value = argv[++i];
      if (value !== "hash" && value !== "openai") {
        throw new Error(`Unknown provider "${value}". Expected "hash" or "openai".`);
      }
      args.provider = value;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--min-hit-at") {
      // e.g. --min-hit-at 3=0.8  → fail if hit@3 < 80%
      const value = argv[++i] ?? "";
      const [k, threshold] = value.split("=");
      const parsedK = Number(k);
      const parsedThreshold = Number(threshold);
      if (!Number.isFinite(parsedK) || !Number.isFinite(parsedThreshold)) {
        throw new Error(
          `Invalid --min-hit-at "${value}". Expected the form K=FRACTION, e.g. 3=0.8`,
        );
      }
      args.minHitAtK = { k: parsedK, threshold: parsedThreshold };
    }
  }

  return args;
}

function resolveProvider(kind: EvalArgs["provider"]): EmbeddingProvider {
  if (kind === "hash") return new HashEmbeddingProvider();

  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "--provider openai needs OPENAI_API_KEY. Omit the flag to use the offline hash provider.",
    );
  }
  const { OpenAIEmbeddingProvider } =
    require("@/be/memory/providers/openai-embedding") as typeof import("@/be/memory/providers/openai-embedding");
  return new OpenAIEmbeddingProvider();
}

export async function runEvalCommand(argv: string[]): Promise<void> {
  const args = parseEvalArgs(argv);

  const goldenSet = parseGoldenSet(JSON.parse(readFileSync(args.goldenSetPath, "utf-8")));
  const embeddings = resolveProvider(args.provider);

  // Throwaway database — the eval must never read or pollute real memories.
  const dbPath = `./.apiary-eval-${crypto.randomUUID()}.sqlite`;

  try {
    initDb(dbPath);
    const agent = createAgent({
      name: `eval-${Date.now()}`,
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const report = await runEval({
      goldenSet,
      store: getMemoryStore(),
      embeddings,
      agentId: agent.id,
    });

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatReport(report, DEFAULT_K_VALUES));
    }

    if (args.minHitAtK) {
      const { k, threshold } = args.minHitAtK;
      const actual = report.metrics.hitAtK[k] ?? 0;
      if (actual < threshold) {
        console.error(
          `hit@${k} was ${(actual * 100).toFixed(1)}%, below the required ${(threshold * 100).toFixed(1)}%`,
        );
        process.exitCode = 1;
      }
    }
  } finally {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(`${dbPath}${suffix}`);
      } catch {
        // Nothing to clean up.
      }
    }
  }
}
