"""Data sources: Checkout 51 offers, Flipp flyers, and store shelf prices."""
import html
import json
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36"}
C51_URL = "https://www.checkout51.com/offers"
FLIPP_SEARCH = "https://backflipp.wishabi.com/flipp/items/search?locale=en-ca&postal_code={postal}&q={q}"
PCX_SEARCH = "https://api.pcexpress.ca/pcx-bff/api/v1/products/search"
PCX_HEADERS = {
    # Public key the Loblaw grocery websites send with every request.
    "x-apikey": "C1xujSegT5j3ap3yexJjqhOfELwGKYvz",
    "x-application-type": "Web",
    "x-loblaw-tenant-id": "ONLINE_GROCERIES",
    "Accept-Language": "en",
    "Content-Type": "application/json",
}
PCX_SITES = {
    "superstore": "https://www.realcanadiansuperstore.ca",
    "independent": "https://www.yourindependentgrocer.ca",
    "nofrills": "https://www.nofrills.ca",
}
SAVEON_SEARCH = "https://storefrontgateway.saveonfoods.com/api/stores/{store}/preview?q={q}&take=12"

STOPWORDS = {
    "any", "or", "and", "the", "with", "of", "for", "products", "product", "variety",
    "varieties", "select", "ct", "pk", "pack", "buy", "get", "all", "size", "sizes",
    "new", "brand", "your", "from", "in", "on",
}


def fetch(url: str, retries: int = 3, headers: dict | None = None, body: bytes | None = None) -> str:
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, data=body, headers={**UA, **(headers or {})})
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read().decode("utf-8", "ignore")
        except urllib.error.HTTPError as e:
            if e.code < 500 and e.code != 429 or attempt == retries - 1:
                raise  # a bad request won't get better by retrying
            time.sleep(2 * (attempt + 1))
        except Exception:
            if attempt == retries - 1:
                raise
            time.sleep(2 * (attempt + 1))
    raise RuntimeError("unreachable")


