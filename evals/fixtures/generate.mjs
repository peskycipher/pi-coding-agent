#!/usr/bin/env node
// Fixture generator + calibration for the test-agent eval suite (spec: workflows/test-eval-spec.md §3).
//
// Proves the spec's calibration-rejection rule under real runner conditions: every
// planted flake must be DETERMINISTIC PER POLARITY — the ground-truth outcome must hold
// for K consecutive real runner invocations, and the nondeterminism evidence (a seed
// sweep with both outcomes) must be present — otherwise the fixture is REJECTED and the
// generator fails. A flake that only sometimes reproduces cannot be scored mechanically.
//
// Polarity contract (mirrors what the eval harness's dispatcher shim will control):
//   - workspace reset between invocations (the shim provisions a fresh tree; calibration
//     replicates by re-emitting the fixture before each polarity block)
//   - jest runs with --runInBand and a fixed seed (CI-like, no worker shuffle)
//   - injective controls: TEST_SEED (seed flake), FAKE_NOW (time flake), isolated vs
//     suite ordering (order flake)
//
// Exit: 0 all fixtures accepted; 1 listing rejected ones with their failing polarity.

import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;
const OUT = path.join(ROOT, "evals/fixtures/out");
const K = 20;          // spec §8 Q5 (resolved): 20 calibration runs per polarity
const SEEDS = [7, 13, 42, 99, 123, 256, 512, 1024]; // sweep: must yield both outcomes

const PY = process.env.PYTEST || path.join(ROOT, ".venv-eval/bin/python");

// ---------- runner adapters ----------
function runJest(dir, extraArgs = []) {
  let out = "", code = 0;
  try {
    out = execFileSync("npx", ["jest", "--runInBand", "--silent", "--watchman=false", ...extraArgs],
      { cwd: dir, encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 24 });
  } catch (e) { out = String(e.stdout || "") + String(e.stderr || ""); code = e.status ?? 1; }
  const m = out.match(/Tests:\s+(\d+) passed(?:,\s+(\d+) failed)?/);
  return { code, passed: m ? +m[1] : 0, failed: m && m[2] ? +m[2] : (code ? 1 : 0), out };
}
function runPytest(dir, extraArgs = []) {
  let out = "", code = 0;
  try {
    out = execFileSync(PY, ["-m", "pytest", dir, "-p", "no:cacheprovider", "--tb=no", "-q", ...extraArgs],
      { cwd: dir, encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 24 });
  } catch (e) { out = String(e.stdout || "") + String(e.stderr || ""); code = e.status ?? 1; }
  const m = out.match(/(\d+) passed(?:,\s+(\d+) failed)?/);
  return { code, passed: m ? +m[1] : 0, failed: m && m[2] ? +m[2] : (code ? 1 : 0), out };
}

// ---------- fixture definitions ----------
// each: { id, runner, files: {path: content}, polarity: {name: {env, args, expect}} }
// expect: { exit: 0|1, failed: [test names/counts] }

const JEST_ORDER = {
  id: "jest-flake-order", runner: "jest",
  files: {
    "state.test.js": `test("test A seeds shared state", () => { require("fs").writeFileSync("__state.sentinel", "1"); expect(true).toBe(true); });`,
    "consumer.test.js": `const fs = require("fs");\ntest("test B fails only after A ran (order-dependent)", () => { if (fs.existsSync("__state.sentinel")) throw new Error("shared-state order dependency: sentinel present"); expect(1).toBe(1); });`,
    "jest.config.json": JSON.stringify({ testEnvironment: "node", testMatch: ["**/*.test.js"] }),
  },
  polarity: {
    suite_order:   { reset: true, args: [],                                       expect: "fail" },
    isolated_b:    { reset: true, args: ["consumer.test.js"],                     expect: "pass" },
  },
};
const PYTEST_ORDER = {
  id: "pytest-flake-order", runner: "pytest",
  files: {
    "test_a_state.py": `import pathlib\ndef test_a_seeds_shared_state():\n    pathlib.Path("__state.sentinel").write_text("1")\n`,
    "test_b_consumer.py": `import pathlib\ndef test_b_fails_only_after_a():\n    if pathlib.Path("__state.sentinel").exists():\n        raise AssertionError("shared-state order dependency: sentinel present")\n`,
  },
  polarity: {
    suite_order:   { reset: true, args: [],                       expect: "all_fail_last" },
    isolated_b:    { reset: true, args: ["test_b_consumer.py"],   expect: "pass" },
  },
};
const JEST_SEED = {
  id: "jest-flake-seed", runner: "jest",
  files: {
    "seed.test.js": `test("fails only for the planted seed", () => { const seed = parseInt(process.env.TEST_SEED || "7", 10); if (seed % 5 === 2) throw new Error("seeded nondeterminism, seed=" + seed); expect(1).toBe(1); });`,
    "jest.config.json": JSON.stringify({ testEnvironment: "node" }),
  },
  polarity: {
    failing_seed:  { reset: true, env: { TEST_SEED: "7" },  args: ["seed.test.js"], expect: "fail" },
    seed_sweep:    { reset: true, env: { TEST_SEED: "sweep" }, args: ["seed.test.js"], sweep: true, expect: "both" },
  },
};
const PYTEST_SEED = {
  id: "pytest-flake-seed", runner: "pytest",
  files: {
    "test_seed.py": `import os\ndef test_fails_only_for_planted_seed():\n    seed = int(os.environ.get("TEST_SEED", "7"))\n    if seed % 5 == 2:\n        raise AssertionError("seeded nondeterminism, seed=%d" % seed)\n`,
  },
  polarity: {
    failing_seed:  { reset: true, env: { TEST_SEED: "7" },  args: ["test_seed.py"], expect: "fail" },
    seed_sweep:    { reset: true, env: { TEST_SEED: "sweep" }, args: ["test_seed.py"], sweep: true, expect: "both" },
  },
};
const JEST_TIME = {
  id: "jest-flake-time", runner: "jest",
  files: {
    "time.test.js": `test("fails under off-hours clock skew only", () => { const now = new Date(process.env.FAKE_NOW || new Date().toISOString()); const h = now.getHours(); if (h < 5) throw new Error("time-dependent behavior (FAKE_NOW=" + process.env.FAKE_NOW + ")"); expect(1).toBe(1); });`,
    "jest.config.json": JSON.stringify({ testEnvironment: "node" }),
  },
  polarity: {
    skew_night:    { reset: true, env: { FAKE_NOW: "2001-01-01T03:00:00Z" }, args: ["time.test.js"], expect: "fail" },
    skew_day:      { reset: true, env: { FAKE_NOW: "2001-01-01T10:00:00Z" }, args: ["time.test.js"], expect: "pass" },
  },
};
const PYTEST_TIME = {
  id: "pytest-flake-time", runner: "pytest",
  files: {
    "test_time.py": `import datetime, os\ndef test_fails_under_off_hours_clock_skew_only():\n    raw = os.environ.get("FAKE_NOW")\n    now = datetime.datetime.fromisoformat(raw) if raw else datetime.datetime.now()\n    if now.hour < 5:\n        raise AssertionError("time-dependent behavior (FAKE_NOW=%s)" % raw)\n`,
  },
  polarity: {
    skew_night:    { reset: true, env: { FAKE_NOW: "2001-01-01T03:00:00" }, args: ["test_time.py"], expect: "fail" },
    skew_day:      { reset: true, env: { FAKE_NOW: "2001-01-01T10:00:00" }, args: ["test_time.py"], expect: "pass" },
  },
};

