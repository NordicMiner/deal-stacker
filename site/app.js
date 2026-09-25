// Deal Stacker - ranks Checkout 51 offers and watched items by final cost at
// each local store, stacking sale prices, store coupons, loyalty points, price
// matching and her own offers; plans the cheapest shopping trip.

const FLIPP_SEARCH = "https://backflipp.wishabi.com/flipp/items/search?locale=en-ca";
const CLAUDE_MODEL = "claude-opus-5";
const DEFAULT_RATES = { "PC Optimum": 1, "Scene+": 10, "More Rewards": 1.5, "Be Well": 1 }; // $ per 1,000 pts
const DEFAULT_STORES = [
  "Walmart", "Real Canadian Superstore", "No Frills", "Save-On-Foods", "Safeway",
  "Sobeys", "Costco", "Shoppers Drug Mart", "Your Independent Grocer",
  "Pet Valu", "PetSmart", "Real Canadian Liquor Store", "Sobeys & Safeway Liquor", "London Drugs",
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
// Switch on default stores added since this phone last saved its settings.
settings.seenStores ??= [...settings.stores];
for (const s of DEFAULT_STORES.filter((s) => !settings.seenStores.includes(s))) {
  settings.seenStores.push(s);
  if (!settings.stores.includes(s)) settings.stores.push(s);
  save("settings", settings);
}
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
// Same rules and word list as relevant()/PROCESSED in scraper/sources.py.
const PROCESSED = new Set(["baby", "bar", "bars", "cake", "candies", "candle", "candy", "carton", "cereal", "chips", "cocktail", "concentrate", "cookies", "crisps", "dressing", "dried", "drink", "drinks", "flavor", "flavored", "flavour", "flavoured", "freshener", "frozen", "gummies", "gummy", "jam", "jelly", "juice", "lemonade", "lotion", "muffin", "muffins", "oil", "pie", "popsicle", "popsicles", "pouch", "pouches", "punch", "puree", "refreshers", "sauce", "scent", "scented", "shampoo", "smoothie", "smoothies", "snack", "snacks", "soda", "sparkling", "spread", "syrup", "tea", "vinegar", "wash", "yoghurt", "yogurt", "cartons", "bites", "can", "cans", "beverage", "beverages"]);
function productMatches(product, itemName, strict = false) {
  product = String(product).replace(/\(.*?\)/g, "");
  const q = tokens(product);
  if (!q.length) return false;
  const hay = new Set(tokens(itemName));
  if (strict && q.length <= 2 && [...hay].some((t) => PROCESSED.has(t) && !q.includes(t))) return false;
  const has = (t) => hay.has(t) || hay.has(t.replace(/s$/, "")) || hay.has(t + "s");
  const brand = q[0];
  if (!has(brand)) return false; // first word is usually the brand
  if (q.filter(has).length / q.length >= 0.7) return true;
  // "TENA Men Shields, Guards or Underwear": any one option can match, but a
  // one-word option also needs a word from the options before it.
  const parts = product.split(/,|\/|&|\bor\b/i).map(tokens).filter((p) => p.length)
    .map((p) => p.filter((t) => t !== brand));
  if (parts.length < 2) return false;
  const seen = [];
  for (const part of parts) {
    if (part.length && part.filter(has).length / part.length >= 0.7 &&
        (part.length > 1 || !seen.length || seen.some(has))) return true;
    seen.push(...part);
  }
  return false;
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

let c51Cash = load("c51Cash", {}); // offer id -> the amount her Checkout 51 app shows

// The offer with her own cashback amount, when she has told us it.
function myC51(o) {
  const mine = c51Cash[o.id];
  return mine == null ? o : { ...o, cashback: mine, cashbackMin: mine };
}

function offerItem(o) {
  return { kind: "offer", key: o.id, title: o.name, image: o.image, desc: o.description,
    product: o.product, matches: o.matches || [], verdict: o.verdict, c51: myC51(o) };
}
function watchItem(term) {
  const server = (data.watch || []).find((w) => w.term.toLowerCase() === term.toLowerCase());
  const found = data.offers.find((o) => productMatches(term, o.product) || productMatches(o.product, term));
  const c51 = found && myC51(found);
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

let c51Limits = load("c51Limits", {}); // offer id -> times Checkout 51 lets her claim it
const claimLimit = (c51) => Math.max(1, c51Limits[c51.id] || 1);

// Everything she gets back for buying n of one item at one store.
function haul(match, c51, n) {
  const price = match.price;
  const program = match.program || programFor(match.merchant);
  const spend = price * n;
  const layers = [];
  const needs = []; // what a bigger haul would unlock
  if (match.storeCoupon) layers.push({ label: "Store digital coupon", amount: match.storeCoupon });

  if (match.points) {
    const b = match.pointsBuy || 1;
    let times, cond;
    if (match.pointsSpend) {
      times = match.pointsRepeat ? Math.floor(spend / match.pointsSpend + 1e-9) : (spend >= match.pointsSpend - 1e-9 ? 1 : 0);
      cond = `${match.pointsRepeat ? "every" : "spend"} $${match.pointsSpend}`;
      if (!times) needs.push(Math.ceil(match.pointsSpend / price - 1e-9));
    } else if (b > 1) {
      times = match.pointsRepeat ? Math.floor(n / b) : (n >= b ? 1 : 0);
      cond = `buy ${b}`;
      if (!times) needs.push(b);
    } else {
      times = n; // points on each item
      cond = n > 1 ? `${n} × ${match.points.toLocaleString()}` : "";
    }
    if (times) {
      const pts = match.points * times;
      layers.push({ label: `${pts.toLocaleString()} ${program || ""} pts${cond ? ` (${cond})` : ""}`,
        amount: pointValue(pts, program), later: true });
    }
  }

  for (const mine of myOffers) {
    if (mine.program !== program || !productMatches(mine.product, match.name)) continue;
    if (mine.onlyAt && !match.merchant.toLowerCase().includes(mine.onlyAt.toLowerCase().replace(/^real canadian /, ""))) continue;
    const q = Math.max(1, mine.minQty || 1, mine.spendMin ? Math.ceil(mine.spendMin / price - 1e-9) : 1);
    if (n < q) { needs.push(q); continue; }
    if (mine.dollarsOff) layers.push({ label: `My ${program}: ${mine.details || "$ off"}`, amount: mine.dollarsOff, mine: true });
    if (mine.points) layers.push({ label: `My ${program}: ${mine.points.toLocaleString()} pts${mine.details ? ` (${mine.details})` : ""}`,
      amount: pointValue(mine.points, program), later: true, mine: true });
  }

  if (c51) {
    const per = c51.qty || 1, limit = claimLimit(c51);
    const claims = Math.min(Math.floor(n / per), limit);
    const range = c51.cashbackMin && c51.cashbackMin !== c51.cashback ? ", up to" : "";
    if (claims) layers.push({ label: `Checkout 51 (${claims > 1 ? `${claims} × ` : ""}${money(c51.cashback)}${per > 1 ? ` per ${per}` : ""}${range})`,
      amount: claims * c51.cashback, later: true, c51: true });
    if (claims < limit) needs.push(per * limit);
  }

  const back = layers.reduce((t, l) => t + l.amount, 0);
  return { n, spend, back, net: spend - back, each: (spend - back) / n, layers, needs };
}

// Best quantity to buy at one store, with the stack for that haul.
function stack(match, c51) {
  const price = match.price;
  const regular = match.wasPrice && price != null && match.wasPrice > price ? match.wasPrice : price;
  if (price == null || price <= 0) {
    const layers = [
      ...(match.storeCoupon ? [{ label: "Store digital coupon", amount: match.storeCoupon }] : []),
      ...(c51 ? [{ label: "Checkout 51", amount: c51.cashback, later: true, c51: true }] : []),
    ];
    return { layers, n: 1, final: null, net: null, regular, stacked: layers.length, hasMine: false, alts: [] };
  }
  const one = haul(match, c51, 1);
  const maxN = Math.min(24, Math.max(1, ...one.needs));
  let best = one;
  const tried = [one];
  for (let n = 2; n <= maxN; n++) {
    const h = haul(match, c51, n);
    tried.push(h);
    if (h.each < best.each - 0.005) best = h;
  }
  // Bigger hauls that unlock something more, for the "or buy N" hint.
  const alts = [...new Set(tried.flatMap((h) => h.needs))].filter((n) => n > best.n && n <= 24)
    .map((n) => haul(match, c51, n))
    .filter((h) => h.back - best.back >= 0.25 * (h.spend - best.spend)) // extra spend earns ≥ 25% back
    .slice(0, 2);
  return { ...best, final: best.each, regular, stacked: best.layers.length,
    hasMine: best.layers.some((l) => l.mine), alts };
}

// "$3.10", "FREE" or "+$1.25 profit"
function netText(net) {
  if (Math.abs(net) < 0.005) return "FREE";
  return net < 0 ? `+${money(-net)} profit` : money(net);
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

let hidden = load("hidden", {}); // "kind|key" -> product names she said aren't it
const hiddenFor = (item) => hidden[`${item.kind}|${item.key}`] || [];

// Best option per store, cheapest first.
function ranked(item) {
  const known = new Set([...(data.stores || []), ...DEFAULT_STORES]);
  const skip = new Set(hiddenFor(item));
  const mine = [...item.matches, ...priceBookMatches(item)].filter((m) => !skip.has(m.name.toLowerCase())).filter((m) => settings.stores.includes(m.merchant) ||
    (m.source === "pricebook" && !known.has(m.merchant)));
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

function rankHtml(m, s, isBest, hideKey) {
  let priceLabel = "Flyer price";
  if (m.source === "shelf") priceLabel = m.wasPrice && m.wasPrice > m.price ? `Sale price (reg. ${money(m.wasPrice)})` : "Shelf price";
  if (m.source === "pricematch") priceLabel = `Price match (${short(m.priceMatchFrom)} flyer)`;
  if (m.source === "pricebook") priceLabel = `${m.via === "manual" ? "Price you saw" : "Your receipt"}, ${shortDate(m.seen)}`;
  const priceRow = m.price != null
    ? `<tr><td>${esc(priceLabel)}${m.perWeight ? " (by weight)" : ""}</td><td>${esc(m.priceText)}</td></tr>`
    : `<tr><td>Price</td><td>not listed</td></tr>`;
  const rows = s.layers.map((l) => `<tr><td>${esc(l.label)}${l.later ? `<span class="later">back after purchase</span>` : ""}</td>
    <td class="minus">−${money(l.amount)}</td></tr>`).join("");
  const buyRow = s.n > 1 ? `<tr><td>Buy ${s.n} × ${money(m.price)}</td><td>${money(s.spend)}</td></tr>` : "";
  const total = s.final == null ? "" : s.n > 1
    ? `<tr class="total"><td>Final cost for ${s.n}</td><td>${netText(s.net)}</td></tr>
       <tr><td>Per item</td><td>${netText(s.final)}</td></tr>`
    : `<tr class="total"><td>Final cost</td><td>${netText(s.final)}</td></tr>`;
  const altNotes = (s.alts || []).map((h) => `Or buy ${h.n}: ${netText(h.net)} total (${netText(h.each)} each), adds ${
    h.layers.filter((l) => !s.layers.some((x) => x.label === l.label)).map((l) => esc(l.label)).join(" + ") || "more back"}.`);
  const ends = m.validTo ? `${m.source === "shelf" ? "Deal" : "Flyer"} ends ${shortDate(m.validTo)}` : "";
  const notes = [
    m.source === "pricematch" ? `Show the ${esc(m.priceMatchFrom)} flyer at the till. It must be the same item and size.` : "",
    m.saleStory ? `${m.source === "flyer" ? "Flyer" : "Store"}: ${esc(m.saleStory)}` : "",
    m.source === "shelf" && data.shelfStores?.[m.merchant] ? `Price from ${esc(data.shelfStores[m.merchant])}` : "",
    m.source === "pricebook" ? `From your price book${m.paid < m.price ? ` (you paid ${money(m.paid)} on sale)` : ""}. Prices may have changed since.` : "",
    ends,
  ].filter(Boolean).map((n) => `<div class="note">${n}</div>`).join("");
  return `<li class="rank${isBest ? " best" : ""}">
    <div class="rank-top"><span class="rank-store">${esc(m.merchant)}${m.source === "pricematch" ? ` <span class="badge green">price match</span>` : ""}</span>
      ${s.final != null ? `<span class="big">${s.n > 1 ? `<span class="qty">buy ${s.n}</span> ` : ""}${netText(s.final)}</span>` : ""}</div>
    <div class="rank-item">${esc(m.name)}</div>
    <table class="stack">${priceRow}${buyRow}${rows}${total}</table>
    ${altNotes.map((n) => `<div class="note tip">💡 ${n}</div>`).join("")}
    ${notes}
    ${m.link ? `<div class="note"><a href="${esc(m.link)}" target="_blank" rel="noopener">View at store ↗</a></div>` : ""}
    ${hideKey && m.source !== "pricematch" ? `<button class="linkish" data-hide="${esc(hideKey)}" data-name="${esc(m.name.toLowerCase())}">Not this product ✕</button>` : ""}
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
    right = `<div class="big">${netText(best.s.final)}</div><div class="sub">${best.s.n > 1 ? `each, buy ${best.s.n} ` : ""}at ${esc(short(best.m.merchant))}</div>`;
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
  if (item.pending && !liveResults.has(key)) {
    liveSearch(key).catch(() => []).then((found) => {
      liveResults.set(key, found);
      if (decodeURIComponent(location.hash) === `#watch/${key}`) showDetail(kind, key);
    });
  }
  const rows = ranked(item);
  const inList = tripList.some((t) => t.kind === kind && t.key === key);
  $("#detail").innerHTML = `
    <div class="detail-head">${item.image ? `<img src="${esc(item.image)}" alt="">` : `<div class="thumb"></div>`}
      <div><h2>${esc(item.title)}</h2>
      ${item.c51 ? `<div class="cash">${cashText(item.c51)} back with Checkout 51</div>` : ""}</div></div>
    ${kind === "offer" && item.c51 && (() => {
      const o = data.offers.find((x) => x.id === item.c51.id);
      if (!o || o.cashbackMin === o.cashback) return "";
      const amounts = [...new Set([o.cashbackMin, o.cashback])];
      return `<div class="limit"><span>My app shows</span>${amounts.map((a) => `<button class="button small${c51Cash[o.id] === a ? " primary" : ""}"
        data-cash="${a}" data-offer-id="${esc(o.id)}">${money(a)}</button>`).join("")}</div>`;
    })()}
    ${item.c51 ? `<div class="limit"><span>Checkout 51 lets me claim it</span>
      <button class="button small" data-limit="-1" data-offer-id="${esc(item.c51.id)}" aria-label="Fewer">−</button>
      <strong>${claimLimit(item.c51)}×</strong>
      <button class="button small" data-limit="1" data-offer-id="${esc(item.c51.id)}" aria-label="More">＋</button></div>` : ""}
    ${item.desc ? `<p class="muted">${esc(item.desc)}</p>` : ""}
    <div class="links">
      <button class="button small ${inList ? "" : "primary"}" data-toggle-list="${esc(kind)}|${esc(key)}">${inList ? "✓ On your list" : "＋ Add to list"}</button>
      ${kind === "offer" ? `<a class="button small" href="${esc(item.c51.url)}" target="_blank" rel="noopener">Checkout 51 ↗</a>` : ""}
    </div>
    ${verdictHtml(item.verdict)}
    <ul class="cards">${rows.length
      ? rows.map((r, i) => rankHtml(r.m, r.s, i === 0 && r.s.final != null, `${kind}|${key}`)).join("")
      : `<li class="empty">${item.pending ? "Full prices arrive after the next scan." : "No local price found this week."}${item.c51 ? ` It still pays ${cashText(item.c51)} back at any store.` : ""}</li>`}</ul>
    ${hiddenFor(item).length ? `<button class="linkish" data-unhide="${esc(kind)}|${esc(key)}">Show ${hiddenFor(item).length} hidden product${hiddenFor(item).length > 1 ? "s" : ""} again</button>` : ""}
    ${shopLinks(item.product)}
    <form class="panel add-price" data-add-price="${esc(item.product)}">
      <h2>Saw a price?</h2>
      <p class="muted">Add a price from a shelf tag or Walmart.ca and it's included in the ranking.</p>
      <div class="add-row three">
        <select name="store" aria-label="Store">${RECEIPT_STORES.filter((x) => x !== "Other")
          .map((x) => `<option${x === "Walmart" ? " selected" : ""}>${esc(x)}</option>`).join("")}</select>
        <input name="price" type="number" min="0" step="0.01" inputmode="decimal" placeholder="$" aria-label="Price" required>
        <button class="button primary" type="submit">Add</button>
      </div>
    </form>`;
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

async function checkToken() {
  const out = $("#token-status");
  if (!settings.githubToken) { out.textContent = "No token saved yet."; return; }
  out.textContent = "Checking…";
  try {
    const res = await fetch(`https://api.github.com/repos/${data.repo}`, {
      headers: { Authorization: `Bearer ${settings.githubToken}`, Accept: "application/vnd.github+json" }, cache: "no-store" });
    if (res.status === 401) throw new Error("GitHub doesn't recognise this token - it may be mistyped or expired");
    if (res.status === 404) throw new Error(`this token can't see ${data.repo} - check "Repository access" includes deal-stacker`);
    if (!res.ok) throw new Error(`GitHub said ${res.status}`);
    const repo = await res.json();
    if (!repo.permissions?.push) throw new Error('the token is read-only - set "Contents" to "Read and write"');
    out.textContent = "✓ Connected. Your watchlist will sync.";
    if (currentWatchTerms().length) syncWatchlist("sync from phone");
  } catch (err) {
    out.textContent = `✗ Not connected: ${err.message}.`;
  }
}

async function liveSearch(term) {
  const url = `${FLIPP_SEARCH}&postal_code=${encodeURIComponent(data.postalCode || "T8N3K8")}&q=${encodeURIComponent(term)}`;
  const json = await (await fetch(url)).json();
  return (json.items || [])
    .filter((i) => productMatches(term, `${i.name} ${i.brand || ""}`, true))
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
      const finals = set.filter((s) => e.options.has(s)).map((s) => e.options.get(s).s.net);
      if (finals.length) { covered++; cost += Math.min(...finals); }
    }
    return { set, covered, cost };
  };
  const better = (a, b) => b.covered - a.covered || a.cost - b.cost;
  const singles = stores.map((s) => evaluate([s])).sort(better);
  const pairs = [];
  for (let i = 0; i < stores.length; i++) for (let j = i + 1; j < stores.length; j++) pairs.push(evaluate([stores[i], stores[j]]));
  pairs.sort(better);
  const everyBest = evaluate([...new Set(priced.map((e) => [...e.options.values()].sort((a, b) => a.s.net - b.s.net)[0].m.merchant))]);

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
  const plan = routeResult ? routeResult.options[routeChoice] : plans[planChoice];

  const groups = new Map();
  for (const e of entries) {
    let group = "Any store", row = null;
    if (!e.item) group = "No longer available";
    else if (plan && e.options.size) {
      const inPlan = plan.set.filter((s) => e.options.has(s)).map((s) => e.options.get(s)).sort((a, b) => a.s.net - b.s.net)[0];
      row = inPlan || [...e.options.values()].sort((a, b) => a.s.net - b.s.net)[0];
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
      <span class="right">${e.row ? `<span class="big">${e.row.s.n > 1 ? `<span class="qty">×${e.row.s.n}</span> ` : ""}${netText(e.row.s.net)}</span>` : ""}
        <button class="remove" data-unlist="${esc(e.t.kind)}|${esc(e.t.key)}" aria-label="Remove">×</button></span>
    </li>`).join("")}</ul></div>`).join("");

  out.innerHTML = `
    ${routeHtml()}
    ${plans.length && !routeResult ? `<div class="plans">${planHtml}</div>` : ""}
    ${cashback ? `<p class="muted">After shopping, claim ${money(cashback)} in Checkout 51 (upload your receipts).</p>` : ""}
    ${groupHtml}
    <div class="links"><button class="button small" data-clear="done">Clear ticked items</button>
      <button class="button small" data-clear="all">Clear list</button></div>`;
}

// ---------- route planner (which stores, which branches, what order) ----------

const OVERPASS = "https://overpass-api.de/api/interpreter";
const OSRM_TABLE = "https://router.project-osrm.org/table/v1/driving/";
const NOMINATIM = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=ca&q=";
const BRANCH_RADIUS_M = 25000;
const MAX_STOPS = 4;
// Order matters: liquor stores before their grocery banners.
const BRANCH_PATTERNS = [
  ["Sobeys & Safeway Liquor", /(sobeys|safeway)\s+liquor/i],
  ["Real Canadian Liquor Store", /liquor\s*store|real canadian liquor/i],
  ["Real Canadian Superstore", /superstore/i],
  ["Walmart", /walmart/i], ["No Frills", /no\s?frills/i], ["Save-On-Foods", /save[- ]?on/i],
  ["Safeway", /safeway/i], ["Sobeys", /sobeys/i], ["Costco", /costco/i],
  ["Shoppers Drug Mart", /shoppers/i], ["Your Independent Grocer", /independent grocer/i],
  ["London Drugs", /london drugs/i], ["PetSmart", /petsmart/i], ["Pet Valu", /pet\s?valu/i],
  ["T&T Supermarket", /t\s?&\s?t\b/i], ["Giant Tiger", /giant tiger/i], ["Dollarama", /dollarama/i],
  ["Rexall", /rexall/i], ["IGA", /\biga\b/i], ["FreshCo", /freshco/i], ["Canadian Tire", /canadian tire/i],
];

let home = load("home", null); // {lat, lon, label} - stays on this phone
let routeResult = null;
let routeChoice = 0;

function km(a, b) {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

// Store branches near home, from OpenStreetMap; cached for 30 days.
async function nearbyBranches() {
  const cached = load("branches", null);
  if (cached && km(cached, home) < 2 && Date.now() - cached.at < 30 * 864e5) return cached.list;
  const around = `(around:${BRANCH_RADIUS_M},${home.lat},${home.lon})`;
  const q = `[out:json][timeout:60];(nwr["shop"~"supermarket|chemist|pet|department_store|variety_store|wholesale|alcohol|general|doityourself"]${around};nwr["amenity"="pharmacy"]${around};);out center tags;`;
  const res = await fetch(OVERPASS, { method: "POST", body: `data=${encodeURIComponent(q)}`,
    headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  if (!res.ok) throw new Error(`store map lookup failed (${res.status})`);
  const list = [];
  for (const el of (await res.json()).elements || []) {
    const t = el.tags || {};
    const name = `${t.brand || ""} ${t.name || ""}`;
    const hit = BRANCH_PATTERNS.find(([, rx]) => rx.test(name));
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    if (!hit || lat == null) continue;
    const street = [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" ");
    list.push({ merchant: hit[0], lat, lon, label: street || t["addr:city"] || t.name || hit[0] });
  }
  save("branches", { lat: home.lat, lon: home.lon, at: Date.now(), list });
  return list;
}

async function drivingMatrix(points) {
  const coords = points.map((p) => `${p.lon.toFixed(5)},${p.lat.toFixed(5)}`).join(";");
  const res = await fetch(`${OSRM_TABLE}${coords}?annotations=duration,distance`);
  const json = await res.json();
  if (json.code !== "Ok") throw new Error("couldn't get driving times");
  return { dur: json.durations, dist: json.distances };
}

function* permutations(arr) {
  if (arr.length <= 1) { yield arr; return; }
  for (let i = 0; i < arr.length; i++) {
    for (const rest of permutations([...arr.slice(0, i), ...arr.slice(i + 1)])) yield [arr[i], ...rest];
  }
}
function* combinations(arr, k, start = 0, pick = []) {
  if (pick.length === k) { yield pick; return; }
  for (let i = start; i < arr.length; i++) yield* combinations(arr, k, i + 1, [...pick, arr[i]]);
}
function* cartesian(lists, i = 0, pick = []) {
  if (i === lists.length) { yield pick; return; }
  for (const x of lists[i]) yield* cartesian(lists, i + 1, [...pick, x]);
}

async function planRoute(fromHere) {
  const status = $("#route-status");
  try {
    if (!home) throw new Error("set your home in Settings first");
    const entries = tripEntries().filter((e) => e.options.size);
    if (!entries.length) throw new Error("add some priced items to your list first");

    status.textContent = "Finding stores near you…";
    let start = home;
    if (fromHere) {
      const pos = await new Promise((ok, fail) => navigator.geolocation.getCurrentPosition(ok, fail, { timeout: 15000 }));
      start = { lat: pos.coords.latitude, lon: pos.coords.longitude, label: "Current location" };
    }
    const branches = await nearbyBranches();

    // Stores worth visiting: cheapest (or within 50¢ of cheapest) for at least one item.
    const useful = new Map();
    for (const e of entries) {
      const best = Math.min(...[...e.options.values()].map((r) => r.s.net));
      for (const [merchant, r] of e.options) if (r.s.net <= best + 0.5) useful.set(merchant, (useful.get(merchant) || 0) + 1);
    }
    const merchants = [...useful.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m)
      .filter((m) => branches.some((b) => b.merchant === m)).slice(0, 8);
    if (!merchants.length) throw new Error("couldn't find any of those stores on the map near home");

    // Up to three nearest branches per store; points 0 = home, 1 = start, then branches.
    let idx = 2;
    const nearest = new Map(merchants.map((m) => [m, branches.filter((x) => x.merchant === m)
      .sort((a, c) => km(a, start) - km(c, start)).slice(0, 3).map((x) => ({ ...x, idx: idx++ }))]));
    const points = [home, start, ...[...nearest.values()].flat()];

    status.textContent = "Working out driving times…";
    const { dur, dist } = await drivingMatrix(points);
    const perKm = settings.perKm ?? 0.25, perHour = settings.perHour ?? 10;

    const best = [];
    for (let k = 1; k <= Math.min(MAX_STOPS, merchants.length); k++) {
      let top = null;
      for (const set of combinations(merchants, k)) {
        let covered = 0, groceries = 0;
        for (const e of entries) {
          const finals = set.filter((m) => e.options.has(m)).map((m) => e.options.get(m).s.net);
          if (finals.length) { covered++; groceries += Math.min(...finals); }
        }
        let route = null;
        for (const pick of cartesian(set.map((m) => nearest.get(m)))) {
          for (const order of permutations(pick)) {
            let s = 0, d = 0, at = 1; // leave from start (index 1), finish at home (index 0)
            for (const b of order) { s += dur[at][b.idx]; d += dist[at][b.idx]; at = b.idx; }
            s += dur[at][0]; d += dist[at][0];
            const cost = (d / 1000) * perKm + (s / 3600) * perHour;
            if (!route || cost < route.cost) route = { order, seconds: s, meters: d, cost };
          }
        }
        const cand = { set: route.order.map((b) => b.merchant), stops: route.order, covered, groceries,
          minutes: Math.round(route.seconds / 60), km: route.meters / 1000, driving: route.cost };
        cand.total = cand.groceries + cand.driving;
        if (!top || cand.covered > top.covered || (cand.covered === top.covered && cand.total < top.total)) top = cand;
      }
      best.push({ ...top, label: `${k} stop${k > 1 ? "s" : ""}` });
    }
    const maxCovered = Math.max(...best.map((b) => b.covered));
    const options = best.filter((b, i) => i === 0 || b.covered > best[i - 1].covered || b.total < best[i - 1].total - 0.5);
    let pick = 0;
    options.forEach((o, i) => {
      const p = options[pick];
      if (o.covered > p.covered || (o.covered === p.covered && o.total < p.total)) pick = i;
    });
    routeResult = { options, start, total: entries.length, maxCovered };
    routeChoice = pick;
    status.textContent = "";
    renderTrip();
  } catch (err) {
    status.textContent = `Couldn't plan the route: ${err.message || err}`;
  }
}

function mapsLink(route) {
  const ll = (p) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;
  const waypoints = route.stops.map(ll).join("|");
  return `https://www.google.com/maps/dir/?api=1&origin=${ll(routeResult.start)}&destination=${ll(home)}`
    + `&waypoints=${encodeURIComponent(waypoints)}&travelmode=driving`;
}

function routeHtml() {
  if (!home) {
    return `<div class="panel route"><h2>🚗 Route</h2>
      <p class="muted">Set your home in Settings and the app will plan the cheapest drive: which stores, which branches and in what order.</p>
      <a class="button small" href="#settings">Set home</a></div>`;
  }
  const head = `<div class="panel route"><h2>🚗 Route</h2>
    <div class="links"><button class="button primary" data-plan-route="home">Plan my route</button>
      <button class="button" data-plan-route="here">From where I am</button>
      ${routeResult ? `<button class="button small" data-clear-route>Clear</button>` : ""}</div>
    <p id="route-status" class="status" role="status"></p>`;
  if (!routeResult) return `${head}</div>`;
  const r = routeResult.options[routeChoice];
  const cards = routeResult.options.map((o, i) => `<button class="plan${i === routeChoice ? " active" : ""}" data-route-choice="${i}">
      <div class="plan-label">${esc(o.label)}</div>
      <div class="plan-cost">${money(o.total)}</div>
      <div class="sub">${money(o.groceries)} groceries + ${money(o.driving)} driving</div>
      <div class="sub">${o.minutes} min · ${o.km.toFixed(1)} km · ${o.covered}/${routeResult.total} items</div>
    </button>`).join("");
  const legs = [`🏠 ${esc(routeResult.start === home ? "Home" : "Current location")}`,
    ...r.stops.map((b, i) => `${i + 1}. <strong>${esc(short(b.merchant))}</strong> <span class="sub">${esc(b.label)}</span>`),
    "🏠 Home"].map((l) => `<li>${l}</li>`).join("");
  return `${head}
    <div class="plans">${cards}</div>
    <ol class="legs">${legs}</ol>
    <a class="button primary" href="${esc(mapsLink(r))}" target="_blank" rel="noopener">Open in Google Maps ↗</a>
    <p class="note">Driving counted at $${(settings.perKm ?? 0.25).toFixed(2)}/km plus $${settings.perHour ?? 10}/hour of your time (change in Settings). Shelf prices are from one branch of each store and are usually the same at the others.</p>
  </div>`;
}

async function findHome(useLocation) {
  const status = $("#home-status");
  try {
    if (useLocation) {
      status.textContent = "Getting your location…";
      const pos = await new Promise((ok, fail) => navigator.geolocation.getCurrentPosition(ok, fail, { timeout: 15000 }));
      home = { lat: pos.coords.latitude, lon: pos.coords.longitude, label: "Saved from this phone's location" };
    } else {
      const q = $("#home-input").value.trim();
      if (!q) return;
      status.textContent = "Looking up that address…";
      const [hit] = await (await fetch(NOMINATIM + encodeURIComponent(q))).json();
      if (!hit) throw new Error("couldn't find that address - try adding the city");
      home = { lat: +hit.lat, lon: +hit.lon, label: hit.display_name };
    }
    save("home", home);
    routeResult = null;
    status.textContent = `Home set: ${home.label}`;
  } catch (err) {
    status.textContent = `Couldn't set home: ${err.message || "location permission was denied"}`;
  }
}

function toggleList(kind, key) {
  const i = tripList.findIndex((t) => t.kind === kind && t.key === key);
  if (i >= 0) tripList.splice(i, 1); else tripList.push({ kind, key, done: false });
  routeResult = null;
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
OFFER_SCHEMA.properties.checkout51 = {
  type: "array",
  items: {
    type: "object",
    properties: { name: { type: "string" }, cashback: { type: "number" }, claimLimit: { type: "integer" } },
    required: ["name", "cashback", "claimLimit"],
    additionalProperties: false,
  },
};
OFFER_SCHEMA.required.push("checkout51");

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

Skip offers not tied to products (e.g. "earn points on fuel", "spend $250 anywhere"). Screenshots may be slices of one long page that overlap; list each offer only once.

Some screenshots may instead be from the Checkout 51 app. Put those in "checkout51", not "offers": for each Checkout 51 offer shown, its name exactly as written, its cash back amount, and its claim limit ("Claim up to 5 times" means 5; use 1 if not shown). If there are no Checkout 51 screenshots, return an empty "checkout51" list.`;

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

// Sends photos to Claude and returns JSON matching the schema.
async function askClaude(files, prompt, schema, status, noun) {
  if (!settings.apiKey) throw new Error("add your Claude API key in Settings first");
  status.textContent = `Preparing ${noun}…`;
  const images = [];
  for (const f of files) images.push(...await imageSlices(f));
  if (images.length > 20) images.length = 20;
  status.textContent = `Reading ${files.length} ${noun}… (about 30 seconds)`;
  const { default: Anthropic } = await import("https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk/+esm");
  const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true });
  let response;
  try {
    response = await client.beta.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { format: { type: "json_schema", schema } },
      messages: [{
        role: "user",
        content: [
          ...images.map((data) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } })),
          { type: "text", text: prompt },
        ],
      }],
    });
  } catch (err) {
    throw new Error(err?.status === 401 ? "that API key didn't work - check it in Settings" : (err?.message || String(err)));
  }
  if (response.stop_reason === "refusal") throw new Error(`Claude couldn't read these ${noun}`);
  if (response.stop_reason === "max_tokens") throw new Error("too much at once - try fewer photos");
  return JSON.parse(response.content.find((b) => b.type === "text")?.text);
}

async function readScreenshots(files) {
  const status = $("#shot-status");
  try {
    const result = await askClaude(files, EXTRACT_PROMPT, OFFER_SCHEMA, status, "screenshots");
    const found = result.offers;
    let c51Updated = 0;
    for (const c of result.checkout51 || []) {
      const same = (o) => productMatches(c.name, o.name) && productMatches(o.name, c.name);
      for (const o of data.offers.filter(same)) {
        if (c.cashback > 0 && Math.abs(c.cashback - o.cashback) < 50) c51Cash[o.id] = c.cashback;
        if (c.claimLimit >= 1) c51Limits[o.id] = Math.min(20, c.claimLimit);
        c51Updated++;
      }
    }
    save("c51Cash", c51Cash);
    save("c51Limits", c51Limits);
    const key = (x) => `${x.program}|${x.product.toLowerCase()}|${x.points}|${x.dollarsOff}`;
    const existing = new Set(myOffers.map(key));
    const fresh = found.filter((x) => !existing.has(key(x)))
      .map((x) => ({ ...x, id: crypto.randomUUID(), added: new Date().toISOString() }));
    myOffers = [...fresh, ...myOffers];
    save("myOffers", myOffers);
    status.textContent = [
      found.length || !c51Updated ? `Added ${fresh.length} offer${fresh.length === 1 ? "" : "s"}${found.length > fresh.length ? ` (${found.length - fresh.length} already saved)` : ""}.` : "",
      c51Updated ? `Updated ${c51Updated} Checkout 51 offer${c51Updated === 1 ? "" : "s"} with your cashback and claim limit.` : "",
    ].filter(Boolean).join(" ");
    renderMine();
  } catch (err) {
    status.textContent = `Couldn't read screenshots: ${err.message}`;
  }
}

// ---------- price book (receipts, shelf tags, prices she types in) ----------

const RECEIPT_STORES = ["Walmart", "Real Canadian Superstore", "No Frills", "Your Independent Grocer", "Save-On-Foods",
  "Safeway", "Sobeys", "IGA", "FreshCo", "Costco", "Shoppers Drug Mart", "London Drugs", "Rexall", "PetSmart",
  "Pet Valu", "Giant Tiger", "T&T Supermarket", "Dollarama", "Canadian Tire", "Other"];

const RECEIPT_SCHEMA = {
  type: "object",
  properties: {
    receipts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          store: { type: "string", enum: RECEIPT_STORES },
          date: { type: "string" },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                price: { type: "number" },
                regularPrice: { type: "number" },
                perWeight: { type: "boolean" },
              },
              required: ["name", "price", "regularPrice", "perWeight"],
              additionalProperties: false,
            },
          },
        },
        required: ["store", "date", "items"],
        additionalProperties: false,
      },
    },
  },
  required: ["receipts"],
  additionalProperties: false,
};

