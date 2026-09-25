// Deal Stacker - ranks Checkout 51 offers by final cost at each local store,
// stacking flyer sale prices, store coupons, loyalty points and her own offers.

const FLIPP_SEARCH = "https://backflipp.wishabi.com/flipp/items/search?locale=en-ca";
const CLAUDE_MODEL = "claude-opus-5";
const DEFAULT_RATES = { "PC Optimum": 1, "Scene+": 10, "More Rewards": 1, "Be Well": 1 }; // $ per 1,000 pts
const DEFAULT_STORES = [
  "Walmart", "Real Canadian Superstore", "No Frills", "Save-On-Foods", "Safeway",
  "Sobeys", "Costco", "Shoppers Drug Mart", "Your Independent Grocer",
];
const STOPWORDS = new Set(["any", "or", "and", "the", "with", "of", "for", "products", "product",
  "variety", "varieties", "select", "ct", "pk", "pack", "buy", "get", "all", "size", "sizes",
  "new", "brand", "your", "from", "in", "on"]);

let data = { offers: [], stores: [], loyaltyPrograms: {} };
let filter = "sale";
let query = "";

// ---------- storage (per-phone; must never break the page) ----------

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}
const settings = load("settings", { stores: DEFAULT_STORES, rates: DEFAULT_RATES, apiKey: "" });
settings.rates = { ...DEFAULT_RATES, ...settings.rates };
let myOffers = load("myOffers", []);

// ---------- helpers ----------

