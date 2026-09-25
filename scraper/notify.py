"""Phone alerts through ntfy.sh (free app; she subscribes to a private topic)."""
import json
import os
import sys
import urllib.request


def send(title: str, lines: list[str], click_url: str) -> None:
    topic = os.environ.get("NTFY_TOPIC", "").strip()
    if not topic or not lines:
        return
    message = "\n".join(lines[:12])
    if len(lines) > 12:
        message += f"\n…and {len(lines) - 12} more"
    payload = {"topic": topic, "title": title, "message": message, "click": click_url, "tags": ["shopping_cart"]}
    req = urllib.request.Request(
        "https://ntfy.sh/",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    try:
        urllib.request.urlopen(req, timeout=30).read()
        print(f"Sent alert: {title}")
    except Exception as e:  # an alert failing must not fail the scan
        print(f"  ! alert failed: {e}", file=sys.stderr)
