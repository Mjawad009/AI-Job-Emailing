const crypto = require("crypto");
const db = require("./db");

async function log(userId, category, level, message) {
  try {
    await db.query(
      "INSERT INTO activity_logs (id, user_id, category, level, message) VALUES ($1, $2, $3, $4, $5)",
      [crypto.randomUUID(), userId, category, level, String(message).slice(0, 2000)]
    );
  } catch (e) {
    // Logging must never break the caller's actual work.
    console.error("Failed to write activity log:", e.message);
  }
}

async function list(userId, { category, limit = 200 } = {}) {
  let sql = "SELECT id, category, level, message, created_at FROM activity_logs WHERE user_id = $1";
  const params = [userId];
  if (category) {
    params.push(category);
    sql += ` AND category = $${params.length}`;
  }
  params.push(limit);
  sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;

  const result = await db.query(sql, params);
  return result.rows.map(r => ({
    id: r.id,
    category: r.category,
    level: r.level,
    message: r.message,
    createdAt: r.created_at.toISOString()
  }));
}

module.exports = { log, list };
