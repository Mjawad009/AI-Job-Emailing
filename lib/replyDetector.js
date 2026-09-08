const { google } = require("googleapis");
const { getAuthedClient } = require("./google");
const history = require("./history");
const store = require("./store");
const sequences = require("./sequences");
const activityLog = require("./activityLog");

// Unlike bounce detection (which has to guess from inbox keyword matching),
// this is structurally reliable: every Gmail send has a threadId, and if any
// message in that thread wasn't sent by us, that's a reply. Only works for
// the Gmail sending method — SMTP has no equivalent concept exposed to us.
async function checkRepliesForUser(userId) {
  const pending = await history.findRepliable(userId, 30);
  if (!pending.length) return { checked: 0, replied: 0, skipped: "no pending sends" };

  const s = await store.load(userId);
  if (s.emailProvider === "smtp") {
    return {
      checked: 0,
      replied: 0,
      skipped: "Reply detection isn't available on custom SMTP — it requires Gmail threads. Switch to Gmail sending to enable it."
    };
  }

  let client;
  try {
    client = await getAuthedClient(userId);
  } catch (e) {
    return { checked: 0, replied: 0, skipped: e.message };
  }

  const gmail = google.gmail({ version: "v1", auth: client });
  const myEmail = (s.google.email || "").toLowerCase();
  let repliedCount = 0;
  let checked = 0;

  for (const send of pending) {
    checked += 1;
    let thread;
    try {
      thread = await gmail.users.threads.get({
        userId: "me",
        id: send.gmailThreadId,
        format: "metadata",
        metadataHeaders: ["From"]
      });
    } catch (e) {
      continue;
    }

    const messages = thread.data.messages || [];
    const hasReply = messages.some(m => {
      const headers = (m.payload && m.payload.headers) || [];
      const fromHeader = headers.find(h => h.name.toLowerCase() === "from");
      const from = fromHeader ? fromHeader.value.toLowerCase() : "";
      return from && !from.includes(myEmail);
    });

    if (hasReply) {
      await history.markReplied(send.id);
      await sequences.stopEnrollmentForReply(send.id).catch(() => {});
      repliedCount += 1;
    }
  }

  return { checked, replied: repliedCount };
}

async function checkRepliesForUserLogged(userId) {
  const result = await checkRepliesForUser(userId);
  if (result.skipped) {
    if (result.skipped !== "no pending sends") {
      await activityLog.log(userId, "reply", "warn", `Reply check skipped: ${result.skipped}`);
    }
  } else if (result.replied > 0) {
    await activityLog.log(userId, "reply", "info", `Checked ${result.checked} thread(s), found ${result.replied} new repl${result.replied === 1 ? "y" : "ies"}.`);
  }
  return result;
}

module.exports = { checkRepliesForUser: checkRepliesForUserLogged };
