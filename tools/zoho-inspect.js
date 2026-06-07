"use strict";

/* Inspect the Zoho Mail API response shapes so we build the backend against
   real field names. Also persists the refresh token + accountId to
   tools/zoho-tokens.json (gitignored) — after this, dev needs no new grant codes.
   Reads creds from tools/zoho-creds.json. US data center. */

const fs = require("fs");
const path = require("path");

const ACCOUNTS_DC = "https://accounts.zoho.com";
const MAIL_DC = "https://mail.zoho.com";
const CREDS = path.join(__dirname, "zoho-creds.json");
const TOKENS = path.join(__dirname, "zoho-tokens.json");

const j = (o) => JSON.stringify(o, null, 2);

async function main() {
  const creds = JSON.parse(fs.readFileSync(CREDS, "utf8"));
  const { clientId, clientSecret, grantCode } = creds;
  if (!grantCode || /PASTE_/.test(grantCode)) {
    console.error("Need a fresh grantCode in tools/zoho-creds.json (the previous one is single-use).");
    process.exit(1);
  }

  // exchange grant → tokens
  const body = new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, client_secret: clientSecret, code: grantCode });
  const tJson = await (await fetch(`${ACCOUNTS_DC}/oauth/v2/token`, { method: "POST", body })).json();
  if (!tJson.access_token) { console.error("Token exchange failed:", j(tJson)); process.exit(1); }
  const access = tJson.access_token;
  const H = { Authorization: `Zoho-oauthtoken ${access}` };
  console.log("✓ tokens obtained\n");

  // accounts
  const accounts = await (await fetch(`${MAIL_DC}/api/accounts`, { headers: H })).json();
  const acct = Array.isArray(accounts.data) ? accounts.data[0] : accounts.data;
  const accountId = acct.accountId || acct.account_id;
  const address = acct.primaryEmailAddress || acct.mailboxAddress || acct.incomingUserName;
  console.log("=== ACCOUNT ===");
  console.log("accountId:", accountId, "| address:", address);
  console.log("account keys:", Object.keys(acct).join(", "), "\n");

  // persist refresh token for future dev (no secrets printed)
  if (tJson.refresh_token) {
    fs.writeFileSync(TOKENS, j({ accountId, address, refreshToken: tJson.refresh_token }), "utf8");
    console.log("✓ saved refresh token → tools/zoho-tokens.json (no more manual grant codes)\n");
  }

  // folders
  const folders = await (await fetch(`${MAIL_DC}/api/accounts/${accountId}/folders`, { headers: H })).json();
  console.log("=== FOLDERS ===");
  (folders.data || []).forEach((f) => console.log(`  ${f.folderId}  ${f.path || f.folderName}  (type=${f.folderType || f.folderName}, unread=${f.unreadCount})`));
  const inbox = (folders.data || []).find((f) => /inbox/i.test(f.path || f.folderName || ""));
  console.log("\ninbox folder keys:", inbox ? Object.keys(inbox).join(", ") : "(none found)", "\n");

  // messages in inbox
  const inboxId = inbox ? inbox.folderId : undefined;
  const listUrl = inboxId
    ? `${MAIL_DC}/api/accounts/${accountId}/messages/view?folderId=${inboxId}&limit=3`
    : `${MAIL_DC}/api/accounts/${accountId}/messages/view?limit=3`;
  const msgs = await (await fetch(listUrl, { headers: H })).json();
  const first = (msgs.data || [])[0];
  console.log("=== FIRST MESSAGE (full object) ===");
  console.log(first ? j(first) : "(no messages)", "\n");

  // content of first message
  if (first) {
    const folderId = first.folderId || inboxId;
    const messageId = first.messageId || first.msgId;
    const cUrl = `${MAIL_DC}/api/accounts/${accountId}/folders/${folderId}/messages/${messageId}/content`;
    const cRes = await fetch(cUrl, { headers: H });
    const cText = await cRes.text();
    let cJson; try { cJson = JSON.parse(cText); } catch { cJson = null; }
    console.log("=== CONTENT ENDPOINT ===", `[${cRes.status}]`);
    if (cJson && cJson.data) {
      console.log("content keys:", Object.keys(cJson.data).join(", "));
      const c = cJson.data.content || "";
      console.log("content length:", c.length, "| first 160:", c.slice(0, 160).replace(/\s+/g, " "));
    } else {
      console.log(cText.slice(0, 400));
    }
  }
}
main().catch((e) => { console.error("Error:", e.message); process.exit(1); });
