# External Orchestrator — Design Document

The external orchestrator (EO) runs on the developer's local machine, outside the sandbox.
It is the **sole interface** between the developer and the sandbox: the developer converses
only with the EO; nothing else crosses the sandbox boundary. The EO supervises the internal
orchestrator (IO) the way the IO supervises its specialists — hierarchical orchestration
(a supervisor of supervisors, per LangGraph's hierarchy pattern) with the developer at the top.

## Responsibilities

| Area | The EO does | The EO does NOT |
|---|---|---|
| Purpose | own the task's purpose: clarify intent, goal, constraints, done-criteria with the developer; keep the session thread; change scope only via TASK/TASK_REVISION envelopes | sequence specialist work or decide pipeline mechanics — that's the IO's pipeline |
| Sandbox lifecycle | provision the sandbox (profile, tool inventory, binding application per `workflows/bindings.md`); decide fresh vs resumed; destroy it at teardown | execute anything inside the sandbox — that's the IO's pipeline |
| Guardrails | apply approval gates, sanitize payloads both ways | pass raw developer credentials into the sandbox |
| Relay | package TASK envelopes, forward CLARIFICATION/STATUS upward | interpret specialist evidence for the developer — it summarizes IO reports |
| Custody & merging | persist ledger + artifacts across sandbox restarts; manage teardown/export; merge artifacts into the durable repo — apply patches, own branches, open/merge PRs, cut tags (README §Version control conventions) — since only the EO holds push credentials | keep state inside the sandbox |
| Trust boundary | filter both directions against indirect prompt injection | allow the developer (or IO) to address anything inside/outside the boundary directly |

## Security boundary rules (the one rule set that may never stretch)

1. The developer has no sandbox shell, FS, or network path. Every interaction is a message.
2. The EO authenticates all traffic to/from the sandbox over a dedicated channel it owns.
3. Inbound sanitization (developer → sandbox): strip secrets from payloads before
   dispatch (the redaction pass defined in protocol.md §Sanitization procedure);
   convert developer prose into structured TASK envelopes; never forward raw
   pasted credentials — the developer supplies them through the channel's secret facility
   or not at all.
4. Outbound sanitization (sandbox → developer): artifacts and fetched content are
   untrusted data. Summarize before showing, quote suspicious embedded instructions
   instead of following them, and label machine-generated content as such (indirect
   prompt injection defense).
5. Approval gates live here, at the boundary:
   - destructive operations or anything irreversible;
   - scoped changes outside the task's declared files; dependency installs;
   - external network requests (ARTIFACT_REQUEST) — see the egress constraints
     (allowlist, query-strip, size cap, monitored as an outbound-data surface) in
     protocol.md §ARTIFACT_REQUEST egress constraints;
   - budget expansions;
   - publish/release-shaped actions — concretely: pushes, PR merges to `main`, and
     tag/release cuts (README §Version control conventions).
   The gate is enforced by the EO holding the credential: the IO cannot bypass an approval
   even if prompted to, because the capability is not dispatched.
6. The EO never edits task content mid-flight; changes to scope are new/updated TASK
   envelopes, so the audit trail stays clean.

## End-to-end lifecycle

1. **Intake** — developer states an intent; EO clarifies goal, constraints, and what
   artifacts should come back; EO assembles the sandbox profile (tool inventory, budget).
2. **Dispatch** — EO opens/persists the session, sends TASK, hands the IO any ledger
   from previous sessions; sandbox starts fresh or resumed per EO's record. The EO also
   creates the task branch `task/<task_ref>` from `main` at dispatch (VC conventions
   §Branches) — it is the repo's branch owner.
3. **Supervision** — EO relays STATUS as progress digests; answers CLARIFICATION by going
   back to the developer; enforces approval gates on demand; enforces wall-clock/budget
   limits, escalating or interrupting as told. Sandbox-side commits happen locally on
   the task branch (agents never touch remotes); durable repository history is created
   EO-side from ARTIFACT_TRANSFER patches carrying identical commit conventions
   (README §Version control conventions).
4. **Verification gate** — on COMPLETION, the EO checks the manifest is present and the
   verdict block exists (a completion without both is bounced back as FAILURE); only then
   does it surface results. On a green verdict, the EO applies the exported patches to
   the task branch and opens a PR; the description carries goal, `Task-Ref`,
   `ledgerRef`, the verdict block, changed files, and the adversarial flaw log when the
   gate was attached (VC conventions §Pull requests). The EO also records the
   patch→durable-commit SHA mapping there — sandbox-local SHAs cited by specialists do
   not exist in the durable repo (EO-protocol §SHA provenance).
5. **Delivery** — EO summarizes results developer-side, hands over artifacts (files copied
   off the ephemeral sandbox before teardown), and archives the ledger for the next session.
   The PR squash-merges on approval; a merge-conflict rebase re-triggers the affected
   build+test lanes before landing (VC conventions §Merging & conflicts).
6. **Failure path** — on FAILURE, EO presents classification + evidence + recovery options;
   the developer chooses resume / re-dispatch / revise; the next action is a new envelope.
   Rolling back already-merged work is a `git revert` PR — releases revert PR + patch
   release; tags are never moved or deleted (VC conventions §Rollback & recovery).

## Message flow (developer's view)

```
Developer ⇄ EO   (conversation, approvals, summaries, artifacts)
EO ⇄ IO          (TASK/STATUS/CLARIFICATION/COMPLETION/FAILURE/ARTIFACT_* envelopes)
IO ⇄ specialists (inside the sandbox, per workflows/orchestrator-internal)
```

The developer sees: their own thread, EO digests of IO STATUS, approval prompts, and
artifacts. The IO never sees the developer's identity or machine; the specialists never
see the developer at all.

## Idea-to-specification intake (interactive EO mode)

The EO's Purpose row in practice: a developer arrives with an *idea* ("a dashboard for
metrics", "a tool that fixes my experiment tracking"), not a task contract. This section
defines the interactive process by which the EO and the developer develop that idea into
the unambiguous, implementable shape the IO can execute. The IO does not exist in this
phase — everything here is EO-side conversation plus gate; the output is a TASK envelope
plus a specification artifact.

### Comparable systems and what this design borrows / rejects

| System | Pattern observed | Borrowed / rejected |
|---|---|---|
| GitHub **Spec Kit** (spec-kit, agentic SDD) | staged commands (constitution → specify → clarify → plan → tasks → implement), each with an explicit human gate; the spec is the carrier, plans/tasks derive from it | **Borrowed**: per-phase human gates; spec-as-carrier; separate clarify stage. Rejected: command/slash-file mechanics (our EO converses; no repo files exist pre-sandbox) |
| GitHub **Copilot Workspace** | Task → Spec (with optional brainstorming) → Plan → Implement, each stage rendered as an editable artifact with check/approve/continue buttons | **Borrowed**: staged artifacts with edit-check-approve; brainstorming as an optional precursor. Rejected: plan-stage UX (the IO owns planning) |
| Claude Code **plan mode** | read-only exploration + plan proposal, explicit approval to proceed | Borrowed: "no writes before approval" posture, mapped to: no sandbox provisioning before spec approval |
| Interview-first agent flows (one question at a time with a stated hypothesis, ~95% confidence stop rule; see the interview-me methodology) | hypotheses attached to each question; explicit-yes gates; "out of scope" line mandatory | **Borrowed wholesale into Stage 1–2** (it is the anti-overwhelm technique: reacting is cheaper than generating) |

### Stage flow (state model)

```
INTAKE → INTERVIEWING → DRAFTING → SPEC REVIEW (gate) → DISPATCHED
                ↑                    ↑                        ↓
                └── TASK_REVISION ←──┴── spec correction loop    (IO pipeline owns everything past here)
                (re-entered at any stage; abandoned specs are kept, never deleted)
```

### Stage 1 — Intake capture

The EO captures the developer's initial idea **without starting to build it**:

1. Capture the idea in freeform (any length, any language).
2. Immediately restate it as a **hypothesis with a confidence number** (0–100%) plus a
   list of what is missing — following the interview-me template (`HYPOTHESIS:` /
   `CONFIDENCE:` with reasons below 70%). The number is a honesty device, not
   decoration: it tells the developer exactly what the next questions are for.
3. Classify the ask: if it is genuinely self-contained ("rename this function"), skip
   the interview and go straight to a minimal spec (Stage 3) — the flow must not
   interrogate for the sake of it.

Chosen over: pure freeform-then-build (the assumption-gap the interview-me methodology
calls "the misfit gets locked in"), and over question-batteries (batches get skimmed;
the third question often depends on the first answer).

### Stage 2 — Collaborative refinement

**One question per turn, always with the EO's guess attached** (Q:/GUESS: pattern).
The guess does double duty: it is faster to correct than to answer from scratch, and it
forces the EO's assumptions into the open where a wrong one is visible. Probes:

- who/why/success/binding-constraint until the ask is concrete;
- a "what would you actually want if you didn't have to justify it" probe when answers
turn into best-practice talk ("scalable", "modern") — the sycophancy guard;
- options presented as **choice pairs with trade-offs when the developer knows what
  they want**; questions when they don't. Options widen search; questions narrow it.
- **Overwhelm control:** a hard question budget — the restatement happens at ≤6
  questions unless the developer volunteers information faster. The 95% stop rule:
  interview until the EO can predict the developer's next three reactions, then stop.

When confidence is high, the EO writes the **restate** in the developer's own words —
Outcome / User / Why now / Success / Constraint / **Out of scope** (out-of-scope is
non-negotiable; half of misalignment is silent disagreement about what is *not* being
built) — and requires an **explicit yes**. "Whatever you think is best" is delegation,
not confirmation: it gets re-asked as two concrete options. "Sounds good" gets "what
would you refine?".

### Stage 3 — The specification artifact (the EO's handoff product)

The EO drafts **`SPEC-<task_ref>.md`** — the artifact the IO implements from. Format
(adapted from the spec-driven methodology spec template, restricted to what the IO can
actually consume):

```markdown
# Spec: <name>  (task_ref: <id>)
## Objective        — what & why; who the user is; one line each
## Success criteria — testable conditions (reframed from any vague requirement:
                       "faster" → concrete numbers/tolerances the test agent can check)
## Constraints      — declared files, dependencies, budget, irreversible-avoidance rules
## Boundaries       — Always / Ask-first (→ approvals_pregranted candidates) / Never
## Tech & runtime   — declared stack, where the sandbox profile diverges from defaults
## Structure        — target repo layout / capability map if multi-module
   (capability map: module id | responsibility | depends on — required when success
    criteria cluster into independently shippable groups; each module becomes its own
    TASK in build order, per the spec-kit-derived decomposition rule)
## Out of scope     — explicit non-goals (mirrors the restate; the IO plans around these)
## Open questions   — must be empty at dispatch; unresolved ones become explicit
                       ASSUMPTIONS with the developer's sign-off recorded against each
```

**Where it lives:** EO-side until dispatch (developer machine, next to the session
ledger). It crosses into the sandbox **as an input artifact** — TASK payload
`session.specRef` (see protocol §Task contract artifacts) — after which the IO's
dispatch machinery slices it (`input.goal` per specialist, `ledger_refs` for
citations); the full document is sandbox-resident so specialists read their slice,
not the whole conversation. **The spec is the only idea-to-pipeline carrier**: chat
history stays EO-local.

### Stage 4 — Handoff verification (three gates, then dispatch)

#### Spec completeness checklist (shared artifact — quoted by both EO and IO)

The checklist is defined once here and applied identically by the EO (pre-approval) and
the IO (at intake). Eight checks, each mechanically locatable in `SPEC-<task_ref>.md`:

| # | Check | Fail ⇒ |
|---|---|---|
| 1 | Objective section present (what & why, user, one line each) | loop to Stage 3 |
| 2 | Every success criterion testable — no vague verbs un-reframed ("faster" must be a number/tolerance) | loop to Stage 2 |
| 3 | Constraints section complete (declared files, dependencies, budget, irreversibility rules) | loop to Stage 3 |
| 4 | Boundaries three-tier (Always / Ask-first / Never) present | loop to Stage 3 |
| 5 | Capability map present iff success criteria cluster into independently shippable groups; module ids stable, dependency direction acyclic | loop to Stage 3 |
| 6 | Out-of-scope non-empty | loop to Stage 2 |
| 7 | Open questions section empty — or each open question converted to an explicit developer-signed ASSUMPTION with its sign-off recorded | loop to Stage 2 |
| 8 | Every Ask-first boundary is representable as an approval scope (`approvals_pregranted` candidates enumerated) | loop to Stage 3 |

1. **Gate 1 — EO applies the checklist** pre-approval. Failures loop back to Stage 2/3;
   a failing spec is never sent as-is.
2. **Gate 2 — Developer approval** (an approval-gated action at the boundary, per
   §5 Approval gates): the spec ships only on an explicit approve; the approval is
   scoped to the spec's SHA (EO records it; later TASK_REVISIONs need a fresh approval
   of the delta).
