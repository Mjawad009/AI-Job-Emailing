const { google } = require("googleapis");
const store = require("./store");

// gmail.send lets us send from the user's account. gmail.readonly lets the
// bounce detector scan their inbox for delivery-failure notifications — a
// second, separately-sensitive scope. Both require Google's app verification
// to work for the general public; see README.
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/userinfo.email"
];

function oauthClient() {
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI ||
    `${process.env.PUBLIC_URL || "http://localhost:3000"}/auth/google/callback`;

  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri
  );
}

function isConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

async function isConnected(userId) {
  const s = await store.load(userId);
  return !!s.google.refreshToken;
}

function getAuthUrl(state) {
  const client = oauthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state
  });
}

async function handleCallback(userId, code) {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  const oauth2 = google.oauth2({ auth: client, version: "v2" });
  const { data } = await oauth2.userinfo.get();

  const current = await store.load(userId);
  await store.update(userId, {
    google: { refreshToken: tokens.refresh_token || current.google.refreshToken, email: data.email }
  });

  return data.email;
}

async function disconnect(userId) {
  await store.update(userId, { google: { refreshToken: "", email: "" } });
}

async function getAuthedClient(userId) {
  const s = await store.load(userId);
  if (!s.google.refreshToken) throw new Error("Gmail is not connected yet. Go to Settings and connect it.");
  const client = oauthClient();
  client.setCredentials({ refresh_token: s.google.refreshToken });
  return client;
}

async function getGmailClient(userId) {
  const client = await getAuthedClient(userId);
  return google.gmail({ version: "v1", auth: client });
}

module.exports = {
  isConfigured,
  isConnected,
  getAuthUrl,
  handleCallback,
  disconnect,
  getGmailClient,
  getAuthedClient,
  SCOPES
};
