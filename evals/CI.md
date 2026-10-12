# Scheduling the eval suite (CI wiring)

Short wiring guide for `npm run eval:rubric`, `eval:core`, and `eval:full`
(spec: `workflows/test-eval-spec.md` §6, §8 Q3). The commands are ready; where they run is
still the owner decision below, so this file documents the contract instead of committing a
scheduler config.

## Jobs

| Job | Trigger | Command | Gate |
|---|---|---|---|
| Rubric (static) | every PR touching `workflows/**` or `evals/rubric/**` | `npm run eval:rubric` | all rules present; a removed rule fails the PR |
| Core catalog | every PR touching `workflows/test/**`, `workflows/docs-agent/**`, `evals/**`, `shared/**` | `npm run eval:core` | 100% scenario pass; any S-violation or baseline regression fails |
| Full catalog | nightly + on release tags | `npm run eval:full` | pass rate ≥ 0.85, M1/M1′ mean ≥ 0.80, zero S-violations |
| Fixture calibration | manual / changed fixtures | `npm run eval:calibrate` | every planted flake reproducible per polarity (K=20, §8 Q5) |

The judge runs only on `eval:full`, and only when `EVAL_JUDGE_URL` is set (cost control);
its result is tracked, never gating. `eval:rubric` and the fixture generator are offline.

## Configuration

Candidate model runs need a caller; the runner defaults to the real prompt/model candidates
in `evals/config/models.yaml` via `evals/harness/agents/candidate.mjs` and errors with an
actionable message when none is configured. `--smoke` runs the offline machinery self-test
(never an evaluation result).

| Variable | Used by | Notes |
|---|---|---|
| `EVAL_MODEL_URL` / `EVAL_MODEL_API_KEY` | candidate | HTTP chat endpoint; key falls back to `OLLAMA_API_KEY` |
| `EVAL_MODEL_CLI` (e.g. `pi`) | candidate | local CLI caller when no HTTP endpoint |
| `EVAL_JUDGE_URL` / `EVAL_JUDGE_API_KEY` | judge | judge is inert without a URL |
| `EVAL_AGENT=smoke` | runner | offline self-test escape hatch |

Keep candidate and judge credentials in CI secrets, never in the repo. Do not expose them to
forks: run `eval:core`/`eval:full` only on trusted branches/tags, or use a machine-side cron
that pulls the trusted revision.

## Artifacts and exit codes

- Each run writes `evals/results/<date>/<model>.jsonl` and one
  `<model>.<scenario>.trace.jsonl` per scenario. Upload the results directory on failure.
- `eval:core` exits non-zero on any scenario failure, S-violation, or baseline regression;
  `eval:full` exits non-zero below 0.85, on any S-violation, or on a regression.
- Baselines live in `evals/baselines/current.json` and are only rewritten with
  `--update-baseline` (owner-approved; spec §8 Q7).

## TODO (spec §8 Q3 — owner decision pending)

The scheduler itself is not chosen: GitHub Actions (if the repo adopts it) vs a machine-side
cron, plus secret storage and runner timeouts. Until that is decided, add the jobs above to
whichever scheduler the owner picks — do not commit a workflow file that pins secrets or
assumes a runner that does not exist yet. Model IDs also remain open (§8 Q1/Q2): the matrix
keeps `owner-to-fill-*` placeholders and no default model id is invented.
