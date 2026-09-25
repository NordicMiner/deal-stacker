// Deal Stacker - ranks Checkout 51 offers and watched items by final cost at
// each local store, stacking sale prices, store coupons, loyalty points, price
// matching and her own offers; plans the cheapest shopping trip.

const FLIPP_SEARCH = "https://backflipp.wishabi.com/flipp/items/search?locale=en-ca";
const CLAUDE_MODEL = "claude-opus-5";
const DEFAULT_RATES = { "PC Optimum": 1, "Scene+": 10, "More Rewards": 1.5, "Be Well": 1 }; // $ per 1,000 pts
const DEFAULT_STORES = [
  "Walmart", "Real Canadian Superstore", "No Frills", "Save-On-Foods", "Safeway",
  "Sobeys", "Costco", "Shoppers Drug Mart", "Your Independent Grocer",
];
const STOPWORDS = new Set(["any", "or", "and", "the", "with", "of", "for", "products", "product",
  "variety", "varieties", "select", "ct", "pk", "pack", "buy", "get", "all", "size", "sizes",
  "new", "brand", "your", "from", "in", "on"]);

let data = { offers: [], watch: [], stores: [], loyaltyPrograms: {}, priceMatch: {} };
let filter = "sale";
let query = "";
let planChoice = null;
const liveResults = new Map(); // watch term -> flyer matches searched from the phone

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
const settings = load("settings", { stores: DEFAULT_STORES, rates: DEFAULT_RATES, apiKey: "", githubToken: "" });
settings.rates = { ...DEFAULT_RATES, ...settings.rates };
let myOffers = load("myOffers", []);
let watchTerms = load("watchTerms", null); // null until first load from the server list
let tripList = load("tripList", []); // [{kind: "offer"|"watch", key, done}]

// ---------- helpers ----------

const $ = (sel) => document.querySelector(sel);
const money = (n) => `$${n.toFixed(2)}`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const shortDate = (iso) => new Date(iso.length === 10 ? `${iso}T12:00` : iso)
  .toLocaleDateString("en-CA", { month: "short", day: "numeric" });
const short = (merchant) => merchant.replace("Real Canadian ", "").replace("Your Independent Grocer", "Independent")
  .replace("Wholesale Club and Club Entrepôt", "Wholesale Club").replace("Shoppers Drug Mart", "Shoppers");

