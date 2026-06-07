# Plan: "Ask" — a conversational agent over the mailbox

Status: **proposed** (planning only — not started)
Last updated: 2026-06-03

## Goal

Add a conversational assistant ("Ask") that lets a basic user — the family,
Amanda — *ask their mailbox anything* and get a **cited** answer, and (later)
direct one-off actions in natural language. The north star is the one thing no
button can do: **ask an open question, get an answer linked to the source email.**

This is the read-side first. Write-side (drafting, rules, bulk actions) is phase two.

## Why chat at all (and where it does NOT belong)

Chat earns its place only for things buttons fundamentally can't express:

- **Open Q&A / retrieval** — "When's my dentist appointment?", "What's the
  confirmation number for Amanda's flight?", "How much did I spend on Uber last
  month?", "Did I reply to the landlord?". No button equivalent. Read-only, safe,
  highest wow for a basic user.
- **Summarize / triage** — "What needs my attention today?", "Catch me up on the
  contractor thread."
- **Standing rules in language** — "Always file Amazon orders into Shopping and
  mark them read." → becomes a persistent rule (reversible/reviewable).
- **Long-tail bulk actions** — "Trash everything from DoorDash older than 3 months."
  Generalizes auto-organize + mass-unsub (those are pre-baked special cases).

Chat is the WRONG tool for the common verbs — dedicated buttons (Clean up,
auto-organize) are faster, more discoverable, and safer. Keep the clean
button-driven core; chat is the **escape hatch for the long tail + the answer box
for questions**, not the primary interface.

## UI placement: context-aware docked panel (NOT a dedicated screen)

A dedicated rail screen forces a mode switch away from what you're looking at,
which defeats the point — you usually want to ask *about* the thing on screen.

Build it as a **right-docked "Ask" panel** that:

- **Sees current context** — header shows "Asking about: this thread / Inbox /
  3 selected". "Summarize this" / "reply saying yes" resolve with no re-specifying.
- **Overlays, keeps your place** — reuse the existing reader drawer/overlay layout
  machinery.
- **Persists the conversation across navigation** — it's a pinnable panel, not a
  transient popover (you want to scroll answers, click citations, follow up).
- **Invokable from anywhere** — visible "Ask" button (header/footer) + keyboard
  shortcut. Visible button matters; family won't discover a hidden ⌘K.
- **Seeds suggested chips when empty** — "What needs my attention?", "Find my
  receipts", "When's my next appointment?". Never hand a basic user a blank box
  (the anti-Zoho-bloat principle).

**Resolve before building:** the existing command palette already does semantic
search (`ai:search`). Let the Ask panel supersede the palette's natural-language
role; keep the palette for fast navigation/jump only — otherwise two competing
search boxes.

## Architecture (read-side = RAG over IMAP)

Core pattern: **retrieve → read a small set → answer with citations.** Never dump
the whole mailbox into the model.

### Tool set (read-only to start) — thin wrappers over existing handlers
- `searchMail(query, scope)` → `ai.searchEmails` + listing → candidate refs (cap ~20)
- `getMessage(id)` / `getThread(id)` → `getContent` → body text *(privacy escalation point)*
- `tally` / `listFolders` → "how many from X", "which folders"
- `currentContext()` → injected automatically: active view, selected ids, open message

### The loop
1. User asks; ambient context attached for free.
2. Model plans tool calls: `searchMail` → fetch top N bodies → read.
3. Model answers; **every claim cites its source message(s)** → clickable chips →
   open that email in the reader. Citations are mandatory (antidote to confidently
   wrong answers about real life).
4. Follow-ups retain the retrieved set + conversation.

### Where it lives in code
- `lib/agent.js` — the tool loop.
- New IPC `agent:ask` (ideally streaming via `webContents.send`).
- Renderer panel — conversation render + citation chips calling existing `openMessage`.

## Key decisions to make before building

1. **Agent loop: Anthropic API + Agent SDK vs hand-rolled CLI loop.** *(biggest)*
   - SDK/API: real tool-use + streaming, purpose-built — but API-key billing,
     separate from the current `claude -p` subscription model.
   - Hand-rolled JSON tool-selection over the existing CLI: no new billing,
     brittler, no native streaming.
2. **Model tiering** — Haiku for cheap steps (search/classify/pick), Sonnet for
   final synthesis over bodies.
3. **Streaming** — needed so it doesn't feel as slow as the scans. Needs SDK or
   `--output-format stream-json`; blocking `claude -p` won't stream.
4. **Privacy posture** — today only *sender metadata* is sent. Q&A sends **bodies**.
   For family use, make this an explicit, visible one-time consent.

## Phasing

- **v1** — Ask/Find with citations (read-only, safe, highest wow).
- **v1.5** — Summarize/triage ("what needs attention", "catch me up").
- **Phase two** — write-side: draft replies, standing rules, bulk actions — all
  behind the same preview + confirm + undo discipline as Clean up.

## Cautions (carry forward)

- Blank chat box = cognitive load; lead with suggested chips.
- Destructive actions + NL ambiguity = danger; always preview + confirm + undo.
- Latency: scoped retrieval, stream output.
- Hallucination: citations required; link sources.
