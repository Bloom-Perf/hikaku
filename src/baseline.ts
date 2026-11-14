import * as fs from "node:fs";
import * as path from "node:path";
import type { Baseline, RunSnapshot } from "./types.js";

/**
 * Save a RunSnapshot as a baseline JSON file, creating its directory if needed.
 */
export function saveBaseline(snapshot: RunSnapshot, filePath: string): void {
  const baseline: Baseline = {
    version: 1,
    createdAt: new Date().toISOString(),
    snapshot,
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(baseline, null, 2), "utf-8");
}

/**
 * Load a baseline from a JSON file.
 * Throws if the file doesn't exist, is not a baseline, or has an unsupported version;
 * the message names the file.
 */
export function loadBaseline(filePath: string): Baseline {
  const raw = fs.readFileSync(filePath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `Invalid baseline ${filePath}: not JSON (${(e as Error).message})`,
    );
  }

  const baseline = parsed as Partial<Baseline> | null;
  if (baseline?.version !== 1) {
    throw new Error(
      `Unsupported baseline version: ${baseline?.version} in ${filePath}. Expected 1.`,
    );
  }
  const snapshot = baseline.snapshot as Partial<RunSnapshot> | undefined;
  if (!Array.isArray(snapshot?.scenarios)) {
    throw new Error(
      `Invalid baseline ${filePath}: snapshot.scenarios is missing`,
    );
  }
  // Baselines saved without resources compare their scenarios only
  return {
    ...baseline,
    snapshot: { ...snapshot, resources: snapshot.resources ?? [] },
  } as Baseline;
}

/**
 * Check whether a baseline file exists at the given path.
 */
export function baselineExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}
