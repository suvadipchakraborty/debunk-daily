"use strict";

/* ============================================================
   CONFIG
   ============================================================ */
const CONFIG = {
  // ⚠️ REPLACE / ROTATE THIS KEY. It is visible to anyone who opens the site,
  // so restrict it in Google Cloud Console (HTTP referrer: your site URL,
  // API restriction: "Fact Check Tools API only").
  GOOGLE_API_KEY: "AIzaSyAEHuQ94EsBNgnEt6verjhCP2CEuhqIEzE",

  API_URL: "https://factchecktools.googleapis.com/v1alpha1/claims:search",
  LANGUAGE: "en",
  SITE_URL: "https://debunk-daily.suvadipchakraborty.workers.dev/",

  MAX_AGE_DAYS: 30,     // only stories fact-checked within this window
  PAGE_SIZE: 30,        // results requested per query
  MAX_CARDS: 40,        // cards shown in the deck
  MIN_FALSE_CARDS: 8,   // if fewer "false" stories exist, pad with "misleading" ones
  CACHE_KEY: "debunk-daily:feed:v2",

  // Full-report reader. Fact-check sites don't allow browsers to fetch their pages directly (CORS),
  // so the page is fetched through a free "reader" service that returns the article as clean text.
  READER_URL: "https://r.jina.ai/",
  REPORT_CACHE_KEY: "debunk-daily:reports:v1",
  REPORT_CACHE_MAX: 20,        // reports kept on the device for offline / instant reopening
  REPORT_MAX_CHARS: 15000,     // longer reports are cut with a "continue on original site" note
  REPORT_TIMEOUT_MS: 25000,

  // Topics used to sweep the API for recent fact-checks (the API needs a query)
  TOPICS: ["viral video", "whatsapp scam", "hoax", "health myth", "deepfake", "election rumor"],
  // Fact-check publishers swept for their latest work
  PUBLISHER_SITES: ["snopes.com", "reuters.com", "politifact.com", "factcheck.org", "boomlive.in", "afp.com"],
};

/* ============================================================
   Helpers
   ============================================================ */
const $ = (s) => document.querySelector(s);
const stage = $("#stage"), messageBox = $("#message"), pager = $("#pager");
const prevBtn = $("#prev"), nextBtn = $("#next"), countEl = $("#count"), bar = $("#bar"), feedSub = $("#feed-sub");

let claims = [];
let idx = 0;
let flipped = false;
let stampTimer;

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(c));
  }
  return el;
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 2800);
}

