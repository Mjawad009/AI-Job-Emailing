const db = require("./db");

const DAILY_LIMIT = parseInt(process.env.PLATFORM_KEY_DAILY_LIMIT || "20", 10);

// Only relevant when the user is on the platform's shared key — anyone using
// their own OpenRouter key has no limit applied here.
//
// reserve() atomically claims a slot before the (possibly expensive/failing)
// API call is made, so concurrent requests can't race past the cap. If the
// API call then fails for reasons unrelated to the cap itself (network
// error, bad response, etc.), the caller should call release() to give the
// slot back — a failed generation shouldn't cost the user part of their
// daily allowance.
async function reserve(userId) {
  const result = await db.query(
    `INSERT INTO usage_counters (user_id, day, count)
     VALUES ($1, CURRENT_DATE, 1)
     ON CONFLICT (user_id, day) DO UPDATE SET count = usage_counters.count + 1
     RETURNING count`,
    [userId]
  );
  const count = result.rows[0].count;

  if (count > DAILY_LIMIT) {
    return { allowed: false, remaining: 0, limit: DAILY_LIMIT };
  }
  return { allowed: true, remaining: DAILY_LIMIT - count, limit: DAILY_LIMIT };
}

async function release(userId) {
  await db.query(
    `UPDATE usage_counters SET count = GREATEST(count - 1, 0) WHERE user_id = $1 AND day = CURRENT_DATE`,
    [userId]
  );
}

module.exports = { reserve, release, DAILY_LIMIT };
