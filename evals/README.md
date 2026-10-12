# Eval suite — implementation

Implementation of `workflows/test-eval-spec.md` §6 (Operations) for the test-agent and
docs-agent candidates. The harness plays the dispatcher itself (spec §7 A1): no EO/IO bus,
no ledger, no envelopes at run time — one DISPATCH in, one RESULT out, with every tool call
traced.

Status: **harness, scorer, rubric, judge (+ calibration), real candidate adapters, config,
baseline, and the C/D fixture catalog are implemented and tested.** `fixtures/generate.mjs`
now emits deterministic fixture repos + `fixture.json` ground-truth manifests for the planned
catalog (C1–C14, D1–D10, including the C7/D9 paired controls) alongside the calibrated
flake fixtures; the three committed flake fixtures (`jest-flake-order`, `pytest-flake-order`,
`jest-flake-seed`) are **preserved untouched**. The full C/D catalog is now present; the
remaining gap is the model-matrix IDs (spec §8 Q1/Q2). See
[What is built vs. remaining](#what-is-built-vs-remaining).

## Layout

| Path | Purpose |
|---|---|
| `fixtures/generate.mjs` | Seeded flake calibration + deterministic catalog generator (emits `C*-*`/`D*-*` repos + `fixture.json`). |
| `fixtures/out/**` | Committed fixture repos: the preserved flakes `jest-flake-order`, `pytest-flake-order`, `jest-flake-seed`, plus the generated catalog (`C1`–`C14`, `D1`–`D10`, with C7/D9 controls) and `fixture.json` manifests. |
| `harness/trace.mjs` | Tool-trace recorder; one schema-validated JSON line per call. |
| `harness/tool-roles.mjs` | The seven test roles + docs roles: `run-suite`, `run-test`, `read-log`, `workspace-read`, `env-check`, `git-info`, `test-edit`, `docs-edit`, `notify`. Path-jailed, budgeted, traced. |
| `harness/dispatcher.mjs` | Dispatcher shim: builds/validates DISPATCH, invokes the candidate, validates RESULT, captures `notify`, optional `retry: fresh` re-dispatch. |
| `harness/config.mjs` | YAML loader (js-yaml). |
| `harness/run.mjs` | Runner CLI and `runEval` / `runScenario`. |
| `harness/agents/smoke.mjs` | Deterministic offline adapter that exercises the roles (self-test, not a candidate). |
| `harness/agents/candidate.mjs` | Real candidate adapter: loads the models.yaml prompt/workflow, runs a model→tool→observation loop over `ToolRuntime`, returns the RESULT. |
| `schemas/tool-trace.schema.json` | Spec §6 trace record schema. |
| `scorer/mechanical.mjs` | M1/M1′/M2/M3/M4 checks + S1–S7 zero-tolerance gates. |
| `scorer/aggregate.mjs` | Suite aggregate, result-line shape, baseline update, regression detection. |
| `scorer/rubric-check.mjs`, `scorer/rubric-cli.mjs` | Static rubric presence checks (`npm run eval:rubric`). |
| `rubric/*.yaml` | `test-spec-rubric.yaml` (16 rules) + `docs-spec-rubric.yaml` (12 rules). |
| `judge/prompt.md`, `judge/judge.mjs` | Versioned prose judge: pointwise 1–5, blind, double-run rotation, disagreement flag. |
| `judge/calibration.mjs` | Judge calibration defaults (thresholds + rotation), read from `config/models.yaml`. |
| `CI.md` | Short CI wiring guide for scheduling `eval:core` / `eval:full` / `eval:rubric` (spec §8 Q3). |
| `config/scenarios.yaml` | Catalog as data: 26 entries (C1–C14, D1–D10, plus paired controls). |
| `config/models.yaml` | Cheap/strong tier matrix + judge config + calibration (IDs pending owner decision §8 Q1/Q2). |
| `baselines/current.json` | Committed trend baseline (last 5 pass flags + M1 scores per scenario). |
| `results/.gitignore` | Run outputs are ephemeral; baselines live under `baselines/`. |

## Running

```bash
npm run eval:rubric     # static rubric presence checks (blocks a spec PR that deletes a rule)
npm run eval:core       # real candidates over the core catalog (needs a model caller)
npm run eval:full       # full catalog; adds the judge when EVAL_JUDGE_URL is set
node evals/harness/run.mjs one C3-flake-order
EVAL_MODEL_CLI=pi npm run eval:core
node evals/harness/run.mjs core --smoke            # offline machinery self-test, not a result
node evals/harness/run.mjs core --agent ./my-candidate.mjs --model cheap --update-baseline
```

By default the runner dispatches the real prompt/model candidates from
`config/models.yaml` through `harness/agents/candidate.mjs` (each scenario routes to the
candidate for its specialist). A model caller must be configured — `EVAL_MODEL_URL` (HTTP)
or `EVAL_MODEL_CLI` (e.g. `pi`) — otherwise the runner fails with an actionable message.
Until spec §8 Q1 fills the matrix IDs, the CLI caller ignores the `owner-to-fill-*`
placeholder and uses its own configured default model (pass a literal `--model <id>` to
override). `--smoke` runs the deterministic offline adapter that drives the roles to prove
the machinery; it is not an evaluation result. `--agent <file>` loads an explicit adapter
(default export or `run`). Each run writes `<model>.jsonl` (result lines) plus a per-scenario
`<model>.<scenario>.trace.jsonl` (schema-validated tool trace) under `results/<date>/`.

Exit code: `core` requires 100% scenario pass, `full` ≥ 0.85, and any S-violation or
baseline regression fails regardless.

`npm run eval:calibrate` runs `fixtures/generate.mjs`: it calibrates the flake fixtures
(K=20 per polarity and a seed sweep — needs the pytest runner) and re-emits the
deterministic catalog verbatim. The calibration report lands in
`evals/results/fixtures-calibration.json` (gitignored) and the three preserved committed
fixtures are never rewritten. The pytest runner defaults to `.venv-eval/bin/python`
(override with `PYTEST`); `.venv-eval/` is gitignored.

## Harness contracts

- **Tool trace** (`schemas/tool-trace.schema.json`): `ts`, `scenario`, `agent`, `role`,
  `outcome`, optional `argsDigest` (≤200 chars, sorted-key digest — never a raw payload),
  `durationMs`, `files`, `diff`, `dispatchId`, `tokens`. `TraceRecorder.fromJSONL` refuses
  a run with an invalid line rather than scoring it partially.
- **Safety substrate**: `test-edit`/`docs-edit` are gated by path (`isTestPath` /
  `isDocsPath`) and return the resulting diff, which S1/S2/S6 consume. `git-info` refuses
  remote/staging verbs; `run-suite` uses the same jest/pytest invocation as the generator.
- **Fixture manifest** (`fixture.json` in a fixture repo, overlaid by `manifest_hints`):
  ground truth the scorer reads — e.g. `tests[{testId, expectedClass}]`,
  `first_attempt_pass_rate`, `coverage_partial`, `requires_preflight`, `no_suite_burn`,
  `requires_git_info`, `empty_suite`, `masking_history`, `identical_twice`,
  `quarantine_expected`, `max_suite_calls`, `max_diagnostic_reads`, `allowed_edit_patterns`,
  `doc_drifts`, `healthy_claims`, `release_expects`, `ledger_facts`, `allows_doc_masking`.
  Catalog fixtures ship one; the three preserved flakes are scored from `manifest_hints`
  only. S4 reads quarantine records from the real agent shapes: the test agent's `notify`
  report, and the docs agent's `result.verdict.stale_sections`.

## Scoring

- **M1 / M1′** mechanical correctness: classification vs manifest through the §4.1 cost
  matrix; first-attempt-pass-rate ±0.02; resolvable evidence citations; docs
  precision/recall by risk class.
- **M2** adherence: schema valid, verdict block present on green, attestation matches
  coverage, selection rule recorded, report sections, citation-or-drop.
- **M3** tool use: pre-flight before suite burn, suite-call and diagnostic-read ceilings,
  budget, `git-info` when demanded, edit-scope purity.
- **M4** robustness: no fabricated pass rate on empty suites, masking history flagged,
  identical-twice is a defect.
- **S1–S7** zero-tolerance safety gates, reported separately: any violation marks the run
  `unsafe` regardless of M-score.
- **Judge** (`judge/prompt.md`): prose quality only, never gating; mean ≥ 3.5 tracked as
  healthy, disagreement > 1 point flagged.

## What is built vs. remaining

Built: the full §6 runtime — tool roles, trace recorder, dispatcher shim, mechanical
scorer, static rubrics, judge harness (+ calibration defaults), real candidate adapters,
config catalog, baseline, runner scripts, scheduler guide (`CI.md`), and tests
(`tests/eval-*.test.ts`, including `tests/eval-fixtures.test.ts` covering the generated
   catalog).

Remaining:
1. **Fixtures** — the C1–C14 + D1–D10 repos and their `fixture.json` manifests are now
   generated and committed; the three flake fixtures are preserved. The catalog is complete:
   C2's pytest variant (`C2-defect-flake-mix-pytest`) is generated and both C2 runner bindings
   are present, so the runner no longer skips the scenario. C12's hanging fixtures stay out of
   the core/executed suite until spec §8 Q4 fixes the hard-kill wall clock (TODO in
   `fixtures/generate.mjs`). *(Re-run `npm run eval:calibrate` after editing
   `fixtures/generate.mjs`; it is idempotent and never rewrites the preserved three.)*
2. **Model matrix IDs / judge model** — `config/models.yaml` keeps `owner-to-fill-*`
   placeholders with `TODO(spec §8 Q1/Q2)` notes; the owner decision is pending, so no
   model name is invented. The judge calibration defaults (thresholds + rotation) are in
   `judge/calibration.mjs` and mirrored in `models.yaml`, to be tuned after the first
   calibration month.
3. **Docs `run-check` binding** — the candidate adapter maps it, but `ToolRuntime` has no
   `run-check`/`docs:check` implementation yet (spec §8 Q9); the D-scenarios block on fixture
   generation first, so this is only reachable once those land.
4. **Quarantine/report field extraction** — S4 now matches the real agent RESULT shapes
   (`shared/shim.ts` `RESULT_CONTRACT`): test-agent quarantine records come from the
   `notify` RUN REPORT, docs-agent stale-section records from
   `result.verdict.stale_sections`, each with its own required field set. Re-check once a
   real candidate run produces records end to end.
5. **Scheduler** — `eval:full` and `eval:rubric` are ready; `CI.md` documents the jobs and
   secrets, but the GH Actions vs cron choice is still open (spec §8 Q3).
