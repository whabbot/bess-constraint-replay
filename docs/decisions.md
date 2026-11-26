# Decisions

This file records choices for the replay tool. Each entry has the date, the decision, the options considered, the evidence, and who decided. An item marked Wail-pending is waiting on Wail.

## 2026-11-26 Pin every pstack role to a Grok model

Decision. `.cursor/rules/pstack-models.mdc` is always applied. The budget is medium, which sets effort at high. Every current pstack role uses a detected Grok slug.

Options considered.

- The setup-pstack skill defaults use Claude and Gemini slugs. The invoking message requires Grok for every role.
- The mapping on `whabbot/hackathon-radar` branch `cursor/hackathon-radar-v1-cb11` is the source for the Grok choices. `main` on that repo has no rules file.
- A bare `grok-4.7` slug has no effort token. It is absent from this session's Task model list.

Evidence. `gh api` read `.cursor/rules/pstack-models.mdc` from that branch. This session's detected Grok slugs are `grok-4.7` at low, medium, high, and xhigh, with and without `-fast`, and `cursor-grok-4.6` at the same efforts.

Who decided. Wail required Grok-only roles and a copy of that mapping. The agent applied the current setup-pstack role list to those choices.

### Slug substitution

The source file writes `grok-4.6-high` on the panel roles. This session's Task list includes `cursor-grok-4.6-high` for that generation. The panel lines use `cursor-grok-4.6-high`.

Wail-pending. Say if those seats should be `grok-4.7-high` instead.

### Lines left out

setup-pstack step 2 drops retired roles. These source lines were not copied.

- `hardest tasks`
- `how explorer`
- `how explainer`
- `why investigators`
- `why synthesizer`
- `reflect tooling`
- `reflect judgment, divergent, synthesizer`
- `architect runners`

### Budget

The source file sets medium, which means high effort. The agent kept that budget.

Wail-pending. Say if you want large, which means xhigh, or small, which means medium.

### Skill offers left open

This repo has no project verification skill and no formal verification skill. setup-pstack offers to generate either one.

Wail-pending. Say if you want either skill generated. This design pass did not generate them.

### Older-file migration

The source file has no `# defaults` line. On a file like that, setup-pstack treats `grok-*` in several roles as stale and would write Claude slugs instead. This file keeps the Grok slugs, because the source comment and the invoking message both require them. It also adds `# defaults: 3`. With that line present, a later setup run leaves these role values alone.

### Cross-vendor judge

Arena's cross-judge is specified as another vendor than the parent. The parent here is Grok, and every pool entry is Grok. A later arena in this repo skips that judge and records the skip.

## 2026-11-26 Use TypeScript for the replay backend

Decision. The replay code will be TypeScript. The React screen and the volume math share one language.

Options considered.

- A Python service that the screen calls.
- TypeScript only. The throwaway TypeScript spike is the seed for the volume function.

Evidence. On 2026-11-26 both scripts fetched settlement date 2026-11-18. Each matched 121 Elexon BOAV bid rows for `2__PFLEX002`, `E_ARBRB-1`, and `V__PHABI010`. The worst absolute gap was 3.553e-15 MWh. The stdout is `scratch/spike/output/python.txt` and `scratch/spike/output/typescript.txt`. After dropping the language name, the command, the start time, and the elapsed time, those files match line for line.

Python took 22.9s. TypeScript took 6.4s. Both made 154 HTTP requests, and TypeScript ran second. A warm server or connection reuse can explain the gap. It is not the reason for the choice. The volume match is float64 rounding of a linear integral, and the same rows match in both languages.

Who decided. The agent, from that run.

Wail-pending. Say if the service should be Python anyway.

## 2026-11-26 Core types

Decision. `docs/types.md` is the type contract. A confirmed loop needs a timestamped FPN rise and a further system bid. A public PN with no submission time is `unconfirmed`. A system-bid cost estimate is not a loop cost. A 3A result is `notApplied` or `replayed`.

Options considered.

