const attempts = new Map(); // ip -> { count, lockedUntil }

const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000; // 15 minutes
const WINDOW_MS = 15 * 60 * 1000; // reset counter after 15 min of no attempts

function key(req) {
  return req.ip || req.headers["x-forwarded-for"] || "unknown";
}

function check(req) {
  const k = key(req);
  const rec = attempts.get(k);
  if (!rec) return { locked: false };
  if (rec.lockedUntil && Date.now() < rec.lockedUntil) {
    return { locked: true, retryAfterMs: rec.lockedUntil - Date.now() };
  }
  return { locked: false };
}

function recordFailure(req) {
  const k = key(req);
  const now = Date.now();
  const rec = attempts.get(k) || { count: 0, firstAt: now };
  if (now - rec.firstAt > WINDOW_MS) {
    rec.count = 0;
    rec.firstAt = now;
  }
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) {
    rec.lockedUntil = now + LOCK_MS;
  }
  attempts.set(k, rec);
}

function recordSuccess(req) {
  attempts.delete(key(req));
}

module.exports = { check, recordFailure, recordSuccess };
