import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { promisify } from "node:util";
import { DATA_DIR } from "./store.js";

const scrypt = promisify(crypto.scrypt);
const USERS_FILE = path.join(DATA_DIR, "users.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const COOKIE = "hw_session";
const SESSION_DAYS = 30;
// If set, new accounts need this code, so strangers cannot sign up and use your API credit.
const SIGNUP_CODE = process.env.SIGNUP_CODE || "";

// ---------- Small JSON-file tables, written one at a time ----------

function jsonTable(file, empty) {
  let cache = null;
  let chain = Promise.resolve();
  async function load() {
    if (cache) return cache;
    try {
      cache = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      cache = empty();
    }
    return cache;
  }
  /** Run fn on the data and save it; calls are queued so writes never interleave. */
  function update(fn) {
    const run = chain.then(async () => {
      const data = await load();
      const result = await fn(data);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(data));
      await fs.rename(tmp, file);
      return result;
    });
    chain = run.catch(() => {});
    return run;
  }
  return { load, update };
}

const users = jsonTable(USERS_FILE, () => []);
const sessions = jsonTable(SESSIONS_FILE, () => ({}));

// ---------- Passwords ----------

async function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const key = await scrypt(password.normalize("NFKC"), salt, 64);
  return { salt, hash: key.toString("hex") };
}

async function checkPassword(user, password) {
  const { hash } = await hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(user.hash, "hex"));
}

const normalizeName = (s) => (typeof s === "string" ? s.trim().toLowerCase() : "");

// ---------- Throttle repeated failed logins ----------

const failures = new Map(); // key -> { count, until }
const MAX_FAILURES = 10;
const LOCK_MS = 15 * 60 * 1000;

function isLocked(key) {
  const f = failures.get(key);
  if (!f) return false;
  if (Date.now() > f.until) { failures.delete(key); return false; }
  return f.count >= MAX_FAILURES;
}
function recordFailure(key) {
  const f = failures.get(key);
  if (!f || Date.now() > f.until) failures.set(key, { count: 1, until: Date.now() + LOCK_MS });
  else f.count++;
}

// ---------- Sessions ----------

const tokenId = (token) => crypto.createHash("sha256").update(token).digest("hex");

function readCookie(req, name) {
  for (const part of (req.headers.cookie || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

function cookieOptions(req) {
  const secure = req.secure || process.env.COOKIE_SECURE === "1";
  return `Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

async function startSession(req, res, user) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = Date.now() + SESSION_DAYS * 24 * 3600 * 1000;
  await sessions.update((all) => {
    for (const [id, s] of Object.entries(all)) if (s.expires < Date.now()) delete all[id];
    all[tokenId(token)] = { userId: user.id, expires };
  });
  res.setHeader("Set-Cookie", `${COOKIE}=${token}; ${cookieOptions(req)}; Max-Age=${SESSION_DAYS * 24 * 3600}`);
}

async function currentUser(req) {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  const session = (await sessions.load())[tokenId(token)];
  if (!session || session.expires < Date.now()) return null;
  return (await users.load()).find((u) => u.id === session.userId) || null;
}

/** Middleware: rejects the request with 401 unless someone is logged in; sets req.user. */
export async function requireUser(req, res, next) {
  try {
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ error: "יש להתחבר מחדש." });
    req.user = { id: user.id, username: user.username };
    next();
  } catch (error) {
    next(error);
  }
}

// ---------- Routes ----------

export function authRoutes(app, { onFirstUser } = {}) {
  app.get("/api/auth/me", async (req, res, next) => {
    try {
      const user = await currentUser(req);
      res.json({ user: user ? { username: user.username } : null, signupNeedsCode: Boolean(SIGNUP_CODE) });
    } catch (e) { next(e); }
  });

  app.post("/api/auth/register", async (req, res, next) => {
    try {
      const username = normalizeName(req.body?.username);
      const password = typeof req.body?.password === "string" ? req.body.password : "";
      if (SIGNUP_CODE && req.body?.code !== SIGNUP_CODE) {
        return res.status(403).json({ error: "קוד ההרשמה שגוי." });
      }
      if (username.length < 3 || username.length > 100 || /\s/.test(username)) {
        return res.status(400).json({ error: "שם המשתמש צריך להיות 3–100 תווים, בלי רווחים." });
      }
      if (password.length < 8 || password.length > 200) {
        return res.status(400).json({ error: "הסיסמה צריכה להיות לפחות 8 תווים." });
      }
      const { salt, hash } = await hashPassword(password);
      const user = { id: crypto.randomUUID(), username, salt, hash, createdAt: new Date().toISOString() };
      const result = await users.update((all) => {
        if (all.some((u) => u.username === username)) return "taken";
        all.push(user);
        return all.length === 1 ? "first" : "ok";
      });
      if (result === "taken") return res.status(409).json({ error: "שם המשתמש הזה כבר תפוס." });
      if (result === "first" && onFirstUser) await onFirstUser(user.id);
      await startSession(req, res, user);
      res.status(201).json({ user: { username } });
    } catch (e) { next(e); }
  });

  app.post("/api/auth/login", async (req, res, next) => {
    try {
      const username = normalizeName(req.body?.username);
      const password = typeof req.body?.password === "string" ? req.body.password : "";
      const keys = [`ip:${req.ip}`, `user:${username}`];
      if (keys.some(isLocked)) {
        return res.status(429).json({ error: "יותר מדי ניסיונות כושלים. נסו שוב בעוד רבע שעה." });
      }
      const user = (await users.load()).find((u) => u.username === username);
      if (!user || !(await checkPassword(user, password))) {
        keys.forEach(recordFailure);
        return res.status(401).json({ error: "שם המשתמש או הסיסמה שגויים." });
      }
      keys.forEach((k) => failures.delete(k));
      await startSession(req, res, user);
      res.json({ user: { username: user.username } });
    } catch (e) { next(e); }
  });

  app.post("/api/auth/logout", async (req, res, next) => {
    try {
      const token = readCookie(req, COOKIE);
      if (token) await sessions.update((all) => { delete all[tokenId(token)]; });
      res.setHeader("Set-Cookie", `${COOKIE}=; ${cookieOptions(req)}; Max-Age=0`);
      res.status(204).end();
    } catch (e) { next(e); }
  });
}
