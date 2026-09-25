# Deal Stacker

Ranks this week's Checkout 51 offers by the real cost at each St. Albert store,
stacking:

1. Flyer sale price (Flipp)
2. Store digital coupons from the flyer
3. Loyalty points in the flyer (PC Optimum, Scene+, More Rewards)
4. Personal PC Optimum / Scene+ offers (added from screenshots on the phone)
5. Checkout 51 cashback

## How it runs

- `scraper/scan.py` (Python stdlib only) pulls Checkout 51 offers and searches
  local flyers for each, writing `site/data.json`.
- `.github/workflows/nightly.yml` runs the scan at midnight and publishes `site/`
  to GitHub Pages.
- The site is static. Personal offers, settings and the Claude API key live only
  in the phone's browser storage.

## Local use

```
python scraper/scan.py
python -m http.server 8000 -d site
```

Then open http://localhost:8000.

## Settings

`config.json` holds the postal code, which stores to scan, and which stores
belong to each loyalty program.
