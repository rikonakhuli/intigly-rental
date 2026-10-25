"use strict";
// Rental Map: one Node service (no npm deps). Serves the static frontend, the JSON API,
// media files, and the admin dashboard. Deployed on Render as a single web service.
//
// Routes (JSON unless noted):
//   GET  /api/listings?city=            live listings for a city (no contact details)
//   GET  /api/listings/:id              one live listing
//   POST /api/auth/signup               {email,password,name,phone,role:'renter'|'owner'}
//   POST /api/auth/login                {email,password}
//   POST /api/auth/logout
//   GET  /api/me                        current user + credit balance
//   POST /api/listings                  owner: create a draft listing
//   GET  /api/my/listings               owner: own listings with status
//   POST /api/listings/:id/media?kind=photo|video   owner: raw file body (Content-Type = file type)
//   POST /api/listings/:id/submit       owner: validate, move to awaiting_payment
//   POST /api/listings/:id/pay/order    owner: PayU form params for the listing fee (browser POSTs them to PayU)
//   POST /api/payu/callback             PayU result (surl/furl): verify reverse hash, then move to pending_approval
//   GET  /api/payu/status?txnid=        owner/renter: state of one PayU payment
//   POST /api/listings/:id/reveal       renter: reveal owner phone, costs 1 credit (first time only)
//   POST /api/credits/order             renter: {quantity} PayU form params, Rs 10 per credit
//   GET  /api/admin/listings            admin: pending_approval + counts
//   POST /api/admin/listings/:id/approve|reject   admin
//   GET  /media/<key>                   stored photo/video
//   GET  /admin                         admin dashboard (admin.html)
//
// Env: PORT, DATA_DIR (db.json + uploads, default ./data), UPLOAD_DIR, PAYU_MERCHANT_KEY,
// PAYU_MERCHANT_SALT (server only, never sent to the browser), PAYU_BASE_URL (default test.payu.in;
// live is secure.payu.in), PUBLIC_BASE_URL (public https origin PayU posts back to), ADMIN_EMAIL +
// ADMIN_PASSWORD (creates the admin account on boot if missing), NODE_ENV=production (Secure cookie).

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { createDb } = require("./src/db");
const { createStorage } = require("./src/storage");

const PORT = Number(process.env.PORT) || 3000;
const PAYU_KEY = process.env.PAYU_MERCHANT_KEY || "";
const PAYU_SALT = process.env.PAYU_MERCHANT_SALT || "";
const PAYU_ACTION = process.env.PAYU_BASE_URL || "https://test.payu.in/_payment";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
const APP_DIR = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(APP_DIR, "data");

// All money in paise (1 rupee = 100 paise). The server decides every amount.
const FEE_PAISE = { standard: 100000, premium: 150000 }; // Rs 1000 (1 BHK), Rs 1500 (1.5 BHK and above)
const CREDIT_PRICE_PAISE = 1000;                          // Rs 10 per call credit
const FREE_CREDITS = 10;                                  // granted once per renter at signup
const MAX_CREDITS_PER_ORDER = 100;
const MIN_PHOTOS = 3;
const CITIES = ["Bangalore", "Mumbai", "Delhi", "Kolkata"];
const SESSION_DAYS = 30;

const db = createDb();
const storage = createStorage(DATA_DIR);

// ---------- seed: data.js is the demo source. Loaded once into the db (status live). ----------
function loadSeed() {
  const src = fs.readFileSync(path.join(APP_DIR, "data.js"), "utf8");
  return vm.runInNewContext(src + "\n;({ SEED_LISTINGS, LANDMARKS, CITY_CENTERS })", {});
}
function seedListings() {
  const { SEED_LISTINGS } = loadSeed();
  const now = new Date().toISOString();
  SEED_LISTINGS.forEach((s) => {
    if (db.find("listings", (l) => l.id === s.id)) return;
    db.insert("listings", Object.assign({}, s, {
      source: "seed", owner_id: null, status: "live", deposit: s.rent * 2,
      deposit_note: "demo default (2 months rent)", created_at: now, updated_at: now
    }));
  });
}
function seedAdmin() {
  const email = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const pw = process.env.ADMIN_PASSWORD || "";
  if (!email || !pw) return;
  const existing = db.find("users", (u) => u.email === email);
  if (existing) { if (existing.role !== "admin") db.update("users", (u) => u.id === existing.id, { role: "admin" }); return; }
  db.insert("users", { id: newId("U"), email, name: "Admin", phone: null, role: "admin", password: hashPassword(pw), created_at: new Date().toISOString() });
}

