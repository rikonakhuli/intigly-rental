"use strict";
// Rental Map: one Node service (no npm deps). Serves the static frontend, the JSON API,
// media files, and the admin dashboard. Deployed on Render as a single web service.
//
// Routes (JSON unless noted):
//   GET  /api/listings                  all live listings, India-wide (no contact details)
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
//   POST /api/listings/:id/reveal       renter: reveal owner phone. Needs an active Weekly Pass (unlimited, no credits)
//   POST /api/pass/order                renter: PayU form params for the Weekly Pass (server prices it)
//   POST /api/credits/order             renter: {quantity} PayU form params, Rs 10 per credit (dormant, not gating reveals)
//   GET  /api/admin/users               admin: renters with pass status
//   POST /api/admin/users/:id/pass      admin: {expires_at: ISO|null} set or revoke a pass
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
// Listing fee = 10% of monthly rent, computed on the server from the listing's rent.
const FEE_RATE_PERCENT = 10;
// Promo FIRST1000: posting is free for the first N listings that publish with it (counted server-side).
const PROMO_CODE = "FIRST1000";
const PROMO_FREE_SLOTS = Number(process.env.PROMO_FIRST_N) || 1000;
const CREDIT_PRICE_PAISE = 1000;                          // Rs 10 per call credit
const FREE_CREDITS = 10;                                  // granted once per renter at signup
const MAX_CREDITS_PER_ORDER = 100;
// Weekly Pass: the only thing that unlocks owner contact, photos and video for renters.
// PASS_PRICE_RUPEES is configurable (default 400). Stored on the user row as pass_expires_at.
const PASS_PRICE_RUPEES = (() => { const n = Number(process.env.PASS_PRICE_RUPEES); return Number.isFinite(n) && n > 0 ? n : 400; })();
const PASS_PRICE_PAISE = Math.round(PASS_PRICE_RUPEES * 100);
const PASS_DAYS = 7;
const PASS_MS = PASS_DAYS * 86400000;
const MIN_PHOTOS = 3;
const SESSION_DAYS = 30;
const BHK_VALUES = ["1RK", "1", "1.5", "2", "2.5", "3", "3.5", "4"];
const FURNISHING_VALUES = ["Unfurnished", "Semi-furnished", "Fully furnished"];
// Sample listings (source seed) are hidden when SHOW_SAMPLE_LISTINGS=0, so the platform can start with owner listings only.
const SHOW_SAMPLES = process.env.SHOW_SAMPLE_LISTINGS !== "0";

const db = createDb();
const storage = createStorage(DATA_DIR);

