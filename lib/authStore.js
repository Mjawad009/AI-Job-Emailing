const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const db = require("./db");

function normalizeEmail(email) {
  return (email || "").trim().toLowerCase();
}

async function createUser(email, password) {
  const normalized = normalizeEmail(email);
  if (!normalized || !normalized.includes("@")) {
    throw new Error("Enter a valid email address.");
  }
  if (!password || password.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }

  const existing = await db.query("SELECT id FROM users WHERE email = $1", [normalized]);
  if (existing.rows.length) {
    throw new Error("An account with that email already exists.");
  }

  const id = crypto.randomUUID();
  const passwordHash = await bcrypt.hash(password, 10);

  await db.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)", [
    id,
    normalized,
    passwordHash
  ]);

  return { id, email: normalized };
}

async function verifyUser(email, password) {
  const normalized = normalizeEmail(email);
  const result = await db.query("SELECT id, email, password_hash FROM users WHERE email = $1", [normalized]);
  if (!result.rows.length) return null;

  const account = result.rows[0];
  const match = await bcrypt.compare(password, account.password_hash);
  if (!match) return null;

  return { id: account.id, email: account.email };
}

async function getUserById(userId) {
  const result = await db.query("SELECT id, email FROM users WHERE id = $1", [userId]);
  if (!result.rows.length) return null;
  return { id: result.rows[0].id, email: result.rows[0].email };
}

module.exports = { createUser, verifyUser, getUserById };
