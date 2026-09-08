const nodemailer = require("nodemailer");
const store = require("./store");
const { getGmailClient } = require("./google");

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function buildRawGmailMessage({ from, to, cc, subject, textBody, htmlBody, attachment }) {
  const mixedBoundary = "om_mixed_" + Date.now();
  const altBoundary = "om_alt_" + Date.now();
  const lines = [];

  lines.push(`From: ${from}`);
  lines.push(`To: ${to}`);
  if (cc) lines.push(`Cc: ${cc}`);
  lines.push(`Subject: ${subject}`);
  lines.push("MIME-Version: 1.0");

  const useMixed = !!attachment;
  if (useMixed) {
    lines.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);
    lines.push("");
    lines.push(`--${mixedBoundary}`);
  }

  lines.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
  lines.push("");

  lines.push(`--${altBoundary}`);
  lines.push("Content-Type: text/plain; charset=UTF-8");
  lines.push("Content-Transfer-Encoding: 7bit");
  lines.push("");
  lines.push(...textBody.split("\n"));
  lines.push("");

  lines.push(`--${altBoundary}`);
  lines.push("Content-Type: text/html; charset=UTF-8");
  lines.push("Content-Transfer-Encoding: 7bit");
  lines.push("");
  lines.push(...htmlBody.split("\n"));
  lines.push("");

  lines.push(`--${altBoundary}--`);

  if (useMixed) {
    lines.push("");
    const fileData = attachment.content.toString("base64");
    lines.push(`--${mixedBoundary}`);
    lines.push(`Content-Type: ${attachment.mimeType}; name="${attachment.fileName}"`);
    lines.push("Content-Transfer-Encoding: base64");
    lines.push(`Content-Disposition: attachment; filename="${attachment.fileName}"`);
    lines.push("");
    lines.push(fileData.match(/.{1,76}/g).join("\n"));
    lines.push("");
    lines.push(`--${mixedBoundary}--`);
  }

  return base64url(lines.join("\r\n"));
}

async function sendViaGmail(userId, { to, subject, textBody, htmlBody, attachment, s }) {
  const gmail = await getGmailClient(userId);
  const from = s.google.email;
  const cc = s.ccSelf ? s.google.email : null;

  const raw = buildRawGmailMessage({ from, to, cc, subject, textBody, htmlBody, attachment });
  const res = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
  // threadId lets the reply detector reliably check "did anyone else post to
  // this thread" via the Gmail API, instead of guessing from inbox contents.
  return { id: res.data.id, threadId: res.data.threadId || null };
}

function buildSmtpTransport(smtp) {
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port || 587,
    secure: !!smtp.secure, // true for 465 (implicit TLS), false for 587/25 (STARTTLS negotiated automatically)
    auth: { user: smtp.username, pass: smtp.password }
  });
}

async function sendViaSmtp(userId, { to, subject, textBody, htmlBody, attachment, s }) {
  const transport = buildSmtpTransport(s.smtp);
  const fromHeader = s.smtp.fromName ? `"${s.smtp.fromName}" <${s.smtp.fromEmail}>` : s.smtp.fromEmail;

  const mailOptions = {
    from: fromHeader,
    to,
    subject,
    text: textBody,
    html: htmlBody
  };
  if (s.ccSelf) mailOptions.cc = s.smtp.fromEmail;
  if (attachment) {
    mailOptions.attachments = [
      { filename: attachment.fileName, content: attachment.content, contentType: attachment.mimeType }
    ];
  }

  const info = await transport.sendMail(mailOptions);
  return { id: info.messageId, threadId: null }; // SMTP has no equivalent of Gmail threads
}

// Verifies SMTP credentials actually work, without sending anything — used
// by the "Test connection" button in Settings.
async function verifySmtp(smtp) {
  const transport = buildSmtpTransport(smtp);
  await transport.verify();
}

async function sendOutreachEmail(userId, { to, subject, textBody, htmlBody, attachCollateral, collateralId }) {
  const s = await store.load(userId);
  const attachment = attachCollateral ? await store.getCollateralFile(userId, collateralId) : null;
  const args = { to, subject, textBody, htmlBody, attachment, s };

  if (s.emailProvider === "smtp") {
    return sendViaSmtp(userId, args);
  }
  return sendViaGmail(userId, args);
}

module.exports = { sendOutreachEmail, verifySmtp };
