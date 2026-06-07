"use strict";

/* One-shot probe: does the Zoho Mail REST API return messages on this plan?
   Reads creds from tools/zoho-creds.json (local, gitignored — never the chat).
   Prints results only — never the secret or the tokens. US data center. */

const fs = require("fs");
const path = require("path");

const ACCOUNTS_DC = "https://accounts.zoho.com";
const MAIL_DC = "https://mail.zoho.com";
const CREDS = path.join(__dirname, "zoho-creds.json");

async function main() {
  let creds;
  try { creds = JSON.parse(fs.readFileSync(CREDS, "utf8")); }
  catch { fail("Could not read tools/zoho-creds.json — fill it in first."); }

  const { clientId, clientSecret, grantCode } = creds;
  if (!clientId || !clientSecret || !grantCode || /PASTE_/.test(`${clientSecret}${grantCode}`)) {
    fail("Fill clientSecret and a fresh grantCode in tools/zoho-creds.json, then re-run.");
  }

  // 1) Grant code → tokens
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    code: grantCode,
  });
  const tRes = await fetch(`${ACCOUNTS_DC}/oauth/v2/token`, { method: "POST", body });
  const tJson = await tRes.json().catch(() => ({}));
  if (!tJson.access_token) {
    console.error("✗ Token exchange failed:", JSON.stringify(tJson));
    console.error("  Grant codes expire in minutes and are single-use — generate a fresh one and re-run.");
    process.exit(1);
  }
  console.log("✓ Step 1 — token exchange OK (refresh_token:", !!tJson.refresh_token, ")");
  const H = { Authorization: `Zoho-oauthtoken ${tJson.access_token}` };

  // 2) Account discovery
  const aRes = await fetch(`${MAIL_DC}/api/accounts`, { headers: H });
  const aText = await aRes.text();
  let aJson; try { aJson = JSON.parse(aText); } catch { aJson = null; }
  if (aRes.status !== 200 || !aJson || !aJson.data) {
    console.error(`✗ Step 2 — /api/accounts failed [${aRes.status}]:`, aText.slice(0, 400));
    process.exit(1);
  }
  const acct = Array.isArray(aJson.data) ? aJson.data[0] : aJson.data;
  const accountId = acct.accountId || acct.account_id;
  const addr = acct.primaryEmailAddress || acct.mailboxAddress || acct.incomingUserName || "(unknown)";
  console.log(`✓ Step 2 — accounts API OK → ${addr}  (accountId ${accountId})`);

  // 3) THE decisive test — list inbox messages
  const mRes = await fetch(`${MAIL_DC}/api/accounts/${accountId}/messages/view?limit=5`, { headers: H });
  const mText = await mRes.text();
  let mJson; try { mJson = JSON.parse(mText); } catch { mJson = null; }
  if (mRes.status === 200 && mJson && Array.isArray(mJson.data)) {
    console.log(`\n🎉 Step 3 — MESSAGES API WORKS ON THIS PLAN — ${mJson.data.length} message(s):`);
    mJson.data.slice(0, 5).forEach((m, i) => {
      console.log(`   ${i + 1}. ${m.fromAddress || "?"}  —  ${(m.subject || "(no subject)").slice(0, 60)}`);
    });
    console.log("\n→ CONFIRMED: we can rebuild ClearKeep's backend on the free-plan Zoho API.");
  } else {
    console.error(`\n✗ Step 3 — messages API blocked [${mRes.status}]:`, mText.slice(0, 500));
    console.error("→ Looks gated on the free plan after all. We'll pivot.");
    process.exit(2);
  }
}

function fail(msg) { console.error(msg); process.exit(1); }
main().catch((e) => { console.error("Error:", e.message); process.exit(1); });
