"use strict";

/* Claude CLI wrapper (uses the user's subscription via headless `claude -p`).
   Pure Node (no Electron deps) so it's testable standalone. Sends only sender
   metadata (addresses + display names) — never message bodies. */

const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const MODEL = "claude-haiku-4-5";

function resolveClaude() {
  const candidates = [
    process.env.CLAUDE_CLI_PATH,
    path.join(os.homedir(), ".local/bin/claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    "/usr/bin/claude",
  ].filter(Boolean);
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch {} }
  return "claude"; // fall back to PATH
}

// Pass the prompt on STDIN, not as an argv (a big sender list can blow the
// command-line length limit). `claude -p` reads the prompt from stdin.
function runClaude(prompt, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const bin = resolveClaude();
    const child = execFile(
      bin, ["-p", "--model", MODEL],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: process.env },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || err.message || "claude failed").slice(0, 240)));
        resolve(String(stdout));
      }
    );
    try { child.stdin.write(prompt); child.stdin.end(); } catch (e) { reject(e); }
  });
}

function parseJsonLoose(text) {
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const m = t.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  if (m) t = m[1];
  return JSON.parse(t);
}

// Given a vendor/brand name and a list of "address (Display Name)" sender
// strings, return the subset that belongs to that vendor.
async function matchVendor(vendorName, senders) {
  const prompt =
    `You are sorting email senders into a folder for the brand/vendor "${vendorName}". ` +
    `From the list, return ONLY a JSON array of the exact sender strings that belong to "${vendorName}" — ` +
    `include all of its domains and subdomains, and any sender whose display name is clearly ${vendorName} even on a different domain. ` +
    `Exclude unrelated senders. No prose, no code fence.\nSenders:\n${JSON.stringify(senders)}`;
  const out = await runClaude(prompt);
  try {
    const arr = parseJsonLoose(out);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch { return []; }
}

// Theme-folder matcher: given a user-named theme (e.g. "Custody Emails") and a
// list of senders ("address (Name) :: recent subjects"), return the senders whose
// mail belongs in that theme — judged by topic/purpose, not just brand. Inclusive
// of clearly-related senders (law firms, courts, agencies, named individuals,
// related services); excludes unrelated marketing that merely mentions a keyword.
async function matchTheme(themeName, senders) {
  const prompt =
    `A user made an email folder called "${themeName}". Each line is a sender: "address (Display Name) :: recent subject lines". ` +
    `Return ONLY a JSON array of objects {"sender":"exact sender string","promo":true|false} for the senders whose mail relates to a "${themeName}" folder. ` +
    `Judge by topic and purpose, across different domains: include the user's OWN providers, accounts, organizations, named individuals, and correspondence about "${themeName}". ` +
    `Set "promo":true when the sender is promotional / marketing / sales / affiliate / advertising — an ad ABOUT the topic from a company the user likely has no account with (e.g. for "Health": weight-loss, supplement, GLP-1, or treatment ads). Set "promo":false for the user's actual providers, accounts, appointments, and personal correspondence. ` +
    `Exclude senders unrelated to "${themeName}". No prose, no code fence.\nSenders:\n${JSON.stringify(senders)}`;
  const out = await runClaude(prompt, { timeoutMs: 120000 });
  try {
    const arr = parseJsonLoose(out);
    return Array.isArray(arr) ? arr.filter((o) => o && typeof o.sender === "string").map((o) => ({ sender: o.sender, promo: !!o.promo })) : [];
  } catch { return []; }
}

// Group senders into vendor clusters for the AI organize sweep.
// Input strings carry a "×N" email count; threshold on total volume so a
// single-address but high-volume vendor (e.g. Venmo) still earns a folder.
async function clusterVendors(senders) {
  const prompt =
    `These are email senders, each tagged with how many emails they've sent (e.g. "×8"). ` +
    `Group them by the company/brand/vendor behind them (merge subdomains and brand variants — e.g. venmo.com and email.venmo.com are both Venmo). ` +
    `Return ONLY a JSON array of objects {"vendor":"Name","senders":["exact sender strings"]}. ` +
    `Only include a vendor if its senders total 3 or more emails. ` +
    `Skip personal/individual humans and one-off senders. No prose, no code fence.\nSenders:\n${JSON.stringify(senders)}`;
  const out = await runClaude(prompt, { timeoutMs: 180000 });
  try {
    const arr = parseJsonLoose(out);
    return Array.isArray(arr) ? arr.filter((c) => c && c.vendor && Array.isArray(c.senders) && c.senders.length) : [];
  } catch { return []; }
}

// Cluster senders for the Clean up sweep. Input lines: "address (Name) ×count :: sample subject".
// Returns [{vendor, senders:[exact addresses], category, spam}]. Metadata only —
// no bodies. `spam` flags forged/throwaway/scammy senders so we delete-don't-unsubscribe them.
async function clusterForUnsub(senders) {
  const prompt =
    `Each line is an email sender: "address (Display Name) ×count :: sample subject". ` +
    `Group the senders by the company/brand/vendor behind them (merge subdomains and brand variants — e.g. email.nike.com and nike.com are both Nike). ` +
    `For each group also return:\n` +
    `- "category": one of promo, newsletter, notification, transactional, social, spam.\n` +
    `- "spam": true if the group looks like junk/spam — forged or throwaway sender, scammy or deceptive subject ("Claim your $500", "You won"), or not a legitimate opt-in mailing list; otherwise false.\n` +
    `- "personal": true ONLY for an INDIVIDUAL HUMAN corresponding person-to-person — a named real person (e.g. "Sean Whitaker <swhitaker@firm.com>", subjects like "RE:"/"FW:" about a real matter), including a named individual at a company writing to this person. FALSE for companies, brands, no-reply/notifications/marketing/automated/bulk senders. CRITICAL: do NOT merge an individual person into a company group — give each person their OWN group with personal:true. Personal senders must never be deleted.\n` +
    `Return ONLY a JSON array of objects {"vendor":"Name","senders":["exact address strings"],"category":"...","spam":true|false,"personal":true|false}. ` +
    `Put the exact address (the token before the first space) in the senders array. Every input sender must appear in exactly one group; a single-sender group is fine. No prose, no code fence.\nSenders:\n${JSON.stringify(senders)}`;
  const out = await runClaude(prompt, { timeoutMs: 180000 });
  try {
    const arr = parseJsonLoose(out);
    return Array.isArray(arr) ? arr.filter((c) => c && c.vendor && Array.isArray(c.senders)) : [];
  } catch { return []; }
}

// Classify a batch of emails into category buckets. Input: [{from, subject}].
// Returns an array of category strings, aligned to the input order.
async function classifyEmails(items) {
  const prompt =
    `Classify each email into exactly ONE category: human, newsletter, notification, transactional, cold, code.\n` +
    `Definitions:\n` +
    `- human: a personal message written by a specific individual to this recipient. NOT automated, bulk, marketing, or from a no-reply/notifications address.\n` +
    `- newsletter: subscriptions, digests, marketing, promotions, event invites, announcements.\n` +
    `- notification: automated service alerts — sign-ins, social activity, app/product updates, reminders, status.\n` +
    `- transactional: receipts, invoices, orders, shipping, account/email/security changes, confirmations, welcome and free-trial emails.\n` +
    `- cold: unsolicited sales or recruiting outreach from someone the recipient doesn't know.\n` +
    `- code: contains a login or verification code.\n` +
    `Almost all automated and company mail is NOT human; reserve "human" for genuine person-to-person messages. ` +
    `Return ONLY a JSON array of category strings, one per email, in the same order and same length. No prose.\n` +
    `Emails:\n${JSON.stringify(items)}`;
  const out = await runClaude(prompt, { timeoutMs: 120000 });
  try {
    const arr = parseJsonLoose(out);
    return Array.isArray(arr) ? arr.map((x) => String(x).toLowerCase()) : [];
  } catch { return []; }
}

// Keeper-finder for the "Find important" sweep. items: [{i, from, subject}].
// folderExamples: { folderName: ["Sender <addr>: subject", …] } — examples of what
// the user already files, used as routing context. Returns verdicts aligned by "i":
// {i, action: keep|junk|uncertain, folder: <one of the folder names or "">, why}.
// Metadata only (sender + subject) — never bodies. Validated to catch keepers that
// no header/regex signal can (e.g. a custody court email from a generic address).
async function findKeepers(items, folderExamples = {}) {
  const names = Object.keys(folderExamples);
  const folderBlock = names.length
    ? names.map((f) => `${f} folder examples:\n${(folderExamples[f] || []).map((s) => "  - " + s).join("\n")}`).join("\n\n")
    : "(They have no folders yet — route every keeper to \"\".)";
  const folderEnum = names.length ? names.map((n) => `"${n}"`).join("|") + `|""` : `""`;
  const prompt =
    `You are helping a NON-TECHNICAL person clean a cluttered inbox WITHOUT losing anything important. ` +
    `They must never lose legal/custody, school/education, medical/health, financial/bills, government, or genuine personal correspondence. ` +
    `Here is what they already file, as examples of what matters to them:\n\n${folderBlock}\n\n` +
    `For EACH email below decide an "action":\n` +
    `- "keep": important — legal/custody, school, medical, bills/financial, government, their real providers/accounts/appointments, or a real person writing to them. When it clearly fits one of their folders, set "folder" to one of ${folderEnum}; otherwise "".\n` +
    `- "junk": promotional, marketing, sales/affiliate ads, cold outreach, or sketchy/scammy senders (gibberish domains or random local-parts, deceptive subjects). Safe to clear.\n` +
    `- "uncertain": genuinely can't tell from the sender and subject alone.\n` +
    `Judge by SENDER LEGITIMACY (a recognizable real org/person vs a gibberish domain or random local-part?) and RELEVANCE to their topics. ` +
    `A transactional-sounding subject ("Order Confirmation", "Delivery") from a gibberish sender is still junk. ` +
    `When an important topic is even plausibly involved, prefer "keep" or "uncertain" over "junk".\n` +
    `Return ONLY a JSON array of {"i":n,"action":"keep|junk|uncertain","folder":"<one of ${folderEnum}>","why":"<=8 words"}, same length and order as the input. No prose, no code fence.\n` +
    `Emails:\n${JSON.stringify(items)}`;
  const out = await runClaude(prompt, { timeoutMs: 120000 });
  try {
    const arr = parseJsonLoose(out);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((v) => v && typeof v.i === "number")
      .map((v) => ({ i: v.i, action: String(v.action || "uncertain").toLowerCase(), folder: String(v.folder || ""), why: String(v.why || "") }));
  } catch { return []; }
}

// "Needs you" extraction. items: [{i, from, subject, body}] (body = stripped text,
// truncated). `today` = "YYYY-MM-DD" for resolving relative dates. Returns, aligned
// by i: {i, summary, action, deadline, dueISO, priority, hasAction}. Reads BODIES —
// caller bounds this to important mail only. Validated: pulls real to-dos + deadlines
// and marks receipts/FYIs hasAction:false (no invented noise).
async function extractActions(items, today) {
  const prompt =
    `Today is ${today}. You help a NON-TECHNICAL person stay on top of important email. ` +
    `For EACH email (sender, subject, body) extract what — if anything — they need to DO and by WHEN. Plain English, concrete.\n` +
    `Return ONLY a JSON array, same order and length, of ` +
    `{"i":n,"summary":"<one line: what this email is>","action":"<what they must do, or 'No action needed'>","deadline":"<human date/time e.g. 'Fri, Jun 6' or ''>","dueISO":"<YYYY-MM-DD if a concrete due date is stated or derivable, else ''>","priority":"high|normal|low","hasAction":true|false}.\n` +
    `- hasAction false for receipts, confirmations, FYIs, newsletters, and anything already completed.\n` +
    `- priority "high": court/custody/legal deadlines, money due, forms/signatures due, appointments, ` +
    `benefits/insurance/coverage renewals, AND anything with a real consequence for inaction (account closure, coverage loss, late fee, default). ` +
    `"normal": a genuine action, lower stakes. "low": no real action.\n` +
    `- Resolve relative dates ("by Friday", "in 10 days") against today for dueISO. NEVER invent a date — leave dueISO "" if none is stated or clearly implied.\n` +
    `No prose, no code fence.\nEmails:\n${JSON.stringify(items)}`;
  const out = await runClaude(prompt, { timeoutMs: 120000 });
  try {
    const arr = parseJsonLoose(out);
    if (!Array.isArray(arr)) return [];
    return arr.filter((v) => v && typeof v.i === "number").map((v) => ({
      i: v.i,
      summary: String(v.summary || ""),
      action: String(v.action || ""),
      deadline: String(v.deadline || ""),
      dueISO: /^\d{4}-\d{2}-\d{2}$/.test(String(v.dueISO || "")) ? v.dueISO : "",
      priority: String(v.priority || "normal").toLowerCase(),
      hasAction: !!v.hasAction,
    }));
  } catch { return []; }
}

// Semantic search. items: [{i, from, subject, snippet, cat, date}].
// Returns the indices (the "i" values) of emails matching the query's intent.
async function searchEmails(query, items) {
  const prompt =
    `You are an email search assistant. A user query and a numbered list of emails follow. ` +
    `Return ONLY a JSON array of the index numbers (the "i" field) of emails whose sender, subject, preview, category, or date match the query's INTENT. ` +
    `Interpret naturally: date ranges (e.g. "Q1" = Jan–Mar; "last month"; "this week"), ` +
    `categories (receipts/invoices/orders ≈ transactional; recruiting/applications/interviews ≈ job-related across ATS senders like Greenhouse, Lever, Ashby, Workday, and company recruiters), ` +
    `topics, and sources (one organization may send from multiple domains/addresses — group them). ` +
    `Return [] if nothing matches. No prose, no code fence.\n` +
    `Query: ${JSON.stringify(query)}\nEmails:\n${JSON.stringify(items)}`;
  const out = await runClaude(prompt, { timeoutMs: 120000 });
  try {
    const arr = parseJsonLoose(out);
    return Array.isArray(arr) ? arr.map(Number).filter((n) => !isNaN(n)) : [];
  } catch { return []; }
}

// "Ask your mailbox" synthesis. Given a question and a small set of retrieved
// emails (with bodies), answer in plain English and cite the emails used by their
// "i". Reads BODIES — the caller bounds this to a retrieved handful. Honest: if the
// answer isn't in the emails it says so (found:false) instead of inventing one.
// Rewrite a follow-up into a self-contained search query using the conversation
// so far, resolving pronouns/relative refs ("it", "what time", "next week"). With
// no history it's a no-op (returns the question). Keeps the retrieval step able to
// find the right mail for a follow-up that isn't self-contained on its own.
async function rewriteQuery(history, question) {
  if (!history || !history.length) return question;
  const convo = history.map((h) => `Q: ${h.q}\nA: ${h.a}`).join("\n");
  const prompt =
    `Rewrite the user's NEW question into a single, self-contained email-search query. ` +
    `Resolve any references ("it", "that one", "what time", "next week", "the second one") using the conversation. ` +
    `If the new question already stands alone, return it unchanged. ` +
    `Output ONLY the rewritten query on one line — no quotes, no prose, no label.\n` +
    `Conversation so far:\n${convo}\n\nNew question: ${question}`;
  try {
    const out = await runClaude(prompt, { timeoutMs: 60000 });
    const line = String(out).trim().split("\n").map((s) => s.trim()).filter(Boolean)[0] || "";
    return line.slice(0, 300) || question;
  } catch { return question; }
}

async function answerQuestion(question, items, today, history = []) {
  const convo = (history && history.length)
    ? `Earlier in this same conversation (for context — resolve "it"/"that"/"what time"/"next week" against this):\n` +
      history.map((h) => `- They asked: ${h.q}\n  You answered: ${h.a}`).join("\n") + `\n\n`
    : "";
  const prompt =
    `Today is ${today}. You help a NON-TECHNICAL person get an answer from their OWN email. ` +
    convo +
    `Using ONLY the emails below, answer their LATEST question in plain, warm, concise English (1–4 sentences; a short list is fine for multiple items). ` +
    `Be concrete — include the actual dates, amounts, names, times, and confirmation numbers found in the emails. ` +
    `Cite every email you draw from by its "i" number in the "cites" array ONLY — do NOT write the numbers in your answer text (no "(email 0)", no "see email 3"); the sources are shown separately. ` +
    `If the answer is NOT in these emails, be honest: set "found" false and say you couldn't find it — NEVER guess or invent details.\n` +
    `Return ONLY JSON: {"found":true|false,"answer":"<plain English>","cites":[<i numbers you used>]}. No prose, no code fence.\n` +
    `Question: ${JSON.stringify(question)}\nEmails:\n${JSON.stringify(items)}`;
  const out = await runClaude(prompt, { timeoutMs: 120000 });
  try {
    const o = parseJsonLoose(out);
    const valid = new Set((items || []).map((it) => it.i));
    const cites = Array.isArray(o.cites) ? o.cites.map(Number).filter((n) => valid.has(n)) : [];
    return { found: o.found !== false, answer: String(o.answer || ""), cites };
  } catch { return { found: false, answer: "", cites: [] }; }
}

module.exports = { matchVendor, matchTheme, clusterVendors, clusterForUnsub, classifyEmails, findKeepers, extractActions, searchEmails, answerQuestion, rewriteQuery, runClaude, resolveClaude, parseJsonLoose };
