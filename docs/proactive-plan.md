# Proactive features — umbrella plan

Status: **scoped / designed, not built.** This is the vision for the *proactive* phase that
follows the reactive cleanup tools (Clean up, Find important). It captures the whole stack;
the deep-dive for the first feature lives in [needs-you-plan.md](./needs-you-plan.md), and the
on-demand Q&A in [ask-agent-plan.md](./ask-agent-plan.md).

## North star

> Watch the inbox so the user doesn't have to, and turn email-dread into a short, plain-English
> list of **what needs them and by when** — while keeping the inbox calm automatically.

The reactive tools were a one-time thinning (7k → ~200). Without a proactive layer the inbox
refills and the work is undone. Proactive = keep it calm *going forward* and surface what matters
*as it arrives*. For Amanda the metric is **calm + nothing-important-missed**, not speed.

The whole engine already exists: `findKeepers` (keep/junk/uncertain + folder routing + sender-
legitimacy reasoning, validated) is exactly what you run on *incoming* mail. The proactive layer is
mostly re-pointing what's built at new mail, plus one new capability (reading the important few for
actions — validated, see Layer 3).

## The proactive stack — three layers

### Layer 1 — Keep it calm (auto-maintain incoming)
A background watcher runs each new arrival through the pipeline: known sender → folder rule
auto-files it (cheap, deterministic — reuses `re-file` / `fileBySenders`); otherwise `findKeepers`
decides. Stops the inbox refilling.

This is where the **"sort vs flag" question** lives. The answer for a non-technical user is
**asymmetric, by confidence × stakes** — see the policy section below. Highest trust-risk layer →
**build last**, only with the digest + undo safety net in place.

### Layer 2 — Surface what matters ("Needs you" priority zone)
A pinned strip / rail view where the AI elevates important incoming mail with a plain-English
reason ("Genesis Legal — looks like a new court filing"). Purely **additive** — it only adds
attention, never moves or hides mail → lowest risk, highest fear-reduction. Directly answers
"did I miss something?"

### Layer 3 — Tell them what to do (action & deadline extraction) ⭐
The standout. For the *few* flagged-important emails, read the body and extract the **action +
deadline** → a calm "Needs you" to-do list, kept current automatically, with calm reminders.
**Validated on real mail** (pulls correct to-dos with amounts/deadlines, marks FYIs "no action").
Full spec: [needs-you-plan.md](./needs-you-plan.md). Layers 2 and 3 ship together as "Needs you."

## Companion — Ask your mailbox
The on-demand pull version of Layer 3, powered by the same extraction. Reframed for a
non-technical user as **suggested questions + answer cards with citations** ("When's my next court
date?", "Did the school send the form?", "How much do I owe Genesis Legal?") — *not* a blank chat
box. Design: [ask-agent-plan.md](./ask-agent-plan.md).

## Cross-cutting: smart notifications
Calm by design — an anxious user must never be trained to ignore pings.
- **Not per-email.** A **daily digest** ("3 things need you today: …") + a notification only when a
  **new high-priority** item appears. Native desktop notification; click opens "Needs you".
- Frequency cap + quiet hours.
- **Reminders** (fast-follow): day-before / morning-of for items with deadlines.
- **Hard constraint:** desktop must be open (no cloud backend) — notifications fire only while the
  app runs. State plainly; this is not phone-push. A background path is a later question.

## Cross-cutting: the sort-vs-flag policy (auto-action by confidence × stakes)
- **Boring & safe → auto-act.** Known-sender keepers auto-file to their folder; obvious bulk junk
  auto-holds (a "Cleared" bucket / Trash, recoverable). She trusts folders, so filed mail isn't lost.
- **Important → flag, never move.** Custody/health/school/financial gets *pinned*, never silently
  relocated. Never hide the thing she's afraid of missing.
- **Unsure → leave in inbox**, lightly marked.
- **The trust rule:** a *"What ClearKeep did"* digest + one-tap undo. Automate the boring, flag the
  important, **hide nothing without a trace.**

## Cross-cutting: trust principles
- **Never hides mail** — proactive surfacing is additive; the source always stays where it is.
- **Always cite the source** — every flagged item / to-do links to the email; money & dates are
  "best read — confirm in the email," never gospel.
- **No autonomous action** — it surfaces and suggests; it never sends, pays, replies, or files on
  the user's behalf. The human acts. (This is a deliberate differentiator vs. the agentic market.)
- **Private** — bodies are read only for the important few, via the user's own AI, not a 3rd-party
  SaaS pipeline. Consider a body-reading toggle.

## Validation status
- **Layer 3 (action/deadline extraction): VALIDATED** on 15 real foldered emails — concrete to-dos
  with amounts + deadlines, FYIs correctly marked no-action. Calibration gaps to fix in the prompt:
  elevate benefits/insurance renewals + consequence-of-inaction to high; handle overdue vs upcoming
  dates. (Details in needs-you-plan.md.)
- **Candidate selection (`findKeepers`): VALIDATED** earlier — separates keepers from gibberish-domain
  junk, catches custody court mail from generic addresses.
- **Layers 1, 2, notifications, ask-your-mailbox: designed, not yet validated/built.**

## Recommended sequencing
1. **"Needs you" (Layers 2 + 3)** — first. Hits the core fear, additive/safe, the emotional core.
   Validated. Settle the §12 open decisions in needs-you-plan.md before building.
2. **Smart notifications + reminders** — layer onto "Needs you" once the list exists.
3. **Ask your mailbox** — same extraction engine, pull instead of push.
4. **Layer 1 (auto-maintain incoming)** — last, built conservatively with digest + undo, since it
   carries the real trust risk.

## Constraints (recap)
- Desktop must be open (no cloud) — proactive watching + notifications run only while the app runs.
- Action extraction reads bodies — bound to flagged-important + recent mail (cost/privacy).
- Yahoo/IMAP first (same as the rest); other providers later.
- Auto-action needs the digest + undo safety net or it erodes trust with a non-technical user.

## Architecture & reuse (recap)
Reuse: `findKeepers` (candidate selection), `imap.getContent` (bodies), `ai.runClaude` plumbing,
the Clean up / Find important view + state-machine + review + trash/undo patterns. New per feature:
`ai.extractActions`; a `lib/needs.js` store; `needs:*` IPC; a "Needs you" view + rail badge; a
poll-based watcher; native notifications; the ask-mailbox retrieval path.
