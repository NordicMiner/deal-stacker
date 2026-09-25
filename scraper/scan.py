"""Nightly scan: Checkout 51 offers + local flyer prices -> site/data.json.

Standard library only, so it runs anywhere Python 3.10+ is installed.
"""
import html
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
OUT = ROOT / "site" / "data.json"

UA = {"User-Agent": "Mozilla/5.0 (deal-stacker personal use)"}
C51_URL = "https://www.checkout51.com/offers"
FLIPP_SEARCH = "https://backflipp.wishabi.com/flipp/items/search?locale=en-ca&postal_code={postal}&q={q}"

STOPWORDS = {
    "any", "or", "and", "the", "with", "of", "for", "products", "product", "variety",
    "varieties", "select", "ct", "pk", "pack", "buy", "get", "all", "size", "sizes",
    "new", "brand", "your", "from", "in", "on",
}


def fetch(url: str, retries: int = 3) -> str:
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read().decode("utf-8", "ignore")
        except Exception:
            if attempt == retries - 1:
                raise
            time.sleep(2 * (attempt + 1))
    raise RuntimeError("unreachable")


def tokens(text: str) -> list[str]:
    text = re.sub(r"[®™©]", "", text.lower())
    return [t for t in re.split(r"[^a-z0-9&']+", text) if len(t) >= 2 and t not in STOPWORDS and not t.isdigit()]


# ---------- Checkout 51 ----------

OFFER_RE = re.compile(
    r'<a href="(?P<href>/offer/[^"]+)">.*?<img src="(?P<img>[^"]+)"'
    r'.*?<span class="offer-name">(?P<name>.*?)</span>\s*'
    r'<span class="offer-description">(?P<desc>.*?)</span>'
    r'.*?cash-back-amount">\$(?P<cash>[\d.]+)',
    re.S,
)


def scan_checkout51() -> list[dict]:
    page = fetch(C51_URL)
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
        qty = int(buy[1]) if buy else 1
        product = buy[2] if buy else name
        spend = re.search(r"spend \$(\d+(?:\.\d+)?)", desc, re.I)
        offer_id = re.search(r"coupon(\d+)$", m["href"])
        by_key[key] = {
            "id": offer_id[1] if offer_id else m["href"],
            "name": name,
            "product": product,
            "description": desc,
            "cashback": cash,
            "cashbackMin": cash,
            "qty": qty,
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


def program_for(merchant: str) -> str | None:
    for program, merchants in CONFIG["loyalty_programs"].items():
        if merchant in merchants:
            return program
    return None


def parse_item(item: dict) -> dict | None:
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
    buy = BUY_RE.search(story)
    spend = SPEND_RE.search(story)
    img = item.get("clean_image_url") or item.get("clipping_image_url") or ""
    return {
        "merchant": item["merchant_name"],
        "name": item.get("name") or "",
        "price": round(unit_price, 2) if unit_price is not None else None,
        "priceText": f"{pre}${price:.2f}{(' ' + post) if post else ''}".strip() if price is not None else "See store",
        "storeCoupon": float(coupon[1]) if coupon else 0,
        "perWeight": bool(re.search(r"/\s*(lb|kg|100\s*g)", post, re.I)),
        "saleStory": story or None,
        "points": int(pts[1].replace(",", "")) if pts else 0,
        "pointsBuy": int(buy[1]) if (pts and buy) else 1,
        "pointsSpend": float(spend[1]) if (pts and spend) else None,
        "program": program_for(item["merchant_name"]),
        "validTo": item.get("valid_to"),
        "image": img.replace("http://", "https://"),
    }


def relevant(query_tokens: list[str], item: dict) -> bool:
    if not query_tokens:
        return False
    hay = set(tokens(f"{item.get('name', '')} {item.get('brand') or ''}"))
    hits = sum(1 for t in query_tokens if t in hay or t.rstrip("s") in hay or t + "s" in hay)
    if query_tokens[0] not in hay and query_tokens[0].rstrip("s") not in hay:
        return False  # first word is usually the brand; require it
    return hits / len(query_tokens) >= 0.6


def search_flyers(offer: dict) -> list[dict]:
    query = re.sub(r"\(.*?\)", "", offer["product"])
    query = re.sub(r"[®™©]", "", query).strip()
    q_tokens = tokens(query)
    url = FLIPP_SEARCH.format(postal=CONFIG["postal_code"], q=urllib.parse.quote(query))
    try:
        data = json.loads(fetch(url))
    except Exception as e:  # one failed search shouldn't sink the whole scan
        print(f"  ! search failed for {query!r}: {e}", file=sys.stderr)
        return []
    stores = set(CONFIG["stores"])
    best: dict[tuple, dict] = {}
    for raw in data.get("items", []):
        if raw.get("merchant_name") not in stores or not relevant(q_tokens, raw):
            continue
        item = parse_item(raw)
        if not item:
            continue
        key = (item["merchant"], item["name"].lower())
        if key not in best or (item["price"] or 1e9) < (best[key]["price"] or 1e9):
            best[key] = item
    return sorted(best.values(), key=lambda i: i["price"] if i["price"] is not None else 1e9)


def main() -> None:
    started = time.time()
    offers = scan_checkout51()
    print(f"Checkout 51: {len(offers)} cashback offers")
    with ThreadPoolExecutor(max_workers=6) as pool:
        for offer, matches in zip(offers, pool.map(search_flyers, offers)):
            offer["matches"] = matches
    found = sum(1 for o in offers if o["matches"])
    print(f"Flyers: {found}/{len(offers)} offers found in a local flyer")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "postalCode": CONFIG["postal_code"],
        "stores": CONFIG["stores"],
        "loyaltyPrograms": CONFIG["loyalty_programs"],
        "offers": offers,
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {OUT} in {time.time() - started:.0f}s")
    if not offers:
        sys.exit("No Checkout 51 offers parsed - page layout may have changed")


if __name__ == "__main__":
    main()
