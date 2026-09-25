"""Run with: python -m unittest discover scraper"""
import unittest
from datetime import date, timedelta

import history as hist
import sources


def m(merchant, price, **kw):
    return {"merchant": merchant, "price": price, "perWeight": False, **kw}


class Matching(unittest.TestCase):
    def test_relevant_needs_brand_and_most_words(self):
        self.assertTrue(sources.relevant("Traditional Medicinals Tea", "TRADITIONAL MEDICINALS TEA, 16's"))
        self.assertFalse(sources.relevant("NESCAFÉ Espresso Concentrate", "Nescafe GOLD Espresso Premium Instant Coffee"))
        self.assertTrue(sources.relevant("NESCAFÉ Espresso Concentrate", "Nescafe Espresso Coffee Concentrate 500 mL"))
        self.assertFalse(sources.relevant("Tide Pods", "Gain Flings pods"))

    def test_sizes_normalise_units(self):
        self.assertEqual(sources.sizes("1.5 L and 2 kg, 40 ea"), {(1500.0, "ml"), (2000.0, "g"), (40.0, "ct")})

    def test_size_ok_only_rejects_clear_mismatch(self):
        wanted = sources.sizes("Valid on 156 g.")
        self.assertTrue(sources.size_ok(wanted, "Friskies Pate 156 g"))
        self.assertFalse(sources.size_ok(wanted, "Friskies Gravy 85 g"))
        self.assertTrue(sources.size_ok(wanted, "Friskies wet food"))  # no size stated
        self.assertTrue(sources.size_ok(set(), "anything 85 g"))


class History(unittest.TestCase):
    def test_unchanged_price_extends_one_range(self):
        h, d = hist.empty(), date(2026, 9, 1)
        for i in range(5):
            hist.record(h, "tide pods", [m("Walmart", 9.97)], d + timedelta(days=i))
        self.assertEqual(h["series"]["tide pods"]["Walmart"], [["2026-09-01", "2026-09-05", 9.97]])

    def test_new_until_two_weeks_tracked(self):
        h, d = hist.empty(), date(2026, 9, 1)
        hist.record(h, "x", [m("A", 5)], d)
        self.assertEqual(hist.verdict(h, "x", [m("A", 5)], d)["kind"], "new")

    def test_low_wait_normal(self):
        h, start = hist.empty(), date(2026, 8, 1)
        hist.record(h, "x", [m("A", 4.00)], start)
        hist.record(h, "x", [m("A", 6.00)], start + timedelta(days=10))
        today = start + timedelta(days=30)
        self.assertEqual(hist.verdict(h, "x", [m("A", 3.50)], today)["kind"], "low")
        self.assertEqual(hist.verdict(h, "x", [m("A", 5.00)], today)["kind"], "wait")
        self.assertEqual(hist.verdict(h, "x", [m("A", 4.20)], today)["kind"], "normal")

    def test_prune_drops_old_ranges(self):
        h, d = hist.empty(), date(2026, 1, 1)
        hist.record(h, "x", [m("A", 5)], d)
        hist.prune(h, d + timedelta(days=hist.KEEP_DAYS + 1))
        self.assertEqual(h["series"], {})


if __name__ == "__main__":
    unittest.main()