- The sketch from arena runner `cursor-grok-4.6-high`, saved during the run at `/tmp/arena/candidate-b/types.md`. That sketch is the base. It brands the scalars, keeps a confirmed loop as a three-step tuple, and refuses to price an unconfirmed finding.
- A smaller status union with no brands, and one cost function for both loops and ordinary system bids. One cost function can present an ordinary bid as loop cost, so that shape lost.

Grafts on the base.

- `priceSystemBid` is separate from `attributeLoopCost`.
- `Counterfactual3A` uses `notApplied` when no non-storage action is marked. A zero delta exists only after a replay has run.
- GSP ids stay `_N` and `_P`.
- Acceptance ids stay numbers.
- The day-ahead type is one half-hour with group, limit, and flow. It has no BM unit list and no inferred active flag.
- Rules 3AA and 3AA Max are not types in this contract. They are later plan items.
- The sketch's third step is a further acceptance plus a day-ahead window and `constraintStillRelevant: true`. The contract's third step is a further system bid. The window stays off that step. A day-ahead half-hour does not establish that the constraint was still relevant.

Arena runners were `grok-4.7-high`, `cursor-grok-4.6-high`, and `grok-4.7-high-fast`. At the pick, only `cursor-grok-4.6-high` had written a file. The cross-vendor judge did not run, because every allowed model is Grok and the parent is Grok.

Who decided. The agent. Wail reviews the contract before implementation.

## 2026-11-26 MVP month and 3A membership

Decision. The first month is 1 November 2026 through 25 November 2026. The spike scanned MDO and MDB for every period on 18 November 2026 and found rows. Rule 3A does not invent a unit-to-constraint map. With no marked non-storage action, the result is `notApplied`.

Evidence. Spike stdout for the 18 November scan, and NESO day-ahead fields `Constraint Group`, `Date_ Time GMT_BST`, `Limit_MW`, `Flow_MW` with no BM unit column. The 2025 limit is in the correction below, not in this paragraph.

Who decided. The agent.

Wail-pending. Say if the first month must be calendar 2025, and say if you want a hand list of non-storage units for a constraint group so 3A can return `replayed`.

## 2026-11-26 Corrections after the design-trail read

The design-trail read on 2026-11-26 flagged five places where a sentence was stronger than its evidence. The agent narrowed those sentences. Who decided. The agent.

### 2025 MDO

The committed spike prints `mdo_rows_2025_12_03_sp20 0` for one settlement period. That line does not include the response body, and it is not an all-period scan. A later fetch saved the bodies in `scratch/spike/output/mdo-probes/`.

Three `datasets/MDO` calls, for 2025-12-03 period 20, 2025-11-12 period 32, and 2025-01-08 period 32, each returned `{"data":[]}`. The dynamic-parameters call for 2025-12-03 period 20, datasets MDO and MDB, returned an empty `data` array and named both datasets in `metadata`. The same MDO call for 2026-11-18 period 32 returned 942 rows. That body is 273410 bytes and is not committed.

Calendar 2025 is not shown to be empty. The first sequence still uses November 2026, because that is the month the spike scanned. Searching 2025 another way stays Wail-pending.

### Cost sign

Both stdout files print the same `net_gbp` figures and the same `sign_note`. That shows the two programs used one formula. It does not show the NESO appendix. The sign reading is from the consultation PDF, document 389366, appendix pages 26 and 28. Page 26 describes bid price times accepted bid volume, plus the same volume at the weighted-average accepted-offer price for that half-hour. Page 28 says the bid component is typically a negative cost that offsets replacement. Those two sentences are in `scratch/spike/output/neso-appendix-cost.txt`.

### Confirmed loops

`loops_confirmed 0` is a fixed print. The scripts have no branch that can print another number. The measured counts are `repeated_bid_pairs_within_3h` 147, 125, and 134. Those counts are pairs of system bids.

### Third loop step

The graft list above now records this. The arena sketch's third step carried a day-ahead window and `constraintStillRelevant: true`. `docs/types.md` puts a further system bid in that position and leaves the window off.

### Audit result

The types row in `.audit/design-pass.tsv` called the contract settled and marked the result `open`. The contract is written and waiting on Wail. A later audit row says that.