function timeAgo(ts) {
  if (!ts) return "";
  const days = Math.round((ts - Date.now()) / 864e5);
  if (days > -30) return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(Math.min(days, 0), "day");
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/* ============================================================
   API: sweep for the latest debunked claims
   ============================================================ */
async function fetchBatch(params) {
  const qs = new URLSearchParams({
    languageCode: CONFIG.LANGUAGE,
    pageSize: CONFIG.PAGE_SIZE,
    maxAgeDays: CONFIG.MAX_AGE_DAYS,
    key: CONFIG.GOOGLE_API_KEY,
    ...params,
  });
  const res = await fetch(`${CONFIG.API_URL}?${qs}`);
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  // Missing or empty `claims` is a valid "nothing found" response
  return (Array.isArray(data.claims) ? data.claims : []).map(normalizeClaim).filter(Boolean);
}

function normalizeClaim(claim) {
  const review = claim?.claimReview?.[0];
  if (!claim?.text || !review) return null;
  return {
    text: claim.text.trim(),
    claimant: claim.claimant || "",
    publisher: review.publisher?.name || review.publisher?.site || "a fact-checker",
    rating: (review.textualRating || "Rated").trim(),
    url: review.url || "",
    date: Date.parse(review.reviewDate || claim.claimDate || "") || 0,
  };
}

function getVerdict(rating) {
  const r = rating.toLowerCase();
  if (/\b(not true|false|fake|pants on fire|incorrect|hoax|fabricated|scam|fraud|bogus|no evidence|untrue|wrong)\b/.test(r)) return "false";
  if (/(misleading|partly|partially|mixture|mostly|half|unproven|unsupported|context|exaggerat|outdated|satire|unverified|distorted)/.test(r)) return "mixed";
  if (/\b(true|correct|accurate|legit)\b/.test(r)) return "true";
  return "other";
}

async function fetchLatest() {
  const jobs = [
    ...CONFIG.TOPICS.map((query) => ({ query })),
    ...CONFIG.PUBLISHER_SITES.map((site) => ({ reviewPublisherSiteFilter: site })),
  ];
  const results = await Promise.allSettled(jobs.map(fetchBatch));
  const ok = results.filter((r) => r.status === "fulfilled");
  if (!ok.length) throw results[0].reason;

  // Merge, de-duplicate, newest first
  const seen = new Set();
  const all = ok.flatMap((r) => r.value).filter((c) => {
    const key = (c.url || c.text).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => b.date - a.date);

  const falses = all.filter((c) => getVerdict(c.rating) === "false");
  let deck = falses;
  if (falses.length < CONFIG.MIN_FALSE_CARDS) {
    deck = all.filter((c) => ["false", "mixed"].includes(getVerdict(c.rating))); // pad with "misleading"
  }
  return deck.slice(0, CONFIG.MAX_CARDS);
}

/* ============================================================
   Flashcard rendering
   ============================================================ */
const SHARE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/></svg>`;

function shareButton(c) {
  const b = h("button", { class: "share", type: "button", "aria-label": "Share this debunk", title: "Share", onclick: () => shareClaim(c) });
  b.innerHTML = SHARE_ICON;
  return b;
}

function buildCard(c) {
  const verdict = getVerdict(c.rating);
  const stampText = verdict === "mixed" ? "Misleading" : "False";
  const ago = timeAgo(c.date);

  const front = h("div", { class: "face front" },
    h("div", { class: "face-top" },
      h("p", { class: "dateline" }, ago ? `Fact-checked ${ago}` : "Recently fact-checked"),
      shareButton(c)
    ),
    h("blockquote", { class: "claim", style: "margin:0" }, `\u201C${c.text}\u201D`),
    c.claimant && h("p", { class: "claimant" }, `Claimed by ${c.claimant}`),
    h("p", { class: "hint" }, "Tap the card to read the full debunk"),
    h("div", { class: `stamp ${verdict === "mixed" ? "s-mixed" : ""}`, "aria-hidden": "true" }, stampText)
  );

  const back = h("div", { class: "face back", inert: "" },
    h("div", { class: "face-top" },
      h("p", { class: "dateline" }, "The verdict"),
      shareButton(c)
    ),
    h("div", { class: "verdict" },
      h("div", { class: "verdict-row" },
        h("span", { class: `badge ${verdict === "mixed" ? "v-mixed" : ""}` }, c.rating),
        ago && h("span", { class: "when" }, ago)
      ),
      h("p", { class: "by" }, `Debunked by ${c.publisher}`)
    ),
    h("div", { class: "report", tabindex: "0", role: "region", "aria-label": "Full fact-check report", "data-state": "idle" }),
    h("div", { class: "back-actions" },
      h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => flip() }, "\u21BA Back to claim"),
      c.url && h("a", { class: "btn btn-red btn-sm", href: c.url, target: "_blank", rel: "noopener noreferrer" }, "Open original \u2197")
    )
  );

  return h("div", { class: "card" }, front, back);
}

function buildEndCard() {
  return h("div", { class: "endcard" },
    h("h3", {}, "You're all caught up."),
    h("p", {}, "That's every debunked story for now. Check back tomorrow, and think twice before you forward."),
    h("button", { class: "btn btn-red", type: "button", onclick: () => go(-idx) }, "Start over")
  );
}

function render(dir = 1) {
  clearTimeout(stampTimer);
  flipped = false;
  const atEnd = idx >= claims.length;
  const content = atEnd ? buildEndCard() : buildCard(claims[idx]);
  const wrap = h("div", { class: `card-wrap ${dir < 0 ? "from-left" : ""}` }, content);
  stage.replaceChildren(wrap);

  if (!atEnd) {
    // Slam the stamp just after the card settles
    stampTimer = setTimeout(() => content.classList.add("is-stamped"), 380);
  }
  prevBtn.disabled = idx === 0;
  nextBtn.disabled = atEnd;
  countEl.textContent = atEnd ? "Done" : `${idx + 1} of ${claims.length}`;
  bar.style.width = `${Math.min(idx + 1, claims.length) / claims.length * 100}%`;
}

function go(step) {
  const next = Math.max(0, Math.min(claims.length, idx + step));
  if (next === idx || !claims.length) return;
  const dir = step;
  idx = next;
  render(dir);
}

function flip() {
  const card = stage.querySelector(".card");
  if (!card) return;
  flipped = !flipped;
  card.classList.toggle("is-flipped", flipped);
  card.querySelector(".front").toggleAttribute("inert", flipped);
  card.querySelector(".back").toggleAttribute("inert", !flipped);
  if (flipped) {
    const box = card.querySelector(".report");
    const c = claims[idx];
    if (box && c && !["ok", "loading"].includes(box.dataset.state)) showReport(c, box);
  }
}

/* ============================================================
   Full report: fetch, clean up, render
   ============================================================ */
const reportMem = new Map();

const NOISE = /(cookie|subscribe|newsletter|sign up|log ?in\b|privacy policy|terms of (use|service)|all rights reserved|advertisement|skip to|follow us|share (this|on)|read more|related (articles|stories|fact)|click here to|support (our|independent)|donate|copyright \u00A9)/i;
const STOP_HEADING = /^(related|more from|you may also|recommended|trending|read next|leave a comment|comments?\b|latest (news|stories|fact))/i;
const BLOCKED = /(just a moment|verify you are human|enable javascript|access denied|attention required|are you a robot|captcha)/i;

function parseReport(raw) {
  if (/Target URL returned error\s+[45]\d\d/i.test(raw) || BLOCKED.test(raw.slice(0, 700))) throw new Error("blocked");

  const title = (raw.match(/^Title:\s*(.+)$/m) || [])[1]?.trim() || "";
  const marker = "Markdown Content:";
  const mi = raw.indexOf(marker);
  const body = mi >= 0 ? raw.slice(mi + marker.length) : raw;

  const blocks = [];
  const seen = new Set();
  let chars = 0, truncated = false;

  for (let line of body.split(/\r?\n/)) {
    line = line.trim();
    if (!line || /^[=\-_*#\s|>]+$/.test(line)) continue;

    line = line
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")          // images
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")        // links -> their text
      .replace(/https?:\/\/\S+/g, "")                  // bare URLs
      .replace(/(\*\*|__|`)/g, "")                      // bold / code marks
      .replace(/\*(\S[^*]*?)\*/g, "$1")                // italics
      .replace(/\s+/g, " ").trim();
    if (!line) continue;

    let type = "p";
    const hm = line.match(/^#{1,6}\s+(.*)$/);
    const lm = line.match(/^(?:[*+\u2022-]|\d+\.)\s+(.*)$/);
    if (hm) { type = "h"; line = hm[1].trim(); }
    else if (lm) { type = "li"; line = lm[1].trim(); }
    line = line.replace(/^>\s*/, "");

    const words = line.split(" ").length;
    if (type === "h") {
      if (STOP_HEADING.test(line)) break;
      if (words < 2 || line === title) continue;
    } else {
      if (words < 5) continue;                        // menus, buttons, bylines
      if (line.length < 160 && NOISE.test(line)) continue;
    }
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    if (chars + line.length > CONFIG.REPORT_MAX_CHARS) { truncated = true; break; }
    chars += line.length;
    blocks.push([type, line]);
  }

  if (chars < 400) throw new Error("too short");
  return { title, blocks, truncated };
}

