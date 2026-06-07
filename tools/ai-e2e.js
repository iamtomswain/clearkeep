// Confirms the claude CLI runs when spawned from the Electron main process
// (env/PATH parity with the real app). Then quits.
const { app } = require("electron");
const path = require("path");
app.setName("ClearKeep");
const ai = require(path.join(__dirname, "..", "lib", "ai"));

app.whenReady().then(async () => {
  try {
    console.log("claude resolved to:", ai.resolveClaude());
    const r = await ai.matchVendor("Venmo", [
      "venmo@venmo.com (Venmo)",
      "no-reply@email.venmo.com (Venmo)",
      "support@turbotenant.com (TurboTenant)",
    ]);
    console.log("matchVendor(Venmo) →", JSON.stringify(r));
  } catch (e) {
    console.error("AI-E2E FAIL:", e.message);
  } finally {
    app.quit();
  }
});