// ---------- ids, passwords, sessions ----------
function newId(prefix) { return prefix + "-" + crypto.randomBytes(5).toString("hex").toUpperCase(); }
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  return "scrypt$" + salt + "$" + crypto.scryptSync(pw, salt, 64).toString("hex");
}
function checkPassword(pw, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const d = crypto.scryptSync(pw, parts[1], 64).toString("hex");
  return d.length === parts[2].length && crypto.timingSafeEqual(Buffer.from(d), Buffer.from(parts[2]));
}
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach((c) => {
    const i = c.indexOf("=");
    if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}
function currentUser(req) {
  const token = parseCookies(req).rm_session;
  if (!token) return null;
  const s = db.find("sessions", (x) => x.token_hash === sha256(token));
  if (!s || new Date(s.expires_at) < new Date()) return null;
  return db.find("users", (u) => u.id === s.user_id);
}
function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", "rm_session=" + token + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + SESSION_DAYS * 86400 + secure);
}
function startSession(res, user) {
  const token = crypto.randomBytes(32).toString("hex");
  db.insert("sessions", { token_hash: sha256(token), user_id: user.id, created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + SESSION_DAYS * 86400000).toISOString() });
  setSessionCookie(res, token);
}
function requireUser(req, roles) {
  const u = currentUser(req);
  if (!u) throw fail(401, "Log in first");
  if (roles && roles.indexOf(u.role) === -1) throw fail(403, "Not allowed for this account");
  return u;
}

// ---------- credits ----------
function creditBalance(userId) {
  return db.filter("ledger", (e) => e.user_id === userId).reduce((sum, e) => sum + e.delta, 0);
}

