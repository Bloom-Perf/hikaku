import * as fs from "node:fs";
import type { Baseline, RunSnapshot } from "./types";

/**
 * Save a RunSnapshot as a baseline JSON file.
 */
export function saveBaseline(snapshot: RunSnapshot, filePath: string): void {
  const baseline: Baseline = {
    version: 1,
    createdAt: new Date().toISOString(),
    snapshot,
  };
  fs.writeFileSync(filePath, JSON.stringify(baseline, null, 2), "utf-8");
}

/**
 * Load a baseline from a JSON file.
 * Throws if file doesn't exist or version is unsupported.
 */
export function loadBaseline(filePath: string): Baseline {
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw) as Baseline;
  if (parsed.version !== 1) {
    throw new Error(
      `Unsupported baseline version: ${parsed.version}. Expected 1.`,
    );
  }
  return parsed;
}

/**
 * Check whether a baseline file exists at the given path.
 */
export function baselineExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}
