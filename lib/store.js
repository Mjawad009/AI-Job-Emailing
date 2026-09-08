const db = require("./db");

const DEFAULT_FORMAT = `Write a concise, professional cold outreach email pitching our services to a potential
customer.

Structure to follow:
1. A short, personalized opening line that references something specific about the
   prospect's company (from the notes/context given) — not a generic "I hope this finds
   you well."
2. 2-3 sentences: what we do and why it's specifically relevant to them — connect a real
   detail about our services to something about their situation. Be concrete, not generic.
   Avoid filler like "we'd love to help you grow."
3. A single, low-friction call to action (e.g. "Worth a quick 15-minute call this week?").
4. A short closing line.

Use exactly {{company}} for the prospect's company name and {{contactName}} for their name
if given — do not paraphrase or rename them.

End the email with this exact signature block, unchanged and on its own lines:
{{name}}
{{companyName}}
{{phone}}
{{links}}

Keep the whole email under 150 words. Plain text only, no markdown, no bullet points, no
hard selling or hype language.`;

const DEFAULTS = {
  name: "", // sender's own name
  companyName: "", // sender's company name
  phone: "",
  links: [], // [{ id, label, url }] — website, pricing page, case study, calendar link, etc.
  openrouterApiKey: "", // per-user override; empty = use the platform's shared key
  openrouterModel: "", // per-user override; empty = use the platform's default model
  emailFormat: DEFAULT_FORMAT,
  subjectTemplate: "Quick question about {{company}}",
  extraInfo: "", // what the company sells / who it's for / pricing notes / proof points, etc.
  defaultCollateralId: "",
  ccSelf: false,
  trackOpens: true,
  trackClicks: true,
  emailProvider: "gmail", // "gmail" | "smtp" — which one actually sends
  google: { refreshToken: "", email: "" },
  smtp: {
    host: "",
    port: 587,
    secure: false, // true = implicit TLS (port 465); false = STARTTLS (port 587) or plain
    username: "",
    password: "",
    fromEmail: "",
    fromName: ""
  }
};

async function loadRaw(userId) {
  const result = await db.query("SELECT data FROM user_settings WHERE user_id = $1", [userId]);
  if (!result.rows.length) {
    await db.query(
      "INSERT INTO user_settings (user_id, data) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING",
      [userId, JSON.stringify(DEFAULTS)]
    );
    return { ...DEFAULTS };
  }
  return { ...DEFAULTS, ...result.rows[0].data };
}

async function listCollateral(userId) {
  const result = await db.query(
    "SELECT id, label, file_name, text FROM collateral_files WHERE user_id = $1 ORDER BY created_at ASC",
    [userId]
  );
  return result.rows.map(r => ({ id: r.id, label: r.label, fileName: r.file_name, text: r.text }));
}

// Full settings object — collateralFiles is attached live from its own table
// so callers don't need to know it's stored separately.
async function load(userId) {
  const [settings, collateralFiles] = await Promise.all([loadRaw(userId), listCollateral(userId)]);
  return { ...settings, collateralFiles };
}

async function save(userId, settings) {
  const { collateralFiles, ...rest } = settings; // derived, never persisted here
  await db.query(
    `INSERT INTO user_settings (user_id, data, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE SET data = $2, updated_at = now()`,
    [userId, JSON.stringify(rest)]
  );
}

async function update(userId, patch) {
  const current = await load(userId);
  const merged = {
    ...current,
    ...patch,
    google: { ...current.google, ...(patch.google || {}) },
    smtp: { ...current.smtp, ...(patch.smtp || {}) }
  };
  await save(userId, merged);
  return merged;
}

// Lightweight collateral entry (id, label, fileName, text) — no file bytes.
// Pass a specific id to get that one; omit it to get the user's default.
async function getCollateral(userId, collateralId) {
  const s = await load(userId);
  if (!s.collateralFiles.length) return null;
  const targetId = collateralId || s.defaultCollateralId || s.collateralFiles[0].id;
  return s.collateralFiles.find(c => c.id === targetId) || null;
}

// Full collateral doc including file bytes — used only when actually
// attaching to an outgoing email.
async function getCollateralFile(userId, collateralId) {
  const s = await load(userId);
  if (!s.collateralFiles.length) return null;
  const targetId = collateralId || s.defaultCollateralId || s.collateralFiles[0].id;
  const result = await db.query(
    "SELECT file_name, mime_type, content FROM collateral_files WHERE id = $1 AND user_id = $2",
    [targetId, userId]
  );
  if (!result.rows.length) return null;
  const row = result.rows[0];
  return { fileName: row.file_name, mimeType: row.mime_type, content: row.content };
}

async function addCollateral(userId, { id, label, fileName, mimeType, content, text }) {
  await db.query(
    `INSERT INTO collateral_files (id, user_id, label, file_name, mime_type, content, text)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, userId, label, fileName, mimeType, content, text || ""]
  );
  const s = await loadRaw(userId);
  if (!s.defaultCollateralId) {
    return update(userId, { defaultCollateralId: id });
  }
  return load(userId);
}

async function removeCollateral(userId, id) {
  await db.query("DELETE FROM collateral_files WHERE id = $1 AND user_id = $2", [id, userId]);
  const s = await loadRaw(userId);
  if (s.defaultCollateralId === id) {
    const remaining = await listCollateral(userId);
    return update(userId, { defaultCollateralId: remaining.length ? remaining[0].id : "" });
  }
  return load(userId);
}

async function setDefaultCollateral(userId, id) {
  return update(userId, { defaultCollateralId: id });
}

module.exports = {
  load,
  save,
  update,
  getCollateral,
  getCollateralFile,
  addCollateral,
  removeCollateral,
  setDefaultCollateral,
  DEFAULT_FORMAT
};
