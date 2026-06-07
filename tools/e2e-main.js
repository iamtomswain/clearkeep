// Regression check: provider-aware account model + dispatcher still serve the
// existing (migrated) Zoho account. Runs in Electron for safeStorage.
const { app } = require("electron");
const path = require("path");
app.setName("ClearKeep");
const accounts = require(path.join(__dirname, "..", "lib", "accounts"));
const zoho = require(path.join(__dirname, "..", "lib", "zoho"));
const gmail = require(path.join(__dirname, "..", "lib", "gmail"));
const BACKENDS = { zoho, gmail };

app.whenReady().then(async () => {
  try {
    const list = accounts.list();
    console.log("accounts:", list.map((a) => `${a.address} (${a.provider})`).join(", ") || "(none)");
    if (!list.length) { console.error("No accounts."); return app.quit(); }
    const a = list[0];
    const oauth = accounts.getProviderOAuth(a.provider);
    const msgs = await BACKENDS[a.provider].listInbox(oauth, accounts.withSecret(a.id), 5);
    console.log(`INBOX OK via ${a.provider} — ${msgs.length} messages. First:`);
    msgs.slice(0, 3).forEach((m) => console.log(`  [${m.unread ? "•" : " "}] ${m.fromEmail} — ${m.subject.slice(0, 40)}`));
  } catch (e) {
    console.error("E2E FAIL:", e.message);
  } finally {
    app.quit();
  }
});
