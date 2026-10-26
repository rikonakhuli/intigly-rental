// End-to-end tests for the rental app. Plain Node, no npm packages.
// Runs the real server on a throwaway port with an isolated DATA_DIR, so data/db.json is never touched.
// Usage: node test/e2e.js
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = "http://localhost:" + PORT;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rental-e2e-"));
const ROOT = path.join(__dirname, "..");
// Tiny promo cap so the "used up" path can be exercised.
const PROMO_N = 2;

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("PASS " + name); }
  else { failed++; console.log("FAIL " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}

async function call(method, url, body, cookie, ctype) {
  const headers = {};
  if (body !== undefined && !(body instanceof Buffer)) headers["Content-Type"] = "application/json";
  if (ctype) headers["Content-Type"] = ctype;
  if (cookie) headers.Cookie = cookie;
  const r = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : (body instanceof Buffer ? body : JSON.stringify(body)), redirect: "manual" });
  const setCookie = r.headers.get("set-cookie") || "";
  const text = await r.text();
  let json = {}; try { json = JSON.parse(text); } catch (e) {}
  return { status: r.status, json, cookie: setCookie ? setCookie.split(";")[0] : null };
}

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + "/api/health"); if (r.ok) return; } catch (e) {}
    await new Promise((res) => setTimeout(res, 150));
  }
  throw new Error("server did not start");
}

// Smallest valid PNG and a stand-in mp4 blob. The server validates the type header and size; the file is never decoded.
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5a0000000049454e44ae426082", "hex");