// ---------- seed: data.js is the demo source. Loaded once into the db (status live). ----------
function loadSeed() {
  const src = fs.readFileSync(path.join(APP_DIR, "data.js"), "utf8");
  return vm.runInNewContext(src + "\n;({ SEED_LISTINGS, LANDMARKS })", {});
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

// ---------- Weekly Pass ----------
// Expiry is checked here on every request (server side). Nothing on the client decides it.
function passActive(u) {
  return !!(u && u.pass_expires_at && Date.parse(u.pass_expires_at) > Date.now());
}
function passView(u) {
  const active = passActive(u);
  return {
    active,
    expires_at: active ? u.pass_expires_at : null,
    days_left: active ? Math.ceil((Date.parse(u.pass_expires_at) - Date.now()) / 86400000) : 0,
    price_rupees: PASS_PRICE_RUPEES, days: PASS_DAYS
  };
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
// Listing fee in paise = 10% of monthly rent in rupees. Rs 30,000 rent -> Rs 3,000 -> 300000 paise.
const feeForRent = (rentRupees) => Math.round(Number(rentRupees)) * FEE_RATE_PERCENT;
// A free FIRST1000 slot is "claimed" when a listing published with the code and was not rejected.
// Rejected listings release their slot. Counted from the db on every check (single process, sync).
const promoUsed = () => db.filter("listings", (l) => !!l.promo_claimed_at && l.status !== "rejected").length;
const promoRemaining = () => Math.max(0, PROMO_FREE_SLOTS - promoUsed());
const promoInfo = () => ({ code: PROMO_CODE, total: PROMO_FREE_SLOTS, remaining: promoRemaining() });
// Reviews: newest first, author shown by first name only.
function reviewsFor(listingId) {
  return db.filter("reviews", (r) => r.listing_id === listingId).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}
function reviewAvg(listingId) {
  const rows = reviewsFor(listingId);
  return rows.length ? Math.round((rows.reduce((a, r) => a + r.rating, 0) / rows.length) * 10) / 10 : null;
}
function reviewView(r) {
  const u = db.find("users", (x) => x.id === r.user_id);
  return { id: r.id, rating: r.rating, comment: r.comment, created_at: r.created_at,
    author: u && u.name ? String(u.name).trim().split(/\s+/)[0] : "Renter" };
}
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
      } else if (order.kind === "pass") {
        // 7 days from payment. If a pass is still running, the new week stacks on the end so paid days are not lost.
        const buyer = tx.find("users", (x) => x.id === order.user_id);
        const base = passActive(buyer) ? Date.parse(buyer.pass_expires_at) : Date.now();
        tx.update("users", (x) => x.id === order.user_id, { pass_expires_at: new Date(base + PASS_MS).toISOString() });
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
  const owner = l.owner_id ? db.find("users", (u) => u.id === l.owner_id) : null;
  const sqm = Number(l.area_sqm) || 0;
  return {
    id: l.id, title: l.title, city: l.city, locality: l.locality, lat: l.lat, lng: l.lng,
    status: l.status, fee_paise: l.fee_paise || null, promo_code: l.promo_code || null, reject_reason: l.reject_reason || null,
    review_count: reviewsFor(l.id).length, rating: reviewAvg(l.id),
    rent: l.rent, deposit: l.deposit,
    bhk: l.bhk, bathrooms: l.bathrooms, area_sqm: sqm, area_sqft: Math.round(sqm * 10.7639),
    balcony: !!l.balcony, furnishing: l.furnishing || "Unfurnished", description: l.description || "",
    source: l.source, sample: l.source === "seed",
    verified: l.source !== "seed" && !!l.approved_at,
    owner_first_name: owner && owner.name ? String(owner.name).trim().split(/\s+/)[0] : null,
    photos, videos, has_video: videos.length > 0,
    has_phone: !!(owner && owner.phone)
  };
}
function fail(status, msg, extra) { return Object.assign(new Error(msg), { status, extra }); }

function parseListingFields(body) {
  const f = {
    title: str(body.title, 90), city: str(body.city, 60), locality: str(body.locality, 60),
    lat: Number(body.lat), lng: Number(body.lng), bhk: str(body.bhk, 4),
    bathrooms: Number(body.bathrooms), area_sqm: Number(body.area_sqm),
    balcony: body.balcony === true || body.balcony === "yes", rent: Number(body.rent),
    deposit: Number(body.deposit), furnishing: str(body.furnishing, 30),
    description: str(body.description, 600)
  };
  if (!f.title) throw fail(400, "Title is required");
  if (!f.city) throw fail(400, "Type the city or town the place is in");
  if (!f.locality) throw fail(400, "Locality is required");
  if (!(f.lat >= 6 && f.lat <= 37 && f.lng >= 68 && f.lng <= 98)) throw fail(400, "Pin the location on the map");
  if (BHK_VALUES.indexOf(f.bhk) === -1) throw fail(400, "Pick the BHK type");
  if (FURNISHING_VALUES.indexOf(f.furnishing) === -1) throw fail(400, "Pick the furnishing");
  if (![1, 2, 3, 4].includes(f.bathrooms)) throw fail(400, "Bathrooms is required");
  if (!(f.area_sqm >= 10 && f.area_sqm <= 2000)) throw fail(400, "Total area in square meters is required");
  if (typeof body.balcony !== "boolean" && body.balcony !== "yes" && body.balcony !== "no") throw fail(400, "Balcony yes or no is required");
  if (!(f.rent >= 1000)) throw fail(400, "Rent per month is required (at least Rs 1000)");
  if (!(Number.isInteger(f.deposit) && f.deposit >= 0)) throw fail(400, "Deposit is required (whole rupees, 0 or more)");
  return f;
}

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
    // India-wide: no city gate. The client narrows by map view or distance.
    const rows = db.filter("listings", (l) => l.status === "live" && (SHOW_SAMPLES || l.source !== "seed"));
    return sendJson(res, 200, { listings: rows.map(publicListing) });
  }
  if (m === "GET" && parts.length === 3 && parts[1] === "listings") {
    const l = db.find("listings", (x) => x.id === parts[2] && x.status === "live");
    if (!l || (!SHOW_SAMPLES && l.source === "seed")) throw fail(404, "Listing not found");
    const pub = publicListing(l);
    const viewer = currentUser(req);
    const out = passActive(viewer) ? Object.assign(pub, { media_locked: false }) : lockMedia(pub);
    return sendJson(res, 200, { listing: out, reviews: reviewsFor(l.id).map(reviewView), pass: passView(viewer) });
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
    if (!u) return sendJson(res, 200, { user: null, pass: passView(null) });
    return sendJson(res, 200, { user: publicUser(u), credits: creditBalance(u.id), pass: passView(u) });
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
  if (m === "GET" && p === "/api/promo") return sendJson(res, 200, { promo: promoInfo() });
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
    const now = new Date().toISOString();
    const fee = feeForRent(l.rent);
    const code = str(b.promo_code, 40).toUpperCase();
    if (code && code !== PROMO_CODE) throw fail(400, "That promo code is not valid.");
    // The free slot is claimed inside one synchronous transaction, so two posts cannot take the last slot.
    const result = db.transaction((tx) => {
      const cur = tx.find("listings", (x) => x.id === l.id);
      const free = code === PROMO_CODE && promoRemaining() > 0;
      const patch = { owner_confirmed_at: now, fee_paise: fee, updated_at: now, promo_code: code || null };
      if (free) Object.assign(patch, { status: "pending_approval", promo_claimed_at: now, payment_id: "FIRST1000", paid_at: null });
      else Object.assign(patch, { status: "awaiting_payment" });
      return { listing: tx.update("listings", (x) => x.id === cur.id, patch), free, soldOut: code === PROMO_CODE && !free };
    });
    return sendJson(res, 200, {
      listing: publicListing(result.listing),
      promo: { applied: result.free, sold_out: result.soldOut, code: code || null, remaining: promoRemaining(), total: PROMO_FREE_SLOTS }
    });
  }
  if (m === "POST" && parts.length === 5 && parts[1] === "listings" && parts[3] === "pay" && parts[4] === "order") {
    const u = requireUser(req, ["owner"]);
    const l = ownListing(u, parts[2]);
    if (l.status !== "awaiting_payment") throw fail(409, "Listing is not waiting for payment");
    if (!l.fee_paise) throw fail(409, "No fee due for this listing");
    const payment = createPayuPayment(req, u, "listing", l.id, l.fee_paise, 1, "Listing fee");
    return sendJson(res, 200, { payment, amount: l.fee_paise, currency: "INR" });
  }

  // Free FIRST1000 publish: no PayU call. The slot was already claimed at submit, so only the status moves.
  if (m === "POST" && parts.length === 5 && parts[1] === "listings" && parts[3] === "pay" && parts[4] === "free") {
    const u = requireUser(req, ["owner"]);
    const l = ownListing(u, parts[2]);
    if (l.status !== "pending_approval" || !l.promo_claimed_at) throw fail(409, "No free slot is held for this listing");
    return sendJson(res, 200, { listing: publicListing(l) });
  }

  // ----- reviews: renters only, one per renter per listing, live listings only
  if (m === "POST" && parts.length === 4 && parts[1] === "listings" && parts[3] === "reviews") {
    const u = requireUser(req, ["renter"]);
    const l = db.find("listings", (x) => x.id === parts[2] && x.status === "live");
    if (!l || (!SHOW_SAMPLES && l.source === "seed")) throw fail(404, "Listing not found");
    const b = await readJson(req);
    const rating = Number(b.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw fail(400, "Pick a rating from 1 to 5 stars");
    const comment = str(b.comment, 500);
    if (db.find("reviews", (r) => r.user_id === u.id && r.listing_id === l.id)) throw fail(409, "You already reviewed this listing");
    const row = db.insert("reviews", { id: newId("V"), listing_id: l.id, user_id: u.id, rating, comment, created_at: new Date().toISOString() });
    return sendJson(res, 201, { review: reviewView(row), listing: publicListing(l) });
  }
  if (m === "POST" && p === "/api/payu/callback") return handlePayuCallback(req, res);
  if (m === "GET" && p === "/api/payu/status") {
    const u = requireUser(req);
    const txnid = String(url.searchParams.get("txnid") || "");
    const o = db.find("orders", (x) => x.payu_txnid === txnid && x.user_id === u.id);
    if (!o) throw fail(404, "Unknown payment");
    const l = o.kind === "listing" ? db.find("listings", (x) => x.id === o.ref) : null;
    return sendJson(res, 200, { status: o.status, kind: o.kind, quantity: o.quantity, credits: creditBalance(u.id), listing_status: l ? l.status : null, pass: passView(u) });
  }

  // ----- renter: call reveal (Weekly Pass gate, unlimited while active)
  if (m === "POST" && parts.length === 4 && parts[1] === "listings" && parts[3] === "reveal") {
    const u = requireUser(req, ["renter"]);
    const l = db.find("listings", (x) => x.id === parts[2] && x.status === "live");
    if (!l || (!SHOW_SAMPLES && l.source === "seed")) throw fail(404, "Listing not found");
    const owner = l.owner_id ? db.find("users", (x) => x.id === l.owner_id) : null;
    if (!owner || !owner.phone) throw fail(404, "Sample listing: no owner contact is attached.");
    // Expiry is checked here, server side. Credit balance is ignored: only the pass unlocks contacts.
    if (!passActive(u)) throw fail(402, "Get the Weekly Pass (Rs " + PASS_PRICE_RUPEES + " for " + PASS_DAYS + " days) to see owner contacts.", { code: "pass_required", pass: passView(u) });
    return sendJson(res, 200, { phone: owner.phone, charged: false, pass: passView(u) });
  }
  // DORMANT (kept on purpose, not called): the old per-call credit deduction. Left in place so it can be restored.
  function revealWithCredit(u, l) {
    return db.transaction((tx) => {
      const balance = tx.filter("ledger", (e) => e.user_id === u.id).reduce((s, e) => s + e.delta, 0);
      if (balance < 1) return { noCredits: true, balance };
      const now = new Date().toISOString();
      tx.insert("ledger", { id: newId("L"), user_id: u.id, delta: -1, reason: "reveal", ref: l.id, created_at: now });
      tx.insert("reveals", { id: newId("R"), user_id: u.id, listing_id: l.id, created_at: now });
      return { noCredits: false, balance: balance - 1 };
    });
  }
  if (m === "POST" && p === "/api/pass/order") {
    const u = requireUser(req, ["renter"]);
    const payment = createPayuPayment(req, u, "pass", u.id, PASS_PRICE_PAISE, 1, "Weekly Pass");
    return sendJson(res, 200, { payment, amount: PASS_PRICE_PAISE, currency: "INR", pass: passView(u) });
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
  if (m === "GET" && p === "/api/admin/users") {
    requireUser(req, ["admin"]);
    const rows = db.filter("users", (u) => u.role === "renter").map((u) => ({ id: u.id, name: u.name, email: u.email, pass: passView(u) }));
    return sendJson(res, 200, { users: rows });
  }
  if (m === "POST" && parts.length === 5 && parts[1] === "admin" && parts[2] === "users" && parts[4] === "pass") {
    requireUser(req, ["admin"]);
    const b = await readJson(req);
    const target = db.find("users", (x) => x.id === parts[3]);
    if (!target) throw fail(404, "User not found");
    let exp = null;
    if (b.expires_at !== null) {
      const t = Date.parse(String(b.expires_at || ""));
      if (!Number.isFinite(t)) throw fail(400, "expires_at must be an ISO time, or null to revoke");
      exp = new Date(t).toISOString();
    }
    db.update("users", (x) => x.id === target.id, { pass_expires_at: exp });
    const fresh = db.find("users", (x) => x.id === target.id);
    return sendJson(res, 200, { user: publicUser(fresh), pass: passView(fresh) });
  }
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
function publicUser(u) {
  const pass = passView(u);
  return { id: u.id, email: u.email, name: u.name, role: u.role, phone_on_file: !!u.phone,
    pass_active: pass.active, pass_expires_at: pass.expires_at, pass_days_left: pass.days_left };
}
// Locked view for viewers without an active pass: no photo or video URLs, counts only.
function lockMedia(pub) {
  return Object.assign({}, pub, { photos: [], videos: [], photo_count: pub.photos.length, video_count: pub.videos.length, media_locked: true });
}

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