async function fetchReport(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONFIG.REPORT_TIMEOUT_MS);
  try {
    const res = await fetch(CONFIG.READER_URL + url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseReport(await res.text());
  } finally { clearTimeout(timer); }
}

function readReportCache() {
  try { return JSON.parse(localStorage.getItem(CONFIG.REPORT_CACHE_KEY) || "{}"); } catch { return {}; }
}
function saveReportCache(url, report) {
  try {
    const all = readReportCache();
    all[url] = { ...report, ts: Date.now() };
    Object.keys(all).sort((a, b) => all[b].ts - all[a].ts).slice(CONFIG.REPORT_CACHE_MAX).forEach((k) => delete all[k]);
    localStorage.setItem(CONFIG.REPORT_CACHE_KEY, JSON.stringify(all));
  } catch {}
}

async function getReport(url) {
  if (reportMem.has(url)) return reportMem.get(url);
  const saved = readReportCache()[url];
  if (saved?.blocks?.length) { reportMem.set(url, saved); return saved; }
  const report = await fetchReport(url);
  reportMem.set(url, report);
  saveReportCache(url, report);
  return report;
}

function originalLink(c, label) {
  return h("a", { class: "report-link", href: c.url, target: "_blank", rel: "noopener noreferrer" }, label);
}