const RECEIPT_PROMPT = `These are photos of Canadian store receipts or shelf price tags, or screenshots of a purchase/order history page from a store's app (e.g. Walmart app purchase history). There may be several receipts or tags, and screenshots may be overlapping slices of one long list - list each item once.

For each receipt or tag:
- store: the store it is from. Walmart app screens (blue header, "Return eligible until…", "Write a review") are Walmart even if the name isn't printed.
- date: YYYY-MM-DD if shown, otherwise "".
- items: every product line, with:
  - name: the full product name with brand and size, expanding receipt abbreviations (e.g. "GV 2% MLK 4L" -> "Great Value 2% Milk 4 L"). If you can't tell what an abbreviation means, keep the words you can read.
  - price: the price for ONE item before tax, after any instant discount printed on the receipt or tag. If a line shows a quantity and a line total (e.g. "Qty 5  $45.60"), divide the total by the quantity ($9.12).
  - regularPrice: the regular price for ONE item if shown (e.g. "was $5.99", a crossed-out price, or a discount line), otherwise 0. Divide crossed-out line totals by the quantity too.
  - perWeight: true for items sold by weight (produce, meat), otherwise false.

Skip deposits, eco fees, bags, tax, subtotals, totals, payment and loyalty lines.`;

let priceBook = load("priceBook", []); // [{id, store, name, price, regularPrice, perWeight, date, via}]
const PRICE_BOOK_DAYS = 120;

