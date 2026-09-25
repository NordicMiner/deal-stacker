"""Nightly scan -> site/data.json (+ site/history.json).

For every Checkout 51 offer and every watchlist item: search local flyers and
store shelf prices, record price history, judge whether today's price is a
good one, and send a phone alert for new sales on watched items.

Standard library only, so it runs anywhere Python 3.10+ is installed.
"""
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import history as hist  # noqa: E402
import notify  # noqa: E402
import sources  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CONFIG = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
SITE = ROOT / "site"
DATA = SITE / "data.json"
HISTORY = SITE / "history.json"
WATCHLIST = ROOT / "watchlist.json"
OWNER, REPO = CONFIG["repo"].split("/")
APP_URL = f"https://{OWNER.lower()}.github.io/{REPO}/"
FLIPP_FLYERS = "https://backflipp.wishabi.com/flipp/data?locale=en-ca&postal_code={postal}"


def local_today() -> date:
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("America/Edmonton")).date()
    except Exception:  # no tz database (e.g. bare Windows Python)
        return (datetime.now(timezone.utc) - timedelta(hours=6)).date()


def load_json(path: Path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return fallback


shelf_failures: dict[str, int] = {}


def search_everywhere(job: tuple[str, frozenset, bool]) -> list[dict]:
    query, wanted, strict = job
    matches = (sources.flyer_matches(CONFIG, query, wanted, strict)
               + sources.shelf_matches(CONFIG, query, shelf_failures, wanted, strict))
    return sorted(matches, key=lambda m: m["price"] if m["price"] is not None else 1e9)


def is_sale(m: dict) -> bool:
    return m["source"] == "flyer" or bool(m.get("wasPrice") and m["price"] < m["wasPrice"])


def money(n: float) -> str:
    return f"${n:.2f}"


def grocery_flyer_ids() -> list[int]:
    try:
        data = json.loads(sources.fetch(FLIPP_FLYERS.format(postal=CONFIG["postal_code"])))
    except Exception as e:
        print(f"  ! flyer list failed: {e}", file=sys.stderr)
        return []
    stores = set(CONFIG["stores"])
    return sorted(f["id"] for f in data.get("flyers", [])
                  if f.get("merchant") in stores and "Groceries" in (f.get("categories") or []))


def build_alerts(history: dict, offers: list[dict], watch: list[dict], flyer_ids: list[int], today: date) -> None:
    lines = []
    watch_hits = 0
    for w in watch:
        sales = [m for m in w["matches"] if is_sale(m) and m["price"] is not None and not m.get("perWeight")]
        if not sales:
            continue
        best = min(sales, key=lambda m: m["price"])
        key = f"watch|{w['key']}|{best['merchant']}|{best['price']}"
        if key in history["notified"]:
            continue
        history["notified"][key] = today.isoformat()
        was = f" (was {money(best['wasPrice'])})" if best.get("wasPrice") else ""
        lines.append(f"⭐ {w['term']}: {money(best['price'])} at {best['merchant']}{was}")
        watch_hits += 1

    new_flyers = [i for i in flyer_ids if i not in history["flyerWeeks"]]
    if new_flyers and history["flyerWeeks"]:  # skip the very first run
        on_sale = []
        for o in offers:
            flyer = [m for m in o["matches"] if m["source"] == "flyer" and m["price"]]
            if flyer:
                best = flyer[0]
                pct = (o["cashback"] / o["qty"] + best["storeCoupon"]) / best["price"]
                on_sale.append((pct, o, best))
        on_sale.sort(key=lambda x: -x[0])
        lines.append(f"🗞️ New flyers are in: {len(on_sale)} Checkout 51 offers are on sale nearby.")
        for pct, o, best in on_sale[:3]:
            lines.append(f"• {o['name']} at {best['merchant']} ({money(best['price'])} before cashback)")
    history["flyerWeeks"] = sorted(set(history["flyerWeeks"]) | set(flyer_ids))[-60:]

    title = (f"{watch_hits} of your items {'is' if watch_hits == 1 else 'are'} on sale"
             if watch_hits else "New flyers are in")
    if os.environ.get("GITHUB_EVENT_NAME", "schedule") in ("schedule", "workflow_dispatch"):
        notify.send(title, lines, APP_URL)
    elif lines:
        print(f"(alert not sent on {os.environ.get('GITHUB_EVENT_NAME')} run) {title}: {lines}")


def main() -> None:
    started = time.time()
    today = local_today()
    history = load_json(HISTORY, None) or hist.empty()

    offers = sources.checkout51_offers()
    watch_terms = [t.strip() for t in load_json(WATCHLIST, {"items": []}).get("items", []) if t.strip()]
    print(f"Checkout 51: {len(offers)} cashback offers; watchlist: {len(watch_terms)} items")

    # Checkout 51 often names the eligible size ("Valid on 156 g"); search for that size.
    jobs = [(o["product"], frozenset(sources.offer_sizes(o["name"], o["description"])), False) for o in offers]
    jobs += [(t, frozenset(), True) for t in watch_terms]  # watchlist words are often generic: be strict
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = dict(zip(jobs, pool.map(search_everywhere, jobs)))

    for o, job in zip(offers, jobs):
        o["matches"] = results[job]
        o["key"] = sources.term_key(o["product"])
        hist.record(history, o["key"], o["matches"], today)
        o["verdict"] = hist.verdict(history, o["key"], o["matches"], today)
    watch = []
    for term in watch_terms:
        w = {"term": term, "key": sources.term_key(term), "matches": results[(term, frozenset(), True)]}
        hist.record(history, w["key"], w["matches"], today)
        w["verdict"] = hist.verdict(history, w["key"], w["matches"], today)
        watch.append(w)

    build_alerts(history, offers, watch, grocery_flyer_ids(), today)
    hist.prune(history, today)

    in_flyer = sum(1 for o in offers if any(m["source"] == "flyer" for m in o["matches"]))
    priced = sum(1 for o in offers if o["matches"])
    print(f"Prices: {priced}/{len(offers)} offers priced somewhere ({in_flyer} in a flyer)")
    if shelf_failures:
        print(f"Shelf-price lookups that failed: {shelf_failures}")

    SITE.mkdir(parents=True, exist_ok=True)
    DATA.write_text(json.dumps({
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "postalCode": CONFIG["postal_code"],
        "repo": CONFIG["repo"],
        "stores": CONFIG["stores"],
        "loyaltyPrograms": CONFIG["loyalty_programs"],
        "priceMatch": CONFIG.get("price_match", {}),
        "shelfStores": {st["merchant"]: st.get("note", "") for st in CONFIG.get("shelf_stores", [])},
        "offers": offers,
        "watch": watch,
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    HISTORY.write_text(json.dumps(history, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {DATA.name} and {HISTORY.name} in {time.time() - started:.0f}s")
    if not offers:
        sys.exit("No Checkout 51 offers parsed - page layout may have changed")


if __name__ == "__main__":
    main()
