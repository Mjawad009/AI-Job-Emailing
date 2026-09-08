const crypto = require("crypto");
const db = require("./db");

function toEntry(row) {
  return {
    id: row.id,
    trackingId: row.tracking_id,
    date: row.sent_at.toISOString(),
    to: row.to_email,
    company: row.company,
    contactName: row.contact_name,
    subject: row.subject,
    batchLabel: row.batch_label,
    status: row.status,
    error: row.error,
    openedAt: row.opened_at ? row.opened_at.toISOString() : null,
    openCount: row.open_count,
    bouncedAt: row.bounced_at ? row.bounced_at.toISOString() : null,
    bounceReason: row.bounce_reason,
    repliedAt: row.replied_at ? row.replied_at.toISOString() : null,
    clickCount: row.click_count !== undefined ? parseInt(row.click_count, 10) : 0
  };
}

async function add(userId, entry) {
  const id = crypto.randomUUID();
  const trackingId = entry.trackingId || crypto.randomUUID();
  const result = await db.query(
    `INSERT INTO sends (id, tracking_id, user_id, to_email, company, contact_name, subject, batch_label, status, error, gmail_message_id, gmail_thread_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      id,
      trackingId,
      userId,
      entry.to || "",
      entry.company || "",
      entry.contactName || "",
      entry.subject || "",
      entry.batchLabel || "",
      entry.status || "sent",
      entry.error || null,
      entry.gmailMessageId || null,
      entry.gmailThreadId || null
    ]
  );
  return toEntry({ ...result.rows[0], click_count: 0 });
}

async function list(userId, { limit, search, status, batch } = {}) {
  let sql = `
    SELECT s.*, COUNT(c.id) AS click_count
    FROM sends s
    LEFT JOIN clicks c ON c.send_id = s.id
    WHERE s.user_id = $1
  `;
  const params = [userId];

  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    sql += ` AND (LOWER(s.to_email) LIKE $${params.length} OR LOWER(s.company) LIKE $${params.length} OR LOWER(s.contact_name) LIKE $${params.length})`;
  }
  if (status) {
    params.push(status);
    sql += ` AND s.status = $${params.length}`;
  }
  if (batch !== undefined) {
    // "__none__" is the sentinel for "sends with no batch label at all"
    params.push(batch === "__none__" ? "" : batch);
    sql += ` AND s.batch_label = $${params.length}`;
  }

  sql += " GROUP BY s.id ORDER BY s.sent_at DESC";

  if (limit) {
    params.push(limit);
    sql += ` LIMIT $${params.length}`;
  }

  const result = await db.query(sql, params);
  return result.rows.map(toEntry);
}

// Per-batch performance breakdown, for comparing campaigns against each other.
async function listBatches(userId) {
  const result = await db.query(
    `SELECT
       s.batch_label,
       COUNT(DISTINCT s.id) FILTER (WHERE s.status IN ('sent','bounced')) AS total_sent,
       COUNT(DISTINCT s.id) FILTER (WHERE s.opened_at IS NOT NULL) AS total_opened,
       COUNT(DISTINCT s.id) FILTER (WHERE s.status = 'bounced') AS total_bounced,
       COUNT(DISTINCT s.id) FILTER (WHERE s.status = 'failed') AS total_failed,
       COUNT(DISTINCT c.send_id) AS total_clicked,
       MAX(s.sent_at) AS last_sent
     FROM sends s
     LEFT JOIN clicks c ON c.send_id = s.id
     WHERE s.user_id = $1 AND s.batch_label != ''
     GROUP BY s.batch_label
     ORDER BY last_sent DESC`,
    [userId]
  );

  return result.rows.map(r => {
    const totalSent = parseInt(r.total_sent, 10);
    const totalOpened = parseInt(r.total_opened, 10);
    const totalClicked = parseInt(r.total_clicked, 10);
    const totalBounced = parseInt(r.total_bounced, 10);
    return {
      batchLabel: r.batch_label,
      totalSent,
      totalOpened,
      totalClicked,
      totalBounced,
      totalFailed: parseInt(r.total_failed, 10),
      openRate: totalSent ? Math.round((totalOpened / totalSent) * 100) : 0,
      clickRate: totalSent ? Math.round((totalClicked / totalSent) * 100) : 0,
      bounceRate: totalSent ? Math.round((totalBounced / totalSent) * 100) : 0,
      lastSent: r.last_sent ? r.last_sent.toISOString() : null
    };
  });
}

async function findByEmail(userId, email) {
  if (!email) return [];
  const result = await db.query(
    `SELECT *, 0 AS click_count FROM sends WHERE user_id = $1 AND LOWER(to_email) = LOWER($2) AND status != 'failed' ORDER BY sent_at DESC`,
    [userId, email.trim()]
  );
  return result.rows.map(toEntry);
}

async function stats(userId) {
  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  startOfWeek.setHours(0, 0, 0, 0);

  const [totals, week, companies] = await Promise.all([
    db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('sent','bounced','replied')) AS total_sent,
         COUNT(*) FILTER (WHERE status = 'failed') AS total_failed,
         COUNT(*) FILTER (WHERE status = 'bounced') AS total_bounced,
         COUNT(*) FILTER (WHERE replied_at IS NOT NULL) AS total_replied,
         COUNT(*) FILTER (WHERE opened_at IS NOT NULL) AS total_opened
       FROM sends WHERE user_id = $1`,
      [userId]
    ),
    db.query(
      `SELECT COUNT(*) AS n FROM sends WHERE user_id = $1 AND status IN ('sent','bounced','replied') AND sent_at >= $2`,
      [userId, startOfWeek]
    ),
    db.query(
      `SELECT COALESCE(NULLIF(company, ''), '(unspecified)') AS company, COUNT(*) AS n
       FROM sends WHERE user_id = $1 AND status IN ('sent','bounced','replied')
       GROUP BY 1 ORDER BY n DESC LIMIT 8`,
      [userId]
    )
  ]);

  const clicksResult = await db.query(
    `SELECT COUNT(DISTINCT c.send_id) AS n
     FROM clicks c JOIN sends s ON s.id = c.send_id
     WHERE s.user_id = $1`,
    [userId]
  );

  const t = totals.rows[0];
  const totalSent = parseInt(t.total_sent, 10);
  const totalOpened = parseInt(t.total_opened, 10);
  const totalClicked = parseInt(clicksResult.rows[0].n, 10);
  const totalBounced = parseInt(t.total_bounced, 10);
  const totalReplied = parseInt(t.total_replied, 10);

  return {
    totalSent,
    totalFailed: parseInt(t.total_failed, 10),
    totalBounced,
    totalReplied,
    totalOpened,
    totalClicked,
    openRate: totalSent ? Math.round((totalOpened / totalSent) * 100) : 0,
    clickRate: totalSent ? Math.round((totalClicked / totalSent) * 100) : 0,
    bounceRate: totalSent ? Math.round((totalBounced / totalSent) * 100) : 0,
    replyRate: totalSent ? Math.round((totalReplied / totalSent) * 100) : 0,
    thisWeek: parseInt(week.rows[0].n, 10),
    topCompanies: companies.rows.map(r => ({ company: r.company, count: parseInt(r.n, 10) }))
  };
}