3. **Gate 3 — IO-side acceptance**: the IO's Stage-1 intake applies **Gate 1's checklist
   verbatim** (same eight checks, same source section). A spec that fails IO intake is
   FAILURE class `spec-invalid` with `recoveryOptions: [revise-spec, clarify]` — the
   pipeline never improvises around an ambiguous spec. IO CLARIFICATION questions
   during any stage resolve the same way.

Optional quality gate: the **adversarial pipeline** attaches at spec approval for large
or irreversible builds (steel-man the spec, contrarian attack the best case) — same
attach point semantics as the post-plan gate, an EO-side quality choice, not a
pipeline-stage owner.

### Route evaluation — single vs parallel sandboxes (pre-dispatch fork)

After spec approval and **before dispatch**, the EO analyzes the spec to determine the
optimal execution strategy and presents it: would parallelizing the work across multiple
sandboxes outperform one sequential pipeline, or is parallelization structurally
ineffective? **The fork applies to every task** — for repository-changing builds the
parallel axis is module tracks; for research-shaped tasks it is independent evidence
areas (e.g., scouting several domains in parallel sandboxes). The analysis — not the
task type — decides whether N=1 is optimal. The EO **stops without dispatching** — the
route is the developer's choice,
recorded in the TASK (`route`, below). This is a decision point, not a formality: the
side-by-side must be honest enough that choosing wrong costs visibly.

