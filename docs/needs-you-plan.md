# "Needs you" — proactive action & deadline surfacing (Layer 3)

Status: **designed, not built.** Validated on real mail 2026-06 (see below). This is the
first proactive feature after the reactive cleanup tools (Clean up, Find important).

## 1. The job

Amanda is non-technical and email stresses her out; the real fear is **missing a
high-stakes deadline** — a custody payment, a school form, a medical pre-check-in,
a benefits renewal — buried in bureaucratic mail. "Needs you" exists to:

> Read the important mail so she doesn't have to, and turn it into a short, plain-English
> list of **what needs her and by when** — kept current automatically.

It is the *additive, safe* layer: it only ever **surfaces** mail, never moves or hides it.
So it carries none of the "where did my email go?" risk of auto-sorting. That's why it's first.

## 2. Validation (already done)

Throwaway pass over 15 of her real foldered Custody/Education/Health emails
(sender + subject + **body** → AI). Result: it extracts concrete to-dos with amounts
and deadlines, and correctly marks receipts/FYIs as "no action" (doesn't invent noise).
Real list it produced:

- Pay Genesis Legal **$655.50** — overdue (caught amount + past-due)
- Sign fee agreement + intake + pay **$5,000 retainer** — new custody matter
- Complete MyChart **PreCheck-In before 11 AM today** (resolved to today's date)
- Pay **$40** chess-club shirts (even caught the payment methods)
- Renew **AHCCCS/KidsCare** coverage
- Complete counseling insurance form

**Calibration gaps found (must fix in the prompt):**
1. Priority was **soft on benefits** — the Medicaid/KidsCare renewal came back `normal`.
   For Amanda, losing coverage is as high-stakes as a court date.
2. **Date/freshness** — it returned an already-past deadline; the feature must distinguish
   overdue vs upcoming and not resurface long-closed items.
3. Some calls are subjective ("missing assignments" → no action) — tunable, acceptable.

## 3. What Amanda sees (UX)

**Rail entry: "Needs you"** with a count badge (active items). Optionally a slim pinned
banner atop the inbox showing the top 1–2 ("⚠️ 2 things need you — a $5,000 retainer · a bill due").

**The list** — to-do cards, grouped by urgency:
- **Overdue** (past deadline, unresolved) — flagged, not hidden
- **This week** (deadline within ~7 days)
- **Later** (further-out deadline)
- **No date** (action, but no deadline)

**A card** shows, in plain language:
- One-line **what it is** ("New custody matter — fee agreement + retainer")
- The **action** ("Sign the fee agreement and pay the $5,000 retainer")
- The **deadline** with colour (overdue = red, due-soon = amber)
- The **sender** + a one-tap **Open** to the source email (the citation — she can always verify)
- Buttons: **Open · Done · Snooze · Not relevant**

**Tone:** calm, no jargon, reassuring. Empty state = "You're all caught up." The list is
framed as *"ClearKeep's best read — tap to see the email,"* never as gospel (critical for
money/dates: never auto-pay, always one tap from the source).

## 4. What gets read (the funnel — bounds cost & privacy)

We can't body-read 2,000+ emails. Body-extraction is bound to **important candidates only**:

1. **Candidate selection (metadata only):** reuse the `findKeepers` brain → the keep + uncertain
   set. Junk is never read.
2. **Body-extraction (the few):** for each candidate, fetch the body (`getContent`) and run the
   action prompt. Junk/low never reaches this step.
3. **Recency bound:** only process mail from the last ~60 days (actions are time-bounded). Open
   question: include filed folder mail in the backfill, or inbox-only? (A custody hearing filed
   last week still has a live deadline — leaning include folders, recency-bounded.)

Body text goes to the model (the user's Claude CLI subscription) for these important few only —
a deliberate, bounded exception to the usual metadata-only rule. Consider a settings toggle.

## 5. The extraction contract

`ai.extractActions(items)` where items = `[{i, from, subject, body}]`, `body` stripped + truncated
(~1500 chars). Pass **today's date** in for relative-date resolution. Returns, aligned by `i`:

```
{ i, summary, action, deadline, priority, hasAction }
```

- `hasAction`: false → never shown (receipts, FYIs, confirmations).
- `priority`: **high** = court/custody/legal deadlines, money due, forms/signatures due,
  appointments, **benefits/insurance/coverage renewals**, and **anything with a stated
  consequence for inaction** (account closure, coverage loss, late fee, default). normal = a
  real action, lower stakes. low = none.
- `deadline`: normalized date/time when stated or clearly implied; "" otherwise. Never invented.
  A derived `temporalStatus` (overdue / due-soon / upcoming / none) drives sorting + colour.

## 6. The watcher (keeping it current)

- **v1:** poll while the app is open — on focus + a periodic timer + manual Refresh. Detect new
  mail by UID > lastSeenUid; classify → if important/uncertain, extract → upsert to-dos.
- **Later:** IMAP IDLE for near-instant pickup.
- **Hard constraint:** desktop must be open — no cloud backend, so this runs only while the app
  is running. State this plainly to the user; it is not phone-push.

## 7. State & lifecycle

Persist a `needs.json` (app support dir, like `folders.json`). Each item:

```
{ id, sourceMessageId, account, summary, action, deadline, priority,
  status: active | done | snoozed(until) | dismissed, createdAt }
```

- **Idempotent by `sourceMessageId`** — re-processing updates, never duplicates.
- **Done / Dismiss / Snooze(until date)** are user-driven and sticky (survive re-scans).
- Acting *in email* does NOT auto-complete a task (reading ≠ done) — keep Done manual.
- Thread dedupe (multiple emails about one hearing) — collapse by topic. (Open question / later.)
- Overdue items persist until Done/Dismissed; stale low items age out.

## 8. Notifications & reminders

Calm by design — an anxious user must not be trained to ignore pings.
- **NOT per-email.** A **daily digest** ("3 things need you today: …") + a notification only when a
  **new high-priority** item appears. Native Electron `Notification`; click opens "Needs you."
- Frequency cap + quiet hours.
- **Reminders** (fast-follow): day-before / morning-of for items with deadlines.

## 9. Trust & safety

- **Never hides mail.** Source stays put; "Needs you" is purely additive → no trust risk.
- **Always cite the source** (one-tap Open). Money/dates are "best read — confirm in the email."
- **Privacy:** bodies read only for important candidates; consider a toggle + a clear note.
- **No autonomous action** — it never pays, replies, or files on her behalf. It surfaces; she acts.

## 10. Architecture & reuse

- Reuse: `findKeepers` (candidate selection), `imap.getContent` (bodies), `ai.runClaude` plumbing,
  the Clean up / Find important view + state-machine + review patterns, the trash/undo discipline.
- New: `ai.extractActions`; `lib/needs.js` store; IPC `needs:scan` (backfill), `needs:refresh`
  (incremental), `needs:update` (done/snooze/dismiss); a renderer "Needs you" view + rail badge +
  optional inbox banner; a poll-based watcher; Electron notifications.
- Yahoo/IMAP first (same as the rest); other backends later.

## 11. Scope

**v1 (MVP):** "Needs you" rail view; backfill over important inbox (+ recent folder?) mail →
extract → urgency-sorted to-do list with Open/Done/Snooze/Dismiss, persisted; calibrated prompt
(benefits + consequence-of-inaction = high; temporal status); manual + light auto refresh;
source-email links.

**v1.5:** daily digest notification; inbox pinned banner.

**Later:** reminders; IMAP IDLE real-time; add-to-calendar; thread/topic dedupe; settings
(body-reading toggle, quiet hours); other providers.

## 12. Open decisions (resolve before/while building)

1. Backfill scope — inbox-only, or include foldered mail? How far back (30/60/90 days)?
2. UI home — rail view, inbox banner, or both for v1?
3. Notification cadence — daily digest, per-high-item, or both? Quiet hours default?
4. Does **Done** also archive/file the source email, or just clear the task?
5. Thread/topic dedupe in v1 or later?
6. Body-reading: on by default with a note, or opt-in?

## 13. Risks & mitigations

- **Wrong amount/date** → never auto-act; always one tap to the source; label as "best read."
- **Over-notifying** → calm digest + caps + quiet hours.
- **Body-read cost** → bound to important + recent; cache by messageId; idempotent.
- **Desktop-open limitation** → set expectations; revisit a background path later.
- **Stale/duplicate to-dos** → idempotent upsert + lifecycle states + aging.
