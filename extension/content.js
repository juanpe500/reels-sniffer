/* Reels Sniffer — content script
 * Runs on an Instagram profile's Reels tab (/{user}/reels/). As you auto-scroll
 * it reads the view-count overlay on every reel tile, dedupes by shortcode, and
 * stores a per-user map in chrome.storage.local. The leaderboard page ranks them.
 *
 * View-count formats handled (EN + ES locales):
 *   under 10k -> exact "8,532" / "8.532"    (thousands separators, no suffix)
 *   >=10k     -> "10.1K" / "234K"            (K)
 *   >=1M      -> "1M" / "2.2M"               (M)
 *   >=1B      -> "1.4B"                       (B)
 *   ES        -> "10,1 mil" / "234 mil" / "1,2 M" / "2,2 mill." / "millones"
 */
(() => {
  "use strict";

  const STORE_KEY = "rs_data"; // { [username]: { username, scanned_at, reels: {shortcode: reel} } }
  const PANEL_ID = "rs-panel";

  // first path segments that are never a profile username
  const RESERVED = new Set([
    "reels", "reel", "p", "tv", "explore", "stories", "direct", "accounts",
    "about", "developer", "legal", "privacy", "terms", "tags", "locations",
    "web", "challenge", "emails", "session", "ajax", "graphql", "api",
  ]);

  const SHORTCODE_RE = /\/reel\/([^/?#]+)/;

  // ---- storage helpers ----
  const db = {
    async all() {
      const r = await chrome.storage.local.get(STORE_KEY);
      return r[STORE_KEY] || {};
    },
    async user(name) {
      const all = await this.all();
      return all[name] || null;
    },
    async saveUser(name, obj) {
      const all = await this.all();
      all[name] = obj;
      await chrome.storage.local.set({ [STORE_KEY]: all });
    },
  };

  // ---- state ----
  let username = null;      // current profile whose reels we're on
  let reels = {};           // in-memory mirror: shortcode -> reel
  let autoTimer = null;
  let idleRounds = 0;
  let lastHeight = 0;
  let lastCount = 0;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- view-count parsing ----
  // A short leaf-text that could be a view count (EN or ES).
  const COUNT_RE =
    /^[\d][\d., \s]*\s*(k|m|b|mil(?:\s?millones)?|millones|mill(?:ó|o)?n?\.?|mill\.?)?\.?$/i;

  function parseViews(raw) {
    if (raw == null) return null;
    let s = String(raw).replace(/ /g, " ").trim().toLowerCase();
    s = s.replace(/\s+/g, " ");
    if (!s) return null;

    // Pull a trailing magnitude suffix off the end, if any.
    let mult = 1;
    const suf = s.match(/(mil\s?millones|mil|millones|mill[oó]n|mill\.?|[kmb])\.?$/i);
    let numPart = s;
    if (suf && suf.index > 0) {
      const tag = suf[1].replace(/\.$/, "");
      numPart = s.slice(0, suf.index).trim();
      if (/^k$/.test(tag)) mult = 1e3;
      else if (/^(m|mill[oó]n|millones|mill)$/i.test(tag)) mult = 1e6;
      else if (/^mil$/i.test(tag)) mult = 1e3;
      else if (/^(b|mil\s?millones)$/i.test(tag)) mult = 1e9;
    }

    let n;
    if (mult > 1) {
      // With a magnitude suffix a single separator is the decimal mark
      // ("10.1k" and "10,1 mil" both mean 10.1).
      numPart = numPart.replace(/[.,]/g, (mm, i, str) =>
        i === str.lastIndexOf(".") || i === str.lastIndexOf(",") ? "." : ""
      );
      n = parseFloat(numPart);
    } else {
      // No suffix -> exact figure, separators are thousands groupers.
      numPart = numPart.replace(/[.,\s]/g, "");
      n = parseInt(numPart, 10);
    }
    if (!isFinite(n)) return null;
    return Math.round(n * mult);
  }

  // Read the view count from a container. On the Reels tab a tile's only numeric
  // overlay is its view count, so we take the max parseable leaf.
  function extractViewsIn(root) {
    let best = null;
    for (const el of root.querySelectorAll("span, div")) {
      if (el.childElementCount > 0) continue; // leaf text only
      const t = (el.textContent || "").trim();
      if (!t || t.length > 16) continue;
      if (!COUNT_RE.test(t)) continue;
      const v = parseViews(t);
      if (v != null && (best == null || v > best)) best = v;
    }
    return best;
  }

  // The count usually lives inside the /reel/ anchor; if IG renders it as a
  // sibling overlay, climb to the tile cell (as long as it wraps just this one
  // reel) and scan there. Never scan a container holding multiple tiles.
  function extractViews(a) {
    let v = extractViewsIn(a);
    if (v != null) return v;
    let node = a;
    for (let up = 0; up < 3 && node.parentElement; up++) {
      node = node.parentElement;
      if (node.querySelectorAll('a[href*="/reel/"]').length !== 1) break;
      v = extractViewsIn(node);
      if (v != null) return v;
    }
    return null;
  }

  function parseTile(a) {
    const href = a.getAttribute("href") || "";
    const m = href.match(SHORTCODE_RE);
    if (!m) return null;
    const shortcode = m[1];
    const img = a.querySelector("img");
    return {
      shortcode,
      url: "https://www.instagram.com/reel/" + shortcode + "/",
      views: extractViews(a),
      image: img ? img.currentSrc || img.src || "" : "",
      alt: img && img.alt ? img.alt : "",
      captured_at: new Date().toISOString(),
    };
  }

  // ---- capture ----
  function capture() {
    const main = document.querySelector("main") || document.body;
    const anchors = main.querySelectorAll('a[href*="/reel/"]');
    let added = 0, updated = 0;
    for (const a of anchors) {
      const t = parseTile(a);
      if (!t) continue;
      const prev = reels[t.shortcode];
      if (!prev) {
        reels[t.shortcode] = t;
        added++;
      } else {
        let changed = false;
        // Keep the largest view figure we've seen (lazy render can show partial).
        if (t.views != null && (prev.views == null || t.views > prev.views)) {
          prev.views = t.views; changed = true;
        }
        if (!prev.image && t.image) { prev.image = t.image; changed = true; }
        if (!prev.alt && t.alt) { prev.alt = t.alt; changed = true; }
        if (changed) updated++;
      }
    }
    if (added || updated) persist();
    renderStats();
    return added;
  }

  let persistTimer = null;
  function persist() {
    // Debounce writes while scrolling fast.
    if (persistTimer) return;
    persistTimer = setTimeout(async () => {
      persistTimer = null;
      if (!username) return;
      await db.saveUser(username, {
        username,
        scanned_at: new Date().toISOString(),
        reels,
      });
    }, 600);
  }

  // ---- auto-scroll ----
  function startAuto() {
    if (autoTimer) return;
    idleRounds = 0;
    lastHeight = document.documentElement.scrollHeight;
    lastCount = Object.keys(reels).length;
    setBtn(true);
    setStatus("Scrolling & sniffing…");
    autoTimer = setInterval(() => {
      capture();
      window.scrollTo(0, document.documentElement.scrollHeight);
      const h = document.documentElement.scrollHeight;
      const c = Object.keys(reels).length;
      if (h > lastHeight || c > lastCount) {
        idleRounds = 0;
        lastHeight = h;
        lastCount = c;
      } else {
        idleRounds++;
      }
      // ~8 stable rounds (~10s) with no growth => assume the tab is exhausted.
      if (idleRounds >= 8) {
        stopAuto();
        capture();
        setStatus("Done — reached the end. " + Object.keys(reels).length + " reels.");
      }
    }, 1200);
  }

  function stopAuto() {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    setBtn(false);
  }

  // ---- UI ----
  function fmtViews(n) {
    if (n == null) return "—";
    if (n >= 1e6) return trim(n / 1e6) + "M";
    if (n >= 1e3) return trim(n / 1e3) + "K";
    return String(n);
  }
  function trim(x) {
    return (Math.round(x * 10) / 10).toString();
  }

  function setStatus(msg) {
    const el = document.getElementById("rs-status");
    if (el) el.textContent = msg;
  }
  function renderStats() {
    const n = Object.keys(reels).length;
    const withViews = Object.values(reels).filter((r) => r.views != null);
    const top = withViews.reduce((mx, r) => (r.views > mx ? r.views : mx), 0);
    const cEl = document.getElementById("rs-count");
    if (cEl) cEl.textContent = String(n);
    const tEl = document.getElementById("rs-top");
    if (tEl) tEl.textContent = n ? fmtViews(top) : "—";
    const mEl = document.getElementById("rs-missing");
    if (mEl) {
      const miss = n - withViews.length;
      mEl.textContent = miss ? miss + " without a number" : "";
    }
  }
  function setBtn(running) {
    const b = document.getElementById("rs-auto");
    if (!b) return;
    b.textContent = running ? "⏸ Stop sniffing" : "▶ Auto-scroll & sniff";
    b.classList.toggle("rs-running", running);
  }

  function buildPanel() {
    if (document.getElementById(PANEL_ID)) return;

    const style = document.createElement("style");
    style.textContent = `
      #${PANEL_ID}{position:fixed;top:120px;right:16px;z-index:2147483647;
        width:236px;background:#1a1a1a;color:#fff;border:1px solid #333;
        border-radius:12px;padding:12px;font:13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;
        box-shadow:0 8px 28px rgba(0,0,0,.5);user-select:none}
      #${PANEL_ID} h4{margin:0 0 4px;font-size:13px;font-weight:700;display:flex;
        justify-content:space-between;align-items:center;gap:6px}
      #${PANEL_ID} .rs-user{font-size:12px;color:#c9a0ff;font-weight:600;margin-bottom:8px;
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #${PANEL_ID} .rs-stats{display:flex;gap:6px;margin-bottom:8px}
      #${PANEL_ID} .rs-stat{flex:1;background:#232326;border-radius:8px;padding:6px 4px;text-align:center}
      #${PANEL_ID} .rs-stat .k{font-size:10px;color:#8a8a92;text-transform:uppercase;letter-spacing:.03em}
      #${PANEL_ID} .rs-stat .v{font-size:16px;font-weight:700}
      #${PANEL_ID} button{width:100%;margin:4px 0;padding:8px;border:0;border-radius:8px;
        background:#2a2a2a;color:#fff;cursor:pointer;font-size:12px;font-weight:600}
      #${PANEL_ID} button:hover{background:#3a3a3a}
      #${PANEL_ID} #rs-auto{background:#7b3ff2}
      #${PANEL_ID} #rs-auto:hover{background:#8f57ff}
      #${PANEL_ID} #rs-auto.rs-running{background:#e0245e}
      #${PANEL_ID} #rs-status{margin-top:6px;font-size:11px;color:#aaa;min-height:14px}
      #${PANEL_ID} #rs-missing{font-size:10px;color:#e0a500;min-height:12px}
      #${PANEL_ID} .rs-min{cursor:pointer;color:#aaa;background:none;width:auto;margin:0;
        padding:0 4px;font-size:16px;line-height:1}
    `;
    document.documentElement.appendChild(style);

    const p = document.createElement("div");
    p.id = PANEL_ID;
    p.innerHTML = `
      <h4>🔎 Reels Sniffer
        <button class="rs-min" id="rs-min" title="Hide">–</button>
      </h4>
      <div class="rs-user" id="rs-userlabel"></div>
      <div id="rs-body">
        <div class="rs-stats">
          <div class="rs-stat"><div class="k">reels</div><div class="v" id="rs-count">0</div></div>
          <div class="rs-stat"><div class="k">top</div><div class="v" id="rs-top">—</div></div>
        </div>
        <div id="rs-missing"></div>
        <button id="rs-auto">▶ Auto-scroll &amp; sniff</button>
        <button id="rs-scan">↻ Capture visible now</button>
        <button id="rs-board">🏆 Open leaderboard</button>
        <div id="rs-status"></div>
      </div>
    `;
    document.documentElement.appendChild(p);

    p.querySelector("#rs-auto").onclick = () =>
      autoTimer ? (stopAuto(), setStatus("Paused.")) : startAuto();
    p.querySelector("#rs-scan").onclick = () => {
      const n = capture();
      setStatus(n ? "+" + n + " new reels captured." : "No new reels in view.");
    };
    p.querySelector("#rs-board").onclick = () => {
      chrome.runtime.sendMessage({
        type: "open_manager",
        hash: username ? "#u=" + encodeURIComponent(username) : "",
      });
    };
    const body = p.querySelector("#rs-body");
    p.querySelector("#rs-min").onclick = () => {
      const hidden = body.style.display === "none";
      body.style.display = hidden ? "" : "none";
      p.querySelector("#rs-min").textContent = hidden ? "–" : "+";
    };

    document.getElementById("rs-userlabel").textContent = "@" + username;
    renderStats();
  }

  function removePanel() {
    const p = document.getElementById(PANEL_ID);
    if (p) p.remove();
    stopAuto();
  }

  // ---- route handling: only on /{user}/reels/ ----
  function usernameFromPath() {
    const parts = location.pathname.split("/").filter(Boolean);
    // want [user, "reels"] (optionally trailing segments)
    if (parts.length < 2) return null;
    if (parts[1] !== "reels") return null;
    const u = parts[0];
    if (RESERVED.has(u)) return null;
    return u;
  }

  async function syncForRoute() {
    const u = usernameFromPath();
    if (!u) { removePanel(); username = null; return; }
    if (u !== username) {
      // Switched profiles — load that user's stored reels (resume/merge).
      username = u;
      const existing = await db.user(u);
      reels = existing ? existing.reels || {} : {};
      removePanel();
    }
    buildPanel();
    capture(); // grab whatever's already on screen
  }

  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      syncForRoute();
    }
  }, 800);

  syncForRoute();
})();
