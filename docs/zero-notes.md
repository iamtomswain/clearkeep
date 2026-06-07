# Zero (Mail-0) teardown — what's worth borrowing

Studied the open-source **Zero** email client (cloned to `/Users/4eighty/Dev/zero`, MIT-licensed,
`Copyright (c) 2025 Zero Email`) for inspiration. It's a Next.js/React/TS + Postgres monorepo
(pnpm/turbo), Gmail/Outlook-first, aimed at power users. We do NOT copy code (different stack:
Electron + vanilla JS + IMAP + Claude CLI) — these are *ideas*. License (MIT) would permit code
reuse with attribution, but the stack mismatch makes that impractical.

## Headline (strategic)
**Zero does NO custom AI classification.** "Important" = Gmail/Outlook **native categories**
(`CATEGORY_IMPORTANT`, `CATEGORY_PERSONAL`, …) + user labels. It only works because it's Gmail-first
and the provider already classified the mail. It also has **no digest / reminders / proactive alerts**.
→ On the two things that matter most for ClearKeep — **AI keeper-finding over IMAP** (where there are
NO native categories) and the **proactive "Needs you" layer** — ClearKeep is already ahead. Zero has
nothing to borrow there because it doesn't do it.

So overlap is smaller than expected. Zero is a Gmail-first, power-user, *agentic* platform; ClearKeep
is non-technical / IMAP / calm / surface-don't-act. A few patterns are still worth taking:

## Borrow (ranked)
1. **Agent / tool-calling loop — idea-portable, HIGH.** LLM + `tools` array + `maxSteps`, persona prompt
   that says *use tools to act, don't give manual instructions*, plain-text replies (no markdown), and a
   **confirm gate for destructive actions when >5 threads**. The right skeleton for **Ask your mailbox**
   and any future action-taking. Files: `apps/server/src/lib/prompts.ts` (AiChatPrompt ~327–610),
   `apps/server/src/routes/ai.ts` (generateText + tools + maxSteps), `apps/server/src/routes/agent/tools.ts`.
2. **Confirmation gates for bulk actions — validates what we built.** ">5 → confirm with count" = our
   Clean up / Tidy up confirms. Polish idea: show 2–3 sample subjects in the confirm. (`prompts.ts` ~521–543.)
3. **"Embed summaries, not bodies" for RAG — idea-portable, for Ask-your-mailbox.** They vectorize thread
   *summaries* (cheap, private) and semantic-search those (Cloudflare Vectorize, `bge-large-en`). NOTE their
   RAG tools (`askZeroMailbox`, `askZeroThread`) are **commented-out/disabled** — even Zero hasn't shipped it.
   For desktop: local vector store (sqlite-vec / small lib), embed summaries on sync, query → retrieve →
   Claude CLI. Files: `apps/server/src/routes/agent/tools.ts` (~44–106), summary prompts in
   `apps/server/src/lib/brain.fallback.prompts.ts`.
4. **Unified provider interface — reference for later.** `MailManager` interface, identical methods across
   Google/Outlook (`apps/server/src/lib/driver/types.ts` ~53–120) — mirrors our `BACKENDS` dispatch. Real
   IMAP gaps flagged for the **Layer 1 watcher**: no history API → poll or **IMAP IDLE**; reconstruct
   threads from `In-Reply-To`/`References` headers; IMAP labels = folders.
5. **Misc small ideas:** modular/per-connection prompts stored in config (customizable without code);
   `List-Unsubscribe`/`-Post` already a first-class parsed field (we do this too); a `summary` table per
   message/thread (suggested-reply + saved flag) if we add summaries.

## Skip
- **Writing-style metrics (52 dims to mimic your tone)** — for drafting email in your voice; that's the
  agentic "act for you" path we deliberately rejected. Not our product.
- **Durable Objects / Cloudflare Workers / Postgres / server architecture** — stack-locked; our local
  SQLite/JSON desktop approach is correct.
- **Twilio phone system, MCP server** — not relevant now.

## Net
Borrow the **agent/tool-calling architecture** (for Ask-your-mailbox) and the **confirmation-gate UX**
(already aligned), plus the **embed-summaries-not-bodies** RAG idea. Everything that makes ClearKeep
*ClearKeep* — IMAP-native AI classification, the cleanup, the proactive "Needs you" — is ours to build;
Zero doesn't have it. Clone kept at `/Users/4eighty/Dev/zero` as a code reference.