function prunePriceBook() {
  const cutoff = new Date(Date.now() - PRICE_BOOK_DAYS * 864e5).toISOString().slice(0, 10);
  const kept = priceBook.filter((e) => e.date >= cutoff);
  if (kept.length !== priceBook.length) { priceBook = kept; save("priceBook", priceBook); }
}

function addPrices(entries) {
  const key = (e) => `${e.store}|${e.name.toLowerCase()}|${e.price}|${e.date}`;
  const existing = new Set(priceBook.map(key));
  const fresh = entries.filter((e) => e.price > 0 && !existing.has(key(e)))
    .map((e) => ({ ...e, id: crypto.randomUUID() }));
  priceBook = [...fresh, ...priceBook];
  save("priceBook", priceBook);
  return fresh.length;
}

async function readReceipts(files) {
  const status = $("#receipt-status");
  try {
    const { receipts } = await askClaude(files, RECEIPT_PROMPT, RECEIPT_SCHEMA, status, "photos");
    const today = new Date().toISOString().slice(0, 10);
    const entries = receipts.filter((r) => r.store !== "Other").flatMap((r) => r.items.map((i) => ({
      store: r.store, name: i.name, price: i.price, regularPrice: i.regularPrice || 0,
      perWeight: i.perWeight, date: /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.date <= today ? r.date : today, via: "receipt",
    })));
    const added = addPrices(entries);
    const stores = [...new Set(receipts.map((r) => r.store))].join(", ");
    status.textContent = `Saved ${added} price${added === 1 ? "" : "s"}${stores ? ` from ${stores}` : ""}.`;
    renderPriceBook();
  } catch (err) {
    status.textContent = `Couldn't read those photos: ${err.message}`;
  }
}