function renderReport(r, c) {
  const out = [];
  if (r.title) out.push(h("h4", { class: "report-title" }, r.title));
  out.push(h("p", { class: "report-source" }, `Source: ${c.publisher}`));
  for (const [type, text] of r.blocks) {
    if (type === "h") out.push(h("h5", { class: "report-h" }, text));
    else out.push(h("p", { class: type === "li" ? "report-li" : "report-p" }, text));
  }
  out.push(h("p", { class: "report-note" },
    r.truncated ? `This report continues on ${c.publisher}. ` : `End of report. Text courtesy of ${c.publisher}. `,
    c.url && originalLink(c, "Read the original \u2197")
  ));
  return out;
}

async function showReport(c, box) {
  if (!c.url) {
    box.dataset.state = "error";
    return box.replaceChildren(h("div", { class: "report-error" }, h("p", {}, "This fact-check didn't include a link to the full report.")));
  }
  box.dataset.state = "loading";
  box.replaceChildren(h("div", { class: "report-loading" },
    h("p", {}, `Fetching the full report from ${c.publisher}\u2026`),
    h("div", { class: "sk sk-dark w100" }), h("div", { class: "sk sk-dark w80" }),
    h("div", { class: "sk sk-dark w100" }), h("div", { class: "sk sk-dark w60" })
  ));
  try {
    const report = await getReport(c.url);
    box.replaceChildren(...renderReport(report, c));
    box.dataset.state = "ok";
    box.scrollTop = 0;
  } catch (err) {
    console.warn("Report load failed:", err);
    box.dataset.state = "error";
    box.replaceChildren(h("div", { class: "report-error" },
      h("p", {}, "Couldn't load the full report inside the app. Some sites block in-app reading, or the connection dropped."),
      h("div", { class: "report-error-actions" },
        h("button", { class: "btn btn-outline btn-sm", type: "button", onclick: () => showReport(c, box) }, "Try again"),
        originalLink(c, "Read it on the original site \u2197")
      )
    ));
  }
}

/* ============================================================
   Loading / empty / error states
   ============================================================ */
function showSkeleton() {
  messageBox.hidden = true;
  stage.hidden = false;
  pager.hidden = false;
  prevBtn.disabled = nextBtn.disabled = true;
  countEl.textContent = "";
  bar.style.width = "0";
  stage.replaceChildren(h("div", { class: "skeleton", "aria-hidden": "true" },
    h("div", { class: "sk sk-line w60" }), h("div", { class: "sk sk-line" }),
    h("div", { class: "sk sk-line w80" }), h("div", { class: "sk sk-line w60" })
  ));
}

function showMessage(icon, title, text, action) {
  stage.replaceChildren();
  stage.hidden = true;
  pager.hidden = true;
  bar.style.width = "0";
  messageBox.replaceChildren(h("div", { class: "icon", "aria-hidden": "true" }, icon), h("h3", {}, title), h("p", {}, text), action);
  messageBox.hidden = false;
}

function startDeck(deck, note) {
  claims = deck;
  idx = 0;
  messageBox.hidden = true;
  stage.hidden = false;
  pager.hidden = false;
  feedSub.textContent = note || `${deck.length} stories from the last ${CONFIG.MAX_AGE_DAYS} days, newest first`;
  render(1);
}

