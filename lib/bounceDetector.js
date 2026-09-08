const { google } = require("googleapis");
const { getAuthedClient } = require("./google");
const history = require("./history");
const store = require("./store");
const sequences = require("./sequences");
const activityLog = require("./activityLog");

const BOUNCE_QUERY =
  '(from:mailer-daemon OR from:postmaster OR subject:"Delivery Status Notification" OR subject:"Undelivered Mail" OR subject:"Mail delivery failed" OR subject:"delivery has failed" OR subject:"failure notice") newer_than:14d';

const FAILURE_KEYWORDS = [
  "undeliver",
  "delivery has failed",
  "delivery failed",
  "delivery status notification",
  "couldn't be delivered",
  "wasn't delivered",
  "was not delivered",
  "550",
  "no such user",
  "mailbox unavailable",
  "recipient address rejected"
];

function decodeBase64Url(data) {
  if (!data) return "";
  return Buffer.from(data, "base64").toString("utf-8");
}

// Recursively collects all text/plain content from a Gmail message payload
// (bounce notifications are typically multipart/report with a plain-text
// human-readable part plus a machine-readable delivery-status part).
function collectPlainText(payload) {
  if (!payload) return "";
  let text = "";
  if (payload.mimeType && payload.mimeType.startsWith("text/") && payload.body && payload.body.data) {
    text += decodeBase64Url(payload.body.data) + "\n";
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      text += collectPlainText(part);
    }
  }
  return text;
}

function looksLikeFailure(subject, body) {
  const haystack = `${subject}\n${body}`.toLowerCase();
  return FAILURE_KEYWORDS.some(kw => haystack.includes(kw));
}

// Checks one user's inbox for bounce notifications and marks matching
// pending sends as bounced. Best-effort: matches by looking for the
// recipient's email address inside the bounce message body/subject. Bounce
// email formats vary a lot between providers, so this won't catch every
// bounce, and very rarely could mismatch — treat bounce counts as
// directional, not authoritative.
async function checkBouncesForUser(userId) {
  const pending = await history.findPendingForBounceCheck(userId, 14);
  if (!pending.length) return { checked: 0, bounced: 0, skipped: "no pending sends" };

  const s = await store.load(userId);
  if (s.emailProvider === "smtp") {
    return {
      checked: 0,
      bounced: 0,
      skipped: "Bounce detection isn't available on custom SMTP — it requires reading a Gmail inbox. Switch to Gmail sending to enable it."
    };
  }

  let client;
  try {
    client = await getAuthedClient(userId);
  } catch (e) {
    return { checked: 0, bounced: 0, skipped: e.message };
  }

  const gmail = google.gmail({ version: "v1", auth: client });

  let listRes;
  try {
    listRes = await gmail.users.messages.list({ userId: "me", q: BOUNCE_QUERY, maxResults: 50 });
  } catch (e) {
    // Most likely cause: the user connected before gmail.readonly was added
    // to the requested scopes, so their stored token doesn't have it —
    // they'd need to reconnect Gmail for bounce checking to work.
    return { checked: 0, bounced: 0, skipped: `Couldn't read inbox: ${e.message}` };
  }

  const messages = listRes.data.messages || [];
  let bouncedCount = 0;

  for (const msgRef of messages) {
    let full;
    try {
      full = await gmail.users.messages.get({ userId: "me", id: msgRef.id, format: "full" });
    } catch (e) {
      continue;
    }

    const headers = full.data.payload.headers || [];
    const subject = (headers.find(h => h.name.toLowerCase() === "subject") || {}).value || "";
    const body = collectPlainText(full.data.payload);

    if (!looksLikeFailure(subject, body)) continue;

    const haystack = `${subject}\n${body}`.toLowerCase();
    for (const send of pending) {
      if (!send.to) continue;
      if (haystack.includes(send.to.toLowerCase())) {
        const reasonLine =
          body
            .split("\n")
            .find(line => FAILURE_KEYWORDS.some(kw => line.toLowerCase().includes(kw)) && line.trim().length > 5) ||
          subject;
        await history.markBounced(send.id, reasonLine.trim().slice(0, 300));
        await sequences.stopEnrollmentForBounce(send.id).catch(() => {}); // best-effort; don't fail the sweep over this
        bouncedCount += 1;
      }
    }
  }

  return { checked: messages.length, bounced: bouncedCount };
}

async function checkBouncesForUserLogged(userId) {
  const result = await checkBouncesForUser(userId);
  if (result.skipped) {
    // Not worth logging routine "nothing to check" skips, only real blockers.
    if (result.skipped !== "no pending sends") {
      await activityLog.log(userId, "bounce", "warn", `Bounce check skipped: ${result.skipped}`);
    }
  } else if (result.bounced > 0) {
    await activityLog.log(userId, "bounce", "info", `Checked ${result.checked} message(s), found ${result.bounced} new bounce(s).`);
  }
  return result;
}

module.exports = { checkBouncesForUser: checkBouncesForUserLogged };