def strip_accents(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", text) if not unicodedata.combining(c))


def tokens(text: str) -> list[str]:
    text = re.sub(r"[®™©]", "", strip_accents(text).lower())
    return [t for t in re.split(r"[^a-z0-9&']+", text) if len(t) >= 2 and t not in STOPWORDS and not t.isdigit()]


def term_key(text: str) -> str:
    """Stable key for a product search, used to join price history across weeks."""
    return " ".join(tokens(re.sub(r"\(.*?\)", "", text)))


def relevant(query: str, name: str) -> bool:
    query = re.sub(r"\(.*?\)", "", query)
    q = tokens(query)
    if not q:
        return False
    hay = set(tokens(name))
    has = lambda t: t in hay or t.rstrip("s") in hay or t + "s" in hay
    brand = q[0]
    if not has(brand):
        return False  # first word is usually the brand; require it
    if sum(1 for t in q if has(t)) / len(q) >= 0.7:
        return True
    # Offers often name several products: "TENA Men Shields, Guards or Underwear".
    # Any one option can match. A bare one-word option ("Underwear") also needs a
    # word from the options before it ("Men"), so plain TENA underwear doesn't count.
    parts = [tokens(p) for p in re.split(r",|/|&|\bor\b", query, flags=re.I)]
    parts = [[t for t in p if t != brand] for p in parts if p]
    if len(parts) < 2:
        return False
    seen: list[str] = []
    for part in parts:
        if part and sum(1 for t in part if has(t)) / len(part) >= 0.7:
            if len(part) > 1 or not seen or any(has(t) for t in seen):
                return True
        seen.extend(part)
    return False


def clean_query(text: str) -> str:
    return strip_accents(re.sub(r"[®™©]", "", re.sub(r"\(.*?\)", "", text))).strip()


# ---------- Checkout 51 ----------

OFFER_RE = re.compile(
    r'<a href="(?P<href>/offer/[^"]+)">.*?<img src="(?P<img>[^"]+)"'
    r'.*?<span class="offer-name">(?P<name>.*?)</span>\s*'
    r'<span class="offer-description">(?P<desc>.*?)</span>'
    r'.*?cash-back-amount">\$(?P<cash>[\d.]+)',
    re.S,
)


def checkout51_offers() -> list[dict]:
    # Checkout 51 picks the country from the visitor's IP; the nightly job runs
    # on US servers, so ask for the Canadian offers explicitly.
    page = fetch(C51_URL, headers={"Cookie": "c51_production_country=CA"})
    offers, by_key = [], {}
    for m in OFFER_RE.finditer(page):
        name = html.unescape(m["name"]).strip()
        desc = html.unescape(m["desc"]).strip()
        cash = float(m["cash"])
        if cash <= 0:
            continue
        # The public page lists the same offer at several amounts (they vary by
        # member); keep one entry and show the range.
        key = (name.lower(), desc.lower())
        if key in by_key:
            existing = by_key[key]
            existing["cashbackMin"] = min(existing["cashbackMin"], cash)
            existing["cashback"] = max(existing["cashback"], cash)
            continue
        buy = re.match(r"buy\s+(\d+)\s*:\s*(.*)", name, re.I)
        spend = re.search(r"spend \$(\d+(?:\.\d+)?)", desc, re.I)
        offer_id = re.search(r"coupon(\d+)$", m["href"])
        by_key[key] = {
            "id": offer_id[1] if offer_id else m["href"],
            "name": name,
            "product": buy[2] if buy else name,
            "description": desc,
            "cashback": cash,
            "cashbackMin": cash,
            "qty": int(buy[1]) if buy else 1,
            "spendMin": float(spend[1]) if spend else None,
            "image": m["img"],
            "url": "https://www.checkout51.com" + m["href"],
        }
        offers.append(by_key[key])
    return offers


# ---------- Flipp flyers ----------

POINTS_RE = re.compile(
    r"(\d{1,3}(?:,\d{3})+|\d+)\s*(?:PC\s*Optimum\s*|Scene\+\s*|More\s*Rewards\s*)?(?:pts|points)\b", re.I
)
BUY_RE = re.compile(r"(?:when you )?buy\s+(\d+)", re.I)
SPEND_RE = re.compile(r"spend \$(\d+(?:\.\d+)?)", re.I)
STORE_COUPON_RE = re.compile(r"save \$(\d+(?:\.\d+)?) with (?:digital |in-store |store )?coupon", re.I)


def points_terms(text: str) -> dict:
    """What a points offer needs: "when you buy 2", "for every $24.97 spent", ..."""
    text = text or ""
    buy = BUY_RE.search(text)
    spend = re.search(r"(?:spend|every)\s+\$(\d+(?:\.\d+)?)", text, re.I) or SPEND_RE.search(text)
    return {
        "pointsBuy": int(buy[1]) if buy else 1,
        "pointsSpend": float(spend[1]) if spend else None,
        "pointsRepeat": bool(re.search(r"\b(every|each)\b", text, re.I)),
    }


def program_for(config: dict, merchant: str) -> str | None:
    for program, merchants in config["loyalty_programs"].items():
        if merchant in merchants:
            return program
    return None


def parse_flyer_item(config: dict, item: dict) -> dict | None:
    price = item.get("current_price")
    story = item.get("sale_story") or ""
    coupon = STORE_COUPON_RE.search(story)
    if price is None and not coupon:
        return None  # no price and nothing to stack - not useful
    pre = (item.get("pre_price_text") or "").strip()
    post = (item.get("post_price_text") or "").strip()
    multi = re.match(r"(\d+)\s*/", pre)  # "2/" $5 -> $2.50 each
    unit_price = price / int(multi[1]) if (multi and price is not None) else price
    pts = POINTS_RE.search(story)
    terms = points_terms(story) if pts else {"pointsBuy": 1, "pointsSpend": None, "pointsRepeat": False}
    img = item.get("clean_image_url") or item.get("clipping_image_url") or ""
    return {
        "source": "flyer",
        "merchant": item["merchant_name"],
        "name": item.get("name") or "",
        "price": round(unit_price, 2) if unit_price is not None else None,
        "priceText": f"{pre}${price:.2f}{(' ' + post) if post else ''}".strip() if price is not None else "See store",
        "storeCoupon": float(coupon[1]) if coupon else 0,
        "perWeight": bool(re.search(r"/\s*(lb|kg|100\s*g)", post, re.I)),
        "saleStory": story or None,
        "points": int(pts[1].replace(",", "")) if pts else 0,
        **terms,
        "program": program_for(config, item["merchant_name"]),
        "validTo": item.get("valid_to"),
        "image": img.replace("http://", "https://"),
    }


def flyer_matches(config: dict, query: str, wanted: frozenset = frozenset()) -> list[dict]:
    q = clean_query(query)
    url = FLIPP_SEARCH.format(postal=config["postal_code"], q=urllib.parse.quote(q))
    try:
        data = json.loads(fetch(url))
    except Exception as e:  # one failed search shouldn't sink the whole scan
        print(f"  ! flyer search failed for {q!r}: {e}", file=sys.stderr)
        return []
    stores = set(config["stores"])
    best: dict[tuple, dict] = {}
    for raw in data.get("items", []):
        if raw.get("merchant_name") not in stores:
            continue
        if not relevant(q, f"{raw.get('name', '')} {raw.get('brand') or ''}"):
            continue
        item = parse_flyer_item(config, raw)
        if not item or not size_ok(wanted, item["name"]):
            continue
        key = (item["merchant"], item["name"].lower())
        if key not in best or (item["price"] or 1e9) < (best[key]["price"] or 1e9):
            best[key] = item
    return sorted(best.values(), key=lambda i: i["price"] if i["price"] is not None else 1e9)


# ---------- Shelf (regular) prices ----------

def _pcx_search(store: dict, query: str) -> list[dict]:
    body = json.dumps({
        "term": query,
        "banner": store["banner"],
        "storeId": store["store_id"],
        "lang": "en",
        "date": datetime.now(timezone(timedelta(hours=-6))).strftime("%d%m%Y"),
        "pickupType": "STORE",
        "pagination": {"from": 0, "size": 12},
        "cartId": "",
    }).encode()
    site = PCX_SITES[store["banner"]]
    headers = {**PCX_HEADERS, "Site-Banner": store["banner"], "Origin": site, "Referer": site + "/"}
    data = json.loads(fetch(PCX_SEARCH, headers=headers, body=body))
    items = []
    for r in data.get("results", []):
        prices = r.get("prices") or {}
        price = (prices.get("price") or {}).get("value")
        if price is None or r.get("stockStatus") == "OOS":
            continue
        was = (prices.get("wasPrice") or {}).get("value")
        badges = r.get("badges") or {}
        loyalty = badges.get("loyaltyBadge") or {}
        deal = badges.get("dealBadge") or {}
        unit = (prices.get("price") or {}).get("unit") or "ea"
        points = loyalty.get("points")
        try:
            points = int(str(points).replace(",", "")) if points else 0
        except ValueError:
            points = 0
        # The badge only says "PC Optimum Offer"; the promotion text has the rule,
        # e.g. "Get 5000 PC Optimum bonus points for every $24.97 spent".
        promo = next((p.get("text") for p in (r.get("promotions") or [])
                      if p.get("type") == "LOYALTY" and p.get("text")), "")
        name = f"{r.get('brand') or ''} {r.get('name') or ''}".strip()
        size = r.get("packageSize") or ""
        img = next((a.get("smallUrl") or a.get("mediumUrl") for a in (r.get("imageAssets") or []) if a), "")
        items.append({
            "source": "shelf",
            "merchant": store["merchant"],
            "name": f"{name}, {size}" if size else name,
            "price": round(price, 2),
            "priceText": f"${price:.2f}{'' if unit == 'ea' else '/' + unit}",
            "wasPrice": round(was, 2) if was else None,
            "perWeight": unit != "ea",
            "storeCoupon": 0,
            "saleStory": (promo or loyalty.get("text") or deal.get("text") or None),
            "points": points,
            **points_terms(promo),
            "program": "PC Optimum",
            "validTo": deal.get("expiryDate") or loyalty.get("expiryDate"),
            "image": img,
            "link": site + (r.get("link") or ""),
        })
    return items


def _saveon_search(store: dict, query: str) -> list[dict]:
    url = lambda q: SAVEON_SEARCH.format(store=store["store_id"], q=urllib.parse.quote(q))
    try:
        data = json.loads(fetch(url(query)))
    except urllib.error.HTTPError as e:
        if e.code != 400:
            raise
        # Save-On rejects some long or punctuated searches; retry with the core words.
        data = json.loads(fetch(url(" ".join(tokens(query)[:3]))))
    items = []
    for p in data.get("products", []):
        price = p.get("priceNumeric")
        if not price or p.get("available") is False:
            continue
        size = p.get("unitOfSize") or {}
        size_txt = f"{size.get('size'):g} {size.get('abbreviation')}" if size.get("size") else ""
        by_weight = (p.get("sellBy") or "").lower() not in ("", "each")
        img = (p.get("image") or {}).get("default") or ""
        items.append({
            "source": "shelf",
            "merchant": store["merchant"],
            "name": f"{p.get('name')}{', ' + size_txt if size_txt and not by_weight else ''}",
            "price": round(price, 2),
            "priceText": p.get("price") or f"${price:.2f}",
            "wasPrice": p.get("wasPriceNumeric"),
            "perWeight": by_weight,
            "storeCoupon": 0,
            "saleStory": p.get("priceLabel") or None,
            "points": 0,
            "pointsBuy": 1,
            "pointsSpend": None,
            "program": "More Rewards",
            "validTo": None,
            "image": img,
            "link": f"https://www.saveonfoods.com/sm/pickup/rsid/{store['store_id']}/product/{p.get('sku') or p.get('productId')}",
        })
    return items


SHELF_SOURCES = {"pcx": _pcx_search, "saveon": _saveon_search}


def shelf_matches(config: dict, query: str, failures: dict, wanted: frozenset = frozenset()) -> list[dict]:
    """Regular store prices, up to two relevant items of the wanted size per store."""
    q = clean_query(query)
    out = []
    for store in config.get("shelf_stores", []):
        try:
            items = SHELF_SOURCES[store["source"]](store, q)
        except Exception as e:
            failures[store["merchant"]] = failures.get(store["merchant"], 0) + 1
            if failures[store["merchant"]] <= 2:
                print(f"  ! {store['merchant']} search failed for {q!r}: {e}", file=sys.stderr)
            continue
        hits = [i for i in items if relevant(q, i["name"]) and size_ok(wanted, i["name"])]
        out.extend(sorted(hits, key=lambda i: i["price"])[:2])
    return out


# ---------- package sizes ----------

UNITS = r"kg|g|ml|l|ct|count|pk|pack|pods?|pacs?|sheets?|ea|bars?|rolls?|capsules?|caplets?|tablets?"
# "156 g", and lists that share a unit: "8 or 12 rolls", "665 mL or 828 mL"
SIZE_RE = re.compile(rf"((?:\d+(?:\.\d+)?\s*(?:,|or|/)\s*)*\d+(?:\.\d+)?)\s*({UNITS})\b", re.I)
UNIT_ALIASES = {"count": "ct", "pk": "ct", "pack": "ct", "pod": "ct", "pods": "ct", "pac": "ct", "pacs": "ct",
                "ea": "ct", "bar": "ct", "bars": "ct", "roll": "ct", "rolls": "ct", "sheet": "sheets",
                "capsule": "ct", "capsules": "ct", "caplet": "ct", "caplets": "ct", "tablet": "ct", "tablets": "ct"}


def sizes(text: str) -> set[tuple[float, str]]:
    out = set()
    for nums, unit in SIZE_RE.findall(text or ""):
        unit = UNIT_ALIASES.get(unit.lower(), unit.lower())
        for num in re.findall(r"\d+(?:\.\d+)?", nums):
            value = float(num)
            u = unit
            if u == "kg":
                value, u = value * 1000, "g"
            if u == "l":
                value, u = value * 1000, "ml"
            out.add((round(value, 1), u))
    return out


def offer_sizes(name: str, description: str) -> set[tuple[float, str]]:
    """Sizes an offer is valid on, from its name and its "Valid on ..." sentences.

    Ignores exclusions like "Excludes 5 count or lower trial packs".
    """
    valid = [s for s in re.split(r"(?<=\.)\s+", description or "")
             if s.lower().startswith("valid on") and "exclud" not in s.lower()]
    return sizes(name) | sizes(" ".join(valid))


def size_ok(wanted: set, item_name: str) -> bool:
    """False only when both sides state a size and none of them agree."""
    if not wanted:
        return True
    have = sizes(item_name)
    comparable = {u for _, u in wanted} & {u for _, u in have}
    if not comparable:
        return True
    return any(w in have for w in wanted)
