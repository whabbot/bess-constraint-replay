# Implementation plan

This sequence builds a small replay tool. One month of public data, a handful of proxy units, loop status, a per-unit timeline, a total cost estimate, and one counterfactual rule, 3A. Each pull request is one change with a pass/fail check. Implementation starts when Wail says to start.

The design pull request and the pstack pull request are already open. They are not steps in this sequence.

## Order

`pr-volume` branches from `main` after the design pull request is merged. `pr-month-cache` and `pr-loops-and-cost` wait for `pr-volume` and can proceed in parallel. `pr-timeline-ui` waits for both. `pr-rule-3a` waits for `pr-timeline-ui`.

`pr-timeline-ui` and `pr-rule-3a` change a screen. Each waits for Wail's review before merge.

Files stay apart so the parallel pair does not edit the same module. `pr-volume` owns `src/domain.ts`, `src/volume.ts`, and `fixtures/`. `pr-month-cache` owns `src/elexon.ts` and `src/cache.ts`. `pr-loops-and-cost` owns `src/loops.ts` and `src/cost.ts`. `pr-timeline-ui` owns `src/app/`. `pr-rule-3a` owns `src/rule3a.ts` and `src/app/Counterfactual.tsx`.

## pr-volume

- [ ] Depends on the design pull request being merged.
- [ ] Files: `src/domain.ts`, `src/volume.ts`, `fixtures/2026-11-18.json`.
- [ ] Change: add the types in `docs/types.md` and the stacked bid-volume integral from the throwaway spike.
- [ ] Result: every fixture row shows the same published and computed megawatt-hours.

Pass when all three checks hold.

- [ ] Unit. Every row in `fixtures/2026-11-18.json` matches within 0.0001 MWh.
- [ ] Live. Refetch `2__PFLEX002`, `E_ARBRB-1`, and `V__PHABI010` for 2026-11-18. The worst absolute gap against BOAV `totalVolumeAccepted` is under 0.0001 MWh.
- [ ] Perf. One pass over the fixture finishes in under 100ms. Fail at 100ms or above. There is no trunk baseline. The ceiling is the gate.

Fail if any check fails.

## pr-month-cache

- [ ] Depends on `pr-volume`.
- [ ] Files: `src/elexon.ts`, `src/cache.ts`.
- [ ] Change: select proxy units for each settlement date from 2026-11-01 through 2026-11-25 and store the raw JSON on disk.
- [ ] Result: 2026-11-18 selects the same three Elexon ids the spike printed, and a second run of that date performs no HTTP.

Pass when all three checks hold.

- [ ] Unit. Given the saved 2026-11-18 reference, MDO, MDB, and BOALF fixtures, the selector returns `2__PFLEX002`, `E_ARBRB-1`, and `V__PHABI010`, each tagged `constraintUnitProxy`.
- [ ] Live. A cold run against Elexon for 2026-11-18 prints those three ids. A warm run prints `http_requests 0` for that date.
- [ ] Perf. The warm read of one cached day finishes in under 1s. Fail at 1s or above.

Fail if any check fails, or if the command prints a unit id that was not in the response body.

## pr-loops-and-cost

- [ ] Depends on `pr-volume`.
- [ ] Files: `src/loops.ts`, `src/cost.ts`.
- [ ] Change: classify each system bid as `unconfirmed` when the PN has no submission time, and price one system bid with the appendix formula.
- [ ] Result: the 2026-11-18 fixture reports zero confirmed loops, and acceptance 27575 in settlement period 32 prices to the spike's net.

Pass when all three checks hold.

- [ ] Unit. Confirmed findings are 0. `attributeLoopCost` does not accept an `unconfirmed` finding. Acceptance `27575`, period 32, net is 1443.210703 GBP within 0.01 GBP.
- [ ] Live. Refetch that acceptance's bid price and the period's accepted offers. The recomputed net matches the fresh inputs within 0.01 GBP, and the UI-facing label is `systemBidCostEstimate`.
- [ ] Perf. Classifying the fixture's system bids finishes in under 100ms. Fail at 100ms or above.

Fail if a confirmed loop appears without a `submittedAt` timestamp, or if the money check misses.

## pr-timeline-ui

- [ ] Depends on `pr-month-cache` and `pr-loops-and-cost`.
- [ ] Files: `src/app/`.
- [ ] Change: one screen with a proxy banner, one unit timeline for the selected day, and the total of `systemBidCostEstimate` net values.
- [ ] Result: for 2026-11-18 and `E_ARBRB-1`, the screen shows acceptance 27575 with both volume numbers, confirmed loops 0, and a total marked as an estimate.

Pass when all three checks hold. This pull request waits for Wail's review before merge.

- [ ] Unit. The timeline view, given the fixture, renders the proxy banner and the estimate label.
- [ ] Live. In a browser, choose 2026-11-18 and `E_ARBRB-1`. The row for acceptance 27575 shows published `-13.533333` MWh and the same computed value. Confirmed loops read 0. The total is labelled an estimate. A unit outside the proxy set is not offered.
- [ ] Perf. With a warm cache, the day view finishes loading in under 2s. Fail at 2s or above.

Fail if the banner is missing, the two volume numbers disagree, or the total is shown as a final charge.

## pr-rule-3a

- [ ] Depends on `pr-timeline-ui`.
- [ ] Files: `src/rule3a.ts`, `src/app/Counterfactual.tsx`.
- [ ] Change: replay rule 3A on a marked membership set. Non-storage marks are taken before storage marks.
- [ ] Result: with no non-storage marks, the screen shows `notApplied`. A fixture with one marked non-storage bid and one marked storage bid shows `replayed` and a delta.

Pass when all three checks hold. This pull request waits for Wail's review before merge.

- [ ] Unit. An empty non-storage mark set returns `notApplied`. A fixture with both roles returns `replayed` and a numeric delta. The type has no zero that means "not run".
- [ ] Live. In the browser, open 2026-11-18, group `SCOTEX`, and `E_ARBRB-1` with no non-storage marks. The panel reads `notApplied`. The day-ahead limit and flow for `SCOTEX` are the NESO values for that half-hour.
- [ ] Perf. The reorder on the fixture finishes in under 100ms. Fail at 100ms or above.

Fail if the screen prints a pound delta when the result is `notApplied`.

## Outside this sequence

These stay out until a public source exists or Wail asks for them.

- Calendar 2025 cost next to NESO's £58.2m and £97.9m figures. The MDO query for 2025-12-03 period 20 returned 0 rows.
- A unit-level negative DC Low, DM Low, DR Low, or Negative Quick Reserve flag for the next 3 hours.
- PN submission timestamps, which the public physical payload does not carry.
- An official BM unit to constraint map.
- Rules 3AA and 3AA Max.
- Clock-change settlement days.
- Trading or investment advice.
