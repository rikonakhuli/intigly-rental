/* Rental Map frontend. Plain JS. Leaflet + OpenStreetMap tiles (no key).
   All money, credits, and contact reveals are decided by the server. */
(function () {
  "use strict";

  const FEE_STANDARD = 1000, FEE_PREMIUM = 1500, MAX_VIDEO_SECONDS = 60, MIN_PHOTOS = 3;
  const CREDIT_RUPEES = 10;
  const state = {
    city: "Bangalore", listings: [], ref: null, user: null, credits: 0,
    selectedId: null, draft: null, pinLatLng: null, authMode: "login"
  };

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const inr = (n) => "₹" + Number(n).toLocaleString("en-IN");
  const rentK = (n) => n >= 100000 ? "₹" + (n / 100000).toFixed(n % 100000 ? 2 : 0).replace(/\.?0+$/, "") + "L" : "₹" + Math.round(n / 1000) + "k";
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function haversineKm(a, b) {
    const R = 6371, toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  const fmtDist = (km) => km < 1 ? Math.round(km * 1000) + " m away" : km.toFixed(1) + " km away";

  function toast(msg, ms) {
    const t = $("#toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms || 2600);
  }
  function notice(msg) {
    const n = $("#notice");
    if (!msg) { n.hidden = true; n.textContent = ""; return; }
    n.textContent = msg; n.hidden = false;
  }

  async function api(url, body, opts) {
    const o = Object.assign({ method: body ? "POST" : "GET", credentials: "same-origin", headers: {} }, opts || {});
    if (body && !o.raw) { o.headers["Content-Type"] = "application/json"; o.body = JSON.stringify(body); }
    if (o.raw) { o.body = o.raw; delete o.raw; }
    const r = await fetch(url, o);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || "Request failed (" + r.status + ")"), { status: r.status, extra: j });
    return j;
  }

  // ---------- map ----------
  const map = L.map("map", { zoomControl: true }).setView([CITY_CENTERS.Bangalore.lat, CITY_CENTERS.Bangalore.lng], 12);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);
  const markerLayer = L.layerGroup().addTo(map);
  let userMarker = null, refMarker = null, visible = [];

  function pinIcon(l, selected) {
    return L.divIcon({ className: "", html: '<div class="pin' + (selected ? " sel" : "") + '">' + esc(rentK(l.rent)) + "</div>", iconSize: null, iconAnchor: [24, 14] });
  }
  function renderMap() {
    markerLayer.clearLayers();
    visible.forEach((l) => {
      L.marker([l.lat, l.lng], { icon: pinIcon(l, l.id === state.selectedId), title: l.title })
        .on("click", () => selectListing(l.id, { fromMap: true })).addTo(markerLayer);
    });
  }
  function fitVisible() {
    if (!visible.length) return;
    map.fitBounds(L.latLngBounds(visible.map((l) => [l.lat, l.lng])), { padding: [40, 40], maxZoom: 14 });
  }

  // ---------- listings ----------
  async function loadListings() {
    try {
      const j = await api("/api/listings?city=" + encodeURIComponent(state.city));
      state.listings = j.listings;
    } catch (e) {
      state.listings = []; notice("Could not load listings: " + e.message);
    }
  }
  function currentFilters() {
    return { bhk: $("#bhkFilter").value, maxRent: Number($("#rentFilter").value) || 0, balcony: $("#balconyFilter").checked };
  }
  function matchesFilters(l, f) {
    if (f.bhk && String(l.bhk) !== f.bhk && !(f.bhk === "3" && Number(l.bhk) >= 3)) return false;
    if (f.maxRent && l.rent > f.maxRent) return false;
    if (f.balcony && !l.balcony) return false;
    return true;
  }
  function refresh(opts) {
    const f = currentFilters(), sortBy = $("#sortSelect").value, ref = state.ref;
    let items = state.listings.filter((l) => l.city === state.city && matchesFilters(l, f));
    items.forEach((l) => { l._dist = ref ? haversineKm(ref, l) : null; });
    if (sortBy === "nearest" && ref) items.sort((a, b) => a._dist - b._dist);
    else if (sortBy === "rent_asc") items.sort((a, b) => a.rent - b.rent);
    else if (sortBy === "rent_desc") items.sort((a, b) => b.rent - a.rent);
    visible = items;
    $("#countLabel").textContent = items.length + " listing" + (items.length === 1 ? "" : "s");
    renderCards(); renderMap();
    if (opts && opts.fit) fitVisible();
  }

  function renderCards() {
    const wrap = $("#cardList");
    if (!visible.length) {
      wrap.innerHTML = '<div class="card empty"><div class="body"><div class="title">No listings here yet</div><div class="meta">Try another area or city. Live listings appear after admin approval.</div></div></div>';
      return;
    }
    wrap.innerHTML = visible.map((l) => {
      const thumb = l.photos && l.photos[0] ? '<img src="' + esc(l.photos[0]) + '" alt="" />' : "photo";
      return '<article class="card' + (l.id === state.selectedId ? " selected" : "") + '" data-id="' + esc(l.id) + '">' +
        '<div class="thumb">' + thumb + (l.has_video ? '<span class="vid">▶ video</span>' : "") + "</div>" +
        '<div class="body">' +
        '<div class="rent">' + inr(l.rent) + ' <span class="meta">/ month</span></div>' +
        '<div class="deposit">Deposit ' + inr(l.deposit) + "</div>" +
        '<div class="title">' + esc(l.title) + "</div>" +
        '<div class="meta">' + esc(l.bhk) + " BHK · " + l.bathrooms + " bath · " + l.area_sqm + " sq m · " + (l.balcony ? "balcony" : "no balcony") + "</div>" +
        '<div class="meta">' + esc(l.locality) + "</div>" +
        (l._dist != null ? '<div class="dist">' + fmtDist(l._dist) + "</div>" : "") +
        "</div></article>";
    }).join("");
    $$("#cardList .card[data-id]").forEach((el) => el.addEventListener("click", () => selectListing(el.dataset.id, { openDetail: true })));
  }

  function selectListing(id, opts) {
    opts = opts || {};
    state.selectedId = id;
    const l = state.listings.find((x) => x.id === id);
    if (!l) return;
    if (opts.fromMap) {
      map.panTo([l.lat, l.lng]); renderMap(); renderCards();
      const el = document.querySelector('#cardList .card[data-id="' + id + '"]');
      if (el) el.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    }
    if (opts.openDetail) openDetail(l);
  }

  // ---------- detail + tap-to-call ----------
  function openDetail(l) {
    const gallery = l.photos && l.photos.length
      ? '<div class="gallery">' + l.photos.slice(0, 4).map((u, i) => '<img class="' + (i === 0 ? "big" : "") + '" src="' + esc(u) + '" alt="listing photo" />').join("") + "</div>"
      : '<div class="gallery"><div class="ph big">No photos (demo listing)</div></div>';
    const video = l.videos && l.videos.length
      ? '<video class="vid-player" controls preload="metadata" src="' + esc(l.videos[0]) + '"></video>'
      : '<div class="video-ph"><div>No video on this demo listing</div></div>';
    const dist = state.ref ? '<div class="meta">' + fmtDist(haversineKm(state.ref, l)) + " from " + esc(state.ref.label || "your search") + "</div>" : "";
    $("#detailBody").innerHTML = gallery + video +
      '<div class="detail-rent">' + inr(l.rent) + ' <span class="meta">/ month</span> <span class="deposit">· deposit ' + inr(l.deposit) + "</span></div>" +
      '<div class="detail-title">' + esc(l.title) + "</div>" +
      '<div class="meta">' + esc(l.locality) + ", " + esc(l.city) + "</div>" + dist +
      '<div class="specs">' + spec("BHK", l.bhk) + spec("Bathrooms", l.bathrooms) + spec("Area", l.area_sqm + " sq m") +
      spec("Balcony", l.balcony ? "Yes" : "No") + spec("Furnishing", esc(l.furnishing)) + spec("Deposit", inr(l.deposit)) + "</div>" +
      '<p class="desc">' + esc(l.description) + "</p>" +
      '<div id="callBox" class="call-box"></div>' +
      '<div id="detailMap" class="detail-map"></div>';
    renderCallBox(l);
    openView("detailView");
    setTimeout(() => {
      const dm = L.map("detailMap", { zoomControl: false, attributionControl: false }).setView([l.lat, l.lng], 15);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(dm);
      L.marker([l.lat, l.lng]).addTo(dm); dm.invalidateSize();
    }, 60);
  }
  function spec(k, v) { return '<div class="spec"><div class="k">' + k + '</div><div class="v">' + v + "</div></div>"; }

  function renderCallBox(l) {
    const box = $("#callBox");
    if (!box) return;
    if (!l.has_phone && l.source === "seed") {
      box.innerHTML = '<p class="muted small">Demo listing: no owner phone on file, so there is nothing to call.</p>';
      return;
    }
    if (!state.user) {
      box.innerHTML = '<button class="btn primary wide" id="callBtn">Log in to call the owner</button>';
      $("#callBtn").addEventListener("click", () => openAuth("login"));
      return;
    }
    if (state.user.role !== "renter") {
      box.innerHTML = '<p class="muted small">Calling is for renter accounts.</p>';
      return;
    }
    box.innerHTML = '<button class="btn primary wide" id="callBtn">Call owner (1 credit)</button>' +
      '<p class="muted small">You have ' + state.credits + " call credit" + (state.credits === 1 ? "" : "s") + ". Each new call uses 1. Calling the same listing again is free.</p>";
    $("#callBtn").addEventListener("click", () => revealCall(l));
  }

  async function revealCall(l) {
    const btn = $("#callBtn");
    if (btn) btn.disabled = true;
    try {
      const j = await api("/api/listings/" + encodeURIComponent(l.id) + "/reveal", {});
      state.credits = j.credits;
      $("#callBox").innerHTML = '<a class="btn primary wide call-link" href="tel:' + esc(j.phone) + '">Call owner: ' + esc(j.phone) + "</a>" +
        '<p class="muted small">' + (j.charged ? "1 credit used. " : "Already unlocked, no credit used. ") + "Credits left: " + j.credits + ".</p>";
      updateAccount();
    } catch (e) {
      if (e.status === 402) {
        state.credits = 0; updateAccount();
        $("#callBox").innerHTML = '<p class="error">' + esc(e.message) + '</p><button class="btn primary wide" id="buyBtn">Buy credits (₹10 each)</button>';
        $("#buyBtn").addEventListener("click", openCredits);
      } else {
        if (btn) btn.disabled = false;
        toast(e.message, 3200);
      }
    }
  }

  // ---------- views ----------
  function openView(id) { $("#" + id).hidden = false; window.scrollTo(0, 0); }
  function closeView(id) { $("#" + id).hidden = true; }
  $$("[data-close]").forEach((b) => b.addEventListener("click", () => closeView(b.dataset.close)));

  // ---------- search with locality autocomplete ----------
  // Pool: localities from the seed for this city, plus landmarks. Client-side, no API.
  function allPlaces(city) {
    const places = [], seen = new Set();
    SEED_LISTINGS.filter((l) => l.city === city).forEach((l) => {
      if (!seen.has(l.locality)) { seen.add(l.locality); places.push({ name: l.locality, kind: "Locality", lat: l.lat, lng: l.lng }); }
    });
    LANDMARKS.filter((p) => p.city === city).forEach((p) => places.push({ name: p.name, kind: "Landmark", lat: p.lat, lng: p.lng }));
    return places;
  }
  function suggestions(q) {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    const pool = allPlaces(state.city);
    const starts = pool.filter((p) => p.name.toLowerCase().startsWith(s));
    const contains = pool.filter((p) => !starts.includes(p) && p.name.toLowerCase().includes(s));
    return starts.concat(contains).slice(0, 7);
  }
  function renderSuggest() {
    const q = $("#searchInput").value;
    const items = suggestions(q);
    const ul = $("#suggest");
    if (!items.length) { ul.hidden = true; ul.innerHTML = ""; return; }
    ul.innerHTML = items.map((p, i) => '<li role="option" data-i="' + i + '"><span class="sg-name">' + esc(p.name) + '</span><span class="sg-kind">' + p.kind + " · " + esc(state.city) + "</span></li>").join("");
    ul.hidden = false;
    $$("#suggest li").forEach((li) => li.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const p = items[Number(li.dataset.i)];
      $("#searchInput").value = p.name; ul.hidden = true; applyPlace(p);
    }));
  }
  function applyPlace(p) {
    state.ref = { lat: p.lat, lng: p.lng, label: p.name };
    placeRefMarker();
    notice("Showing listings nearest to " + p.name + ".");
    refresh({ fit: false });
    map.setView([p.lat, p.lng], 14);
  }
  async function doSearch() {
    $("#suggest").hidden = true;
    const q = $("#searchInput").value.trim();
    if (!q) { notice(""); state.ref = null; placeRefMarker(); refresh({ fit: true }); return; }
    const hit = suggestions(q)[0] || allPlaces(state.city).find((p) => p.name.toLowerCase() === q.toLowerCase());
    if (hit) return applyPlace(hit);
    notice('No match for "' + q + '" in ' + state.city + ". Try a locality such as Indiranagar, Bandra or Powai.");
  }
  $("#searchInput").addEventListener("input", renderSuggest);
  $("#searchInput").addEventListener("blur", () => setTimeout(() => { $("#suggest").hidden = true; }, 150));
  $("#searchInput").addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
  $("#searchBtn").addEventListener("click", doSearch);

  function placeRefMarker() {
    if (refMarker) map.removeLayer(refMarker);
    refMarker = null;
    if (!state.ref) return;
    refMarker = L.circleMarker([state.ref.lat, state.ref.lng], { radius: 7, color: "#111827", weight: 2, fillColor: "#fff", fillOpacity: 1 })
      .addTo(map).bindTooltip(state.ref.label || "search point");
  }

  function useMyLocation() {
    if (!navigator.geolocation) { notice("This browser has no location support. Search by place name instead."); return; }
    notice("Asking for your location...");
    navigator.geolocation.getCurrentPosition((pos) => {
      const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      state.ref = { lat: p.lat, lng: p.lng, label: "your location" };
      if (userMarker) map.removeLayer(userMarker);
      userMarker = L.marker([p.lat, p.lng], { icon: L.divIcon({ className: "", html: '<div class="pin user"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }) }).addTo(map);
      placeRefMarker();
      const near = Object.keys(CITY_CENTERS).sort((a, b) => haversineKm(p, CITY_CENTERS[a]) - haversineKm(p, CITY_CENTERS[b]))[0];
      if (near !== state.city && haversineKm(p, CITY_CENTERS[near]) < 60) setCity(near, { keepRef: true });
      notice("Sorted nearest to you first.");
      refresh({ fit: false }); map.setView([p.lat, p.lng], 14);
    }, (err) => {
      notice((err && err.code === 1 ? "Location permission was denied." : "Could not get your location.") + " You can still search by place name.");
    }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
  }
  $("#locBtn").addEventListener("click", useMyLocation);

  async function setCity(city, opts) {
    opts = opts || {};
    state.city = city;
    $$(".city-btn").forEach((b) => b.classList.toggle("active", b.dataset.city === city));
    if (!opts.keepRef) { state.ref = null; placeRefMarker(); notice(""); }
    map.setView([CITY_CENTERS[city].lat, CITY_CENTERS[city].lng], 12);
    await loadListings();
    refresh({ fit: true });
  }
  $$(".city-btn").forEach((b) => b.addEventListener("click", () => setCity(b.dataset.city)));
  ["#bhkFilter", "#rentFilter", "#balconyFilter", "#sortSelect"].forEach((s) => $(s).addEventListener("change", () => refresh({ fit: false })));

  // ---------- account + auth ----------
  function openAuth(mode) {
    state.authMode = mode || "login";
    const signup = state.authMode === "signup";
    $("#authTitle").textContent = signup ? "Create an account" : "Log in";
    $("#authSubmit").textContent = signup ? "Create account" : "Log in";
    $("#authSwitch").textContent = signup ? "I already have an account" : "Create an account instead";
    $("#signupFields").hidden = !signup;
    $("#authError").hidden = true;
    openView("authView");
  }
  $("#authSwitch").addEventListener("click", () => openAuth(state.authMode === "signup" ? "login" : "signup"));
  $("#authForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = { email: f.get("email"), password: f.get("password") };
    if (state.authMode === "signup") Object.assign(body, { name: f.get("name"), phone: f.get("phone"), role: f.get("role") });
    try {
      const j = await api(state.authMode === "signup" ? "/api/auth/signup" : "/api/auth/login", body);
      state.user = j.user; state.credits = j.credits || 0;
      closeView("authView"); e.target.reset(); updateAccount();
      if (state.user.role === "renter" && state.credits) toast("Account ready. You have " + state.credits + " free call credits.", 3200);
      if (state.user.role === "owner") openPost();
      if (state.selectedId) { const l = state.listings.find((x) => x.id === state.selectedId); if (l && !$("#detailView").hidden) renderCallBox(l); }
    } catch (err) {
      $("#authError").textContent = err.message; $("#authError").hidden = false;
    }
  });

  function updateAccount() {
    const a = $("#accountArea");
    if (!state.user) {
      a.innerHTML = '<button class="btn ghost" id="loginBtn">Log in</button><button class="btn primary" id="signupBtn">Sign up</button>';
      $("#loginBtn").addEventListener("click", () => openAuth("login"));
      $("#signupBtn").addEventListener("click", () => openAuth("signup"));
      return;
    }
    if (state.user.role === "renter") {
      a.innerHTML = '<button class="btn ghost" id="creditsChip">' + state.credits + ' credits</button><button class="btn ghost" id="logoutBtn">Log out</button>';
      $("#creditsChip").addEventListener("click", openCredits);
    } else {
      a.innerHTML = '<button class="btn primary" id="postBtn">Post a listing</button><button class="btn ghost" id="logoutBtn">Log out</button>';
      $("#postBtn").addEventListener("click", openPost);
    }
    $("#logoutBtn").addEventListener("click", logout);
  }
  async function logout() {
    await api("/api/auth/logout", {});
    state.user = null; state.credits = 0; updateAccount();
    if (state.selectedId) { const l = state.listings.find((x) => x.id === state.selectedId); if (l && !$("#detailView").hidden) renderCallBox(l); }
    toast("Logged out.");
  }
  async function restoreSession() {
    try {
      const j = await api("/api/me");
      state.user = j.user; state.credits = j.credits || 0;
    } catch (e) { state.user = null; }
    updateAccount();
  }

  // ---------- credits purchase (PayU hosted checkout, Rs 10 each, server prices) ----------
  function openCredits() {
    if (!state.user || state.user.role !== "renter") { openAuth("login"); return; }
    $("#creditsNow").textContent = state.credits + " credits";
    $("#creditQty").value = 10;
    $("#creditsTotal").textContent = inr(10 * CREDIT_RUPEES);
    $("#creditsStatus").textContent = "";
    openView("creditsView");
  }
  $("#creditQty").addEventListener("input", () => {
    const q = Math.max(1, Math.min(100, Math.floor(Number($("#creditQty").value) || 0)));
    $("#creditsTotal").textContent = inr(q * CREDIT_RUPEES);
  });
  $("#creditsPay").addEventListener("click", async () => {
    const btn = $("#creditsPay");
    const status = (m) => { $("#creditsStatus").textContent = m; };
    const q = Math.floor(Number($("#creditQty").value) || 0);
    if (q < 1 || q > 100) return status("Buy 1 to 100 credits at a time.");
    btn.disabled = true; status("Creating order...");
    let order;
    try {
      order = await api("/api/credits/order", { quantity: q });
    } catch (e) { btn.disabled = false; return status("Could not create the order: " + e.message); }
    status("Redirecting to PayU...");
    postToPayu(order.payment);
  });

  // Sends the browser to PayU's hosted checkout. The server built every param and the hash.
  function postToPayu(payment) {
    const form = document.createElement("form");
    form.method = "POST";
    form.action = payment.action;
    Object.keys(payment.params).forEach((k) => {
      const input = document.createElement("input");
      input.type = "hidden"; input.name = k; input.value = payment.params[k];
      form.appendChild(input);
    });
    document.body.appendChild(form);
    form.submit();
  }

  // PayU redirects back to /?payu=success|failed|invalid&txnid=... after the server verified the hash.
  // The page only reports the result here. The server state (credits, listing status) is already set.
  async function handlePayuReturn() {
    const params = new URLSearchParams(location.search);
    const result = params.get("payu");
    if (!result) return;
    const txnid = params.get("txnid") || "";
    history.replaceState(null, "", "/");
    if (result === "success") {
      try {
        const s = await api("/api/payu/status?txnid=" + encodeURIComponent(txnid));
        if (s.kind === "listing") toast("Paid. Your listing is waiting for admin approval before it goes live.", 4200);
        else toast("Payment received. You now have " + s.credits + " credits.", 3200);
      } catch (e) { toast("Payment received. Refresh to see your balance.", 3200); }
    } else if (result === "failed") toast("Payment failed or was cancelled. Nothing was charged to your listing or credits.", 4200);
    else toast("Payment could not be verified. Nothing was added. Contact support with reference " + txnid + ".", 5200);
  }


  // ---------- owner post flow ----------
  let pickMap = null, pickMarker = null, currentDraftId = null;
  function initPickMap() {
    if (pickMap) { pickMap.invalidateSize(); return; }
    const c = CITY_CENTERS[$("#postForm [name=city]").value || state.city];
    pickMap = L.map("pickMap").setView([c.lat, c.lng], 13);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(pickMap);
    pickMap.on("click", (e) => {
      state.pinLatLng = { lat: e.latlng.lat, lng: e.latlng.lng };
      if (pickMarker) pickMap.removeLayer(pickMarker);
      pickMarker = L.marker([e.latlng.lat, e.latlng.lng]).addTo(pickMap);
      $("#pinStatus").textContent = "Pinned at " + e.latlng.lat.toFixed(5) + ", " + e.latlng.lng.toFixed(5);
    });
    setTimeout(() => pickMap.invalidateSize(), 80);
  }
  function openPost() {
    if (!state.user || state.user.role !== "owner") { openAuth("login"); return; }
    $("#postForm").reset();
    state.pinLatLng = null; currentDraftId = null; videoOk = false;
    if (pickMarker && pickMap) { pickMap.removeLayer(pickMarker); pickMarker = null; }
    $("#pinStatus").textContent = "Not pinned yet. Tap the small map below.";
    $("#photoNote").textContent = "No photos selected."; $("#videoNote").textContent = "No video selected.";
    $("#formError").hidden = true;
    openView("postView"); initPickMap(); loadMyListings();
  }
  $("#postForm [name=city]").addEventListener("change", (e) => {
    if (e.target.value && pickMap) { const c = CITY_CENTERS[e.target.value]; pickMap.setView([c.lat, c.lng], 13); }
  });
  $("#postForm [name=photos]").addEventListener("change", (e) => {
    const n = e.target.files.length;
    $("#photoNote").textContent = n ? n + " photo(s) selected." + (n < MIN_PHOTOS ? " Need at least " + MIN_PHOTOS + "." : "") : "No photos selected.";
  });
  let videoOk = false;
  $("#postForm [name=video]").addEventListener("change", (e) => {
    videoOk = false;
    const f = e.target.files[0];
    if (!f) { $("#videoNote").textContent = "No video selected."; return; }
    const v = document.createElement("video");
    v.preload = "metadata"; v.src = URL.createObjectURL(f);
    v.onloadedmetadata = () => {
      if (v.duration > MAX_VIDEO_SECONDS) { $("#videoNote").textContent = "Video is " + Math.round(v.duration) + " seconds. Max is " + MAX_VIDEO_SECONDS + "."; e.target.value = ""; }
      else { videoOk = true; $("#videoNote").textContent = "Video OK (" + Math.round(v.duration) + " seconds): " + f.name; }
    };
    v.onerror = () => { $("#videoNote").textContent = "Could not read this video. Try MP4 or MOV."; };
  });

  function showError(msg) { const e = $("#formError"); e.textContent = msg; e.hidden = false; e.scrollIntoView({ behavior: "smooth", block: "center" }); }

  async function uploadMedia(id, kind, file) {
    return api("/api/listings/" + encodeURIComponent(id) + "/media?kind=" + kind, null, {
      method: "POST", raw: file, headers: { "Content-Type": file.type }
    });
  }

  $("#postForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const form = ev.target;
    const get = (n) => form.elements[n].value.trim();
    const photos = Array.from(form.elements.photos.files);
    const video = form.elements.video.files[0];
    if (!get("title")) return showError("Title is required.");
    if (!get("city")) return showError("Pick a city.");
    if (!get("locality")) return showError("Locality is required.");
    if (!state.pinLatLng) return showError("Tap the map to pin the property location.");
    if (!get("bhk")) return showError("BHK is required.");
    if (!get("bathrooms")) return showError("Bathrooms is required.");
    if (!get("area_sqm")) return showError("Total area in square meters is required.");
    if (!get("balcony")) return showError("Balcony yes or no is required.");
    if (!get("rent")) return showError("Rent per month is required.");
    if (get("deposit") === "") return showError("Deposit is required (enter 0 if none).");
    if (photos.length < MIN_PHOTOS) return showError("Add at least " + MIN_PHOTOS + " photos. Photos are required.");
    if (!video) return showError("A video of the place is required.");
    if (!videoOk) return showError("The video could not be checked. Pick a video under " + MAX_VIDEO_SECONDS + " seconds.");
    if (!form.elements.owner_confirm.checked) return showError("Tick the owner confirmation. Brokers and agents cannot post.");

    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      const created = await api("/api/listings", {
        title: get("title"), city: get("city"), locality: get("locality"),
        lat: state.pinLatLng.lat, lng: state.pinLatLng.lng, bhk: get("bhk"), bathrooms: get("bathrooms"),
        area_sqm: get("area_sqm"), balcony: get("balcony"), rent: get("rent"), deposit: get("deposit"),
        furnishing: get("furnishing"), description: get("description")
      });
      const id = created.listing.id;
      currentDraftId = id;
      for (const p of photos.slice(0, 8)) await uploadMedia(id, "photo", p);
      await uploadMedia(id, "video", video);
      const sub = await api("/api/listings/" + encodeURIComponent(id) + "/submit", { owner_confirm: true });
      state.draft = { id, title: sub.listing.title, fee: sub.listing.fee_paise / 100 };
      $("#payTitle").textContent = state.draft.title;
      $("#payFee").textContent = inr(state.draft.fee);
      closeView("postView");
      openView("payView");
    } catch (e) {
      showError(e.message);
    } finally { btn.disabled = false; }
  });

  $("#payNow").addEventListener("click", async () => {
    const d = state.draft;
    if (!d) return;
    const btn = $("#payNow");
    const status = (m) => { $("#payStatus").textContent = m; };
    btn.disabled = true; status("Creating order...");
    let order;
    try { order = await api("/api/listings/" + encodeURIComponent(d.id) + "/pay/order", {}); }
    catch (e) { btn.disabled = false; return status("Could not create the payment order: " + e.message); }
    status("Redirecting to PayU...");
    postToPayu(order.payment);
  });


  async function loadMyListings() {
    const box = $("#myListings");
    try {
      const j = await api("/api/my/listings");
      box.innerHTML = j.listings.length ? '<h3>Your listings</h3>' + j.listings.map((l) =>
        '<div class="mine"><strong>' + esc(l.title) + "</strong> · " + esc(l.locality) + " · " + inr(l.rent) + " <span class=\"status s-" + esc(l.status) + '">' + esc(l.status.replace("_", " ")) + "</span>" +
        (l.reject_reason ? '<div class="error small">' + esc(l.reject_reason) + "</div>" : "") + "</div>").join("") : "";
    } catch (e) { box.innerHTML = ""; }
  }

  // ---------- boot ----------
  (async function boot() {
    await restoreSession();
    await handlePayuReturn();
    await loadListings();
    refresh({ fit: true });
  })();
})();