// ---------- PayU hosted checkout ----------
// Flow: the server builds the PayU form params plus a request hash (sha512 with the salt). The
// browser POSTs them to PayU (PAYU_ACTION). PayU posts the result back to /api/payu/callback, where
// the server recomputes the reverse hash with the salt. Only a verified success for a known txnid,
// with our merchant key and the exact amount, changes listing or credit state. The salt never leaves
// this process.
const sha512 = (s) => crypto.createHash("sha512").update(s).digest("hex");
function safeEqualHex(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
// Request hash: sha512(key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||SALT)
function payuRequestHash(p) {
  return sha512([p.key, p.txnid, p.amount, p.productinfo, p.firstname, p.email,
    p.udf1, p.udf2, p.udf3, p.udf4, p.udf5, "", "", "", "", "", PAYU_SALT].join("|"));
}
// Response (reverse) hash: sha512(SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)
// Also accepts the documented no-udf variant, with additional_charges prefixed when PayU sends it.
function payuResponseHashOk(f) {
  const got = String(f.hash || "").toLowerCase();
  if (!/^[0-9a-f]{128}$/.test(got)) return false;
  const v = (k) => (f[k] == null ? "" : String(f[k]));
  const pre = v("additional_charges") ? [v("additional_charges")] : [];
  const withUdf = [PAYU_SALT, v("status"), "", "", "", "", "",
    v("udf5"), v("udf4"), v("udf3"), v("udf2"), v("udf1"), v("email"), v("firstname"), v("productinfo"), v("amount"), v("txnid"), v("key")];
  const noUdf = [PAYU_SALT, v("status"), ...Array(10).fill(""),
    v("email"), v("firstname"), v("productinfo"), v("amount"), v("txnid"), v("key")];
  return [withUdf, noUdf].some((parts) => safeEqualHex(sha512(pre.concat(parts).join("|")), got));
}
const rupees = (paise) => (paise / 100).toFixed(2);
function payuBase(req) { return PUBLIC_BASE_URL || ("http://" + (req.headers.host || "localhost")); }
// Writes the order row and returns the form params the browser POSTs to PayU.
function createPayuPayment(req, user, kind, ref, amountPaise, quantity, productinfo) {
  if (!PAYU_KEY || !PAYU_SALT) throw fail(503, "Payments are not set up yet");
  const txnid = "T" + crypto.randomBytes(12).toString("hex").toUpperCase(); // 25 chars, new per attempt
  const base = payuBase(req);
  const p = {
    key: PAYU_KEY, txnid, amount: rupees(amountPaise), productinfo,
    firstname: String(user.name || "").replace(/\|/g, "").trim() || "Customer",
    email: String(user.email).replace(/\|/g, ""),
    surl: base + "/api/payu/callback", furl: base + "/api/payu/callback",
    udf1: kind, udf2: String(ref), udf3: "", udf4: "", udf5: ""
  };
  if (user.phone) p.phone = user.phone;
  p.hash = payuRequestHash(p);
  db.insert("orders", { id: newId("O"), kind, user_id: user.id, ref: kind === "listing" ? ref : null, quantity,
    amount: amountPaise, payu_txnid: txnid, status: "created", payu_mihpayid: null, created_at: new Date().toISOString() });
  return { action: PAYU_ACTION, params: p };
}
function payuBack(res, state, txnid) {
  res.writeHead(302, { Location: "/?payu=" + state + (txnid ? "&txnid=" + encodeURIComponent(txnid) : ""), "Cache-Control": "no-store" });
  res.end();
}
// PayU posts here (surl and furl). The browser may arrive without our session cookie, so trust
// comes only from the verified hash, the known txnid, our merchant key and the exact amount.
async function handlePayuCallback(req, res) {
  const f = Object.fromEntries(new URLSearchParams((await readBody(req, 65536)).toString("utf8")));
  const txnid = String(f.txnid || "");
  const order = txnid ? db.find("orders", (o) => o.payu_txnid === txnid) : null;
  if (!order) { console.warn("payu callback: unknown txnid"); return payuBack(res, "invalid", null); }
  if (!payuResponseHashOk(f)) { console.warn("payu callback: hash mismatch, txnid " + txnid); return payuBack(res, "invalid", txnid); }
  if (String(f.key || "") !== PAYU_KEY) { console.warn("payu callback: merchant key mismatch, txnid " + txnid); return payuBack(res, "invalid", txnid); }
  if (order.status === "paid") return payuBack(res, "success", txnid);
  const now = new Date().toISOString();
  if (String(f.status || "") === "success") {
    if (Math.round(Number(f.amount) * 100) !== order.amount) { console.warn("payu callback: amount mismatch, txnid " + txnid); return payuBack(res, "invalid", txnid); }
    const mihpayid = String(f.mihpayid || "") || null;
    db.transaction((tx) => {
      const cur = tx.find("orders", (o) => o.id === order.id);
      if (cur.status === "paid") return;
      tx.update("orders", (o) => o.id === order.id, { status: "paid", payu_mihpayid: mihpayid, paid_at: now });
      if (order.kind === "listing") {
        tx.update("listings", (x) => x.id === order.ref && x.status === "awaiting_payment", { status: "pending_approval", payment_id: mihpayid, paid_at: now });
      } else {
        tx.insert("ledger", { id: newId("L"), user_id: order.user_id, delta: order.quantity, reason: "purchase", ref: order.id, created_at: now });
      }
    });
    return payuBack(res, "success", txnid);
  }
  db.update("orders", (o) => o.id === order.id && o.status === "created", { status: "failed" });
  return payuBack(res, "failed", txnid);
}


// ---------- validation helpers ----------
const str = (v, max) => String(v == null ? "" : v).trim().slice(0, max);
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const cleanPhone = (s) => str(s, 20).replace(/[\s-]/g, "");
const phoneOk = (s) => /^\+?\d{10,13}$/.test(s);
function publicListing(l) {
  const media = db.filter("media", (m) => m.listing_id === l.id);
  const photos = media.filter((m) => m.kind === "photo").map((m) => storage.driver.publicUrl(m.key));
  const videos = media.filter((m) => m.kind === "video").map((m) => storage.driver.publicUrl(m.key));
  return {
    id: l.id, title: l.title, city: l.city, locality: l.locality, lat: l.lat, lng: l.lng,
    status: l.status, fee_paise: l.fee_paise || null, reject_reason: l.reject_reason || null,
    rent: l.rent, deposit: l.deposit, deposit_note: l.deposit_note || null,
    bhk: l.bhk, bathrooms: l.bathrooms, area_sqm: l.area_sqm, balcony: !!l.balcony,
    furnishing: l.furnishing || "Unfurnished", description: l.description || "", source: l.source,
    photos, videos, has_video: videos.length > 0,
    has_phone: !!(l.owner_id && (db.find("users", (u) => u.id === l.owner_id) || {}).phone)
  };
}
function fail(status, msg, extra) { return Object.assign(new Error(msg), { status, extra }); }

function parseListingFields(body) {
  const f = {
    title: str(body.title, 90), city: str(body.city, 20), locality: str(body.locality, 60),
    lat: Number(body.lat), lng: Number(body.lng), bhk: str(body.bhk, 4),
    bathrooms: Number(body.bathrooms), area_sqm: Number(body.area_sqm),
    balcony: body.balcony === true || body.balcony === "yes", rent: Number(body.rent),
    deposit: Number(body.deposit), furnishing: str(body.furnishing, 30) || "Unfurnished",
    description: str(body.description, 600)
  };
  if (!f.title) throw fail(400, "Title is required");
  if (CITIES.indexOf(f.city) === -1) throw fail(400, "Pick one of the four cities");
  if (!f.locality) throw fail(400, "Locality is required");
  if (!(f.lat >= 6 && f.lat <= 37 && f.lng >= 68 && f.lng <= 98)) throw fail(400, "Pin the location on the map");
  if (["1", "1.5", "2", "2.5", "3", "4"].indexOf(f.bhk) === -1) throw fail(400, "BHK is required");
  if (![1, 2, 3, 4].includes(f.bathrooms)) throw fail(400, "Bathrooms is required");
  if (!(f.area_sqm >= 10 && f.area_sqm <= 2000)) throw fail(400, "Total area in square meters is required");
  if (typeof body.balcony !== "boolean" && body.balcony !== "yes" && body.balcony !== "no") throw fail(400, "Balcony yes or no is required");
  if (!(f.rent >= 1000)) throw fail(400, "Rent per month is required (at least Rs 1000)");
  if (!(Number.isInteger(f.deposit) && f.deposit >= 0)) throw fail(400, "Deposit is required (whole rupees, 0 or more)");
  return f;
}
const feeFor = (bhk) => (Number(bhk) >= 1.5 ? FEE_PAISE.premium : FEE_PAISE.standard);

// ---------- body readers ----------
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(fail(413, "Upload too large")); req.destroy(); }
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function readJson(req) {
  const buf = await readBody(req, 65536);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString("utf8")); } catch (e) { throw fail(400, "Invalid JSON"); }
}
function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