const $ = (sel) => document.querySelector(sel);
const money = (n) => `$${n.toFixed(2)}`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function tokens(text) {
  return String(text).toLowerCase().replace(/[®™©]/g, "")
    .split(/[^a-z0-9&']+/).filter((t) => t.length >= 2 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}
function productMatches(product, itemName) {
  const q = tokens(product);
  if (!q.length) return false;
  const hay = new Set(tokens(itemName));
  const has = (t) => hay.has(t) || hay.has(t.replace(/s$/, "")) || hay.has(t + "s");
  if (!has(q[0])) return false; // first word is usually the brand
  return q.filter(has).length / q.length >= 0.6;
}
function programFor(merchant) {
  for (const [program, merchants] of Object.entries(data.loyaltyPrograms || {})) {
    if (merchants.includes(merchant)) return program;
  }
  return merchant === "Rexall" ? "Be Well" : null;
}
const pointValue = (points, program) => (points * (settings.rates[program] ?? 0)) / 1000;

// ---------- stacking ----------

// Returns the per-item cost breakdown for one store's flyer item.
function stack(match, c51) {
  const layers = [];
  const price = match.price;
  if (match.storeCoupon) layers.push({ label: "Store digital coupon", amount: match.storeCoupon });

  if (match.points) {
    const units = match.pointsSpend && price ? Math.ceil(match.pointsSpend / price) : (match.pointsBuy || 1);
    const pts = match.points / units;
    const program = match.program || programFor(match.merchant);
    const cond = match.pointsSpend ? `spend $${match.pointsSpend}` : units > 1 ? `buy ${units}` : "";
    layers.push({
      label: `${Math.round(pts).toLocaleString()} ${program || ""} pts${cond ? ` (${cond})` : ""}`,
      amount: pointValue(pts, program), later: true,
    });
  }

  const program = match.program || programFor(match.merchant);
  for (const mine of myOffers) {
    if (mine.program !== program || !productMatches(mine.product, match.name)) continue;
    if (mine.onlyAt && !match.merchant.toLowerCase().includes(mine.onlyAt.toLowerCase().replace(/^real canadian /, ""))) continue;
    const qty = Math.max(1, mine.minQty || 1);
    if (mine.dollarsOff) layers.push({ label: `My ${program}: ${mine.details || "$ off"}`, amount: mine.dollarsOff / qty, mine: true });
    if (mine.points) layers.push({ label: `My ${program}: ${mine.points.toLocaleString()} pts${qty > 1 ? ` (buy ${qty})` : ""}`, amount: pointValue(mine.points / qty, program), later: true, mine: true });
  }

  if (c51) {
    const per = c51.cashback / (c51.qty || 1);
    const range = c51.cashbackMin && c51.cashbackMin !== c51.cashback ? " (up to)" : "";
    layers.push({ label: `Checkout 51${c51.qty > 1 ? ` (buy ${c51.qty})` : ""}${range}`, amount: per, later: true });
  }

  const saved = layers.reduce((s, l) => s + l.amount, 0);
  return {
    layers,
    saved,
    final: price == null ? null : Math.max(0, price - saved),
    stacked: layers.length,
    hasMine: layers.some((l) => l.mine),
  };
}

function rankedMatches(offer) {
  return (offer.matches || [])
    .filter((m) => settings.stores.includes(m.merchant))
    .map((m) => ({ m, s: stack(m, offer) }))
    .sort((a, b) => (a.s.final ?? 1e9) - (b.s.final ?? 1e9));
}

// ---------- deals list ----------

function renderDeals() {
  const q = query.trim().toLowerCase();
  const rows = data.offers
    .map((o) => ({ o, ranked: rankedMatches(o) }))
    .filter(({ o, ranked }) => (filter === "all" || ranked.length) &&
      (!q || `${o.name} ${o.description}`.toLowerCase().includes(q)))
    .sort((a, b) => {
      if (!!b.ranked.length !== !!a.ranked.length) return b.ranked.length ? 1 : -1;
      const pct = (r) => { const t = r.ranked[0]; return t && t.m.price ? t.s.saved / t.m.price : 0; };
      return pct(b) - pct(a) || a.o.name.localeCompare(b.o.name);
    });

  const list = $("#deal-list");
  if (!rows.length) {
    list.innerHTML = `<li class="empty">${filter === "sale"
      ? "None of this week's Checkout 51 offers are in a local flyer yet. Try “All offers”."
      : "No offers match that search."}</li>`;
    return;
  }
  list.innerHTML = rows.map(({ o, ranked }) => {
    const best = ranked[0];
    const cash = o.cashbackMin && o.cashbackMin !== o.cashback
      ? `${money(o.cashbackMin)}–${money(o.cashback)}` : money(o.cashback);
    let right = `<div class="cash">${cash} back</div>`;
    let sub = esc(o.description);
    if (best) {
      right = best.s.final != null
        ? `<div class="big">${money(best.s.final)}</div><div class="sub">at ${esc(short(best.m.merchant))}</div>`
        : `<div class="cash">${cash} back</div>`;
      sub = `${cash} back · ${ranked.length} store${ranked.length > 1 ? "s" : ""} `
        + (best.s.stacked >= 2 ? `<span class="badge">${best.s.stacked} stacked</span>` : "")
        + (ranked.some((r) => r.s.hasMine) ? ` <span class="badge green">my offer</span>` : "");
    }
    return `<li><button class="card" data-offer="${esc(o.id)}">
      <img src="${esc(o.image)}" alt="" loading="lazy">
      <div><div class="name">${esc(o.name)}</div><div class="sub">${sub}</div></div>
      <div class="right">${right}</div></button></li>`;
  }).join("");
}

const short = (merchant) => merchant.replace("Real Canadian ", "").replace("Your Independent Grocer", "Independent")
  .replace("Wholesale Club and Club Entrepôt", "Wholesale Club").replace("Shoppers Drug Mart", "Shoppers");

// ---------- deal detail ----------

function rankHtml(m, s, isBest) {
  const rows = s.layers.map((l) => `<tr><td>${esc(l.label)}${l.later ? `<span class="later">back after purchase</span>` : ""}</td>
    <td class="minus">−${money(l.amount)}</td></tr>`).join("");
  const priceRow = m.price != null
    ? `<tr><td>Flyer price${m.perWeight ? " (by weight)" : ""}</td><td>${esc(m.priceText)}</td></tr>`
    : `<tr><td>Price</td><td>not listed in flyer</td></tr>`;
  const total = s.final != null ? `<tr class="total"><td>Final cost per item</td><td>${money(s.final)}</td></tr>` : "";
  const until = m.validTo ? new Date(m.validTo).toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric" }) : "";
  return `<li class="rank${isBest ? " best" : ""}">
    <div class="rank-top"><span class="rank-store">${esc(m.merchant)}</span>
      ${s.final != null ? `<span class="big">${money(s.final)}</span>` : ""}</div>
    <div class="rank-item">${esc(m.name)}</div>
    <table class="stack">${priceRow}${rows}${total}</table>
    ${m.saleStory ? `<div class="note">Flyer: ${esc(m.saleStory)}</div>` : ""}
    ${until ? `<div class="note">Flyer ends ${esc(until)}</div>` : ""}
  </li>`;
}

function shopLinks(product) {
  const q = encodeURIComponent(product);
  return `<div class="links">
    <a href="https://www.walmart.ca/en/search?q=${q}" target="_blank" rel="noopener">Walmart.ca price ↗</a>
    <a href="https://www.realcanadiansuperstore.ca/en/search?search-bar=${q}" target="_blank" rel="noopener">Superstore price ↗</a>
    <a href="https://flipp.com/en-ca/search/${q}" target="_blank" rel="noopener">All flyers ↗</a>
  </div>`;
}

function showDetail(id) {
  const o = data.offers.find((x) => x.id === id);
  if (!o) return go("deals");
  const ranked = rankedMatches(o);
  const cash = o.cashbackMin && o.cashbackMin !== o.cashback
    ? `${money(o.cashbackMin)}–${money(o.cashback)}` : money(o.cashback);
  $("#detail").innerHTML = `
    <div class="detail-head"><img src="${esc(o.image)}" alt="">
      <div><h2>${esc(o.name)}</h2><div class="cash">${cash} back with Checkout 51</div></div></div>
    <p class="muted">${esc(o.description)}</p>
    <ul class="cards" id="ranks">${ranked.length
      ? ranked.map((r, i) => rankHtml(r.m, r.s, i === 0 && r.s.final != null)).join("")
      : `<li class="empty">Not on sale in a local flyer this week. It still pays ${cash} back at any store at regular price.</li>`}</ul>
    ${shopLinks(o.product)}
    <a class="button small" href="${esc(o.url)}" target="_blank" rel="noopener">Open in Checkout 51 ↗</a>`;
  go("detail");
}

// Each screen has its own #hash so the phone's back gesture works.
function route() {
  const hash = decodeURIComponent(location.hash.slice(1));
  if (hash.startsWith("offer/")) showDetail(hash.slice(6));
  else go(["mine", "settings"].includes(hash) ? hash : "deals");
}

// ---------- my offers (screenshots -> Claude) ----------

const OFFER_SCHEMA = {
  type: "object",
  properties: {
    offers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          program: { type: "string", enum: ["PC Optimum", "Scene+", "More Rewards", "Other"] },
          product: { type: "string" },
          points: { type: "integer" },
          dollarsOff: { type: "number" },
          minQty: { type: "integer" },
          spendMin: { type: "number" },
          expires: { type: "string" },
          details: { type: "string" },
          onlyAt: { type: "string" },
        },
        required: ["program", "product", "points", "dollarsOff", "minQty", "spendMin", "expires", "details", "onlyAt"],
        additionalProperties: false,
      },
    },
  },
  required: ["offers"],
  additionalProperties: false,
};