function tokens(text) {
  return String(text).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[®™©]/g, "")
    .split(/[^a-z0-9&']+/).filter((t) => t.length >= 2 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}
function productMatches(product, itemName) {
  const q = tokens(product);
  if (!q.length) return false;
  const hay = new Set(tokens(itemName));
  const has = (t) => hay.has(t) || hay.has(t.replace(/s$/, "")) || hay.has(t + "s");
  if (!has(q[0])) return false; // first word is usually the brand
  return q.filter(has).length / q.length >= 0.7;
}
function programFor(merchant) {
  for (const [program, merchants] of Object.entries(data.loyaltyPrograms || {})) {
    if (merchants.includes(merchant)) return program;
  }
  return merchant === "Rexall" ? "Be Well" : null;
}
const pointValue = (points, program) => (points * (settings.rates[program] ?? 0)) / 1000;
const cashText = (o) => o.cashbackMin && o.cashbackMin !== o.cashback
  ? `${money(o.cashbackMin)}–${money(o.cashback)}` : money(o.cashback);

// ---------- items: Checkout 51 offers and watched products share one shape ----------

function offerItem(o) {
  return { kind: "offer", key: o.id, title: o.name, image: o.image, desc: o.description,
    product: o.product, matches: o.matches || [], verdict: o.verdict, c51: o };
}
function watchItem(term) {
  const server = (data.watch || []).find((w) => w.term.toLowerCase() === term.toLowerCase());
  const c51 = data.offers.find((o) => productMatches(term, o.product) || productMatches(o.product, term));
  const matches = server?.matches || liveResults.get(term) || [];
  return { kind: "watch", key: term, title: term, product: term, desc: c51 ? `Checkout 51: ${c51.name}` : "",
    image: c51?.image || matches.find((m) => m.image)?.image || "", matches,
    verdict: server?.verdict, c51, pending: !server };
}
function resolveItem(kind, key) {
  if (kind === "offer") { const o = data.offers.find((x) => x.id === key); return o ? offerItem(o) : null; }
  return watchItem(key);
}

// ---------- stacking ----------

// Per-item cost breakdown for one store's price.
function stack(match, c51) {
  const layers = [];
  const price = match.price;
  if (match.storeCoupon) layers.push({ label: "Store digital coupon", amount: match.storeCoupon });

  const program = match.program || programFor(match.merchant);
  if (match.points) {
    const units = match.pointsSpend && price ? Math.ceil(match.pointsSpend / price) : (match.pointsBuy || 1);
    const pts = match.points / units;
    const cond = match.pointsSpend ? `spend $${match.pointsSpend}` : units > 1 ? `buy ${units}` : "";
    layers.push({
      label: `${Math.round(pts).toLocaleString()} ${program || ""} pts${cond ? ` (${cond})` : ""}`,
      amount: pointValue(pts, program), later: true,
    });
  }

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
    layers.push({ label: `Checkout 51${c51.qty > 1 ? ` (buy ${c51.qty})` : ""}${range}`, amount: per, later: true, c51: true });
  }

  const saved = layers.reduce((s, l) => s + l.amount, 0);
  const final = price == null ? null : Math.max(0, price - saved);
  const regular = match.wasPrice && price != null && match.wasPrice > price ? match.wasPrice : price;
  return { layers, saved, final, regular, stacked: layers.length, hasMine: layers.some((l) => l.mine) };
}

// No Frills (and any other configured store) matches competitors' flyer prices.
function priceMatchOptions(matches) {
  const out = [];
  for (const [store, rule] of Object.entries(data.priceMatch || {})) {
    if (!settings.stores.includes(store)) continue;
    const cheapest = matches
      .filter((m) => m.source === "flyer" && rule.competitors.includes(m.merchant) && m.price != null && !m.perWeight)
      .sort((a, b) => a.price - b.price)[0];
    if (!cheapest) continue;
    out.push({ ...cheapest, source: "pricematch", priceMatchFrom: cheapest.merchant, merchant: store,
      program: rule.program, points: 0, storeCoupon: 0, saleStory: null, link: null });
  }
  return out;
}

const isSale = (m) => m.source === "flyer" || m.source === "pricematch" || (m.wasPrice && m.price < m.wasPrice);

// Best option per store, cheapest first.
function ranked(item) {
  const mine = item.matches.filter((m) => settings.stores.includes(m.merchant));
  const all = [...mine, ...priceMatchOptions(item.matches)].map((m) => ({ m, s: stack(m, item.c51) }));
  const best = new Map();
  for (const r of all) {
    const cur = best.get(r.m.merchant);
    if (!cur || (r.s.final ?? 1e9) < (cur.s.final ?? 1e9)) best.set(r.m.merchant, r);
  }
  // A price match competes with the store's own price, so it only shows when it's cheaper.
  return [...best.values()].sort((a, b) => (a.s.final ?? 1e9) - (b.s.final ?? 1e9));
}

const savingPct = (r) => (r && r.s.final != null && r.s.regular ? (r.s.regular - r.s.final) / r.s.regular : 0);

// ---------- shared rendering ----------

function verdictBadge(v) {
  if (v?.kind === "low") return `<span class="badge green">8-wk low</span>`;
  if (v?.kind === "wait") return `<span class="badge">was ${money(v.low.price)}</span>`;
  return "";
}
function verdictHtml(v) {
  if (!v) return "";
  if (v.kind === "low") return `<div class="verdict good">📉 Lowest price in ${Math.max(2, Math.round(v.days / 7))} weeks. A good time to stock up.</div>`;
  if (v.kind === "wait") return `<div class="verdict wait">⏳ It was ${money(v.low.price)} at ${esc(short(v.low.merchant))} on ${shortDate(v.low.date)}. Worth waiting if you're not running low.</div>`;
  if (v.kind === "normal") return `<div class="verdict">8-week low: ${money(v.low.price)} at ${esc(short(v.low.merchant))} (${shortDate(v.low.date)}).</div>`;
  if (v.kind === "new") return `<div class="verdict">📈 Tracking prices since ${shortDate(v.since)}. Price advice starts after two weeks.</div>`;
  return "";
}

function rankHtml(m, s, isBest) {
  let priceLabel = "Flyer price";
  if (m.source === "shelf") priceLabel = m.wasPrice && m.wasPrice > m.price ? `Sale price (reg. ${money(m.wasPrice)})` : "Shelf price";
  if (m.source === "pricematch") priceLabel = `Price match (${short(m.priceMatchFrom)} flyer)`;
  const priceRow = m.price != null
    ? `<tr><td>${esc(priceLabel)}${m.perWeight ? " (by weight)" : ""}</td><td>${esc(m.priceText)}</td></tr>`
    : `<tr><td>Price</td><td>not listed</td></tr>`;
  const rows = s.layers.map((l) => `<tr><td>${esc(l.label)}${l.later ? `<span class="later">back after purchase</span>` : ""}</td>
    <td class="minus">−${money(l.amount)}</td></tr>`).join("");
  const total = s.final != null ? `<tr class="total"><td>Final cost per item</td><td>${money(s.final)}</td></tr>` : "";
  const ends = m.validTo ? `${m.source === "shelf" ? "Deal" : "Flyer"} ends ${shortDate(m.validTo)}` : "";
  const notes = [
    m.source === "pricematch" ? `Show the ${esc(m.priceMatchFrom)} flyer at the till. It must be the same item and size.` : "",
    m.saleStory ? `${m.source === "flyer" ? "Flyer" : "Store"}: ${esc(m.saleStory)}` : "",
    ends,
  ].filter(Boolean).map((n) => `<div class="note">${n}</div>`).join("");
  return `<li class="rank${isBest ? " best" : ""}">
    <div class="rank-top"><span class="rank-store">${esc(m.merchant)}${m.source === "pricematch" ? ` <span class="badge green">price match</span>` : ""}</span>
      ${s.final != null ? `<span class="big">${money(s.final)}</span>` : ""}</div>
    <div class="rank-item">${esc(m.name)}</div>
    <table class="stack">${priceRow}${rows}${total}</table>
    ${notes}
    ${m.link ? `<div class="note"><a href="${esc(m.link)}" target="_blank" rel="noopener">View at store ↗</a></div>` : ""}
  </li>`;
}

function shopLinks(product) {
  const q = encodeURIComponent(product);
  return `<div class="links">
    <a href="https://www.walmart.ca/en/search?q=${q}" target="_blank" rel="noopener">Walmart.ca price ↗</a>
    <a href="https://flipp.com/en-ca/search/${q}" target="_blank" rel="noopener">All flyers ↗</a>
  </div>`;
}

function cardHtml(item, rows, attrs) {
  const best = rows[0];
  const cash = item.c51 ? `${cashText(item.c51)} back` : "";
  let right = cash ? `<div class="cash">${cash}</div>` : "";
  let sub = esc(item.desc || "");
  if (best && best.s.final != null) {
    right = `<div class="big">${money(best.s.final)}</div><div class="sub">at ${esc(short(best.m.merchant))}</div>`;
    const sale = rows.some((r) => isSale(r.m));
    sub = [cash, `${rows.length} store${rows.length > 1 ? "s" : ""}`].filter(Boolean).join(" · ") + " "
      + (sale ? `<span class="badge">on sale</span> ` : "")
      + (best.m.source === "pricematch" ? `<span class="badge green">price match</span> ` : "")
      + (rows.some((r) => r.s.hasMine) ? `<span class="badge green">my offer</span> ` : "")
      + verdictBadge(item.verdict);
  } else if (item.pending) {
    sub = "Prices after the next scan";
  }
  const inList = tripList.some((t) => t.kind === item.kind && t.key === item.key);
  return `<li><button class="card" ${attrs}>
    ${item.image ? `<img src="${esc(item.image)}" alt="" loading="lazy">` : `<div class="thumb"></div>`}
    <div><div class="name">${inList ? "🛒 " : ""}${esc(item.title)}</div><div class="sub">${sub}</div></div>
    <div class="right">${right}</div></button></li>`;
}

// ---------- deals list ----------

function renderDeals() {
  const q = query.trim().toLowerCase();
  const rows = data.offers
    .map((o) => { const item = offerItem(o); return { item, rows: ranked(item) }; })
    .filter(({ item, rows }) => (filter === "all" || rows.some((r) => isSale(r.m) && r.s.final != null)) &&
      (!q || `${item.title} ${item.desc}`.toLowerCase().includes(q)))
    .sort((a, b) => {
      const pa = a.rows[0]?.s.final != null, pb = b.rows[0]?.s.final != null;
      if (pa !== pb) return pb ? 1 : -1;
      return savingPct(b.rows[0]) - savingPct(a.rows[0]) || a.item.title.localeCompare(b.item.title);
    });

  const list = $("#deal-list");
  if (!rows.length) {
    list.innerHTML = `<li class="empty">${filter === "sale"
      ? "None of this week's Checkout 51 offers are on sale nearby. Try “All offers”."
      : "No offers match that search."}</li>`;
    return;
  }
  list.innerHTML = rows.map(({ item, rows }) => cardHtml(item, rows, `data-open="offer/${esc(item.key)}"`)).join("");
}

// ---------- detail (offer or watched item) ----------

function showDetail(kind, key) {
  const item = resolveItem(kind, key);
  if (!item) return go("deals");
  const rows = ranked(item);
  const inList = tripList.some((t) => t.kind === kind && t.key === key);
  $("#detail").innerHTML = `
    <div class="detail-head">${item.image ? `<img src="${esc(item.image)}" alt="">` : `<div class="thumb"></div>`}
      <div><h2>${esc(item.title)}</h2>
      ${item.c51 ? `<div class="cash">${cashText(item.c51)} back with Checkout 51</div>` : ""}</div></div>
    ${item.desc ? `<p class="muted">${esc(item.desc)}</p>` : ""}
    <div class="links">
      <button class="button small ${inList ? "" : "primary"}" data-toggle-list="${esc(kind)}|${esc(key)}">${inList ? "✓ On your list" : "＋ Add to list"}</button>
      ${kind === "offer" ? `<a class="button small" href="${esc(item.c51.url)}" target="_blank" rel="noopener">Checkout 51 ↗</a>` : ""}
    </div>
    ${verdictHtml(item.verdict)}
    <ul class="cards">${rows.length
      ? rows.map((r, i) => rankHtml(r.m, r.s, i === 0 && r.s.final != null)).join("")
      : `<li class="empty">${item.pending ? "Full prices arrive after the next scan." : "No local price found this week."}${item.c51 ? ` It still pays ${cashText(item.c51)} back at any store.` : ""}</li>`}</ul>
    ${shopLinks(item.product)}`;
  go("detail");
}

// ---------- watchlist ----------

function currentWatchTerms() {
  if (watchTerms === null) watchTerms = (data.watch || []).map((w) => w.term);
  return watchTerms;
}

async function syncWatchlist(note) {
  const status = $("#watch-status");
  save("watchTerms", watchTerms);
  if (!settings.githubToken || !data.repo) {
    status.textContent = "Saved on this phone. Add a GitHub token in Settings to get alerts and store prices for your watchlist.";
    return;
  }
  status.textContent = "Saving…";
  try {
    const api = `https://api.github.com/repos/${data.repo}/contents/watchlist.json`;
    const headers = { Authorization: `Bearer ${settings.githubToken}`, Accept: "application/vnd.github+json" };
    const current = await fetch(api, { headers, cache: "no-store" });
    if (!current.ok && current.status !== 404) throw new Error(`GitHub said ${current.status}`);
    const sha = current.ok ? (await current.json()).sha : undefined;
    const json = JSON.stringify({ items: watchTerms }, null, 2) + "\n";
    const content = btoa(String.fromCharCode(...new TextEncoder().encode(json)));
    const put = await fetch(api, { method: "PUT", headers, body: JSON.stringify({ message: `Watchlist: ${note}`, content, sha }) });
    if (!put.ok) throw new Error(put.status === 401 || put.status === 403 ? "the GitHub token was refused" : `GitHub said ${put.status}`);
    status.textContent = "Saved. Store prices and alerts update in about 2 minutes.";
  } catch (err) {
    status.textContent = `Saved on this phone, but couldn't sync: ${err.message}`;
  }
}

async function liveSearch(term) {
  const url = `${FLIPP_SEARCH}&postal_code=${encodeURIComponent(data.postalCode || "T8N3K8")}&q=${encodeURIComponent(term)}`;
  const json = await (await fetch(url)).json();
  return (json.items || [])
    .filter((i) => productMatches(term, `${i.name} ${i.brand || ""}`))
    .map(parseFlippItem).filter(Boolean);
}

async function fillPendingWatch() {
  const pending = currentWatchTerms().filter((t) => watchItem(t).pending && !liveResults.has(t));
  await Promise.all(pending.map(async (t) => {
    try { liveResults.set(t, await liveSearch(t)); } catch { liveResults.set(t, []); }
  }));
  if (pending.length) renderWatch();
}

function renderWatch() {
  const terms = currentWatchTerms();
  const list = $("#watch-list");
  if (!terms.length) {
    list.innerHTML = `<li class="empty">Add things you buy often (coffee, detergent, cat food) and you'll see whenever they're on sale.</li>`;
    return;
  }
  const items = terms.map((t) => { const item = watchItem(t); return { item, rows: ranked(item) }; })
    .sort((a, b) => Number(b.rows.some((r) => isSale(r.m))) - Number(a.rows.some((r) => isSale(r.m))));
  list.innerHTML = items.map(({ item, rows }) => cardHtml(item, rows, `data-open="watch/${esc(item.key)}"`)
    .replace("</button></li>", `</button><button class="remove" data-unwatch="${esc(item.key)}" aria-label="Remove ${esc(item.key)}">×</button></li>`)).join("");
}

// ---------- shopping list + trip planner ----------

function tripEntries() {
  return tripList.map((t) => {
    const item = resolveItem(t.kind, t.key);
    const options = new Map();
    if (item) for (const r of ranked(item)) if (r.s.final != null) options.set(r.m.merchant, r);
    return { t, item, options };
  });
}

function planTrip(entries) {
  const priced = entries.filter((e) => e.options.size);
  const stores = [...new Set(priced.flatMap((e) => [...e.options.keys()]))];
  const evaluate = (set) => {
    let covered = 0, cost = 0;
    for (const e of priced) {
      const finals = set.filter((s) => e.options.has(s)).map((s) => e.options.get(s).s.final);
      if (finals.length) { covered++; cost += Math.min(...finals); }
    }
    return { set, covered, cost };
  };
  const better = (a, b) => b.covered - a.covered || a.cost - b.cost;
  const singles = stores.map((s) => evaluate([s])).sort(better);
  const pairs = [];
  for (let i = 0; i < stores.length; i++) for (let j = i + 1; j < stores.length; j++) pairs.push(evaluate([stores[i], stores[j]]));
  pairs.sort(better);
  const everyBest = evaluate([...new Set(priced.map((e) => [...e.options.values()].sort((a, b) => a.s.final - b.s.final)[0].m.merchant))]);

  const plans = [];
  if (singles[0]) plans.push({ ...singles[0], label: "One store" });
  if (pairs[0] && (pairs[0].covered > singles[0].covered || singles[0].cost - pairs[0].cost >= 1)) plans.push({ ...pairs[0], label: "Two stores" });
  if (everyBest.set.length > (plans.at(-1)?.set.length || 0) && everyBest.cost < (plans.at(-1)?.cost ?? Infinity) - 0.5) {
    plans.push({ ...everyBest, label: `Every best price (${everyBest.set.length} stores)` });
  }
  return { plans, pricedCount: priced.length };
}

function renderTrip() {
  const entries = tripEntries();
  const out = $("#trip");
  if (!entries.length) {
    out.innerHTML = `<div class="empty">Tap “＋ Add to list” on any deal or watched item. Your list is grouped by store, with the cheapest trip worked out.</div>`;
    return;
  }
  const { plans, pricedCount } = planTrip(entries);
  if (planChoice == null || planChoice >= plans.length) planChoice = Math.min(1, plans.length - 1);
  const plan = plans[planChoice];

  const groups = new Map();
  for (const e of entries) {
    let group = "Any store", row = null;
    if (!e.item) group = "No longer available";
    else if (plan && e.options.size) {
      const inPlan = plan.set.filter((s) => e.options.has(s)).map((s) => e.options.get(s)).sort((a, b) => a.s.final - b.s.final)[0];
      row = inPlan || [...e.options.values()].sort((a, b) => a.s.final - b.s.final)[0];
      group = inPlan ? row.m.merchant : "Not on this trip";
    }
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push({ ...e, row });
  }
  const order = [...(plan?.set || []), "Any store", "Not on this trip", "No longer available"];
  const sorted = [...groups.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));

  const cashback = entries.filter((e) => e.item?.c51).reduce((s, e) => s + e.item.c51.cashback, 0);
  const planHtml = plans.map((p, i) => `<button class="plan${i === planChoice ? " active" : ""}" data-plan="${i}">
      <div class="plan-label">${esc(p.label)}</div>
      <div class="plan-stores">${p.set.map((s) => esc(short(s))).join(" + ")}</div>
      <div class="plan-cost">${money(p.cost)} <span class="sub">· ${p.covered}/${pricedCount} items</span></div>
    </button>`).join("");

  const groupHtml = sorted.map(([store, list]) => `<div class="panel group">
    <h2>${esc(store)}</h2>
    ${store === "Any store" ? `<p class="muted">No local price found. Checkout 51 still pays back wherever you buy it.</p>` : ""}
    ${store === "Not on this trip" ? `<p class="muted">Cheapest at a store you're skipping on this trip.</p>` : ""}
    <ul class="trip-items">${list.map((e) => `<li class="${e.t.done ? "done" : ""}">
      <label><input type="checkbox" data-done="${esc(e.t.kind)}|${esc(e.t.key)}" ${e.t.done ? "checked" : ""}>
        <span><span class="name">${esc(e.item?.title || e.t.key)}</span>
        <span class="sub">${e.row ? `${store === "Not on this trip" ? `${esc(short(e.row.m.merchant))} · ` : ""}${esc(e.row.m.name)}` : ""}</span>
        ${e.row?.m.source === "pricematch" ? `<span class="sub">Price match: bring the ${esc(e.row.m.priceMatchFrom)} flyer</span>` : ""}</span></label>
      <span class="right">${e.row ? `<span class="big">${money(e.row.s.final)}</span>` : ""}
        <button class="remove" data-unlist="${esc(e.t.kind)}|${esc(e.t.key)}" aria-label="Remove">×</button></span>
    </li>`).join("")}</ul></div>`).join("");

  out.innerHTML = `
    ${plans.length ? `<div class="plans">${planHtml}</div>` : ""}
    ${cashback ? `<p class="muted">After shopping, claim ${money(cashback)} in Checkout 51 (upload your receipts).</p>` : ""}
    ${groupHtml}
    <div class="links"><button class="button small" data-clear="done">Clear ticked items</button>
      <button class="button small" data-clear="all">Clear list</button></div>`;
}

function toggleList(kind, key) {
  const i = tripList.findIndex((t) => t.kind === kind && t.key === key);
  if (i >= 0) tripList.splice(i, 1); else tripList.push({ kind, key, done: false });
  save("tripList", tripList);
  updateListBadge();
}

function updateListBadge() {
  const open = tripList.filter((t) => !t.done).length;
  $("#list-count").textContent = open ? String(open) : "";
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
      <button class="button small" data-watch-product="${esc(o.product)}">Watch</button>
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
    source: "flyer",
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
    image: (item.clean_image_url || "").replace("http://", "https://"),
  };
}

async function findPrices(id) {
  const mine = myOffers.find((o) => o.id === id);
  const out = document.querySelector(`[data-results="${CSS.escape(id)}"]`);
  if (!mine || !out) return;
  out.innerHTML = `<li class="note">Searching flyers…</li>`;
  try {
    const item = { matches: await liveSearch(mine.product), c51: null };
    const rows = ranked(item).slice(0, 5);
    out.innerHTML = rows.length
      ? rows.map((r, i) => rankHtml(r.m, r.s, i === 0 && r.s.final != null)).join("")
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
  $("#github-token").value = settings.githubToken || "";
}

// ---------- navigation ----------

const TABS = ["deals", "watch", "list", "mine", "settings"];

function go(view) {
  if (view === "deals") renderDeals();
  if (view === "watch") { renderWatch(); fillPendingWatch(); }
  if (view === "list") renderTrip();
  for (const v of document.querySelectorAll(".view")) v.hidden = v.id !== `view-${view}`;
  const tab = view === "detail" ? (location.hash.startsWith("#watch/") ? "watch" : "deals") : view;
  for (const b of document.querySelectorAll(".tabbar button")) b.classList.toggle("active", b.dataset.tab === tab);
  window.scrollTo(0, 0);
}

// Each screen has its own #hash so the phone's back gesture works.
function route() {
  const hash = decodeURIComponent(location.hash.slice(1));
  const [kind, ...rest] = hash.split("/");
  if ((kind === "offer" || kind === "watch") && rest.length) showDetail(kind, rest.join("/"));
  else go(TABS.includes(hash) ? hash : "deals");
}

function addWatch(term) {
  term = term.trim();
  if (!term) return;
  const terms = currentWatchTerms();
  if (terms.some((t) => t.toLowerCase() === term.toLowerCase())) return;
  terms.push(term);
  renderWatch();
  fillPendingWatch();
  syncWatchlist(`add ${term}`);
}

function wire() {
  document.querySelector(".tabbar").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (b) location.hash = b.dataset.tab === "deals" ? "" : b.dataset.tab;
  });
  $("[data-back]").addEventListener("click", () => history.length > 1 ? history.back() : (location.hash = ""));
  window.addEventListener("hashchange", route);
  document.body.addEventListener("click", (e) => {
    const open = e.target.closest("[data-open]");
    if (open) location.hash = open.dataset.open.split("/").map(encodeURIComponent).join("/");
    const toggle = e.target.closest("[data-toggle-list]");
    if (toggle) {
      const [kind, ...key] = toggle.dataset.toggleList.split("|");
      toggleList(kind, key.join("|"));
      showDetail(kind, key.join("|"));
    }
  });
  $(".chips").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-filter]");
    if (!chip) return;
    filter = chip.dataset.filter;
    for (const c of document.querySelectorAll(".chip")) c.classList.toggle("active", c === chip);
    renderDeals();
  });
  $("#search").addEventListener("input", (e) => { query = e.target.value; renderDeals(); });

  $("#watch-form").addEventListener("submit", (e) => {
    e.preventDefault();
    addWatch($("#watch-input").value);
    $("#watch-input").value = "";
  });
  $("#watch-list").addEventListener("click", (e) => {
    const remove = e.target.closest("[data-unwatch]");
    if (!remove) return;
    watchTerms = currentWatchTerms().filter((t) => t !== remove.dataset.unwatch);
    renderWatch();
    syncWatchlist(`remove ${remove.dataset.unwatch}`);
  });

  $("#trip").addEventListener("click", (e) => {
    const plan = e.target.closest("[data-plan]");
    if (plan) { planChoice = +plan.dataset.plan; renderTrip(); }
    const un = e.target.closest("[data-unlist]");
    if (un) { const [kind, ...key] = un.dataset.unlist.split("|"); toggleList(kind, key.join("|")); renderTrip(); }
    const clear = e.target.closest("[data-clear]");
    if (clear) {
      tripList = clear.dataset.clear === "all" ? [] : tripList.filter((t) => !t.done);
      save("tripList", tripList);
      updateListBadge();
      renderTrip();
    }
  });
  $("#trip").addEventListener("change", (e) => {
    const box = e.target.closest("[data-done]");
    if (!box) return;
    const [kind, ...key] = box.dataset.done.split("|");
    const entry = tripList.find((t) => t.kind === kind && t.key === key.join("|"));
    if (entry) entry.done = box.checked;
    save("tripList", tripList);
    updateListBadge();
    box.closest("li").classList.toggle("done", box.checked);
  });

  $("#shots").addEventListener("change", (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    if (files.length) readScreenshots(files);
  });
  $("#mine-list").addEventListener("click", (e) => {
    const find = e.target.closest("[data-find]");
    const remove = e.target.closest("[data-remove]");
    const watch = e.target.closest("[data-watch-product]");
    if (find) findPrices(find.dataset.find);
    if (watch) { addWatch(watch.dataset.watchProduct); location.hash = "watch"; }
    if (remove) {
      myOffers = myOffers.filter((o) => o.id !== remove.dataset.remove);
      save("myOffers", myOffers);
      renderMine();
    }
  });

  $("#store-toggles").addEventListener("change", () => {
    settings.stores = [...document.querySelectorAll("#store-toggles input:checked")].map((i) => i.value);
    save("settings", settings);
  });
  $("#rate-inputs").addEventListener("change", (e) => {
    const input = e.target.closest("[data-rate]");
    if (!input) return;
    settings.rates[input.dataset.rate] = Math.max(0, parseFloat(input.value) || 0);
    save("settings", settings);
  });
  $("#api-key").addEventListener("change", (e) => {
    settings.apiKey = e.target.value.trim();
    save("settings", settings);
  });
  $("#github-token").addEventListener("change", (e) => {
    settings.githubToken = e.target.value.trim();
    save("settings", settings);
    if (settings.githubToken && currentWatchTerms().length) syncWatchlist("sync from phone");
  });
}

async function init() {
  wire();
  dropExpired();
  renderMine();
  updateListBadge();
  try {
    const res = await fetch(`data.json?t=${Date.now()}`);
    data = await res.json();
    const when = new Date(data.generated);
    const onSale = data.offers.filter((o) => ranked(offerItem(o)).some((r) => isSale(r.m) && r.s.final != null)).length;
    $("#scan-info").textContent = `${data.offers.length} Checkout 51 offers · ${onSale} on sale nearby · updated ${when.toLocaleString("en-CA", { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
    $("#data-info").textContent = `Last scan: ${when.toLocaleString("en-CA")}. Flyers for postal code ${data.postalCode}. Prices refresh every night.`;
  } catch {
    $("#scan-info").textContent = "Couldn't load this week's deals.";
  }
  renderSettings();
  route();
}

init();
