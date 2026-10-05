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
    h("p", { class: "hint" }, "Tap the card to see who debunked it"),
    h("div", { class: `stamp ${verdict === "mixed" ? "s-mixed" : ""}`, "aria-hidden": "true" }, stampText)
  );

  const back = h("div", { class: "face back", inert: "" },
    h("div", { class: "face-top" },
      h("p", { class: "dateline" }, "The verdict"),
      shareButton(c)
    ),
    h("div", { class: "verdict" },
      h("span", { class: `badge ${verdict === "mixed" ? "v-mixed" : ""}` }, c.rating),
      h("p", { class: "by" }, `Debunked by ${c.publisher}`),
      ago && h("p", { class: "when" }, `Published ${ago}`)
    ),
    c.url && h("a", { class: "btn btn-red", href: c.url, target: "_blank", rel: "noopener noreferrer" }, "Read Full Report"),
    h("p", { class: "hint" }, "Tap the card to flip back")
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
  else if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && !e.target.closest("a, button") && e.target.closest(".card")) flip();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "ArrowRight") go(1);
  else if (e.key === "ArrowLeft") go(-1);
  else if ((e.key === " " || e.key === "Enter") && e.target === stage) { e.preventDefault(); flip(); }
});
prevBtn.addEventListener("click", () => go(-1));
nextBtn.addEventListener("click", () => go(1));

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
