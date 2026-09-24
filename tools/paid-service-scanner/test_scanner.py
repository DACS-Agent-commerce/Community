from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

from scanner import (  # noqa: E402
    FetchError,
    FixtureTransport,
    LiveTransport,
    build_candidates,
    classify_payment,
    run_scan,
)


OBSERVED_AT = "2026-09-24T12:00:00Z"


def observation(description: str, *, tool_name: str = "tool") -> dict:
    return {
        "protocol": "webmcp",
        "source": "test-directory",
        "sourceUrl": "https://directory.example/api/tools",
        "publisherRelationship": "third_party_directory",
        "serviceId": "example.test",
        "serviceName": "Example",
        "serviceUrl": "https://example.test/",
        "serviceDescription": "",
        "tool": {"name": tool_name, "title": None, "description": description},
        "metadata": {},
        "evidenceFields": {"tool.description": description},
    }


class ClassifierTests(unittest.TestCase):
    def test_explicit_unit_price(self) -> None:
        result = classify_payment(observation("Costs $0.01 per request."), OBSERVED_AT)
        self.assertEqual(result["status"], "reported_explicit_price")
        self.assertEqual(result["verificationStatus"], "reported_unverified")

    def test_explicit_subscription(self) -> None:
        result = classify_payment(observation("Requires an active paid subscription."), OBSERVED_AT)
        self.assertEqual(result["status"], "reported_explicit_subscription")

    def test_inferred_tier(self) -> None:
        result = classify_payment(observation("Available only on the premium tier."), OBSERVED_AT)
        self.assertEqual(result["status"], "inferred_paid_lead")
        self.assertEqual(result["confidence"], "low")

    def test_commerce_function_is_not_access_evidence(self) -> None:
        self.assertIsNone(classify_payment(observation("Pay an invoice for cart items.", tool_name="pay_invoice"), OBSERVED_AT))
        self.assertIsNone(classify_payment(observation("Pay $10 for an item in the shopper's cart."), OBSERVED_AT))

    def test_tool_name_is_not_scanned(self) -> None:
        self.assertIsNone(classify_payment(observation("Create a checkout session.", tool_name="paid_checkout"), OBSERVED_AT))

    def test_live_transport_refuses_non_allowlisted_url_before_request(self) -> None:
        with self.assertRaises(FetchError):
            LiveTransport(1).get_json("https://provider.example/pricing", "test")


class FixtureScanTests(unittest.TestCase):
    def test_offline_scan_paginates_deduplicates_and_classifies(self) -> None:
        result = run_scan(
            FixtureTransport(HERE / "fixtures"),
            mode="fixture",
            sources=("mcp-registry", "webmcp.com", "wmcp.ai"),
            max_pages=3,
            page_size=50,
            max_site_details=10,
            observed_at=OBSERVED_AT,
        )
        self.assertEqual(result["failures"], [])
        self.assertEqual(result["summary"]["paidServiceCandidates"], 3)
        by_key = {candidate["identityKey"]: candidate for candidate in result["candidates"]}
        registry = by_key["mcp|example.ai/generator|*"]
        self.assertEqual(registry["metadata"]["version"], "1.1.0")
        self.assertEqual(registry["payment"]["status"], "reported_explicit_price")
        self.assertNotIn("mcp|example.shop/checkout|*", by_key)
        self.assertNotIn("webmcp|shop.example|pay_invoice", by_key)
        self.assertFalse(result["policy"]["toolsInvoked"])
        self.assertTrue(result["summary"]["allSelectedSourcesExhausted"])
        json.dumps(result)

    def test_cross_directory_duplicate_merges_provenance(self) -> None:
        first = observation("Costs $1 per call.")
        second = observation("Requires a paid plan.")
        second["source"] = "other-directory"
        second["sourceUrl"] = "https://other.example/api"
        candidates = build_candidates((first, second), OBSERVED_AT)
        self.assertEqual(len(candidates), 1)
        self.assertEqual({item["source"] for item in candidates[0]["provenance"]}, {"test-directory", "other-directory"})

    def test_page_cap_is_reported_as_partial_coverage(self) -> None:
        result = run_scan(
            FixtureTransport(HERE / "fixtures"),
            mode="fixture",
            sources=("mcp-registry",),
            max_pages=1,
            page_size=50,
            max_site_details=0,
            observed_at=OBSERVED_AT,
        )
        source = result["sources"][0]
        self.assertEqual(source["status"], "partial")
        self.assertFalse(source["coverage"]["paginationExhausted"])
        self.assertEqual(source["coverage"]["stopReason"], "max_pages")
        self.assertFalse(result["summary"]["allSelectedSourcesExhausted"])


if __name__ == "__main__":
    unittest.main()
