# Plan: Vendor Folders + Theme Folders

Status: **proposed** (planning only — not started)
Last updated: 2026-06-03
Related: [ask-agent-plan.md](ask-agent-plan.md) — Theme folders reuse the same semantic-match machinery.

## Goal

Two distinct folder types, side by side:

- **Vendor folders** — *unchanged* from today. Auto-organize reasons over senders,
  clusters by brand/vendor (merging subdomains + brand variants), names the folder,
  and files. Precise, predictable, one-folder-per-brand (Amazon, Nike, …).
- **Theme folders** — *new*. **Name-first / intent-anchored.** The user creates a
  folder with a name (e.g. "Custody Emails"); the model reasons over that **name**
  and finds the senders/emails that fit the theme (lawyer's office, associates,
  court mail). Broad, topical, fewer folders.

## Why name-first for themes (the key design decision)

The hard, error-prone part of themes is the model **autonomously** deciding where
theme boundaries are and naming them ("is this Health or Shopping?"). Name-first
deletes that problem: the user's folder name *is* the intent, so the model only does
**membership matching against an explicit target** — far more reliable and
predictable than open-ended grouping.

It also reuses an existing pattern: the **New Folder button** already works
name-first (`folders:createAndFill` → `ai.matchVendor(name, senders)` → `deriveRules`
→ `fileBySenders`). Theme folders are that same flow with a **topical** matcher
instead of a brand matcher.

## Model choice: Haiku, with one honest limit

- **Haiku is enough.** Matching clearly-themed senders (court domains, the law
  firm's domain, subjects mentioning custody/hearing/case) against a theme name is
  easy classification — not reasoning-hard.
- **The limit is signal, not model tier.** Matching on **sender + sample subject**
  metadata catches emails where the theme is *visible* in who-sent-it or the subject.
  It will **miss** ones where neither reveals it (e.g. the lawyer emailing from a
  personal Gmail, subject "Documents attached"). Catching those needs reading
  **bodies** (semantic search over content) — the agent/RAG territory: more cost +
  the privacy shift from metadata-only to reading contents. **Sonnet would NOT fix
  this** — it's missing information, not reasoning.
- Verdict: great for the obvious themed senders, partial for subtle one-offs. Start
  on Haiku; escalate specific obscure cases (e.g. white-label senders) only if
  testing shows misses, and prefer feeding better context (subjects) over upgrading.

## Reuse / where it lives

- `folders:createAndFill` flow (name → match → derive rules → file) — extend with a
  theme matcher.
- A topical matcher like `ai.searchEmails` (already exists: query + items → matching
  indices) rather than `ai.matchVendor` (brand-only).
- `deriveRules` + `fileBySenders` for persistence + filing.
- **Stepping stone to the Ask agent:** a theme folder is essentially *a saved
  natural-language query that also files* — same machinery as semantic search.

## Open questions / decisions to nail

1. **Sender-level vs email-level matching.**
   - *Start sender-level:* find the senders that fit the theme, file all their mail
     (reuses `deriveRules` + `fileBySenders`). Works great when themed senders are
     theme-dedicated (lawyer, court, associates — they usually are).
   - *Caveat:* over-files for a **mixed sender** that sends both themed and unrelated
     mail (e.g. a county portal sending custody *and* tax notices).
   - Email-level (per-message) is more precise but much heavier. Deferred.

2. **One-time sweep vs living filter.**
   - Proposed: on creation, do the semantic sweep **and freeze the matched senders
     into address/domain rules**. Known senders then auto-file going forward
     (rule-based), and a **"re-scan this theme"** action re-runs the semantic match to
     pick up *new* senders. Best of both.

3. **Coverage of subtle members** (the body-content limit above) — accept the
   metadata-only ceiling for v1, or invest in content search (privacy + cost)?

4. **Naming.** "Theme folders" is a placeholder — find a clearer label (Smart
   folders? Topic folders?).

5. **Optional theme hint.** Should the user be able to add a hint beyond the name
   (e.g. the law firm's name/domain) to anchor matching, or rely on name + subjects?

6. **Model escalation policy.** If Haiku misses obscure senders, do we (a) feed more
   context, (b) selectively escalate low-confidence senders to Sonnet, or (c) accept
   the miss?

## Build order (proposed)

1. Theme matcher on Haiku (name + sender + sample subjects → matching senders).
2. Wire into a "New theme folder" creation flow (distinct from vendor folders).
3. Freeze matches to rules + add "re-scan theme."
4. Test accuracy on Amanda's real senders (esp. the Custody + School cases, incl.
   whether Peachjar gets caught via subjects) before deciding on any Sonnet
   escalation.