const EXTRACT_PROMPT = `These are screenshots of a Canadian shopper's loyalty-app offers page (PC Optimum, Scene+ or Save-On More Rewards). Extract every offer tied to a product or product category.

For each offer:
- program: which loyalty program the screenshots are from.
- product: brand and product exactly as a shopper would search for it (e.g. "Tide Pods", "PC Organics milk"). No marketing words.
- points: bonus points earned (0 if none).
- dollarsOff: instant dollars off (0 if none).
- minQty: number of items that must be bought (1 if not stated).
- spendMin: minimum dollar spend required (0 if none).
- expires: expiry as YYYY-MM-DD if shown, otherwise "".
- details: the offer's condition in a few words, e.g. "2,000 pts when you buy 2".
- onlyAt: if the offer says it is only valid at one banner (e.g. "Shoppers Drug Mart", "No Frills", "Safeway"), that store name; otherwise "" (valid at every store in the program).

Skip offers not tied to products (e.g. "earn points on fuel", "spend $250 anywhere"). Screenshots may be slices of one long page that overlap; list each offer only once.`;

// Phone screenshots are tall; send slices Claude can read comfortably.
async function imageSlices(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1000 / bitmap.width);
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const sliceH = 1800, overlap = 120;
  const slices = [];
  for (let y = 0; y < h; y += sliceH - overlap) {
    const ch = Math.min(sliceH, h - y);
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = ch;
    canvas.getContext("2d").drawImage(bitmap, 0, y / scale, bitmap.width, ch / scale, 0, 0, w, ch);
    slices.push(canvas.toDataURL("image/jpeg", 0.85).split(",")[1]);
    if (y + ch >= h) break;
  }
  bitmap.close();
  return slices;
}

