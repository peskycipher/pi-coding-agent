# Eval suite — implementation

Implementation of `workflows/test-eval-spec.md` §6 (Operations) for the test-agent and
docs-agent candidates. The harness plays the dispatcher itself (spec §7 A1): no EO/IO bus,
no ledger, no envelopes at run time — one DISPATCH in, one RESULT out, with every tool call
traced.

Status: **harness, scorer, rubric, judge, config, and baseline are implemented and tested.**
The fixture *generator* and the three committed flake fixtures already existed and were
**not** regenerated or modified. The remaining gap is fixture coverage: most of the C/D
catalog has no committed fixture yet, so the runner skips those scenarios and reports them.
See [What is built vs. remaining](#what-is-built-vs-remaining).

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
| `schemas/tool-trace.schema.json` | Spec §6 trace record schema. |
| `scorer/mechanical.mjs` | M1/M1′/M2/M3/M4 checks + S1–S7 zero-tolerance gates. |
| `scorer/aggregate.mjs` | Suite aggregate, result-line shape, baseline update, regression detection. |
| `scorer/rubric-check.mjs`, `scorer/rubric-cli.mjs` | Static rubric presence checks (`npm run eval:rubric`). |
| `rubric/*.yaml` | `test-spec-rubric.yaml` (16 rules) + `docs-spec-rubric.yaml` (12 rules). |
| `judge/prompt.md`, `judge/judge.mjs` | Versioned prose judge: pointwise 1–5, blind, double-run rotation, disagreement flag. |
| `config/scenarios.yaml` | Catalog as data: 26 entries (C1–C14, D1–D10, plus paired controls). |
| `config/models.yaml` | Cheap/strong tier matrix + judge config (IDs pending owner decision §8 Q1). |
| `baselines/current.json` | Committed trend baseline (last 5 pass flags + M1 scores per scenario). |
| `results/.gitignore` | Run outputs are ephemeral; baselines live under `baselines/`. |

## Running

```bash
npm run eval:rubric     # static rubric presence checks (blocks a spec PR that deletes a rule)
npm run eval:core       # core catalog (C1,C2,C5,C6,C7,C9,C10 + D1,D2,D6,D8)
npm run eval:full       # full catalog; adds the judge when EVAL_JUDGE_URL is set
node evals/harness/run.mjs one C3-flake-order
node evals/harness/run.mjs core --agent ./my-candidate.mjs --model cheap --update-baseline
```

The candidate adapter is `({ dispatch, runtime, runner, scenario }) => RESULT`
(default export or `run`). Without `--agent`, the smoke adapter runs, which drives the
roles to prove the machinery — it is not an evaluation result. Each run writes
`<model>.jsonl` (result lines) plus a per-scenario `<model>.<scenario>.trace.jsonl`
(schema-validated tool trace) under `results/<date>/`.

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
scorer, static rubrics, judge harness, config catalog, baseline, runner scripts, and tests
(`tests/eval-*.test.ts`).

Remaining:
1. **Fixtures** — only the three pre-existing flake fixtures are committed. C1, C4–C14 and
   D1–D10 need the generator run to emit their repos + `fixture.json` manifests (spec §3
   / §3.1). `evals/config/scenarios.yaml` already declares them and the runner reports them
   as skipped. *(Do not regenerate in place without reviewing the committed three.)*
2. **Model matrix IDs / judge model** — placeholders in `config/models.yaml`; owner
   decision spec §8 Q1/Q2.
3. **Candidate adapters** — wiring the real prompt/workflow candidates to the dispatcher
   (and the model call path) is outside the smoke adapter.
4. **Quarantine/report field extraction** — S4 currently reads `quarantine_proposals` from
   `notify` payloads or the RESULT; confirm the real agent's report shape against this.
5. **Judge calibration** — thresholds are the spec defaults, to be tuned after the first
   calibration month.
6. **Nightly/CI scheduling** — `eval:full` and `eval:rubric` are ready to wire into GH
   Actions or cron (spec §8 Q3).
