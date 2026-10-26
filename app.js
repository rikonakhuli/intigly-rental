/* Rental Map frontend. Plain JS. Leaflet + OpenStreetMap tiles (no key).
   Tenants browse everything without an account. Owner contact is the only gated action.
   Money, credits and contact reveals are decided by the server. */
(function () {
  "use strict";

  const FEE_RATE = 0.10, PROMO_CODE = "FIRST1000", MAX_VIDEO_SECONDS = 60, MIN_PHOTOS = 3, MAX_PHOTOS = 8;
  // Fee is 10% of monthly rent. The server computes the amount it charges; this is display only.
  const feeFor = (rent) => Math.round(Number(rent || 0) * FEE_RATE);
  const CREDIT_RUPEES = 10, FREE_CREDITS = 10;
  const SQM_TO_SQFT = 10.7639;
  const state = {
    listings: [], ref: null, user: null, credits: 0,
    selectedId: null, draft: null, pinLatLng: null, authMode: "login", gateNext: null
  };

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const inr = (n) => "₹" + Number(n).toLocaleString("en-IN");
  const rentK = (n) => n >= 100000 ? "₹" + (n / 100000).toFixed(n % 100000 ? 2 : 0).replace(/\.?0+$/, "") + "L" : "₹" + Math.round(n / 1000) + "k";
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const bhkLabel = (b) => b === "1RK" ? "1 RK" : (b === "3" ? "3 BHK" : b + " BHK");
  const bhkShort = (b) => b === "1RK" ? "1 RK" : b + " BHK";
  const plural = (n, w) => n + " " + w + (n === 1 ? "" : "s");
  const initial = (s) => esc(String(s || "?").trim().charAt(0).toUpperCase());

  function haversineKm(a, b) {
    const R = 6371, toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  const fmtDist = (km) => km < 1 ? Math.round(km * 1000) + " m" : km.toFixed(1) + " km";

  function toast(msg, ms) {
    const t = $("#toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms || 2800);
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
  // India-wide start: whole country in view until the visitor's location is known.
  const INDIA_VIEW = { lat: 22.5, lng: 79.0, zoom: 5 };
  const map = L.map("map", { zoomControl: false }).setView([INDIA_VIEW.lat, INDIA_VIEW.lng], INDIA_VIEW.zoom);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);
  const markerLayer = L.layerGroup().addTo(map);
  let userMarker = null, refMarker = null, visible = [];

  function pinIcon(l, selected) {
    return L.divIcon({
      className: "",
      html: '<div class="pin' + (selected ? " sel" : "") + '">' + esc(rentK(l.rent)) + "</div>",
      iconSize: [0, 0], iconAnchor: [0, 0]
    });
  }
  // Declutter: price pills that would overlap an already-placed pill are nudged to the nearest free spot on a small ring.
  // Display-only: the real lat/lng on each listing is unchanged. Recomputed on zoom.
  function declutteredLatLngs(list) {
    const W = 66, H = 34; // approx pill box, anchored at its bottom-centre
    const placed = [];
    const clash = (x, y) => placed.some((p) => Math.abs(p.x - x) < W && Math.abs(p.y - y) < H);
    const out = new Map();
    list.forEach((l) => {
      const pt = map.latLngToContainerPoint([l.lat, l.lng]);
      let x = pt.x, y = pt.y;
      if (clash(x, y)) {
        let found = false;
        for (const r of [40, 70, 100, 130]) {
          for (let k = 0; k < 8 && !found; k++) {
            const ang = (2 * Math.PI * k) / 8 - Math.PI / 2;
            const cx = pt.x + Math.cos(ang) * r, cy = pt.y + Math.sin(ang) * r * 0.7;
            if (!clash(cx, cy)) { x = cx; y = cy; found = true; }
          }
          if (found) break;
        }
      }
      placed.push({ x, y });
      const ll = map.containerPointToLatLng([x, y]);
      out.set(l.id, [ll.lat, ll.lng]);
    });
    return out;
  }
  function renderMap() {
    markerLayer.clearLayers();
    const pos = declutteredLatLngs(visible);
    visible.forEach((l) => {
      L.marker(pos.get(l.id), { icon: pinIcon(l, l.id === state.selectedId), title: l.title, zIndexOffset: l.id === state.selectedId ? 500 : 0 })
        .on("click", () => selectListing(l.id, { fromMap: true })).addTo(markerLayer);
    });
  }
  map.on("zoomend", () => { if (visible.length) renderMap(); });
  // Panning or zooming narrows the list to what is on screen.
  map.on("moveend", () => refresh({ fit: false }));
  function fitTo(list) {
    if (!list.length) return;
    map.fitBounds(L.latLngBounds(list.map((l) => [l.lat, l.lng])), { padding: [36, 36], maxZoom: 14, animate: false });
  }

  // ---------- listings ----------
  // All live listings load once, India-wide. The map view decides what is shown.
  async function loadListings() {
    try {
      const j = await api("/api/listings");
      state.listings = j.listings;
    } catch (e) {
      state.listings = []; notice("Could not load listings: " + e.message);
    }
  }

  // BHK: "3" means 3 BHK and above. Other values match exactly. "1RK" is its own type.
  function bhkMatches(value, filter) {
    if (filter === "3") return ["3", "3.5", "4"].indexOf(String(value)) !== -1;
    return String(value) === filter;
  }
  function currentFilters() {
    const rent = ($("#rentFilter").value || ":").split(":");
    return {
      bhk: $("#bhkFilter").value,
      minRent: Number(rent[0]) || 0,
      maxRent: Number(rent[1]) || 0,
      furnishing: $("#furnFilter").value,
      balcony: $("#balconyFilter").value,
      verified: $("#verifiedFilter").checked
    };
  }
  function matchesFilters(l, f) {
    if (f.bhk && !bhkMatches(l.bhk, f.bhk)) return false;
    if (f.minRent && l.rent < f.minRent) return false;
    if (f.maxRent && l.rent > f.maxRent) return false;
    if (f.furnishing && l.furnishing !== f.furnishing) return false;
    if (f.balcony === "yes" && !l.balcony) return false;
    if (f.balcony === "no" && l.balcony) return false;
    if (f.verified && !l.verified) return false;
    return true;
  }
  function filtersActive() {
    const f = currentFilters();
    return !!(f.bhk || f.minRent || f.maxRent || f.furnishing || f.balcony || f.verified);
  }
  function refresh(opts) {
    const f = currentFilters(), sortBy = $("#sortSelect").value, ref = state.ref;
    const matching = state.listings.filter((l) => matchesFilters(l, f));
    if (opts && opts.fit) fitTo(matching);
    const bounds = map.getBounds();
    let items = matching.filter((l) => bounds.contains([l.lat, l.lng]));
    items.forEach((l) => { l._dist = ref ? haversineKm(ref, l) : null; });
    if (sortBy === "nearest" && ref) items.sort((a, b) => a._dist - b._dist);
    else if (sortBy === "rent_asc") items.sort((a, b) => a.rent - b.rent);
    else if (sortBy === "rent_desc") items.sort((a, b) => b.rent - a.rent);
    visible = items;
    $("#countLabel").textContent = plural(items.length, "home") + " in view" +
      (matching.length > items.length ? " · " + matching.length + " across India (zoom out to see them)" : "");
    $("#resetFilters").hidden = !filtersActive();
    $$("#filters .chip").forEach((el) => {
      const on = el.tagName === "SELECT" ? !!el.value && el.id !== "sortSelect" : (el.querySelector("input") ? el.querySelector("input").checked : false);
      el.classList.toggle("on", on);
    });
    renderCards(); renderMap();
  }

  function renderCards() {
    const wrap = $("#cardList");
    if (!visible.length) {
      wrap.innerHTML = '<div class="card empty"><div class="body"><div class="title">No homes match these filters</div><div class="loc">Try a wider budget or another area. Owners add new homes after admin review.</div></div></div>';
      return;
    }
    wrap.innerHTML = visible.map((l) => {
      const thumb = l.photos && l.photos[0] ? '<img src="' + esc(l.photos[0]) + '" alt="" loading="lazy" />' : '<div class="ph">No photo yet</div>';
      const tags = '<div class="tags">' + (l.verified ? '<span class="tag verified">✓ Verified</span>' : (l.sample ? '<span class="tag">Sample</span>' : "")) + "</div>";
      return '<article class="card' + (l.id === state.selectedId ? " selected" : "") + '" data-id="' + esc(l.id) + '">' +
        '<div class="thumb">' + thumb + tags + (l.has_video ? '<span class="tag vid">▶ Video</span>' : "") + "</div>" +
        '<div class="body">' +
        '<div class="rent">' + inr(l.rent) + ' <small>/ month</small></div>' +
        '<div class="title">' + esc(l.title) + "</div>" +
        '<div class="facts">' + esc(bhkShort(l.bhk)) + " · " + esc(l.furnishing) + " · " + (l.balcony ? "Balcony" : "No balcony") + "</div>" +
        '<div class="loc">' + esc(l.locality) + " · Deposit " + inr(l.deposit) + "</div>" +
        (l._dist != null ? '<div class="dist">' + fmtDist(l._dist) + " away</div>" : "") +
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
    if (opts.openDetail) openDetailById(l.id);
  }

  // ---------- detail sheet ----------
  function specCell(k, v) { return '<div class="spec"><div class="k">' + k + '</div><div class="v">' + v + "</div></div>"; }
  function moneyLine(label, amount, note) {
    return '<div class="line"><div>' + label + (note ? '<span class="note">' + note + "</span>" : "") + "</div><strong>" + amount + "</strong></div>";
  }

  // Always reload the detail from the server so the photo/video/phone lock is the server's call.
  function openDetailById(id) {
    api("/api/listings/" + encodeURIComponent(id)).then((j) => { state.passOn = !!(j.pass && j.pass.active); openDetail(j.listing); }).catch(() => toast("That listing is not available"));
  }
  function openDetail(l) {
    const photos = l.photos || [];
    // Server decides: detail responses carry media_locked. Card data is never used for the locked check.
    const locked = l.media_locked === true;
    const gallery = locked ? lockedHero(l) : photos.length
      ? '<div class="gallery">' + photos.slice(0, 4).map((u, i) => '<img class="' + (i === 0 ? "big" : "") + '" src="' + esc(u) + '" alt="' + esc(l.title) + '" />').join("") + "</div>" +
        (photos.length > 1 ? '<span class="gallery-count">' + photos.length + " photos</span>" : "")
      : '<div class="gallery"><div class="ph">No photos yet</div></div>';
    const video = locked ? "" : (l.videos && l.videos.length)
      ? '<div class="section-h">Video tour</div><div class="video-box"><video controls preload="metadata" src="' + esc(l.videos[0]) + '"></video></div>'
      : "";
    const dist = state.ref ? "<br/>" + fmtDist(haversineKm(state.ref, l)) + " from " + esc(state.ref.label || "your search") : "";
    const sqft = Math.round(l.area_sqm * SQM_TO_SQFT);
    const verifiedLine = l.verified
      ? '<div class="verified-line">✓ Verified listing · owner confirmed, no broker</div>'
      : (l.sample ? '<div class="verified-line" style="color:var(--muted)">Sample listing for preview</div>' : "");
    const ownerName = l.owner_first_name ? esc(l.owner_first_name) : "Owner";

    $("#detailBody").innerHTML =
      gallery +
      '<div class="detail">' +
        '<div class="price-row"><div class="price">' + inr(l.rent) + ' <small>/ month</small></div>' +
        '<div class="dep">Deposit <b>' + inr(l.deposit) + "</b></div></div>" +
        '<h1 id="detailTitle">' + esc(l.title) + "</h1>" +
        '<div class="loc">' + esc(l.locality) + ", " + esc(l.city) + dist + "</div>" +
        verifiedLine +
        '<div class="spec-grid">' +
          specCell("BHK", esc(bhkShort(l.bhk))) +
          specCell("Bathrooms", esc(l.bathrooms)) +
          specCell("Area", l.area_sqm + " m² · " + sqft + " ft²") +
          specCell("Balcony", l.balcony ? "Yes" : "No") +
          specCell("Furnishing", esc(l.furnishing)) +
          specCell("Deposit", inr(l.deposit)) +
        "</div>" +
        video +
        '<div class="section-h">Money</div>' +
        '<div class="money">' +
          moneyLine("Monthly rent", inr(l.rent), "Paid every month") +
          moneyLine("Security deposit", inr(l.deposit), l.deposit === 0 ? "No deposit asked" : "Refundable at move-out, as agreed") +
        "</div>" +
        '<div class="section-h">About this home</div>' +
        '<p class="desc">' + esc(l.description || "No description added yet.") + "</p>" +
        '<div class="section-h">Owner</div>' +
        '<div class="owner-card"><div class="avatar">' + initial(l.owner_first_name || "O") + '</div><div>' +
          '<div class="who">' + ownerName + (l.verified ? " · Verified owner" : "") + '</div>' +
          '<div class="meta">' + (l.sample ? "Sample listing. No contact attached." : "Contact number is shown after you unlock it.") + "</div>" +
        "</div></div>" +
        '<div class="section-h">Location</div>' +
        '<div id="detailMap" class="detail-map"></div>' +
        '<div class="section-h">Share</div>' +
        '<div class="share-row">' +
          '<button class="btn ghost" id="shareBtn">Share</button>' +
          '<a class="btn ghost" id="waShare" target="_blank" rel="noopener">WhatsApp</a>' +
          '<button class="btn ghost" id="copyLinkBtn">Copy link</button>' +
        "</div>" +
        '<div class="section-h">Reviews</div>' +
        '<div id="reviewsBox"></div>' +
      "</div>" +
      '<div class="cta-bar"><div class="lbl" id="ctaLabel"></div><div id="callBox"></div></div>';

    renderCallBox(l);
    const lb = document.getElementById("lockBuyBtn");
    if (lb) lb.addEventListener("click", () => buyPass());
    wireShare(l);
    loadReviews(l);
    openView("detailView");
    setTimeout(() => {
      const dm = L.map("detailMap", { zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false }).setView([l.lat, l.lng], 15);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(dm);
      L.circleMarker([l.lat, l.lng], { radius: 9, color: "#fff", weight: 3, fillColor: "#0f766e", fillOpacity: 1 }).addTo(dm);
      dm.invalidateSize();
    }, 60);
  }

  // The contact gate. Public: details, photos, video, money, specs. Gated: owner number.
  function renderCallBox(l) {
    const box = $("#callBox"), lbl = $("#ctaLabel");
    if (!box) return;
    lbl.innerHTML = "<b>" + inr(l.rent) + "</b>/ month · deposit " + inr(l.deposit);
    if (l.sample || !l.has_phone) {
      box.innerHTML = '<button class="btn primary" disabled>Owner contact n/a</button>';
      lbl.innerHTML = "<b>Sample listing</b>No owner contact is attached";
      return;
    }
    if (!state.user) {
      box.innerHTML = '<button class="btn primary" id="viewNumBtn">View number</button>';
      $("#viewNumBtn").addEventListener("click", () => openGate("login", () => revealCall(l)));
      return;
    }
    if (state.user.role !== "renter") {
      box.innerHTML = '<span class="muted small">Owner accounts can\'t call other owners.</span>';
      return;
    }
    if (!state.user.pass_active) {
      box.innerHTML = '<button class="btn primary" id="passBuyBtn">Buy Weekly Pass ₹' + passPrice() + '</button>';
      $("#passBuyBtn").addEventListener("click", buyPass);
      lbl.innerHTML = "<b>Owner number locked</b>Weekly Pass ₹" + passPrice() + " for " + PASS_DAYS + " days";
      return;
    }
    box.innerHTML = '<button class="btn primary" id="callBtn">Call owner</button>';
    $("#callBtn").addEventListener("click", () => revealCall(l));
  }

  const PASS_DAYS = 7;
  function passPrice() { return (state.passPrice || 400); }
  // Locked hero: map-style grey tile, lock badge, price and buy. Shown on detail when no active pass.
  function lockedHero(l) {
    return '<div class="lock-hero">' +
      '<div class="lock-card">' +
        '<div class="lock-ico"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" fill="currentColor"/><path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="2"/></svg></div>' +
        '<div class="lock-t">Photos, video and owner number are locked</div>' +
        '<div class="lock-s">Weekly Pass ₹' + passPrice() + ' · ' + PASS_DAYS + ' days unlimited access</div>' +
        '<button class="btn primary wide" id="lockBuyBtn">Buy Weekly Pass ₹' + passPrice() + '</button>' +
      '</div>' +
    '</div>';
  }
  // Pass purchase: the server computes the amount and builds the PayU form. The browser only posts it.
  async function buyPass() {
    if (!state.user) { openGate("login", () => buyPass()); return; }
    if (state.user.role !== "renter") { toast("The pass is for renter accounts."); return; }
    try {
      const j = await api("/api/pass/order", {});
      if (j.pass) state.passPrice = j.pass.price_rupees;
      postToPayu(j.payment);
    } catch (e) { toast("Could not start payment: " + e.message, 3600); }
  }
  async function refreshMe() {
    try { const j = await api("/api/me"); state.user = j.user; if (j.pass) state.passPrice = j.pass.price_rupees; updateAccount(); } catch (e) { /* keep current */ }
  }

  async function revealCall(l) {
    const btn = $("#callBtn") || $("#viewNumBtn");
    if (btn) btn.disabled = true;
    try {
      const j = await api("/api/listings/" + encodeURIComponent(l.id) + "/reveal", {});
      if (j.pass && state.user) { state.user.pass_active = true; state.user.pass_days_left = j.pass.days_left; }
      updateAccount();
      $("#callBox").innerHTML = '<div class="call-done"><a class="btn primary" href="tel:' + esc(j.phone) + '">Call ' + esc(j.phone) + "</a>" +
        '<span class="muted small">Weekly Pass active' + (j.pass ? ", " + plural(j.pass.days_left, "day") + " left" : "") + ".</span></div>";
      $("#ctaLabel").innerHTML = "<b>Owner: " + esc(l.owner_first_name || "Owner") + "</b>Number unlocked";
    } catch (e) {
      if (e.status === 402) {
        if (state.user) state.user.pass_active = false;
        updateAccount();
        renderCallBox(l);
        toast(e.message, 3600);
      } else {
        if (btn) btn.disabled = false;
        toast(e.message, 3200);
      }
    }
  }

  // ---------- views ----------
  // ---------- share ----------
  function listingUrl(l) { return location.origin + location.pathname + "#listing=" + encodeURIComponent(l.id); }
  function wireShare(l) {
    const url = listingUrl(l);
    const text = l.title + " · " + inr(l.rent) + "/month · " + (l.locality || "") + ", " + (l.city || "");
    const wa = "https://wa.me/?text=" + encodeURIComponent(text + " " + url);
    $("#waShare").href = wa;
    $("#shareBtn").addEventListener("click", async () => {
      if (navigator.share) {
        try { await navigator.share({ title: l.title, text: text, url: url }); return; }
        catch (e) { if (e && e.name === "AbortError") return; }
      }
      window.open(wa, "_blank", "noopener");
    });
    $("#copyLinkBtn").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(url); toast("Link copied"); }
      catch (e) { window.prompt("Copy this link", url); }
    });
  }

  // ---------- reviews ----------
  const starText = (n) => "★".repeat(Math.round(n)) + "☆".repeat(5 - Math.round(n));
  async function loadReviews(l) {
    const box = $("#reviewsBox");
    function paint(list) {
      const avg = l.rating;
      const head = list.length
        ? '<div class="rev-head"><strong>' + starText(avg || 0) + "</strong> " + Number(avg).toFixed(1) + " · " + list.length + " review" + (list.length === 1 ? "" : "s") + "</div>"
        : '<p class="muted small">No reviews yet.</p>';
      const items = list.map((r) => '<div class="rev"><div class="rev-top"><strong>' + starText(r.rating) + '</strong> <span class="muted small">' + esc(r.author) + " · " + esc(new Date(r.created_at).toLocaleDateString("en-IN")) + "</span></div>" + (r.comment ? '<div class="rev-body">' + esc(r.comment) + "</div>" : "") + "</div>").join("");
      let form = "";
      if (!state.user) form = '<p class="muted small">Log in as a renter to leave a review.</p>';
      else if (state.user.role === "renter") form = '<form id="reviewForm" class="rev-form"><div class="rev-stars" id="revStars">' + [1,2,3,4,5].map((n) => '<button type="button" class="star" data-n="' + n + '" aria-label="' + n + ' stars">★</button>').join("") + '</div><textarea name="comment" rows="2" maxlength="500" placeholder="Short comment (optional)"></textarea><button class="btn primary" type="submit" id="reviewSubmit">Post review</button><p id="reviewErr" class="error small" hidden></p></form>';
      box.innerHTML = head + items + form;
      let picked = 0;
      $$("#revStars .star").forEach((b) => b.addEventListener("click", () => { picked = Number(b.dataset.n); $$("#revStars .star").forEach((x) => x.classList.toggle("on", Number(x.dataset.n) <= picked)); }));
      const f = $("#reviewForm");
      if (f) f.addEventListener("submit", async (e) => {
        e.preventDefault();
        const err = $("#reviewErr"); err.hidden = true;
        if (!picked) { err.textContent = "Tap a star rating first."; err.hidden = false; return; }
        const btn = $("#reviewSubmit"); btn.disabled = true;
        try {
          const j = await api("/api/listings/" + encodeURIComponent(l.id) + "/reviews", { rating: picked, comment: f.elements.comment.value.trim() });
          toast("Review posted"); loadReviews(j.listing ? Object.assign(l, j.listing, { __reviews: null }) : l);
        } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
      });
    }
    try {
      const j = await api("/api/listings/" + encodeURIComponent(l.id));
      l.rating = j.listing.rating; l.review_count = j.listing.review_count;
      paint(j.reviews || []);
    } catch (e) { box.innerHTML = '<p class="muted small">Reviews unavailable.</p>'; }
  }
  // Open a shared link: #listing=ID opens that live listing's detail.
  function openFromHash() {
    const m = /^#listing=(.+)$/.exec(location.hash || "");
    if (!m) return;
    api("/api/listings/" + encodeURIComponent(decodeURIComponent(m[1]))).then((j) => openDetail(j.listing)).catch(() => toast("That listing is not available"));
  }
  window.addEventListener("hashchange", openFromHash);


  function openView(id) { $("#" + id).hidden = false; document.body.style.overflow = "hidden"; $("#" + id).scrollTop = 0; }
  function closeView(id) { $("#" + id).hidden = true; if (!$$(".sheet, .modal").some((el) => !el.hidden)) document.body.style.overflow = ""; }
  $$("[data-close]").forEach((b) => b.addEventListener("click", () => closeView(b.dataset.close)));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") $$(".sheet, .modal").forEach((el) => { if (!el.hidden) closeView(el.id); }); });

  // ---------- search (area or landmark, across all seed data, India-wide) ----------
  function allPlaces() {
    const places = [], seen = new Set();
    SEED_LISTINGS.forEach((l) => {
      const key = l.locality.toLowerCase() + "|" + l.city.toLowerCase();
      if (!seen.has(key)) { seen.add(key); places.push({ name: l.locality, kind: "Area", sub: l.city, lat: l.lat, lng: l.lng }); }
    });
    LANDMARKS.forEach((p) => places.push({ name: p.name, kind: "Landmark", sub: p.city, lat: p.lat, lng: p.lng }));
    return places;
  }
  function suggestions(q) {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    const pool = allPlaces();
    const starts = pool.filter((p) => p.name.toLowerCase().startsWith(s));
    const contains = pool.filter((p) => !starts.includes(p) && p.name.toLowerCase().includes(s));
    return starts.concat(contains).slice(0, 7);
  }
  function renderSuggest() {
    const items = suggestions($("#searchInput").value);
    const ul = $("#suggest");
    if (!items.length) { ul.hidden = true; ul.innerHTML = ""; return; }
    ul.innerHTML = items.map((p, i) => '<li role="option" data-i="' + i + '"><span>' + esc(p.name) + '</span><span class="sg-kind">' + esc(p.sub) + "</span></li>").join("");
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
    notice("Sorted by distance from " + p.name + ".");
    map.setView([p.lat, p.lng], 14);
    refresh({ fit: false });
  }
  function doSearch() {
    $("#suggest").hidden = true;
    const q = $("#searchInput").value.trim();
    if (!q) { notice(""); state.ref = null; placeRefMarker(); refresh({ fit: true }); return; }
    const hit = suggestions(q)[0] || allPlaces().find((p) => p.name.toLowerCase() === q.toLowerCase());
    if (hit) return applyPlace(hit);
    notice('No match for "' + q + '". Try Indiranagar, Bandra, Connaught Place or Salt Lake.');
  }
  $("#searchInput").addEventListener("input", renderSuggest);
  $("#searchInput").addEventListener("blur", () => setTimeout(() => { $("#suggest").hidden = true; }, 150));
  $("#searchInput").addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });

  function placeRefMarker() {
    if (refMarker) map.removeLayer(refMarker);
    refMarker = null;
    if (!state.ref) return;
    refMarker = L.circleMarker([state.ref.lat, state.ref.lng], { radius: 7, color: "#0f172a", weight: 2, fillColor: "#fff", fillOpacity: 1 })
      .addTo(map).bindTooltip(state.ref.label || "search point");
  }
  function useMyLocation() {
    if (!navigator.geolocation) { notice("This browser has no location support. Search by area name instead."); return; }
    notice("Finding your location...");
    navigator.geolocation.getCurrentPosition((pos) => {
      const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      state.ref = { lat: p.lat, lng: p.lng, label: "you" };
      if (userMarker) map.removeLayer(userMarker);
      userMarker = L.marker([p.lat, p.lng], { icon: L.divIcon({ className: "", html: '<div class="pin user"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }) }).addTo(map);
      placeRefMarker();
      notice("Sorted by distance from you.");
      map.setView([p.lat, p.lng], 14);
      refresh({ fit: false });
    }, (err) => {
      notice((err && err.code === 1 ? "Location permission was denied." : "Could not get your location.") + " You can still search by area name.");
    }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
  }
  $("#locBtn").addEventListener("click", useMyLocation);

  ["#bhkFilter", "#rentFilter", "#furnFilter", "#balconyFilter", "#verifiedFilter", "#sortSelect"].forEach((s) => $(s).addEventListener("change", () => refresh({ fit: false })));
  $("#resetFilters").addEventListener("click", () => {
    ["#bhkFilter", "#rentFilter", "#furnFilter", "#balconyFilter"].forEach((s) => { $(s).value = ""; });
    $("#verifiedFilter").checked = false;
    refresh({ fit: false });
  });

  // ---------- account + the contact gate ----------
  // openGate(mode, next): the login/signup modal. `next` runs after a successful login.
  // gate: true when opened from View number (shows the 10 free credits badge).
  // owner: true when the owner sign-up path was chosen, which sets the role to owner.
  function openGate(mode, next, opts) {
    state.gateNext = next || null;
    setAuthMode(mode || "login", Object.assign({ gate: !!next }, opts || {}));
    openView("authView");
  }
  function setAuthMode(mode, opts) {
    opts = opts || {};
    state.authMode = mode;
    const signup = mode === "signup";
    $("#authTitle").textContent = signup
      ? (opts.owner ? "List your property" : "Create your free account")
      : (opts.owner ? "Log in to list your property" : "Login to view owner's contact");
    $("#authSub").textContent = signup
      ? (opts.owner ? "Owners only. Brokers and agents are not allowed." : "Renters get 10 free call credits. One credit unlocks one owner contact.")
      : (opts.owner ? "Owners log in to post a property. Brokers are not allowed." : "Log in or create a free account in seconds.");
    $("#authSubmit").textContent = signup ? "Create account" : "Continue";
    $("#authSwitch").textContent = signup ? "Already have an account? Log in" : "New here? Create a free account";
    $("#signupFields").hidden = !signup;
    $("#authError").hidden = true;
    $("#authForm").elements.password.setAttribute("autocomplete", signup ? "new-password" : "current-password");
    $(".gate-badge").hidden = !opts.gate;
    const roleWant = opts.owner ? "owner" : "renter";
    $$("#authForm input[name=role]").forEach((r) => { r.checked = r.value === roleWant; });
  }
  $("#authSwitch").addEventListener("click", () => setAuthMode(state.authMode === "signup" ? "login" : "signup"));
  $("#authForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = { email: f.get("email"), password: f.get("password") };
    if (state.authMode === "signup") Object.assign(body, { name: f.get("name"), phone: f.get("phone"), role: f.get("role") });
    const submit = $("#authSubmit"); submit.disabled = true;
    try {
      const j = await api(state.authMode === "signup" ? "/api/auth/signup" : "/api/auth/login", body);
      state.user = j.user; state.credits = j.credits || 0;
      closeView("authView"); e.target.reset(); updateAccount();
      if (state.user.role === "renter" && state.authMode === "signup") toast("Account ready. You have " + FREE_CREDITS + " free call credits.", 3400);
      const next = state.gateNext; state.gateNext = null;
      if (state.user.role === "owner" && !next) openPost();
      if (state.selectedId && !$("#detailView").hidden) { const sel = state.listings.find((x) => x.id === state.selectedId); if (sel) renderCallBox(sel); }
      if (next) next();
    } catch (err) {
      $("#authError").textContent = err.message; $("#authError").hidden = false;
    } finally { submit.disabled = false; }
  });

  function updateAccount() {
    const a = $("#accountArea");
    if (!state.user) {
      a.innerHTML = '<button class="btn primary small-btn" id="listBtn">List property</button>';
      $("#listBtn").addEventListener("click", () => { if (state.user) openPost(); else openGate("signup", null, { owner: true }); });
      return;
    }
    if (state.user.role === "renter") {
      const badge = state.user.pass_active
        ? '<span class="pass-badge on" id="passBadge">Pass · ' + plural(state.user.pass_days_left || 0, "day") + " left</span>"
        : '<button class="pass-badge off" id="passBadge">Locked · Get pass</button>';
      a.innerHTML = badge + '<button class="link-btn" id="logoutBtn">Log out</button>';
      const pb = $("#passBadge");
      if (!state.user.pass_active) pb.addEventListener("click", buyPass);
    } else {
      a.innerHTML = '<button class="btn primary small-btn" id="postBtn">Post a property</button><button class="link-btn" id="logoutBtn">Log out</button>';
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
    if (!state.user) { openGate("login", () => openCredits()); return; }
    if (state.user.role !== "renter") { toast("Credits are for renter accounts."); return; }
    $("#creditsNow").textContent = plural(state.credits, "credit");
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
        else if (s.kind === "pass") { await refreshMe(); toast("Weekly Pass active for " + PASS_DAYS + " days. Owner numbers and photos are unlocked.", 4200); if (state.selectedId) { const sel = state.listings.find((x) => x.id === state.selectedId); if (sel) openDetail(sel); } }
        else toast("Payment received.", 3200);
      } catch (e) { toast("Payment received. Refresh to see your balance.", 3200); }
    } else if (result === "failed") toast("Payment failed or was cancelled. Nothing was charged to your listing or credits.", 4200);
    else toast("Payment could not be verified. Nothing was added. Contact support with reference " + txnid + ".", 5200);
  }

  // ---------- owner: post a property ----------
  let pickMap = null, pickMarker = null, currentDraftId = null;
  function initPickMap() {
    if (pickMap) { pickMap.invalidateSize(); return; }
    pickMap = L.map("pickMap", { zoomControl: true }).setView([INDIA_VIEW.lat, INDIA_VIEW.lng], INDIA_VIEW.zoom);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(pickMap);
    pickMap.on("click", (e) => {
      state.pinLatLng = { lat: e.latlng.lat, lng: e.latlng.lng };
      if (pickMarker) pickMap.removeLayer(pickMarker);
      pickMarker = L.circleMarker([e.latlng.lat, e.latlng.lng], { radius: 9, color: "#fff", weight: 3, fillColor: "#0f766e", fillOpacity: 1 }).addTo(pickMap);
      $("#pinStatus").textContent = "Pinned";
      $("#pinStatus").classList.add("ok");
    });
    setTimeout(() => pickMap.invalidateSize(), 80);
  }
  function openPost() {
    if (!state.user) { openGate("signup", null, { owner: true }); return; }
    if (state.user.role !== "owner") { toast("Post with an owner account. Log out and sign up as an owner."); return; }
    $("#postForm").reset();
    state.pinLatLng = null; currentDraftId = null; videoOk = false;
    if (pickMarker && pickMap) { pickMap.removeLayer(pickMarker); pickMarker = null; }
    $("#pinStatus").textContent = "Not pinned yet"; $("#pinStatus").classList.remove("ok");
    $("#photoNote").textContent = "No photos selected."; $("#videoNote").textContent = "No video selected.";
    $("#areaNote").textContent = "";
    $("#formError").hidden = true;
    openView("postView"); initPickMap(); loadMyListings(); loadPromo();
  }
  // Free-text city/town with suggestions from the landmark + seed list (any text is accepted).
  (function wireCityInput() {
    const input = $("#postForm [name=city]");
    const dl = $("#cityList");
    if (!input || !dl) return;
    const names = Array.from(new Set(SEED_LISTINGS.map((l) => l.city).concat(LANDMARKS.map((p) => p.city)))).sort();
    dl.innerHTML = names.map((n) => '<option value="' + esc(n) + '"></option>').join("");
  })();
  $("#postForm [name=area_sqm]").addEventListener("input", (e) => {
    const sqm = Number(e.target.value);
    $("#areaNote").textContent = sqm > 0 ? "≈ " + Math.round(sqm * SQM_TO_SQFT) + " sq ft" : "";
  });
  function refreshFeeLabel() {
    const rent = $("#postForm [name=rent]").value;
    const code = $("#postForm [name=promo_code]").value.trim().toUpperCase();
    const info = state.promo || { total: 0, remaining: 0 };
    let label = "10% of rent = " + inr(feeFor(rent)) + " listing fee";
    if (code === PROMO_CODE) {
      label = info.remaining > 0 ? "Free with FIRST1000 · " + info.remaining + " of " + info.total + " free slots left" : "FIRST1000 is used up · " + inr(feeFor(rent)) + " listing fee";
    }
    $("#feeNote").textContent = label;
    $("#postSubmit").textContent = "Continue to payment";
  }
  $("#postForm [name=rent]").addEventListener("input", refreshFeeLabel);
  $("#postForm [name=promo_code]").addEventListener("input", refreshFeeLabel);
  async function loadPromo() {
    try { const j = await api("/api/promo"); state.promo = j.promo; } catch (e) { state.promo = null; }
    refreshFeeLabel();
  }
  $("#postForm [name=photos]").addEventListener("change", (e) => {
    const n = e.target.files.length;
    let msg = n ? n + " photo" + (n === 1 ? "" : "s") + " selected." : "No photos selected.";
    if (n > MAX_PHOTOS) msg += " Only the first " + MAX_PHOTOS + " are used.";
    if (n && n < MIN_PHOTOS) msg += " Add at least " + MIN_PHOTOS + ".";
    $("#photoNote").textContent = msg;
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
    if (photos.length < MIN_PHOTOS) return showError("Add at least " + MIN_PHOTOS + " photos.");
    if (!video) return showError("Add a video of the place.");
    if (!videoOk) return showError("The video could not be checked. Pick a video under " + MAX_VIDEO_SECONDS + " seconds.");
    if (!get("title")) return showError("Add a title.");
    if (!get("city")) return showError("Type the city or town the place is in.");
    if (!get("locality")) return showError("Add the locality.");
    if (!state.pinLatLng) return showError("Drop the pin on your building on the map.");
    if (!get("rent")) return showError("Enter the monthly rent.");
    if (get("deposit") === "") return showError("Enter the deposit (0 if none).");
    if (!get("bhk")) return showError("Pick the BHK type.");
    if (!get("bathrooms")) return showError("Pick the number of bathrooms.");
    if (!get("area_sqm")) return showError("Enter the total area in square metres.");
    if (!get("balcony")) return showError("Say whether there is a balcony.");
    if (!get("furnishing")) return showError("Pick the furnishing.");
    if (!form.elements.owner_confirm.checked) return showError("Tick the owner confirmation. Brokers and agents cannot post.");

    const btn = $("#postSubmit");
    btn.disabled = true; btn.textContent = "Saving...";
    try {
      const created = await api("/api/listings", {
        title: get("title"), city: get("city"), locality: get("locality"),
        lat: state.pinLatLng.lat, lng: state.pinLatLng.lng, bhk: get("bhk"), bathrooms: get("bathrooms"),
        area_sqm: get("area_sqm"), balcony: get("balcony"), rent: get("rent"), deposit: get("deposit"),
        furnishing: get("furnishing"), description: get("description")
      });
      const id = created.listing.id;
      currentDraftId = id;
      for (const p of photos.slice(0, MAX_PHOTOS)) await uploadMedia(id, "photo", p);
      await uploadMedia(id, "video", video);
      const sub = await api("/api/listings/" + encodeURIComponent(id) + "/submit", { owner_confirm: true, promo_code: get("promo_code") });
      state.draft = { id, title: sub.listing.title, fee: (sub.listing.fee_paise || 0) / 100, free: !!(sub.promo && sub.promo.applied) };
      $("#payTitle").textContent = state.draft.title;
      if (state.draft.free) {
        $("#payFee").textContent = "₹0 (FIRST1000)";
        $("#payNow").textContent = "Publish free";
        $("#payPromoNote").textContent = "FIRST1000 applied. " + sub.promo.remaining + " free slots left out of " + sub.promo.total + ".";
      } else {
        $("#payFee").textContent = inr(state.draft.fee) + " (10% of " + inr(sub.listing.rent) + " rent)";
        $("#payNow").textContent = "Pay with PayU";
        $("#payPromoNote").textContent = sub.promo && sub.promo.sold_out ? "FIRST1000 is used up. The 10% fee applies." : "";
      }
      closeView("postView");
      openView("payView");
    } catch (e) {
      showError(e.message);
    } finally { btn.disabled = false; btn.textContent = "Continue to payment"; }
  });

  $("#payNow").addEventListener("click", async () => {
    const d = state.draft;
    if (!d) return;
    const btn = $("#payNow");
    const status = (m) => { $("#payStatus").textContent = m; };
    if (d.free) {
      btn.disabled = true; status("Publishing...");
      try { await api("/api/listings/" + encodeURIComponent(d.id) + "/pay/free", {}); status("Sent for approval."); closeView("payView"); toast("Listing sent for approval"); }
      catch (e) { status("Could not publish: " + e.message); }
      finally { btn.disabled = false; }
      return;
    }
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
      box.innerHTML = j.listings.length ? '<h3 style="margin:20px 0 6px">Your listings</h3>' + j.listings.map((l) =>
        '<div class="mine"><strong>' + esc(l.title) + "</strong> · " + esc(l.locality) + " · " + inr(l.rent) + ' <span class="status s-' + esc(l.status) + '">' + esc(l.status.replace("_", " ")) + "</span>" +
        (l.reject_reason ? '<div class="error small">' + esc(l.reject_reason) + "</div>" : "") + "</div>").join("") : "";
    } catch (e) { box.innerHTML = ""; }
  }

  // ---------- boot ----------
  // Visitor's spot (if they allow it) centres the map at city zoom. Otherwise the map fits all listings across India.
  function visitorSpot() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        () => resolve(null),
        { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 }
      );
    });
  }
  (async function boot() {
    const [, , , spot] = await Promise.all([restoreSession(), handlePayuReturn(), loadListings(), visitorSpot()]);
    if (spot) map.setView([spot.lat, spot.lng], 12);
    refresh({ fit: !spot });
  })();
})();