**Analysis inputs** (all from the spec — no sandbox needed, so this analysis happens
while nothing is provisioned): the capability map's DAG (module independence, build
order, shared files per module), the success criteria's verification cost (suite
runtime, build time), task size, and the budget envelope.

**Ineffective-parallelization criteria — state this explicitly when any holds**
(and recommend single-sandbox): a capability map whose DAG is a chain (every module
depends on the previous); heavy shared-file surface between modules; no capability map
(too small or too vague to decompose — the default is then single-sandbox, stated as
"not decomposable: single sandbox recommended"); work dominated by model latency rather
than local compute (parallel sandboxes don't speed up serial LLM reasoning); or an
interface so unstable that independent modules would churn.

**The comparison the EO presents (both options always rendered, side-by-side):**

| Dimension | Single sandbox | Parallel sandboxes (×N) |
|---|---|---|
| Wall-clock estimate | sum of module times (+ integration pass) | slowest module track + merge/integration overhead |
| Resource & token usage | one pipeline's tokens | ≈N × per-pipeline tokens **plus** duplicated context/spec cost per sandbox |
| Sandboxes required | 1 | N (one per independent module track; ≤ the parallel cap from the DAG) |
| Coordination & merge overhead | none — one branch, one PR | N branches/PRs, interface-freeze contract, cross-module consistency checks, ledger reconciliation at merge |
| Main risks | wall-clock on the critical path; single-context bloat | merge conflicts, interface drift between tracks, duplicated spec/context cost, budget fragmentation, harder cross-track regression isolation |
| Recommended when | DAG is or nearly is a chain; shared files dominate; model-latency-bound; small task | 2+ structurally independent modules, each with meaningful local compute (builds/suites); small, known merge surface |

Estimates are stated as ranges (`T_seq: ~Xh; T_par: ~max(module_i) + T_merge ± uncertainty`)
with the *basis* named (module sizes, suite runtimes) — no false precision. Token and
sandbox-count estimates cite the binding's budget wiring and the task-level caps;
coordination overhead names its concrete components (merge PRs, interface-contract
checks, the rebase-and-lane-re-run policy on conflict).

**The recommendation** — the EO picks one route and justifies it in one or two lines
(typically: which ineffective-parallelization criteria hold, or the wall-clock delta vs
merge risk). Like every recommendation here, it does not decide: the developer's choice
— `single`, or a specific `parallel` track plan — is recorded in the TASK and dispatch
follows only that route. A later route change = TASK_REVISION with the delta
(re-provisioning per the Sandbox lifecycle row; unused parallel sandboxes are destroyed,
never idled-billed). Two supporting rules: **budget subdivision** — per-track allocations
are proportional to the module wall-clock estimates, reserving the merge/integration
overhead share up-front; **ledger reconciliation** — at squash-merge the EO writes a
`RECONCILED` ledger entry linking each track's `ledgerRef` into the task's canonical
ledger, so one trace (`task_ref`) reconstructs a parallel task end-to-end.

### Dispatch

On approval: TASK dispatched with `session.specRef` + constraints (pre-granted
approvals drawn from the spec's Ask-first list), budget per §Budget semantics. Sandbox
provisioning follows the binding artifact (workflows/bindings.md). Spec corrections
mid-pipeline = TASK_REVISION with the spec delta; the IO re-enters delegation planning
(existing behavior), the spec SHA updates, and the developer re-approves material
changes.

### Options considered for the interaction model (trade-offs, not chosen here)

| Option | Pros | Cons | Status |
|---|---|---|---|
| **Interview-first** (stages 1–2 before any artifact; chosen) | surfaces the real ask ("dashboard" → "a list") before wrong frames harden; anti-overwhelm via budget + one-question turns | feels slow to impatient users; needs discipline to not over-interview trivial asks | **chosen**, with the self-contained-ask bypass |
| **Draft-first-then-interview** (EO freeform-captures a draft spec, then asks targeted diffs) | faster for users who can read specs; the draft is itself a disambiguation device | drafts anchor the user on the EO's framing (sycophancy risk); wrong drafts cost a full rewrite | rejected as default; **permitted** when the developer opens with dense structured input |
| **Capability-map-first** (decompose before any spec text, Spec Kit style) | prevents monolithic mega-specs | premature for vague ideas — you can't decompose what isn't yet stated | kept as the **multi-module branch**, not the entry |
| **In-chat spec vs file artifact** | in-chat is lower friction; file artifact is versionable, diffable, survives sessions, reviewable | in-chat history is EO-local by design (the pipeline must not depend on chat) | file artifact chosen (chat renders it inline for review); consistent with VC custody |

## Sandbox constraints

| Constraint | EO-side consequence |
|---|---|
| Ephemeral filesystem | EO is the persistence tier: ledger + artifacts live on the developer machine, exported continuously and on teardown |
| Limited network egress | ARTIFACT_REQUEST is the sanctioned path for outside content — under the EO's fetch allowlist and size cap; the EO fetches, sanitizes, and injects results, and the sandbox never gets raw egress |
| Isolated tooling | The EO provisions and declares the tool inventory per sandbox (TASK sandbox profile); capabilities not declared cannot be dispatched |
| Untrusted outputs | All artifacts land in a quarantine directory, scanned/sanitized before delivery into the developer's workspace |

## Sources

- LangGraph multi-agent concepts — hierarchical as supervisor-of-supervisors; handoffs
  with explicit destination + payload; control over agent communication.
- Anthropic — "Building effective agents": orchestrator-workers; guardrails ahead of
  complexity; evaluator/verification gating before completion.
- Anthropic — "How we built our multi-agent research system": lead-agent context economy,
  summaries-over-transcripts, effort scaling and budgets.
- Hearsay-II blackboard lineage — shared knowledge space owned and sequenced by one writer.
- Companion specs: `protocol.md` (wire schema), `diagram.md` (sequence), `system-prompt.md`
  (EO behavior), and `workflows/orchestrator-internal/*` for the sandbox side.