const store = require("./store");
const googleLib = require("./google");

function smtpConfigured(smtp) {
  return !!(smtp && smtp.host && smtp.username && smtp.password && smtp.fromEmail);
}

// Returns { ready, provider, reason } — reason is set when not ready, explaining what's missing.
async function checkReady(userId) {
  const s = await store.load(userId);

  if (s.emailProvider === "smtp") {
    if (smtpConfigured(s.smtp)) return { ready: true, provider: "smtp" };
    return {
      ready: false,
      provider: "smtp",
      reason: "Custom SMTP isn't fully set up yet. Go to Settings and fill in host, username, password, and from address."
    };
  }

  const connected = await googleLib.isConnected(userId);
  if (connected) return { ready: true, provider: "gmail" };
  return {
    ready: false,
    provider: "gmail",
    reason: "Gmail is not connected. Go to Settings to connect it, or switch to custom SMTP."
  };
}

module.exports = { checkReady, smtpConfigured };