async function load() {
  showSkeleton();
  feedSub.textContent = "Loading the latest stories…";
  try {
    const deck = await fetchLatest();
    if (!deck.length) {
      return showMessage("?", "No new debunks right now.", "Nothing fresh has been fact-checked in the last few weeks. Check back soon, and use your best judgment in the meantime.",
        h("button", { class: "btn btn-red", type: "button", onclick: load }, "Refresh"));
    }
    try { localStorage.setItem(CONFIG.CACHE_KEY, JSON.stringify({ ts: Date.now(), deck })); } catch {}
    startDeck(deck);
  } catch (err) {
    console.error("Fact Check API error:", err);
    // Fall back to the last saved deck if we have one
    try {
      const saved = JSON.parse(localStorage.getItem(CONFIG.CACHE_KEY) || "null");
      if (saved?.deck?.length) {
        startDeck(saved.deck, `Offline. Showing ${saved.deck.length} saved stories.`);
        return toast("Couldn't refresh. Showing saved stories.");
      }
    } catch {}
    const keyProblem = err.status === 400 || err.status === 403;
    showMessage("!", keyProblem ? "The fact-check service rejected the request." : "Couldn't load the news.",
      keyProblem ? `Error ${err.status}. Check GOOGLE_API_KEY in app.js and that the Fact Check Tools API is enabled.` : "Check your connection and try again.",
      h("button", { class: "btn btn-red", type: "button", onclick: load }, "Try again"));
  }
}

/* ============================================================
   Sharing
   ============================================================ */
async function shareClaim(c) {
  const text = `\u{1F6D1} FAKE NEWS ALERT: The claim that '${c.text}' is actually ${c.rating} according to ${c.publisher}. Check it on Debunk Daily!`;
  try {
    if (navigator.share) await navigator.share({ title: "Debunk Daily", text, url: CONFIG.SITE_URL });
    else { await navigator.clipboard.writeText(`${text} ${CONFIG.SITE_URL}`); toast("Copied. Paste it anywhere to share."); }
  } catch (err) {
    if (err.name !== "AbortError") toast("Couldn't share. Try again.");
  }
}

/* ============================================================
   Controls: tap to flip, swipe, keys, buttons
   ============================================================ */
let startX = 0, startY = 0, tracking = false;
stage.addEventListener("pointerdown", (e) => { tracking = true; startX = e.clientX; startY = e.clientY; });
stage.addEventListener("pointercancel", () => { tracking = false; });
stage.addEventListener("pointerup", (e) => {
  if (!tracking) return;
  tracking = false;
  const dx = e.clientX - startX, dy = e.clientY - startY;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
  else if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && !e.target.closest("a, button, .report") && e.target.closest(".card")) flip();
});

document.addEventListener("keydown", (e) => {
  if (aboutDlg.open) return;
  if (e.key === "ArrowRight") go(1);
  else if (e.key === "ArrowLeft") go(-1);
  else if ((e.key === " " || e.key === "Enter") && e.target === stage) { e.preventDefault(); flip(); }
});
prevBtn.addEventListener("click", () => go(-1));
nextBtn.addEventListener("click", () => go(1));

/* ============================================================
   About dialog
   ============================================================ */
const aboutDlg = $("#about");
document.querySelectorAll("[data-open-about]").forEach((b) => b.addEventListener("click", (e) => {
  e.preventDefault();
  aboutDlg.showModal();
  document.body.classList.add("modal-open");
  aboutDlg.querySelector(".about-body").scrollTop = 0;
}));
aboutDlg.addEventListener("close", () => document.body.classList.remove("modal-open"));
aboutDlg.addEventListener("click", (e) => { if (e.target === aboutDlg) aboutDlg.close(); });
aboutDlg.querySelector(".about-close").addEventListener("click", () => aboutDlg.close());

/* ============================================================
   PWA: install prompt + service worker
   ============================================================ */
const installBtn = $("#install-btn");
let deferredPrompt = null;
if (matchMedia("(display-mode: standalone)").matches || navigator.standalone === true) installBtn.hidden = true;

window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferredPrompt = e; });
window.addEventListener("appinstalled", () => { installBtn.hidden = true; deferredPrompt = null; toast("Installed. Find Debunk Daily on your home screen."); });
installBtn.addEventListener("click", async () => {
  if (deferredPrompt) { deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; }
  else toast("To install: open your browser menu and choose \u201CAdd to Home Screen\u201D.");
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch((err) => console.warn("SW registration failed:", err)));
}

load();