async function update(userId, id, patch) {
  const fields = [];
  const params = [];

  const keyMap = { company: "company", contactName: "contact_name", status: "status" };
  for (const [jsKey, col] of Object.entries(keyMap)) {
    if (patch[jsKey] !== undefined) {
      params.push(patch[jsKey]);
      fields.push(`${col} = $${params.length}`);
    }
  }
  if (patch.to !== undefined) {
    params.push(patch.to);
    fields.push(`to_email = $${params.length}`);
  }
  if (!fields.length) return null;

  params.push(id, userId);
  const result = await db.query(
    `UPDATE sends SET ${fields.join(", ")} WHERE id = $${params.length - 1} AND user_id = $${params.length} RETURNING *, 0 AS click_count`,
    params
  );
  if (!result.rows.length) return null;
  return toEntry(result.rows[0]);
}

async function remove(userId, id) {
  const result = await db.query("DELETE FROM sends WHERE id = $1 AND user_id = $2", [id, userId]);
  return result.rowCount > 0;
}

function escapeCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function toCsv(userId) {
  const entries = await list(userId);
  const header = ["date", "company", "contactName", "to", "subject", "status", "openedAt", "openCount", "clickCount", "bounceReason"];
  const rows = entries.map(e => header.map(h => escapeCell(e[h])).join(","));
  return [header.join(","), ...rows].join("\n");
}

// ---------- tracking ----------
async function recordOpen(trackingId) {
  await db.query(
    `UPDATE sends SET opened_at = COALESCE(opened_at, now()), open_count = open_count + 1 WHERE tracking_id = $1`,
    [trackingId]
  );
}

async function recordClick(trackingId, url) {
  const result = await db.query("SELECT id FROM sends WHERE tracking_id = $1", [trackingId]);
  if (!result.rows.length) return null;
  const sendId = result.rows[0].id;
  await db.query("INSERT INTO clicks (id, send_id, url) VALUES ($1, $2, $3)", [crypto.randomUUID(), sendId, url]);
  // A click implies an open, in case the image pixel itself was blocked.
  await db.query(
    `UPDATE sends SET opened_at = COALESCE(opened_at, now()), open_count = open_count + 1 WHERE id = $1`,
    [sendId]
  );
  return sendId;
}

// ---------- bounce detection support ----------
async function findPendingForBounceCheck(userId, sinceDays = 14) {
  const result = await db.query(
    `SELECT id, to_email, sent_at FROM sends
     WHERE user_id = $1 AND status = 'sent' AND sent_at >= now() - ($2 || ' days')::interval`,
    [userId, sinceDays]
  );
  return result.rows.map(r => ({ id: r.id, to: r.to_email, sentAt: r.sent_at }));
}

async function markBounced(sendId, reason) {
  await db.query(
    `UPDATE sends SET status = 'bounced', bounced_at = now(), bounce_reason = $2 WHERE id = $1`,
    [sendId, reason || null]
  );
}

// ---------- reply detection support ----------
async function findRepliable(userId, sinceDays = 30) {
  const result = await db.query(
    `SELECT id, to_email, gmail_thread_id FROM sends
     WHERE user_id = $1 AND status = 'sent' AND gmail_thread_id IS NOT NULL
       AND sent_at >= now() - ($2 || ' days')::interval`,
    [userId, sinceDays]
  );
  return result.rows.map(r => ({ id: r.id, to: r.to_email, gmailThreadId: r.gmail_thread_id }));
}

async function markReplied(sendId) {
  const result = await db.query(
    `UPDATE sends SET status = 'replied', replied_at = now() WHERE id = $1 RETURNING id`,
    [sendId]
  );
  return result.rowCount > 0;
}

module.exports = {
  listBatches,
  add,
  list,
  findByEmail,
  stats,
  update,
  remove,
  toCsv,
  recordOpen,
  recordClick,
  findPendingForBounceCheck,
  markBounced,
  findRepliable,
  markReplied
};
