import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { saveBaseline, loadBaseline, baselineExists } from "../src/baseline";
import type { RunSnapshot } from "../src/types";

describe("baseline", () => {
  let tmpDir: string;

  const sampleSnapshot: RunSnapshot = {
    timestamp: "2026-03-08T12:00:00.000Z",
    scenarios: [
      {
        scenario: "Login",
        iteration: 0,
        hosts: [
          {
            hostname: "example.com",
            requestCount: 10,
            requestFinishedCount: 9,
            requestFailedCount: 1,
            responseCount: 9,
            durationPercentiles: {
              p50: 0.1,
              p75: 0.2,
              p90: 0.4,
              p95: 0.5,
              p99: 0.8,
            },
            durationSum: 3.5,
            durationCount: 10,
          },
        ],
        totalRequests: 10,
        totalRequestsFailed: 1,
        errorRate: 0.1,
        aggregatedDurationPercentiles: {
          p50: 0.1,
          p75: 0.2,
          p90: 0.4,
          p95: 0.5,
          p99: 0.8,
        },
      },
    ],
    resources: [],
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hikaku-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("saves and loads a baseline (roundtrip)", () => {
    const filePath = path.join(tmpDir, "baseline.json");
    saveBaseline(sampleSnapshot, filePath);
    const loaded = loadBaseline(filePath);

    expect(loaded.version).to.equal(1);
    expect(loaded.createdAt).to.be.a("string");
    expect(loaded.snapshot.scenarios).to.deep.equal(sampleSnapshot.scenarios);
    expect(loaded.snapshot.resources).to.deep.equal(sampleSnapshot.resources);
  });

  it("saves baseline as pretty-printed JSON", () => {
    const filePath = path.join(tmpDir, "baseline.json");
    saveBaseline(sampleSnapshot, filePath);

    const raw = fs.readFileSync(filePath, "utf-8");
    // Pretty-printed JSON has newlines and indentation
    expect(raw).to.include("\n");
    expect(raw).to.include("  ");
  });

  it("throws when loading a non-existent file", () => {
    expect(() => loadBaseline(path.join(tmpDir, "nope.json"))).to.throw();
  });

  it("throws on unsupported version", () => {
    const filePath = path.join(tmpDir, "bad.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({ version: 99, createdAt: "", snapshot: {} }),
      "utf-8",
    );

    expect(() => loadBaseline(filePath)).to.throw(
      "Unsupported baseline version: 99",
    );
  });

  it("baselineExists returns true when file exists", () => {
    const filePath = path.join(tmpDir, "baseline.json");
    saveBaseline(sampleSnapshot, filePath);
    expect(baselineExists(filePath)).to.be.true;
  });

  it("baselineExists returns false when file does not exist", () => {
    expect(baselineExists(path.join(tmpDir, "nope.json"))).to.be.false;
  });
});