// ---------- handlers ----------
function ownListing(user, id) {
  const l = db.find("listings", (x) => x.id === id);
  if (!l || l.owner_id !== user.id) throw fail(404, "Listing not found");
  return l;
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  const m = req.method;
  const parts = p.split("/").filter(Boolean); // ["api", ...]

  // ----- public listings
  if (m === "GET" && p === "/api/listings") {
    const city = url.searchParams.get("city");
    const rows = db.filter("listings", (l) => l.status === "live" && (!city || l.city === city));
    return sendJson(res, 200, { listings: rows.map(publicListing) });
  }
  if (m === "GET" && parts.length === 3 && parts[1] === "listings") {
    const l = db.find("listings", (x) => x.id === parts[2] && x.status === "live");
    if (!l) throw fail(404, "Listing not found");
    return sendJson(res, 200, { listing: publicListing(l) });
  }

  // ----- auth
  if (m === "POST" && p === "/api/auth/signup") {
    const b = await readJson(req);
    const email = str(b.email, 120).toLowerCase();
    const role = b.role === "owner" ? "owner" : "renter";
    const password = String(b.password || "");
    const name = str(b.name, 60);
    const phone = cleanPhone(b.phone);
    if (!isEmail(email)) throw fail(400, "Enter a valid email");
    if (password.length < 8) throw fail(400, "Password must be at least 8 characters");
    if (!name) throw fail(400, "Name is required");
    if (role === "owner" && !phoneOk(phone)) throw fail(400, "Owner phone number is required (10 to 13 digits)");
    if (phone && !phoneOk(phone)) throw fail(400, "Phone number looks wrong");
    if (db.find("users", (u) => u.email === email)) throw fail(409, "An account with this email already exists");
    const now = new Date().toISOString();
    const user = db.transaction((tx) => {
      const u = tx.insert("users", { id: newId("U"), email, name, phone: phone || null, role, password: hashPassword(password), created_at: now });
      if (role === "renter") tx.insert("ledger", { id: newId("L"), user_id: u.id, delta: FREE_CREDITS, reason: "signup_free", ref: null, created_at: now });
      return u;
    });
    startSession(res, user);
    return sendJson(res, 201, { user: publicUser(user), credits: creditBalance(user.id) });
  }
  if (m === "POST" && p === "/api/auth/login") {
    const b = await readJson(req);
    const user = db.find("users", (u) => u.email === str(b.email, 120).toLowerCase());
    if (!user || !checkPassword(String(b.password || ""), user.password)) throw fail(401, "Wrong email or password");
    startSession(res, user);
    return sendJson(res, 200, { user: publicUser(user), credits: creditBalance(user.id) });
  }
  if (m === "GET" && p === "/api/health") return sendJson(res, 200, { ok: true });
  if (m === "POST" && p === "/api/auth/logout") {
    const token = parseCookies(req).rm_session;
    if (token) db.transaction((tx) => { tx.data.sessions = tx.data.sessions.filter((s) => s.token_hash !== sha256(token)); });
    res.setHeader("Set-Cookie", "rm_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    return sendJson(res, 200, { ok: true });
  }
  if (m === "GET" && p === "/api/me") {
    const u = currentUser(req);
    if (!u) return sendJson(res, 200, { user: null });
    return sendJson(res, 200, { user: publicUser(u), credits: creditBalance(u.id) });
  }

  // ----- owner: listing post flow
  if (m === "POST" && p === "/api/listings") {
    const u = requireUser(req, ["owner"]);
    const f = parseListingFields(await readJson(req));
    const now = new Date().toISOString();
    const l = db.insert("listings", Object.assign(f, {
      id: newId("L"), source: "owner", owner_id: u.id, status: "draft", deposit_note: null,
      created_at: now, updated_at: now
    }));
    return sendJson(res, 201, { listing: publicListing(l) });
  }
  if (m === "GET" && p === "/api/my/listings") {
    const u = requireUser(req, ["owner"]);
    const rows = db.filter("listings", (l) => l.owner_id === u.id);
    return sendJson(res, 200, { listings: rows.map((l) => Object.assign(publicListing(l), { status: l.status, reject_reason: l.reject_reason || null })) });
  }
  if (m === "POST" && parts.length === 4 && parts[1] === "listings" && parts[3] === "media") {
    const u = requireUser(req, ["owner"]);
    const l = ownListing(u, parts[2]);
    if (["draft", "awaiting_payment"].indexOf(l.status) === -1) throw fail(409, "Media can only change before payment");
    const kind = url.searchParams.get("kind") === "video" ? "video" : "photo";
    const ctype = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    const buf = await readBody(req, storage.limits[kind].max + 1);
    const err = storage.validate(kind, ctype, buf.length);
    if (err) throw fail(400, err);
    const existing = db.filter("media", (x) => x.listing_id === l.id && x.kind === kind);
    if (kind === "video" && existing.length >= 1) throw fail(400, "One video per listing. Remove it first.");
    if (kind === "photo" && existing.length >= 8) throw fail(400, "Up to 8 photos per listing");
    const key = storage.newKey(l.id, kind, ctype);
    storage.driver.put(key, buf);
    const row = db.insert("media", { id: newId("M"), listing_id: l.id, kind, key, content_type: ctype, size: buf.length, created_at: new Date().toISOString() });
    return sendJson(res, 201, { media: { id: row.id, kind, url: storage.driver.publicUrl(key) } });
  }
  if (m === "POST" && parts.length === 4 && parts[1] === "listings" && parts[3] === "submit") {
    const u = requireUser(req, ["owner"]);
    const l = ownListing(u, parts[2]);
    if (l.status !== "draft") throw fail(409, "This listing is already submitted");
    const media = db.filter("media", (x) => x.listing_id === l.id);
    const photos = media.filter((x) => x.kind === "photo").length;
    const videos = media.filter((x) => x.kind === "video").length;
    if (photos < MIN_PHOTOS) throw fail(400, "Add at least " + MIN_PHOTOS + " photos");
    if (videos < 1) throw fail(400, "A video of the place is required");
    const b = await readJson(req);
    if (b.owner_confirm !== true) throw fail(400, "Tick the owner confirmation. Brokers and agents cannot post.");
    const updated = db.update("listings", (x) => x.id === l.id, { status: "awaiting_payment", owner_confirmed_at: new Date().toISOString(), fee_paise: feeFor(l.bhk), updated_at: new Date().toISOString() });
    return sendJson(res, 200, { listing: publicListing(updated) });
  }
  if (m === "POST" && parts.length === 5 && parts[1] === "listings" && parts[3] === "pay" && parts[4] === "order") {
    const u = requireUser(req, ["owner"]);
    const l = ownListing(u, parts[2]);
    if (l.status !== "awaiting_payment") throw fail(409, "Listing is not waiting for payment");
    const payment = createPayuPayment(req, u, "listing", l.id, l.fee_paise, 1, "Listing fee");
    return sendJson(res, 200, { payment, amount: l.fee_paise, currency: "INR" });
  }
  if (m === "POST" && p === "/api/payu/callback") return handlePayuCallback(req, res);
  if (m === "GET" && p === "/api/payu/status") {
    const u = requireUser(req);
    const txnid = String(url.searchParams.get("txnid") || "");
    const o = db.find("orders", (x) => x.payu_txnid === txnid && x.user_id === u.id);
    if (!o) throw fail(404, "Unknown payment");
    const l = o.kind === "listing" ? db.find("listings", (x) => x.id === o.ref) : null;
    return sendJson(res, 200, { status: o.status, kind: o.kind, quantity: o.quantity, credits: creditBalance(u.id), listing_status: l ? l.status : null });
  }

  // ----- renter: call reveal and credits
  if (m === "POST" && parts.length === 4 && parts[1] === "listings" && parts[3] === "reveal") {
    const u = requireUser(req, ["renter"]);
    const l = db.find("listings", (x) => x.id === parts[2] && x.status === "live");
    if (!l) throw fail(404, "Listing not found");
    const owner = l.owner_id ? db.find("users", (x) => x.id === l.owner_id) : null;
    if (!owner || !owner.phone) throw fail(404, "No phone number on this listing (demo listing)");
    const already = db.find("reveals", (r) => r.user_id === u.id && r.listing_id === l.id);
    if (already) return sendJson(res, 200, { phone: owner.phone, charged: false, credits: creditBalance(u.id) });
    const result = db.transaction((tx) => {
      const balance = tx.filter("ledger", (e) => e.user_id === u.id).reduce((s, e) => s + e.delta, 0);
      if (balance < 1) return { noCredits: true, balance };
      const now = new Date().toISOString();
      tx.insert("ledger", { id: newId("L"), user_id: u.id, delta: -1, reason: "reveal", ref: l.id, created_at: now });
      tx.insert("reveals", { id: newId("R"), user_id: u.id, listing_id: l.id, created_at: now });
      return { noCredits: false, balance: balance - 1 };
    });
    if (result.noCredits) throw fail(402, "No call credits left. Buy more for Rs 10 each.", { credits: 0, code: "no_credits" });
    return sendJson(res, 200, { phone: owner.phone, charged: true, credits: result.balance });
  }
  if (m === "POST" && p === "/api/credits/order") {
    const u = requireUser(req, ["renter"]);
    const b = await readJson(req);
    const q = Number(b.quantity);
    if (!Number.isInteger(q) || q < 1 || q > MAX_CREDITS_PER_ORDER) throw fail(400, "Buy 1 to " + MAX_CREDITS_PER_ORDER + " credits at a time");
    const amount = q * CREDIT_PRICE_PAISE;
    const payment = createPayuPayment(req, u, "credits", u.id, amount, q, "Call credits x" + q);
    return sendJson(res, 200, { payment, amount, currency: "INR", quantity: q });
  }


  // ----- admin
  if (m === "GET" && p === "/api/admin/listings") {
    requireUser(req, ["admin"]);
    const status = url.searchParams.get("status") || "pending_approval";
    const rows = db.filter("listings", (l) => l.status === status);
    const counts = {};
    db.data.listings.forEach((l) => { counts[l.status] = (counts[l.status] || 0) + 1; });
    return sendJson(res, 200, { listings: rows.map((l) => Object.assign(publicListing(l), { status: l.status, owner_phone_masked: maskPhone((db.find("users", (x) => x.id === l.owner_id) || {}).phone) })), counts });
  }
  if (m === "POST" && parts.length === 5 && parts[1] === "admin" && parts[2] === "listings" && (parts[4] === "approve" || parts[4] === "reject")) {
    const admin = requireUser(req, ["admin"]);
    const b = await readJson(req);
    const l = db.find("listings", (x) => x.id === parts[3]);
    if (!l) throw fail(404, "Listing not found");
    if (l.status !== "pending_approval") throw fail(409, "Only listings waiting for approval can be decided");
    const now = new Date().toISOString();
    const patch = parts[4] === "approve"
      ? { status: "live", approved_at: now, approved_by: admin.id }
      : { status: "rejected", reject_reason: str(b.reason, 200) || "Not approved", approved_by: admin.id, approved_at: now };
    return sendJson(res, 200, { listing: publicListing(db.update("listings", (x) => x.id === l.id, patch)) });
  }

  throw fail(404, "Not found");
}

function maskPhone(p) { return p ? p.slice(0, 3) + "XXXXX" + p.slice(-2) : null; }
function publicUser(u) { return { id: u.id, email: u.email, name: u.name, role: u.role, phone_on_file: !!u.phone }; }

// ---------- static + media ----------
const STATIC = new Set(["index.html", "styles.css", "app.js", "data.js", "config.js", "admin.js"]);
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "application/javascript", ".png": "image/png" };