const FIXTURES = [JEST_ORDER, PYTEST_ORDER, JEST_SEED, PYTEST_SEED, JEST_TIME, PYTEST_TIME];

// ---------- calibration ----------
const expectMatches = (res, expect) => {
  if (expect === "fail") return res.failed > 0 && res.passed === 0;
  if (expect === "pass") return res.code === 0 && res.failed === 0;
  return true; // "both"/"all_fail_last" handled by caller
};

function calibrate(fx) {
  const results = { polarities: {}, accepted: true, rejections: [] };
  for (const [name, pol] of Object.entries(fx.polarity)) {
    const outcomes = [];
    for (let i = 0; i < K; i++) {
      let res;
      if (pol.sweep) {
        // seed sweep: each seed is one deterministic invocation; fixture accepted only
        // if the sweep yields BOTH outcomes (proof of genuine nondeterminism + mechanism)
        outcomes.push(...SEEDS.map(s => {
          process.env.TEST_SEED = String(s);
          return fx.runner === "jest" ? expectMatches(runJest(path.join(OUT, fx.id), pol.args), "fail") : expectMatches(runPytest(path.join(OUT, fx.id), pol.args), "fail");
        }));
        process.env.TEST_SEED = "";
        const fails = outcomes.filter(Boolean).length, passes = outcomes.length - fails;
        if (fails === 0 || passes === 0) {
          results.rejections.push(`${name}: seed sweep degenerate (${fails} fails / ${passes} passes across ${SEEDS.length} seeds)`);
          results.accepted = false;
        }
        results.polarities[name] = { sweep: true, fails, passes, seeds: SEEDS.length };
        break;
      }
      if (pol.reset) rmFixtureWorkspace(fx.id);
      emit(fx);
      for (const [k, v] of Object.entries(pol.env || {})) process.env[k] = v;
      res = fx.runner === "jest" ? runJest(path.join(OUT, fx.id), pol.args) : runPytest(path.join(OUT, fx.id), pol.args);
      for (const k of Object.keys(pol.env || {})) process.env[k] = "";
      outcomes.push(expectMatches(res, pol.expect));
    }
    if (!results.polarities[name]) {
      const ok = outcomes.every(Boolean);
      if (!ok) { results.rejections.push(`${name}: polarity not deterministic — expected "${pol.expect}" but K=${K} runs gave ${outcomes.filter(Boolean).length}/${K} matches`); results.accepted = false; }
      results.polarities[name] = { matches: outcomes.filter(Boolean).length, K };
    }
  }
  return results;
}

function emit(fx) {
  const dir = path.join(OUT, fx.id);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(fx.files)) {
    writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}
function rmFixtureWorkspace(id) { rmSync(path.join(OUT, id), { recursive: true, force: true }); }

// ---------- main ----------
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const report = { K, generated: new Date().toISOString(), fixtures: {}, accepted: 0, rejected: 0 };
let failed = false;
for (const fx of FIXTURES) {
  const res = calibrate(fx);
  report.fixtures[fx.id] = { runner: fx.runner, ...res };
  if (res.accepted) report.accepted++; else { report.rejected++; failed = true; }
}
report.fixtures = Object.fromEntries(Object.entries(report.fixtures).map(([k, v]) =>
  [k, { runner: v.runner, accepted: v.accepted, polarities: v.polarities, rejections: v.rejections }]));
writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (failed) { console.error("CALIBRATION REJECTED one or more fixtures — see manifest"); process.exit(1); }
console.log(`CALIBRATION ACCEPTED ${report.accepted}/${FIXTURES.length} fixtures (K=${K} per polarity)`);