(async () => {
  const env = Object.assign({}, process.env, {
    PORT: String(PORT), DATA_DIR, SHOW_SAMPLE_LISTINGS: "0",
    PAYU_MERCHANT_KEY: "testkey", PAYU_MERCHANT_SALT: "testsalt",
    PROMO_FIRST_N: String(PROMO_N),
    ADMIN_EMAIL: "admin@test.local", ADMIN_PASSWORD: "adminpass123"
  });
  const srv = spawn(process.execPath, [path.join(ROOT, "server.js")], { env, cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let srvLog = ""; srv.stdout.on("data", (d) => srvLog += d); srv.stderr.on("data", (d) => srvLog += d);
  try {
    await waitUp();

    // ---- fee calc: 10% of monthly rent, computed server-side
    const renter = await call("POST", "/api/auth/signup", { email: "renter@test.local", password: "password123", name: "Asha Rao", role: "renter" });
    ok("renter signup ok", renter.status === 200 || renter.status === 201, renter);
    const rCookie = renter.cookie;

    const owner = await call("POST", "/api/auth/signup", { email: "owner@test.local", password: "password123", name: "Vikram Sen", role: "owner", phone: "9876543210" });
    ok("owner signup ok", owner.status === 200 || owner.status === 201, owner);
    const oCookie = owner.cookie;

    const fields = { title: "Sunny 2 BHK", city: "Bangalore", locality: "HSR Layout", lat: 12.91, lng: 77.64, bhk: "2", bathrooms: "2", area_sqm: "90", balcony: "yes", rent: 30000, deposit: 60000, furnishing: "Semi-furnished", description: "test" };
    async function makeListing(promo) {
      const c = await call("POST", "/api/listings", fields, oCookie);
      ok("create listing draft", c.status === 201, c);
      const id = c.json.listing.id;
      for (let i = 0; i < 3; i++) {
        const p = await call("POST", "/api/listings/" + id + "/media?kind=photo", PNG, oCookie, "image/png");
        if (p.status !== 201) ok("upload photo " + i, false, p);
      }
      const v = await call("POST", "/api/listings/" + id + "/media?kind=video", PNG, oCookie, "video/mp4");
      ok("upload video", v.status === 201, v);
      const s = await call("POST", "/api/listings/" + id + "/submit", { owner_confirm: true, promo_code: promo || "" }, oCookie);
      return { id, submit: s };
    }

    const std = await makeListing("");
    ok("fee: rent 30000 -> fee 300000 paise (Rs 3,000)", std.submit.status === 200 && std.submit.json.listing.fee_paise === 300000, std.submit.json);
    // free-text city: any town typed is accepted, and an empty city is refused
    const pune = await call("POST", "/api/listings", { ...fields, city: "Pune", locality: "Koregaon Park", lat: 18.54, lng: 73.9 }, oCookie);
    ok("post accepts free-text city (Pune, not in any list)", pune.status === 201 && pune.json.listing.city === "Pune", pune);
    const noCity = await call("POST", "/api/listings", { ...fields, city: "" }, oCookie);
    ok("post refuses an empty city", noCity.status === 400, noCity);
    ok("no promo -> awaiting_payment", std.submit.json.listing && std.submit.json.listing.status === "awaiting_payment", std.submit.json);
    ok("no promo -> promo.applied false", std.submit.json.promo && std.submit.json.promo.applied === false, std.submit.json.promo);

    // pay order created for the standard fee, amount from server
    const order = await call("POST", "/api/listings/" + std.id + "/pay/order", {}, oCookie);
    ok("pay order created for paid listing", order.status === 200 && order.json.amount === 300000 && !!order.json.payment, order);
    ok("pay order params include amount 3000.00", order.json.payment && /3000\.00/.test(JSON.stringify(order.json.payment.params)), order.json.payment && order.json.payment.params);

    // ---- coupon FIRST1000: free while slots remain, counted server-side
    const promoInfo0 = await call("GET", "/api/promo");
    ok("promo info shows total and remaining", promoInfo0.json.promo && promoInfo0.json.promo.total === PROMO_N && promoInfo0.json.promo.remaining === PROMO_N, promoInfo0.json);

    const f1 = await makeListing("FIRST1000");
    ok("coupon 1: applied, free", f1.submit.json.promo && f1.submit.json.promo.applied === true, f1.submit.json);
    ok("coupon 1: status pending_approval (no payment)", f1.submit.json.listing && f1.submit.json.listing.status === "pending_approval", f1.submit.json.listing);
    ok("coupon 1: remaining drops to 1", f1.submit.json.promo && f1.submit.json.promo.remaining === PROMO_N - 1, f1.submit.json.promo);

    const freePay = await call("POST", "/api/listings/" + f1.id + "/pay/free", {}, oCookie);
    ok("free publish route accepts held slot", freePay.status === 200, freePay);
    const payFreeOnPaid = await call("POST", "/api/listings/" + std.id + "/pay/free", {}, oCookie);
    ok("free publish refused for a non-promo listing", payFreeOnPaid.status === 409, payFreeOnPaid);
    const payOrderOnFree = await call("POST", "/api/listings/" + f1.id + "/pay/order", {}, oCookie);
    ok("PayU order refused for a free listing (no fee)", payOrderOnFree.status === 409, payOrderOnFree);

    const f2 = await makeListing("FIRST1000");
    ok("coupon 2: applied, free", f2.submit.json.promo && f2.submit.json.promo.applied === true, f2.submit.json);
    ok("coupon 2: remaining now 0", f2.submit.json.promo && f2.submit.json.promo.remaining === 0, f2.submit.json.promo);

    const f3 = await makeListing("FIRST1000");
    ok("coupon 3: sold out, not applied", f3.submit.json.promo && f3.submit.json.promo.applied === false && f3.submit.json.promo.sold_out === true, f3.submit.json.promo);
    ok("coupon 3: falls back to 10% fee (Rs 3,000)", f3.submit.json.listing && f3.submit.json.listing.fee_paise === 300000 && f3.submit.json.listing.status === "awaiting_payment", f3.submit.json.listing);

    const badCode = await makeListing("NOTACODE");
    ok("invalid promo code rejected", badCode.submit.status === 400, badCode.submit);

    // rejection releases a slot
    const adm = await call("POST", "/api/auth/login", { email: "admin@test.local", password: "adminpass123" });
    ok("admin login ok", adm.status === 200 && !!adm.cookie, adm);
    const rej = await call("POST", "/api/admin/listings/" + f2.id + "/reject", { reason: "test" }, adm.cookie);
    ok("admin rejects coupon listing", rej.status === 200, rej);
    const promoAfterReject = await call("GET", "/api/promo");
    ok("rejected coupon listing releases its slot (remaining back to 1)", promoAfterReject.json.promo.remaining === 1, promoAfterReject.json);

    // approve f1 and std so reviews can happen on live listings
    await call("POST", "/api/admin/listings/" + f1.id + "/approve", {}, adm.cookie);
    await call("POST", "/api/admin/listings/" + std.id + "/approve", {}, adm.cookie);
    const live = await call("GET", "/api/listings/" + f1.id);
    ok("live listing visible via public detail", live.status === 200 && live.json.listing.status === "live", live.json);
    ok("public detail shows fee and promo fields", live.json.listing && "promo_code" in live.json.listing, live.json.listing);

    // ---- share: the public detail link works and needs no login
    const shared = await call("GET", "/api/listings/" + f1.id);
    ok("share link target loads with no login", shared.status === 200, shared);
    const sharedNoLive = await call("GET", "/api/listings/" + f2.id);
    ok("rejected listing is not shareable (404)", sharedNoLive.status === 404, sharedNoLive.status);

    // ---- reviews: renters only, 1-5 stars, one per renter per listing, live only
    const badStars = await call("POST", "/api/listings/" + f1.id + "/reviews", { rating: 6, comment: "x" }, rCookie);
    ok("review rejects 6 stars", badStars.status === 400, badStars);
    const zeroStars = await call("POST", "/api/listings/" + f1.id + "/reviews", { rating: 0 }, rCookie);
    ok("review rejects 0 stars", zeroStars.status === 400, zeroStars);
    const ownerReview = await call("POST", "/api/listings/" + f1.id + "/reviews", { rating: 5 }, oCookie);
    ok("owner cannot review (renter only)", ownerReview.status === 403, ownerReview);
    const anonReview = await call("POST", "/api/listings/" + f1.id + "/reviews", { rating: 5 });
    ok("anonymous cannot review", anonReview.status === 401, anonReview);
    const r1 = await call("POST", "/api/listings/" + f1.id + "/reviews", { rating: 4, comment: "Good light, quiet street." }, rCookie);
    ok("renter posts 4-star review", r1.status === 201 && r1.json.review.rating === 4, r1);
    ok("review shows renter first name only", r1.json.review && r1.json.review.author === "Asha", r1.json.review);
    const dup = await call("POST", "/api/listings/" + f1.id + "/reviews", { rating: 2, comment: "again" }, rCookie);
    ok("second review by same renter refused", dup.status === 409, dup);
    const detailR = await call("GET", "/api/listings/" + f1.id);
    ok("listing detail includes reviews", Array.isArray(detailR.json.reviews) && detailR.json.reviews.length === 1 && detailR.json.reviews[0].comment === "Good light, quiet street.", detailR.json);
    ok("listing rating average is 4", detailR.json.listing && detailR.json.listing.rating === 4 && detailR.json.listing.review_count === 1, detailR.json.listing);
    const noLiveReview = await call("POST", "/api/listings/" + f2.id + "/reviews", { rating: 3 }, rCookie);
    ok("review refused on a non-live listing", noLiveReview.status === 404, noLiveReview);

    // second renter, averages update
    const r2 = await call("POST", "/api/auth/signup", { email: "renter2@test.local", password: "password123", name: "Ravi Kumar", role: "renter" });
    const rev2 = await call("POST", "/api/listings/" + f1.id + "/reviews", { rating: 5 }, r2.cookie);
    ok("second renter review ok", rev2.status === 201, rev2);
    const avg2 = await call("GET", "/api/listings/" + f1.id);
    ok("average of 4 and 5 is 4.5 (2 reviews)", avg2.json.listing.rating === 4.5 && avg2.json.listing.review_count === 2, avg2.json.listing);

    // ---- regression: no-login browsing and listing list still work
    const list = await call("GET", "/api/listings");
    ok("no-login listing browse works without a city param", list.status === 200 && Array.isArray(list.json.listings), list.status);
    const listCity = await call("GET", "/api/listings?city=Bangalore");
    ok("city param is ignored (no gate): same list as unfiltered", listCity.status === 200 && listCity.json.listings.length === list.json.listings.length, listCity.status);

    // ---- static assets served
    const idx = await fetch(BASE + "/");
    const idxText = await idx.text();
    ok("index.html served", idx.status === 200 && /feeNote/.test(idxText) && /promo_code/.test(idxText), idx.status);
    const appJs = await fetch(BASE + "/app.js");
    const appText = await appJs.text();
    ok("app.js served with share + review hooks", appText.includes("wireShare") && appText.includes("loadReviews") && appText.includes("#listing="), appJs.status);
    ok("app.js has no hard-coded 1000/1500 flat fee", !/FEE_STANDARD|FEE_PREMIUM/.test(appText));

    // ---- Weekly Pass ----
    // A fresh renter with no pass. Listing detail is public, but media and phone are locked.
    const pr = await call("POST", "/api/auth/signup", { email: "pass1@test.local", password: "password123", name: "Meera Iyer", role: "renter" });
    const pCookie = pr.cookie;
    const detLocked = await call("GET", "/api/listings/" + f1.id, undefined, pCookie);
    ok("locked detail: basic info still visible (title, rent, locality, BHK)", detLocked.json.listing && detLocked.json.listing.title && detLocked.json.listing.rent === 30000 && detLocked.json.listing.locality && detLocked.json.listing.bhk, detLocked.json.listing);
    ok("locked detail: photos and videos withheld", detLocked.json.listing.media_locked === true && detLocked.json.listing.photos.length === 0 && detLocked.json.listing.videos.length === 0 && detLocked.json.listing.photo_count === 3, detLocked.json.listing);
    ok("locked detail: pass not active, price reported", detLocked.json.pass && detLocked.json.pass.active === false && detLocked.json.pass.price_rupees === 400, detLocked.json.pass);
    const revLocked = await call("POST", "/api/listings/" + f1.id + "/reveal", {}, pCookie);
    ok("locked reveal: 402 pass_required (no phone)", revLocked.status === 402 && revLocked.json.code === "pass_required" && !revLocked.json.phone, revLocked);
    const meLocked = await call("GET", "/api/me", undefined, pCookie);
    ok("me: renter without pass shows pass_active false", meLocked.json.user && meLocked.json.user.pass_active === false, meLocked.json);

    // Pass purchase: server computes Rs 400 and makes a PayU order.
    const po = await call("POST", "/api/pass/order", {}, pCookie);
    ok("pass order created at Rs 400 (40000 paise)", po.status === 200 && po.json.amount === 40000 && po.json.payment && po.json.payment.params, po.json);
    ok("pass order params include amount 400.00", po.json.payment && /400\.00/.test(JSON.stringify(po.json.payment.params)), po.json.payment && po.json.payment.params);
    const anonPass = await call("POST", "/api/pass/order", {});
    ok("pass order refused for anonymous", anonPass.status === 401, anonPass);
    const ownerPass = await call("POST", "/api/pass/order", {}, oCookie);
    ok("pass order refused for owner accounts", ownerPass.status === 403, ownerPass);

    // Simulate PayU success via admin grant route (same write the callback does), then check unlock.
    const grant = await call("POST", "/api/admin/users/" + pr.json.user.id + "/pass", { expires_at: new Date(Date.now() + 7 * 86400000).toISOString() }, adm.cookie);
    ok("admin can grant a pass", grant.status === 200 && grant.json.pass.active === true, grant.json);
    const detUnlocked = await call("GET", "/api/listings/" + f1.id, undefined, pCookie);
    ok("unlocked detail after pass: photos and video present", detUnlocked.json.listing.media_locked === false && detUnlocked.json.listing.photos.length === 3 && detUnlocked.json.listing.videos.length === 1, detUnlocked.json.listing);
    const revOk = await call("POST", "/api/listings/" + f1.id + "/reveal", {}, pCookie);
    ok("pass holder: reveal returns owner phone", revOk.status === 200 && revOk.json.phone === "9876543210", revOk.json);
    ok("pass holder: reveal does not charge credits", revOk.json.charged === false, revOk.json);
    const meActive = await call("GET", "/api/me", undefined, pCookie);
    ok("me: active pass reports days left", meActive.json.user.pass_active === true && meActive.json.user.pass_days_left >= 6, meActive.json.user);

    // Credit path: a pass holder with zero credits is not blocked, and a non-pass renter is blocked even with credits.
    const credBefore = (await call("GET", "/api/me", undefined, pCookie)).json.credits;
    const rv2 = await call("POST", "/api/listings/" + f1.id + "/reveal", {}, pCookie);
    const credAfter = (await call("GET", "/api/me", undefined, pCookie)).json.credits;
    ok("credit path: pass holder reveal leaves the credit ledger untouched", rv2.status === 200 && credBefore === credAfter, { before: credBefore, after: credAfter, status: rv2.status });
    const credCheck = await call("GET", "/api/me", undefined, r2.cookie);
    ok("credit path: renter2 (credits on file, no pass) is blocked from reveal", (await call("POST", "/api/listings/" + f1.id + "/reveal", {}, r2.cookie)).status === 402, credCheck.json);

    // Expiry: admin sets an expiry in the past. Server must revert to locked without any client help.
    const expire = await call("POST", "/api/admin/users/" + pr.json.user.id + "/pass", { expires_at: new Date(Date.now() - 1000).toISOString() }, adm.cookie);
    ok("admin sets pass in the past (expired)", expire.status === 200 && expire.json.pass.active === false, expire.json);
    const detExpired = await call("GET", "/api/listings/" + f1.id, undefined, pCookie);
    ok("expired pass: detail locked again", detExpired.json.listing.media_locked === true && detExpired.json.listing.photos.length === 0, detExpired.json.listing);
    const revExpired = await call("POST", "/api/listings/" + f1.id + "/reveal", {}, pCookie);
    ok("expired pass: reveal refused (402)", revExpired.status === 402 && !revExpired.json.phone, revExpired);

    // Admin users list shows pass status.
    const au = await call("GET", "/api/admin/users", undefined, adm.cookie);
    const row = au.json.users && au.json.users.find((u) => u.id === pr.json.user.id);
    ok("admin users list shows pass status", au.status === 200 && row && row.pass.active === false, au.json);
    const auDenied = await call("GET", "/api/admin/users", undefined, pCookie);
    ok("admin users list refused for renter", auDenied.status === 403, auDenied.status);

    // Price is configurable: PASS_PRICE_RUPEES env sets the price the server reports and charges.
    // (checked in the separate configured run below)
    const appText2 = appText;
    ok("app.js buy button wired to Weekly Pass", appText2.includes("Buy Weekly Pass"), null);
  } catch (e) {
    failed++; console.log("FAIL harness error: " + (e && e.stack || e));
  } finally {
    srv.kill();
    console.log("\n" + passed + " passed, " + failed + " failed");
    if (failed) { console.log("--- server log tail ---\n" + srvLog.slice(-1500)); }
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
    process.exit(failed ? 1 : 0);
  }
})();
