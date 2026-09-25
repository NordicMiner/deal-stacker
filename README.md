# Deal Stacker

Ranks this week's Checkout 51 offers, and a personal watchlist, by the real
cost at each St. Albert store, stacking:

1. Flyer sale prices (Flipp) and regular shelf prices (Superstore, Your
   Independent Grocer, Save-On-Foods)
2. Store digital coupons from the flyer
3. Loyalty points (PC Optimum, Scene+, More Rewards)
4. Personal loyalty offers (added from screenshots on the phone)
5. No Frills price matching against competitor flyers
6. Checkout 51 cashback

It also keeps price history ("lowest in 8 weeks" / "was cheaper, wait"),
plans the cheapest one- or two-store trip for a shopping list, and sends
phone alerts through ntfy when watched items go on sale.

## How it runs

- `scraper/scan.py` (Python stdlib only) pulls Checkout 51 offers and the
  watchlist, searches flyers and store prices for each, updates price history
  and sends alerts. Output: `site/data.json` and `site/history.json`.
- `.github/workflows/nightly.yml` runs at 12:05 am and 7:05 am Mountain time
  (and on every push), restores history from the published site, and publishes
  `site/` to GitHub Pages.
- `watchlist.json` is the watchlist the scan uses. The phone app updates it
  through the GitHub API when a GitHub token is set in Settings.
- Personal offers, the shopping list, settings and API keys live only in the
  phone's browser storage.

## Setup

- Alerts: add a repository secret `NTFY_TOPIC` (a long random name) and
  subscribe to the same topic in the ntfy app.
- Watchlist sync: create a fine-grained GitHub token with **Contents: read and
  write** on this repository only, and paste it into the app's Settings.

## Local use

```
python -m unittest discover scraper
python scraper/scan.py
python -m http.server 8000 -d site
```

## Settings

`config.json` holds the postal code, which stores to scan, loyalty programs,
the stores whose shelf prices are checked, and price-match rules.