// Her own prices fill in stores the nightly scan can't see (Walmart, London Drugs, PetSmart...).
function priceBookMatches(item) {
  const live = new Set(item.matches.filter((m) => m.price != null).map((m) => m.merchant));
  const wanted = item.c51 ? offerSizes(item.c51.name, item.c51.description) : [];
  const latest = new Map();
  for (const e of priceBook) {
    if (live.has(e.store) || e.perWeight || !productMatches(item.product, e.name, item.kind === "watch") || !sizeOk(wanted, e.name)) continue;
    const cur = latest.get(e.store);
    if (!cur || e.date > cur.date) latest.set(e.store, e);
  }
  return [...latest.values()].map((e) => {
    const price = e.regularPrice > e.price ? e.regularPrice : e.price; // a past sale price may be over
    return { source: "pricebook", merchant: e.store, name: e.name, price, priceText: money(price),
      paid: e.price, seen: e.date, via: e.via, program: programFor(e.store), points: 0, storeCoupon: 0 };
  });
}

function renderPriceBook() {
  const out = $("#pricebook-list");
  if (!priceBook.length) { out.innerHTML = ""; return; }
  const stores = new Set(priceBook.map((e) => e.store));
  out.innerHTML = `<li class="note">${priceBook.length} prices from ${stores.size} store${stores.size > 1 ? "s" : ""}, kept for ${PRICE_BOOK_DAYS} days.</li>`
    + priceBook.slice(0, 40).map((e) => `<li class="book-row">
      <span><span class="name">${esc(e.name)}</span><span class="sub">${esc(short(e.store))} · ${shortDate(e.date)}${e.via === "manual" ? " · typed in" : ""}</span></span>
      <span class="right"><span class="big">${money(e.price)}</span>
        <button class="remove" data-unbook="${esc(e.id)}" aria-label="Remove">×</button></span></li>`).join("");
}

