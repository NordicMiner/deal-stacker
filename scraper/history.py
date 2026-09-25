"""Price history kept between nightly runs.

Stored as ranges so an unchanged price costs one entry, not one per night:
    series[term][merchant] = [[first_seen, last_seen, price], ...]
"""
from datetime import date, timedelta

KEEP_DAYS = 200
WINDOW_DAYS = 56  # "lowest in 8 weeks"
MIN_TRACKED_DAYS = 14  # don't call anything a low until we've watched a while


def empty() -> dict:
    return {"version": 1, "series": {}, "notified": {}, "flyerWeeks": []}


def record(history: dict, term: str, matches: list[dict], today: date) -> None:
    """Record today's lowest per-store price for a product search."""
    if not term:
        return
    best: dict[str, float] = {}
    for m in matches:
        if m.get("price") is None or m.get("perWeight"):
            continue
        if m["merchant"] not in best or m["price"] < best[m["merchant"]]:
            best[m["merchant"]] = m["price"]
    if not best:
        return
    day = today.isoformat()
    series = history["series"].setdefault(term, {})
    for merchant, price in best.items():
        ranges = series.setdefault(merchant, [])
        if ranges and ranges[-1][2] == price and ranges[-1][1] >= (today - timedelta(days=2)).isoformat():
            ranges[-1][1] = day
        elif not ranges or ranges[-1][1] != day:
            ranges.append([day, day, price])
        else:  # a second run the same day: keep the lower price
            ranges[-1][2] = min(ranges[-1][2], price)


def prune(history: dict, today: date) -> None:
    cutoff = (today - timedelta(days=KEEP_DAYS)).isoformat()
    for term in list(history["series"]):
        stores = history["series"][term]
        for merchant in list(stores):
            stores[merchant] = [r for r in stores[merchant] if r[1] >= cutoff]
            if not stores[merchant]:
                del stores[merchant]
        if not stores:
            del history["series"][term]
    history["notified"] = {k: v for k, v in history["notified"].items() if v >= cutoff}


def verdict(history: dict, term: str, matches: list[dict], today: date) -> dict | None:
    """Is today's best price a good one compared to the last 8 weeks?"""
    current = [m for m in matches if m.get("price") is not None and not m.get("perWeight")]
    if not current:
        return None
    now = min(current, key=lambda m: m["price"])
    series = history["series"].get(term) or {}
    first = min((r[0] for ranges in series.values() for r in ranges), default=today.isoformat())
    tracked = (today - date.fromisoformat(first)).days
    if tracked < MIN_TRACKED_DAYS:
        return {"kind": "new", "since": first}

    window_start = (today - timedelta(days=WINDOW_DAYS)).isoformat()
    low = None
    for merchant, ranges in series.items():
        for start, end, price in ranges:
            if end >= window_start and (low is None or price < low["price"]):
                low = {"price": price, "merchant": merchant, "date": end}
    if low is None or now["price"] <= low["price"] + 0.005:
        return {"kind": "low", "days": min(tracked, WINDOW_DAYS)}
    if now["price"] >= low["price"] * 1.15:
        return {"kind": "wait", "low": low}
    return {"kind": "normal", "low": low}
