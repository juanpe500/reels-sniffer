/* Reels Sniffer — leaderboard page.
 * Two views:
 *   • Users overview  — one card per scanned profile (reel count, top views, date)
 *   • Leaderboard     — a user's reels ranked high→low by view count
 * Data lives in chrome.storage.local under rs_data. A 9:16 embed modal lets you
 * play any reel and step through the ranking.
 */
(() => {
  "use strict";

  const STORE_KEY = "rs_data";

  const el = {
    count: document.getElementById("count"),
    crumb: document.getElementById("crumb"),
    brand: document.getElementById("brand"),
    users: document.getElementById("users"),
    lead: document.getElementById("lead"),
    empty: document.getElementById("empty"),
    pager: document.getElementById("pager"),
    searchWrap: document.getElementById("searchWrap"),
    search: document.getElementById("search"),
    sortMode: document.getElementById("sortMode"),
    perpage: document.getElementById("perpage"),
    json: document.getElementById("json"),
    csv: document.getElementById("csv"),
    back: document.getElementById("back"),
    modalBack: document.getElementById("modalBack"),
    modal: document.getElementById("modal"),
    modalFrame: document.getElementById("modalFrame"),
    modalClose: document.getElementById("modalClose"),
    modalOpen: document.getElementById("modalOpen"),
    modalGrip: document.getElementById("modalGrip"),
    mvTitle: document.getElementById("mvTitle"),
    mvPrev: document.getElementById("mvPrev"),
    mvNext: document.getElementById("mvNext"),
  };

  let data = {};              // full rs_data map
  let view = "users";         // "users" | "lead"
  let currentUser = null;
  let ranked = [];            // reels of currentUser, filtered + sorted
  let page = 1;
  let perPage = 24;
  let query = "";
  let sortMode = "views-desc";

  // ---- formatting ----
  function fmtViews(n) {
    if (n == null) return "—";
    if (n >= 1e6) return trim(n / 1e6) + "M";
    if (n >= 1e3) return trim(n / 1e3) + "K";
    return String(n);
  }
  function trim(x) { return (Math.round(x * 10) / 10).toString(); }
  function fmtFull(n) { return n == null ? "no count" : n.toLocaleString("en-US") + " views"; }
  function fmtDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) +
      " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }

  // ---- load ----
  async function load() {
    const r = await chrome.storage.local.get(STORE_KEY);
    data = r[STORE_KEY] || {};
    if (currentUser && !data[currentUser]) { currentUser = null; view = "users"; }
    routeFromHash();
    render();
  }

  function userStats(u) {
    const reels = Object.values(u.reels || {});
    const withV = reels.filter((r) => r.views != null);
    const top = withV.reduce((mx, r) => (r.views > mx ? r.views : mx), 0);
    const total = withV.reduce((s, r) => s + r.views, 0);
    return { n: reels.length, withV: withV.length, top, total };
  }

  // ---- render dispatch ----
  function render() {
    const names = Object.keys(data);
    el.count.textContent = String(names.length);
    if (view === "lead" && currentUser && data[currentUser]) renderLeaderboard();
    else renderUsers();
  }

  function toggleHeaderControls(inLead) {
    for (const node of [el.searchWrap, el.sortMode, el.perpage, el.json, el.csv, el.back]) {
      node.style.display = inLead ? "" : "none";
    }
    el.searchWrap.style.display = inLead ? "" : "none";
  }

  // ---- users overview ----
  function renderUsers() {
    view = "users";
    currentUser = null;
    toggleHeaderControls(false);
    el.crumb.textContent = "";
    el.lead.style.display = "none";
    el.pager.innerHTML = "";
    const names = Object.keys(data).sort((a, b) => userStats(data[b]).top - userStats(data[a]).top);

    if (!names.length) {
      el.users.style.display = "none";
      el.empty.style.display = "";
      el.empty.querySelector("h2").textContent = "No users scanned yet";
      return;
    }
    el.empty.style.display = "none";
    el.users.style.display = "";

    const frag = document.createDocumentFragment();
    for (const name of names) {
      const u = data[name];
      const s = userStats(u);
      const c = document.createElement("div");
      c.className = "ucard";
      c.onclick = (e) => { if (e.target.closest(".udel")) return; openUser(name); };
      c.innerHTML = `
        <div class="uname">@${escapeHtml(name)}</div>
        <div class="urow"><span class="lbl">Reels</span><span class="val">${s.n}</span></div>
        <div class="urow"><span class="lbl">Top views</span><span class="val top">${fmtViews(s.top)}</span></div>
        <div class="urow"><span class="lbl">Total views</span><span class="val">${fmtViews(s.total)}</span></div>
        <div class="udate">scanned ${fmtDate(u.scanned_at)}</div>
        <button class="udel" title="Delete this user's data">×</button>
      `;
      c.querySelector(".udel").onclick = (e) => { e.stopPropagation(); deleteUser(name); };
      frag.appendChild(c);
    }
    el.users.replaceChildren(frag);
  }

  // ---- leaderboard ----
  function openUser(name) {
    currentUser = name;
    view = "lead";
    page = 1;
    query = "";
    el.search.value = "";
    location.hash = "u=" + encodeURIComponent(name);
    render();
  }

  function computeRanked() {
    const u = data[currentUser];
    let list = Object.values(u.reels || {});
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((r) => (r.shortcode || "").toLowerCase().includes(q));
    const cmp = {
      "views-desc": (a, b) => (b.views ?? -1) - (a.views ?? -1),
      "views-asc": (a, b) => (a.views ?? Infinity) - (b.views ?? Infinity),
      "recent": (a, b) => (b.captured_at || "").localeCompare(a.captured_at || ""),
    }[sortMode];
    list.sort(cmp);
    ranked = list;
  }

  function renderLeaderboard() {
    view = "lead";
    toggleHeaderControls(true);
    el.users.style.display = "none";
    el.empty.style.display = "none";
    el.lead.style.display = "";

    const s = userStats(data[currentUser]);
    el.crumb.innerHTML = `<b>@${escapeHtml(currentUser)}</b> · ${s.n} reels · top ${fmtViews(s.top)} · scanned ${fmtDate(data[currentUser].scanned_at)}`;

    computeRanked();

    if (!ranked.length) {
      el.lead.innerHTML = "";
      el.pager.innerHTML = "";
      el.empty.style.display = "";
      el.empty.querySelector("h2").textContent = query ? "No matches" : "No reels stored";
      return;
    }

    const start = (page - 1) * perPage;
    const slice = ranked.slice(start, start + perPage);
    const frag = document.createDocumentFragment();
    slice.forEach((r, i) => frag.appendChild(reelCard(r, start + i)));
    el.lead.replaceChildren(frag);
    renderPager();
  }

  const EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>';

  function reelCard(r, index) {
    const rank = index + 1; // rank within the current sort
    const c = document.createElement("div");
    c.className = "rcard";

    const thumb = document.createElement("div");
    thumb.className = "thumb";
    thumb.onclick = () => openModal(r);

    if (r.image) {
      const img = document.createElement("img");
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      img.src = r.image;
      img.alt = r.alt || "";
      img.onerror = () => {
        img.remove();
        const ph = document.createElement("div");
        ph.className = "ph";
        ph.textContent = "thumbnail expired — click to play ▶";
        thumb.appendChild(ph);
      };
      thumb.appendChild(img);
    } else {
      const ph = document.createElement("div");
      ph.className = "ph";
      ph.textContent = "no thumbnail — click to play ▶";
      thumb.appendChild(ph);
    }

    const rk = document.createElement("span");
    rk.className = "rank" + (sortMode === "views-desc" && rank <= 3 ? " g" + rank : "");
    rk.textContent = "#" + rank;
    thumb.appendChild(rk);

    const vb = document.createElement("span");
    vb.className = "views-badge";
    vb.title = fmtFull(r.views);
    vb.innerHTML = EYE + "<span>" + fmtViews(r.views) + "</span>";
    thumb.appendChild(vb);

    const body = document.createElement("div");
    body.className = "rbody";
    const open = document.createElement("a");
    open.className = "open";
    open.href = r.url;
    open.target = "_blank";
    open.rel = "noopener";
    open.textContent = "Open ↗";
    open.onclick = (e) => { e.preventDefault(); openModal(r); };
    const code = document.createElement("span");
    code.className = "code";
    code.textContent = r.shortcode || "";
    body.append(open, code);

    c.append(thumb, body);
    return c;
  }

  function renderPager() {
    const maxPage = Math.ceil(ranked.length / perPage);
    el.pager.innerHTML = "";
    if (maxPage <= 1) {
      const info = document.createElement("span");
      info.className = "pageinfo";
      info.textContent = ranked.length + " reel" + (ranked.length === 1 ? "" : "s");
      el.pager.appendChild(info);
      return;
    }
    const mk = (label, target, disabled) => {
      const b = document.createElement("button");
      b.className = "btn";
      b.textContent = label;
      if (disabled) b.disabled = true;
      else b.onclick = () => { page = target; renderLeaderboard(); window.scrollTo({ top: 0, behavior: "smooth" }); };
      return b;
    };
    el.pager.appendChild(mk("« First", 1, page === 1));
    el.pager.appendChild(mk("‹ Prev", page - 1, page === 1));
    const info = document.createElement("span");
    info.className = "pageinfo";
    const from = (page - 1) * perPage + 1;
    const to = Math.min(page * perPage, ranked.length);
    info.textContent = `${from}–${to} of ${ranked.length} · page ${page}/${maxPage}`;
    el.pager.appendChild(info);
    el.pager.appendChild(mk("Next ›", page + 1, page === maxPage));
    el.pager.appendChild(mk("Last »", maxPage, page === maxPage));
  }

  // ---- mutations ----
  async function deleteUser(name) {
    if (!confirm("Delete all stored reels for @" + name + "? This cannot be undone.")) return;
    const r = await chrome.storage.local.get(STORE_KEY);
    const map = r[STORE_KEY] || {};
    delete map[name];
    await chrome.storage.local.set({ [STORE_KEY]: map });
    // storage.onChanged reloads.
  }

  // ---- embed modal ----
  let modalIndex = -1;
  let wheelLock = false;
  const MODAL_SIZE_KEY = "rs_modal_size";

  function embedUrl(url) {
    const base = String(url || "").split("?")[0].replace(/\/+$/, "");
    return base + "/embed/";
  }
  function availStageH() {
    const tb = document.getElementById("mvTopbar").offsetHeight || 0;
    return Math.max(300, window.innerHeight - tb - 24);
  }
  function defaultModalSize() {
    const h = Math.min(availStageH(), 860);
    return { w: Math.round((h * 9) / 16), h: Math.round(h) };
  }
  function applyModalSize(s) {
    const maxW = window.innerWidth - 24, maxH = availStageH();
    el.modal.style.width = Math.max(220, Math.min(s.w, maxW)) + "px";
    el.modal.style.height = Math.max(300, Math.min(s.h, maxH)) + "px";
  }
  function loadModalSize() {
    try { const s = JSON.parse(localStorage.getItem(MODAL_SIZE_KEY)); if (s && s.w && s.h) return s; } catch {}
    return defaultModalSize();
  }
  function saveModalSize() {
    try { localStorage.setItem(MODAL_SIZE_KEY, JSON.stringify({ w: el.modal.offsetWidth, h: el.modal.offsetHeight })); } catch {}
  }

  function showAt(i) {
    if (i < 0 || i >= ranked.length) return;
    modalIndex = i;
    const r = ranked[i];
    el.modalFrame.src = embedUrl(r.url);
    el.modalOpen.href = r.url;
    el.mvTitle.innerHTML = `#${i + 1} · <span class="v">${fmtViews(r.views)}</span> · ${escapeHtml(r.shortcode || "")}`;
    el.mvPrev.disabled = i <= 0;
    el.mvNext.disabled = i >= ranked.length - 1;
    if (!el.modal.classList.contains("resizing")) applyModalSize(loadModalSize());
  }
  function openModal(r) {
    if (!r || !r.url) return;
    el.modal.style.position = "";
    el.modal.style.left = "";
    el.modal.style.top = "";
    el.modalBack.classList.add("show");
    const idx = ranked.indexOf(r);
    if (idx >= 0) showAt(idx);
    else {
      modalIndex = -1;
      el.modalFrame.src = embedUrl(r.url);
      el.modalOpen.href = r.url;
      el.mvTitle.textContent = r.shortcode || "";
      el.mvPrev.disabled = el.mvNext.disabled = true;
      applyModalSize(loadModalSize());
    }
  }
  function closeModal() {
    el.modalBack.classList.remove("show");
    el.modalFrame.src = "about:blank";
    modalIndex = -1;
  }
  function step(dir) {
    if (modalIndex < 0) return;
    const n = modalIndex + dir;
    if (n < 0 || n >= ranked.length) return;
    showAt(n);
  }

  el.modalClose.addEventListener("click", closeModal);
  el.modalBack.addEventListener("click", (e) => { if (e.target === el.modalBack) closeModal(); });
  el.mvPrev.addEventListener("click", () => step(-1));
  el.mvNext.addEventListener("click", () => step(1));
  document.addEventListener("keydown", (e) => {
    if (!el.modalBack.classList.contains("show")) return;
    if (e.key === "Escape") closeModal();
    else if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); step(1); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); step(-1); }
  });
  el.modalBack.addEventListener("wheel", (e) => {
    if (e.target.closest("#mvTopbar")) return;
    e.preventDefault();
    if (wheelLock || Math.abs(e.deltaY) < 8) return;
    wheelLock = true;
    step(e.deltaY > 0 ? 1 : -1);
    setTimeout(() => { wheelLock = false; }, 260);
  }, { passive: false });
  el.modalGrip.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, sw = el.modal.offsetWidth, sh = el.modal.offsetHeight;
    const rect = el.modal.getBoundingClientRect();
    el.modal.style.position = "absolute";
    el.modal.style.left = rect.left + "px";
    el.modal.style.top = rect.top + "px";
    el.modal.classList.add("resizing");
    const onMove = (ev) => applyModalSize({ w: sw + (ev.clientX - sx), h: sh + (ev.clientY - sy) });
    const onUp = () => {
      el.modal.classList.remove("resizing");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      saveModalSize();
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  // ---- export ----
  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function stamp() {
    const d = new Date(), p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes());
  }
  function csvCell(v) { return '"' + (v == null ? "" : String(v)).replace(/"/g, '""') + '"'; }

  function exportJSON() {
    if (!currentUser) return;
    computeRanked();
    download("reels_" + currentUser + "_" + stamp() + ".json",
      JSON.stringify({ username: currentUser, scanned_at: data[currentUser].scanned_at, reels: ranked }, null, 2),
      "application/json");
  }
  function exportCSV() {
    if (!currentUser) return;
    computeRanked();
    const cols = ["rank", "views", "shortcode", "url", "captured_at"];
    const lines = [cols.join(",")];
    ranked.forEach((r, i) => {
      lines.push([i + 1, r.views == null ? "" : r.views, csvCell(r.shortcode), csvCell(r.url), csvCell(r.captured_at)].join(","));
    });
    download("reels_" + currentUser + "_" + stamp() + ".csv", "﻿" + lines.join("\r\n"), "text/csv");
  }

  // ---- misc ----
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function routeFromHash() {
    const m = location.hash.match(/u=([^&]+)/);
    if (m) {
      const name = decodeURIComponent(m[1]);
      if (data[name]) { currentUser = name; view = "lead"; return; }
    }
    view = "users";
    currentUser = null;
  }

  // ---- events ----
  el.brand.addEventListener("click", () => { location.hash = ""; renderUsers(); });
  el.back.addEventListener("click", () => { location.hash = ""; renderUsers(); });
  let searchTimer = null;
  el.search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { query = el.search.value; page = 1; renderLeaderboard(); }, 160);
  });
  el.sortMode.addEventListener("change", () => { sortMode = el.sortMode.value; page = 1; renderLeaderboard(); });
  el.perpage.addEventListener("change", () => { perPage = parseInt(el.perpage.value, 10) || 24; page = 1; renderLeaderboard(); });
  el.json.addEventListener("click", exportJSON);
  el.csv.addEventListener("click", exportCSV);
  window.addEventListener("hashchange", () => { routeFromHash(); render(); });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORE_KEY]) load();
  });

  load();
})();