async function readScreenshots(files) {
  const status = $("#shot-status");
  if (!settings.apiKey) {
    status.textContent = "Add your Claude API key in Settings first.";
    return;
  }
  try {
    status.textContent = "Preparing screenshots…";
    const images = [];
    for (const f of files) images.push(...await imageSlices(f));
    if (images.length > 20) images.length = 20;

    status.textContent = `Reading ${files.length} screenshot${files.length > 1 ? "s" : ""}… (about 30 seconds)`;
    const { default: Anthropic } = await import("https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk/+esm");
    const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true });
    const response = await client.beta.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { format: { type: "json_schema", schema: OFFER_SCHEMA } },
      messages: [{
        role: "user",
        content: [
          ...images.map((data) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } })),
          { type: "text", text: EXTRACT_PROMPT },
        ],
      }],
    });
    if (response.stop_reason === "refusal") throw new Error("Claude couldn't read these screenshots.");
    if (response.stop_reason === "max_tokens") throw new Error("Too many offers at once - try fewer screenshots.");
    const text = response.content.find((b) => b.type === "text")?.text;
    const found = JSON.parse(text).offers;

    const key = (x) => `${x.program}|${x.product.toLowerCase()}|${x.points}|${x.dollarsOff}`;
    const existing = new Set(myOffers.map(key));
    const fresh = found.filter((x) => !existing.has(key(x)))
      .map((x) => ({ ...x, id: crypto.randomUUID(), added: new Date().toISOString() }));
    myOffers = [...fresh, ...myOffers];
    save("myOffers", myOffers);
    status.textContent = `Added ${fresh.length} offer${fresh.length === 1 ? "" : "s"}${found.length > fresh.length ? ` (${found.length - fresh.length} already saved)` : ""}.`;
    renderMine();
    renderDeals();
  } catch (err) {
    const msg = err?.status === 401 ? "That API key didn't work - check it in Settings." : (err?.message || String(err));
    status.textContent = `Couldn't read screenshots: ${msg}`;
  }
}

function dropExpired() {
  const today = new Date().toISOString().slice(0, 10);
  const kept = myOffers.filter((o) => !o.expires || o.expires >= today);
  if (kept.length !== myOffers.length) { myOffers = kept; save("myOffers", myOffers); }
}

function renderMine() {
  const list = $("#mine-list");
  if (!myOffers.length) {
    list.innerHTML = `<li class="empty">No saved offers yet.</li>`;
    return;
  }
  list.innerHTML = myOffers.map((o) => `<li class="rank" data-mine="${esc(o.id)}">
    <div class="rank-top"><span class="rank-store">${esc(o.product)}</span><span class="badge green">${esc(o.program)}</span></div>
    <div class="rank-item">${esc(o.details)}${o.onlyAt ? ` · ${esc(o.onlyAt)} only` : ""}${o.expires ? ` · until ${esc(o.expires)}` : ""}</div>
    <div class="links">
      <button class="button small" data-find="${esc(o.id)}">Find best price</button>
      <button class="button small" data-remove="${esc(o.id)}">Remove</button>
    </div>
    <ul class="cards" data-results="${esc(o.id)}"></ul></li>`).join("");
}