function serveStatic(res, name) {
  res.writeHead(200, { "Content-Type": MIME[path.extname(name)] || "application/octet-stream" });
  fs.createReadStream(path.join(APP_DIR, name)).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;
    if (p.startsWith("/api/")) return await handleApi(req, res, url);
    if (req.method === "GET" && p.startsWith("/media/")) {
      const key = decodeURIComponent(p.slice(7));
      const stream = storage.driver.stream && storage.driver.stream(key);
      if (!stream) return sendJson(res, 404, { error: "Not found" });
      res.writeHead(200, { "Content-Type": key.endsWith(".mp4") ? "video/mp4" : key.endsWith(".mov") ? "video/quicktime" : key.endsWith(".webm") ? "video/webm" : "image/jpeg", "Cache-Control": "public, max-age=86400" });
      return stream.pipe(res);
    }
    if (req.method === "GET" && (p === "/" || p === "/index.html")) return serveStatic(res, "index.html");
    if (req.method === "GET" && (p === "/admin" || p === "/admin/")) {
      res.writeHead(200, { "Content-Type": MIME[".html"] });
      return fs.createReadStream(path.join(APP_DIR, "admin.html")).pipe(res);
    }
    if (req.method === "GET" && STATIC.has(p.slice(1))) return serveStatic(res, p.slice(1));
    return sendJson(res, 404, { error: "Not found" });
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    sendJson(res, status, Object.assign({ error: status === 500 ? "Server error" : e.message }, e.extra || {}));
  }
});

seedListings();
seedAdmin();
server.listen(PORT, () => {
  if (!PAYU_KEY || !PAYU_SALT) console.warn("warning: PAYU_MERCHANT_KEY / PAYU_MERCHANT_SALT not set. Payments will fail.");
  console.log("rental map on http://localhost:" + PORT + " (storage: " + storage.driver.name + ", db: json file)");
});

module.exports = { server };
