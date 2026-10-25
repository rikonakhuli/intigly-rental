/* Admin dashboard: approve or reject owner listings. Admin role is checked on the server. */
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  let status = "pending_approval";
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const inr = (n) => "₹" + Number(n).toLocaleString("en-IN");

  async function api(url, body) {
    const r = await fetch(url, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined, credentials: "same-origin" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || "Request failed"), { status: r.status });
    return j;
  }

  async function load() {
    $("#adminMsg").textContent = "";
    try {
      const j = await api("/api/admin/listings?status=" + encodeURIComponent(status));
      $("#adminLogin").hidden = true;
      $("#adminMsg").textContent = "Counts: " + Object.entries(j.counts || {}).map(([k, v]) => k + " " + v).join(", ");
      const list = j.listings || [];
      $("#adminList").innerHTML = list.length ? list.map((l) =>
        '<article class="admin-card" data-id="' + esc(l.id) + '">' +
        '<div class="rent">' + inr(l.rent) + ' <span class="meta">/ month · deposit ' + inr(l.deposit) + '</span></div>' +
        '<div class="title">' + esc(l.title) + '</div>' +
        '<div class="meta">' + esc(l.city) + ' · ' + esc(l.locality) + ' · ' + esc(l.bhk) + ' BHK · ' + l.bathrooms + ' bath · ' + l.area_sqm + ' sq m · balcony ' + (l.balcony ? 'yes' : 'no') + '</div>' +
        '<div class="meta">photos ' + l.photos.length + ' · videos ' + l.videos.length + ' · owner phone ' + esc(l.owner_phone_masked || '-') + '</div>' +
        '<p class="desc">' + esc(l.description) + '</p>' +
        (l.status === 'pending_approval' ? '<div class="admin-actions"><button class="btn primary" data-act="approve">Approve and go live</button><button class="btn" data-act="reject">Reject</button></div>' : '<div class="meta">status: ' + esc(l.status) + '</div>') +
        '</article>').join("") : '<p class="muted">Nothing in this queue.</p>';
    } catch (e) {
      if (e.status === 401 || e.status === 403) {
        $("#adminLogin").hidden = false;
        $("#adminList").innerHTML = "";
        $("#adminMsg").textContent = e.status === 403 ? "This account is not an admin." : "Log in as admin.";
      } else {
        $("#adminMsg").textContent = "Error: " + e.message;
      }
    }
  }

  document.querySelectorAll("[data-status]").forEach((b) => b.addEventListener("click", () => {
    status = b.dataset.status;
    document.querySelectorAll("[data-status]").forEach((x) => x.classList.toggle("active", x === b));
    load();
  }));

  $("#adminList").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const id = btn.closest("[data-id]").dataset.id;
    const act = btn.dataset.act;
    let reason = "";
    if (act === "reject") { reason = prompt("Reason for rejecting (shown to the owner):") || ""; if (!reason) return; }
    try {
      await api("/api/admin/listings/" + encodeURIComponent(id) + "/" + act, { reason });
      load();
    } catch (err) { $("#adminMsg").textContent = "Error: " + err.message; }
  });

  $("#adminLoginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api("/api/auth/login", { email: f.get("email"), password: f.get("password") });
      load();
    } catch (err) { $("#adminMsg").textContent = err.message; }
  });

  load();
})();