// Same rules as offer_sizes()/size_ok() in scraper/sources.py.
const UNITS = "kg|g|ml|l|ct|count|pk|pack|pods?|pacs?|sheets?|ea|bars?|rolls?|capsules?|caplets?|tablets?";
const UNIT_ALIASES = { count: "ct", pk: "ct", pack: "ct", pod: "ct", pods: "ct", pac: "ct", pacs: "ct", ea: "ct",
  bar: "ct", bars: "ct", roll: "ct", rolls: "ct", sheet: "sheets", capsule: "ct", capsules: "ct", caplet: "ct",
  caplets: "ct", tablet: "ct", tablets: "ct" };
const SIZE_RE = new RegExp(String.raw`((?:\d+(?:\.\d+)?\s*(?:,|or|/)\s*)*\d+(?:\.\d+)?)\s*(${UNITS})\b`, "gi");
function sizes(text) {
  const out = new Set();
  for (const [, nums, rawUnit] of String(text || "").matchAll(SIZE_RE)) {
    for (const n of nums.match(/\d+(?:\.\d+)?/g)) {
      let unit = UNIT_ALIASES[rawUnit.toLowerCase()] || rawUnit.toLowerCase();
      let value = +n;
      if (unit === "kg") { value *= 1000; unit = "g"; }
      if (unit === "l") { value *= 1000; unit = "ml"; }
      out.add(`${Math.round(value * 10) / 10}|${unit}`);
    }
  }
  return [...out];
}
function offerSizes(name, description) {
  const valid = String(description || "").split(/(?<=\.)\s+/)
    .filter((x) => x.toLowerCase().startsWith("valid on") && !x.toLowerCase().includes("exclud"));
  return [...new Set([...sizes(name), ...sizes(valid.join(" "))])];
}
function sizeOk(wanted, itemName) {
  if (!wanted.length) return true;
  const have = sizes(itemName);
  const units = new Set(have.map((x) => x.split("|")[1]));
  if (!wanted.some((w) => units.has(w.split("|")[1]))) return true;
  return wanted.some((w) => have.includes(w));
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
  $("#per-km").value = settings.perKm ?? 0.25;
  $("#per-hour").value = settings.perHour ?? 10;
  $("#home-status").textContent = home ? `Home set: ${home.label}` : "";
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
// A shared link like #import=<base64 JSON> adds prices to this phone's price book.
// The data rides in the URL fragment, which browsers never send to the server.
function importFromLink(encoded) {
  try {
    const bytes = Uint8Array.from(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    const { store, date, items } = JSON.parse(new TextDecoder().decode(bytes));
    const today = new Date().toISOString().slice(0, 10);
    const added = addPrices(items.map((i) => ({
      store, name: i.name, price: i.price, regularPrice: i.regularPrice || 0, perWeight: !!i.perWeight,
      date: /^\d{4}-\d{2}-\d{2}$/.test(date || "") && date <= today ? date : today, via: "receipt",
    })));
    renderPriceBook();
    history.replaceState(null, "", "#mine");
    go("mine");
    $("#receipt-status").textContent = `Imported ${added} ${store} price${added === 1 ? "" : "s"} from the shared link.`;
  } catch {
    history.replaceState(null, "", "#mine");
    go("mine");
    $("#receipt-status").textContent = "That import link looks broken - ask for a new one.";
  }
}

function route() {
  if (location.hash.startsWith("#import=")) return importFromLink(location.hash.slice(8));
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
    const cash = e.target.closest("[data-cash]");
    if (cash) {
      c51Cash[cash.dataset.offerId] = +cash.dataset.cash;
      save("c51Cash", c51Cash);
      routeResult = null;
      route();
    }
    const hide = e.target.closest("[data-hide]");
    if (hide) {
      const list = hidden[hide.dataset.hide] ||= [];
      if (!list.includes(hide.dataset.name)) list.push(hide.dataset.name);
      save("hidden", hidden);
      routeResult = null;
      route();
    }
    const unhide = e.target.closest("[data-unhide]");
    if (unhide) {
      delete hidden[unhide.dataset.unhide];
      save("hidden", hidden);
      routeResult = null;
      route();
    }
    const limit = e.target.closest("[data-limit]");
    if (limit) {
      const id = limit.dataset.offerId;
      c51Limits[id] = Math.min(20, Math.max(1, (c51Limits[id] || 1) + +limit.dataset.limit));
      save("c51Limits", c51Limits);
      routeResult = null;
      route();
    }
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
    const routeBtn = e.target.closest("[data-plan-route]");
    if (routeBtn) planRoute(routeBtn.dataset.planRoute === "here");
    const choice = e.target.closest("[data-route-choice]");
    if (choice) { routeChoice = +choice.dataset.routeChoice; renderTrip(); }
    if (e.target.closest("[data-clear-route]")) { routeResult = null; renderTrip(); }
    const un = e.target.closest("[data-unlist]");
    if (un) { const [kind, ...key] = un.dataset.unlist.split("|"); toggleList(kind, key.join("|")); renderTrip(); }
    const clear = e.target.closest("[data-clear]");
    if (clear) {
      tripList = clear.dataset.clear === "all" ? [] : tripList.filter((t) => !t.done);
      routeResult = null;
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

  $("#receipts").addEventListener("change", (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    if (files.length) readReceipts(files);
  });
  $("#pricebook-list").addEventListener("click", (e) => {
    const remove = e.target.closest("[data-unbook]");
    if (!remove) return;
    priceBook = priceBook.filter((x) => x.id !== remove.dataset.unbook);
    save("priceBook", priceBook);
    renderPriceBook();
  });
  $("#detail").addEventListener("submit", (e) => {
    const form = e.target.closest("[data-add-price]");
    if (!form) return;
    e.preventDefault();
    const price = parseFloat(form.price.value);
    if (!(price > 0)) return;
    addPrices([{ store: form.store.value, name: form.dataset.addPrice, price, regularPrice: 0, perWeight: false,
      date: new Date().toISOString().slice(0, 10), via: "manual" }]);
    route(); // re-render the detail with the new price
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
  $("#home-form").addEventListener("submit", (e) => { e.preventDefault(); findHome(false); });
  $("#home-here").addEventListener("click", () => findHome(true));
  for (const [id, key] of [["#per-km", "perKm"], ["#per-hour", "perHour"]]) {
    $(id).addEventListener("change", (e) => {
      settings[key] = Math.max(0, parseFloat(e.target.value) || 0);
      save("settings", settings);
      routeResult = null;
    });
  }
  $("#api-key").addEventListener("change", (e) => {
    settings.apiKey = e.target.value.trim();
    save("settings", settings);
  });
  $("#github-token").addEventListener("change", (e) => {
    settings.githubToken = e.target.value.trim();
    save("settings", settings);
    checkToken();
  });
  $("#check-token").addEventListener("click", checkToken);
  $("#sync-now").addEventListener("click", () => syncWatchlist("sync from phone"));
}

async function init() {
  wire();
  dropExpired();
  prunePriceBook();
  renderMine();
  renderPriceBook();
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
