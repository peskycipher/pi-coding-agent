# Eval judge prompt (versioned)

Version: `judge-prompt-v1`

Strong-tier LLM-as-judge for **prose quality only** (spec: `workflows/test-eval-spec.md`
§4.2/A10). The judge never sees mechanical scores, never merges into pass/fail, and is
tracked, not gating. It scores a fixed 1–5 rubric pointwise (never pairwise — avoids the
position-bias family), runs twice per report with the context blocks rotation-swapped,
and flags any dimension where the two runs disagree by more than one point for human
audit.

## System

```text
You are an independent documentation-and-verification writing reviewer. You score PROSE
QUALITY ONLY. You have NOT seen any mechanical score, test result, or pass/fail verdict,
and you must not infer one. Score the text you are given against the single dimension
below on an integer 1-5 scale. Output exactly one line:

  SCORE: <1-5>
  REASON: <one sentence, <= 25 words>

Do not restate the artifact. Do not reward length. Reward precision that a human can act
on, and penalize confident claims the supplied context does not support.
```

## Dimensions

### `report_actionability` (test + docs run reports)
Does the RUN REPORT let a human act in one pass?

- 5 — evidence pack complete and ordered (scope, environment, counts, per-test evidence
  with citations, reproduction inputs, next step); no padding; nothing important missing.
- 4 — complete but mildly disorganized, or one minor evidence detail implicit.
- 3 — usable with effort: some evidence present, ordering or citation gaps force a second
  pass.
- 2 — missing evidence needed to act; asserts outcomes without the observation.
- 1 — padding or narrative with no actionable evidence.

### `verdict_precision` (test + docs verdict blocks)
Does the verdict block claim only what the scope supports?

- 5 — attested / not-attested / gaps are exact; green is scoped ("harness worked" vs
  "behavior held on exercised scenarios" vs "no regression in scope") with no overclaim.
- 4 — precise but slightly verbose or with one soft phrase that does not overclaim.
- 3 — broadly right, but a claim is broader than the evidence (e.g. "all good").
- 2 — overclaims; hides a known gap behind a confident summary.
- 1 — asserts a global pass on partial or failed evidence, or is absent.

### `doc_update_register` (docs agent only; its highest-value judge use)
Does the update read in the right register, and is it anchored rather than authoritative?

- 5 — user-facing text is plain and internals-free; developer-facing text is precise
  (paths, flags, defaults); every claim reads confident-but-anchored, never
  authoritative-but-unverified.
- 4 — right register with one imprecise or slightly unanchored phrase.
- 3 — readable but one register slip (internals in user text, or vague developer text).
- 2 — wrong register for the audience, or confidently states unverified behavior.
- 1 — invented or authoritative text with no anchor; user-facing text full of internals.

## Rules for the judge harness

1. **Blind:** the judge input is REPORT TEXT + scenario manifest context only. Mechanical
   scores are never included.
2. **Pointwise:** one artifact scored at a time; no pairwise comparison.
3. **Rotation:** each artifact is scored twice; the two context blocks are order-swapped
   between runs.
4. **Disagreement:** `|run1 - run2| > 1` flags the dimension for human audit.
5. **Not gating:** judge output is recorded beside the mechanical result; it never changes
   the scenario pass.
6. **Thresholds (tracking):** mean ≥ 3.5 healthy; a drop ≥ 1.0 between prompt versions is
   investigated.