// Live flyer search from the phone (Flipp allows cross-origin requests).
function parseFlippItem(item) {
  const price = item.current_price;
  const story = item.sale_story || "";
  const coupon = story.match(/save \$(\d+(?:\.\d+)?) with (?:digital |in-store |store )?coupon/i);
  if (price == null && !coupon) return null;
  const pre = (item.pre_price_text || "").trim();
  const post = (item.post_price_text || "").trim();
  const multi = pre.match(/^(\d+)\s*\//);
  const pts = story.match(/(\d{1,3}(?:,\d{3})+|\d+)\s*(?:PC\s*Optimum\s*|Scene\+\s*|More\s*Rewards\s*)?(?:pts|points)\b/i);
  const buy = story.match(/(?:when you )?buy\s+(\d+)/i);
  const spend = story.match(/spend \$(\d+(?:\.\d+)?)/i);
  return {
    merchant: item.merchant_name,
    name: item.name || "",
    price: price == null ? null : Math.round((multi ? price / +multi[1] : price) * 100) / 100,
    priceText: price == null ? "See store" : `${pre}$${price.toFixed(2)}${post ? " " + post : ""}`,
    perWeight: /\/\s*(lb|kg|100\s*g)/i.test(post),
    storeCoupon: coupon ? +coupon[1] : 0,
    saleStory: story || null,
    points: pts ? +pts[1].replace(/,/g, "") : 0,
    pointsBuy: pts && buy ? +buy[1] : 1,
    pointsSpend: pts && spend ? +spend[1] : null,
    program: programFor(item.merchant_name),
    validTo: item.valid_to,
  };
}

async function findPrices(id) {
  const mine = myOffers.find((o) => o.id === id);
  const out = document.querySelector(`[data-results="${CSS.escape(id)}"]`);
  if (!mine || !out) return;
  out.innerHTML = `<li class="note">Searching flyers…</li>`;
  try {
    const url = `${FLIPP_SEARCH}&postal_code=${encodeURIComponent(data.postalCode || "T8N3K8")}&q=${encodeURIComponent(mine.product)}`;
    const res = await fetch(url);
    const json = await res.json();
    const items = (json.items || [])
      .filter((i) => settings.stores.includes(i.merchant_name) && productMatches(mine.product, `${i.name} ${i.brand || ""}`))
      .map(parseFlippItem).filter(Boolean);
    const ranked = items.map((m) => ({ m, s: stack(m, null) }))
      .sort((a, b) => (a.s.final ?? 1e9) - (b.s.final ?? 1e9)).slice(0, 5);
    out.innerHTML = ranked.length
      ? ranked.map((r, i) => rankHtml(r.m, r.s, i === 0 && r.s.final != null)).join("")
      : `<li class="note">Not on sale in a local flyer this week.</li>${shopLinks(mine.product)}`;
  } catch {
    out.innerHTML = `<li class="note">Couldn't reach the flyer search. Try again in a minute.</li>`;
  }
}

// ---------- settings ----------

function renderSettings() {
  const stores = [...new Set([...(data.stores || []), ...settings.stores])];
  $("#store-toggles").innerHTML = stores.map((s) => `<label>
    <input type="checkbox" value="${esc(s)}" ${settings.stores.includes(s) ? "checked" : ""}> ${esc(short(s))}</label>`).join("");
  $("#rate-inputs").innerHTML = Object.entries(settings.rates).map(([p, r]) => `<label>${esc(p)}
    <input type="number" min="0" step="0.25" inputmode="decimal" data-rate="${esc(p)}" value="${r}"></label>`).join("");
  $("#api-key").value = settings.apiKey || "";
}

// ---------- navigation ----------

function go(view) {
  if (view === "deals") renderDeals();
  for (const v of document.querySelectorAll(".view")) v.hidden = v.id !== `view-${view}`;
  const tab = view === "detail" ? "deals" : view;
  for (const b of document.querySelectorAll(".tabbar button")) b.classList.toggle("active", b.dataset.tab === tab);
  window.scrollTo(0, 0);
}

function wire() {
  document.querySelector(".tabbar").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (b) location.hash = b.dataset.tab === "deals" ? "" : b.dataset.tab;
  });
  $("[data-back]").addEventListener("click", () => history.length > 1 ? history.back() : (location.hash = ""));
  window.addEventListener("hashchange", route);
  $("#deal-list").addEventListener("click", (e) => {
    const card = e.target.closest("[data-offer]");
    if (card) location.hash = `offer/${encodeURIComponent(card.dataset.offer)}`;
  });
  $(".chips").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-filter]");
    if (!chip) return;
    filter = chip.dataset.filter;
    for (const c of document.querySelectorAll(".chip")) c.classList.toggle("active", c === chip);
    renderDeals();
  });
  $("#search").addEventListener("input", (e) => { query = e.target.value; renderDeals(); });

  $("#shots").addEventListener("change", (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    if (files.length) readScreenshots(files);
  });
  $("#mine-list").addEventListener("click", (e) => {
    const find = e.target.closest("[data-find]");
    const remove = e.target.closest("[data-remove]");
    if (find) findPrices(find.dataset.find);
    if (remove) {
      myOffers = myOffers.filter((o) => o.id !== remove.dataset.remove);
      save("myOffers", myOffers);
      renderMine();
      renderDeals();
    }
  });

  $("#store-toggles").addEventListener("change", () => {
    settings.stores = [...document.querySelectorAll("#store-toggles input:checked")].map((i) => i.value);
    save("settings", settings);
    renderDeals();
  });
  $("#rate-inputs").addEventListener("change", (e) => {
    const input = e.target.closest("[data-rate]");
    if (!input) return;
    settings.rates[input.dataset.rate] = Math.max(0, parseFloat(input.value) || 0);
    save("settings", settings);
    renderDeals();
  });
  $("#api-key").addEventListener("change", (e) => {
    settings.apiKey = e.target.value.trim();
    save("settings", settings);
  });
}

async function init() {
  wire();
  dropExpired();
  renderMine();
  try {
    const res = await fetch(`data.json?t=${Date.now()}`);
    data = await res.json();
    const when = new Date(data.generated);
    const onSale = data.offers.filter((o) => rankedMatches(o).length).length;
    $("#scan-info").textContent = `${data.offers.length} Checkout 51 offers · ${onSale} on sale nearby · updated ${when.toLocaleString("en-CA", { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
    $("#data-info").textContent = `Last scan: ${when.toLocaleString("en-CA")}. Flyers for postal code ${data.postalCode}. Scans run nightly at midnight.`;
  } catch {
    $("#scan-info").textContent = "Couldn't load this week's deals.";
  }
  renderSettings();
  renderDeals();
  route();
}

init();
