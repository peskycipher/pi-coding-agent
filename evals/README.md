# Eval suite — implementation

Implementation of `workflows/test-eval-spec.md` §6 (Operations) for the test-agent and
docs-agent candidates. The harness plays the dispatcher itself (spec §7 A1): no EO/IO bus,
no ledger, no envelopes at run time — one DISPATCH in, one RESULT out, with every tool call
traced.

Status: **harness, scorer, rubric, judge (+ calibration), real candidate adapters, config,
and baseline are implemented and tested.** The fixture *generator* and the three committed
flake fixtures already existed and were **not** regenerated or modified. The remaining gap is
fixture coverage: most of the C/D catalog has no committed fixture yet, so the runner skips
those scenarios and reports them. See [What is built vs. remaining](#what-is-built-vs-remaining).

## Layout

| Path | Purpose |
|---|---|
| `fixtures/generate.mjs` | Seeded fixture generator + calibration (pre-existing). |
| `fixtures/out/**` | Committed fixture repos (pre-existing, reused as-is): `jest-flake-order`, `pytest-flake-order`, `jest-flake-seed`. |
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
(`tests/eval-*.test.ts`).

Remaining:
1. **Fixtures** — only the three pre-existing flake fixtures are committed. C1, C4–C14 and
   D1–D10 need the generator run to emit their repos + `fixture.json` manifests (spec §3
   / §3.1). `evals/config/scenarios.yaml` already declares them and the runner reports them
   as skipped. *(Do not regenerate in place without reviewing the committed three.)*
2. **Model matrix IDs / judge model** — `config/models.yaml` keeps `owner-to-fill-*`
   placeholders with `TODO(spec §8 Q1/Q2)` notes; the owner decision is pending, so no
   model name is invented. The judge calibration defaults (thresholds + rotation) are in
   `judge/calibration.mjs` and mirrored in `models.yaml`, to be tuned after the first
   calibration month.
3. **Docs `run-check` binding** — the candidate adapter maps it, but `ToolRuntime` has no
   `run-check`/`docs:check` implementation yet (spec §8 Q9); the D-scenarios block on fixture
   generation first, so this is only reachable once those land.
4. **Quarantine/report field extraction** — S4 currently reads `quarantine_proposals` from
   `notify` payloads or the RESULT; confirm the real agent's report shape against this.
5. **Scheduler** — `eval:full` and `eval:rubric` are ready; `CI.md` documents the jobs and
   secrets, but the GH Actions vs cron choice is still open (spec §8 Q3).
