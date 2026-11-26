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

Arena's cross-judge is specified as another vendor than the parent. The parent here is Grok, and every pool entry is Grok. A later arena in this repo skips that judge and says so, rather than calling Claude or Gemini.
