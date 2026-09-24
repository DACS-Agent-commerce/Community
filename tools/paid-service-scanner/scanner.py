#!/usr/bin/env python3
"""Bounded public-only discovery of paid MCP and WebMCP service candidates.

The scanner reads three fixed public directory APIs.  It never connects to a
discovered MCP endpoint, invokes a discovered tool, follows a provider URL, or
uses credentials.  Directory text is classified as reported evidence, not as
provider-verified pricing.
"""

from __future__ import annotations

import argparse
import json
import re
import ssl
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlparse
from urllib.request import HTTPRedirectHandler, HTTPSHandler, Request, build_opener


SCHEMA_VERSION = "0.1"
USER_AGENT = "DACS-Community-paid-service-scanner/0.1"
MAX_RESPONSE_BYTES = 5 * 1024 * 1024
ALLOWED_API_HOSTS = frozenset(
    {
        "registry.modelcontextprotocol.io",
        "webmcp.com",
        "www.wmcp.ai",
    }
)
SOURCE_IDS = ("mcp-registry", "webmcp.com", "wmcp.ai")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class FetchError(RuntimeError):
    pass


class JsonTransport(Protocol):
    def get_json(self, url: str, source: str) -> Any: ...


class AllowlistedRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        parsed = urlparse(newurl)
        if parsed.scheme != "https" or parsed.hostname not in ALLOWED_API_HOSTS:
            raise FetchError(f"refused redirect outside API allowlist: {newurl}")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class LiveTransport:
    def __init__(self, timeout: float) -> None:
        self.timeout = timeout
        context = ssl.create_default_context()
        defaults = ssl.get_default_verify_paths()
        if defaults.cafile is None and defaults.capath is None:
            for fallback in (
                Path("/etc/ssl/cert.pem"),
                Path("/etc/ssl/certs/ca-certificates.crt"),
                Path("/etc/pki/tls/certs/ca-bundle.crt"),
            ):
                if fallback.is_file():
                    context.load_verify_locations(cafile=str(fallback))
                    break
        self.opener = build_opener(AllowlistedRedirectHandler(), HTTPSHandler(context=context))

    def get_json(self, url: str, source: str) -> Any:
        parsed = urlparse(url)
        if parsed.scheme != "https" or parsed.hostname not in ALLOWED_API_HOSTS:
            raise FetchError(f"refused URL outside API allowlist: {url}")
        request = Request(url, headers={"Accept": "application/json", "User-Agent": USER_AGENT})
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                final = urlparse(response.geturl())
                if final.scheme != "https" or final.hostname not in ALLOWED_API_HOSTS:
                    raise FetchError(f"refused response outside API allowlist: {response.geturl()}")
                data = response.read(MAX_RESPONSE_BYTES + 1)
        except (HTTPError, URLError, TimeoutError, OSError) as exc:
            raise FetchError(str(exc)) from exc
        if len(data) > MAX_RESPONSE_BYTES:
            raise FetchError(f"response exceeded {MAX_RESPONSE_BYTES} bytes")
        try:
            return json.loads(data)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise FetchError(f"invalid JSON: {exc}") from exc


class FixtureTransport:
    """Replay named pages from fixtures/manifest.json without network access."""

    def __init__(self, fixture_dir: Path) -> None:
        manifest_path = fixture_dir / "manifest.json"
        self.fixture_dir = fixture_dir
        self.manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.indices: dict[str, int] = {}

    def _read(self, relative: str) -> Any:
        path = (self.fixture_dir / relative).resolve()
        root = self.fixture_dir.resolve()
        if root not in path.parents:
            raise FetchError(f"fixture escapes fixture directory: {relative}")
        return json.loads(path.read_text(encoding="utf-8"))

    def get_json(self, url: str, source: str) -> Any:
        if source == "wmcp.ai-detail":
            domain = urlparse(url).path.rsplit("/", 1)[-1]
            relative = self.manifest.get("wmcpDetails", {}).get(domain)
            if not relative:
                raise FetchError(f"no wmcp detail fixture for {domain}")
            return self._read(relative)
        key = {
            "mcp-registry": "registryPages",
            "webmcp.com": "webmcpPages",
            "wmcp.ai": "wmcpSitePages",
        }.get(source)
        if key is None:
            raise FetchError(f"unknown fixture source: {source}")
        index = self.indices.get(key, 0)
        pages = self.manifest.get(key, [])
        if index >= len(pages):
            raise FetchError(f"no fixture page {index + 1} for {source}")
        self.indices[key] = index + 1
        return self._read(pages[index])


@dataclass
class SourceStats:
    id: str
    api: str
    pages_attempted: int = 0
    pages_succeeded: int = 0
    records_seen: int = 0
    details_attempted: int = 0
    details_succeeded: int = 0
    pagination_exhausted: bool = False
    stop_reason: str = "max_pages"
    site_details_available: int = 0
    site_detail_cap_reached: bool = False

    def to_json(self) -> dict[str, Any]:
        complete = (
            self.pages_attempted == self.pages_succeeded
            and self.details_attempted == self.details_succeeded
            and self.pagination_exhausted
            and not self.site_detail_cap_reached
        )
        return {
            "id": self.id,
            "api": self.api,
            "status": "ok" if complete else "partial",
            "pagesAttempted": self.pages_attempted,
            "pagesSucceeded": self.pages_succeeded,
            "recordsSeen": self.records_seen,
            "detailsAttempted": self.details_attempted,
            "detailsSucceeded": self.details_succeeded,
            "coverage": {
                "paginationExhausted": self.pagination_exhausted,
                "stopReason": self.stop_reason,
                "siteDetailsAvailable": self.site_details_available,
                "siteDetailCapReached": self.site_detail_cap_reached,
            },
        }


@dataclass
class ScanContext:
    transport: JsonTransport
    observed_at: str
    max_pages: int
    page_size: int
    max_site_details: int
    failures: list[dict[str, Any]] = field(default_factory=list)

    def failure(self, source: str, stage: str, url: str, exc: Exception) -> None:
        self.failures.append(
            {
                "source": source,
                "stage": stage,
                "url": url,
                "error": str(exc),
                "recoverable": True,
                "observedAt": self.observed_at,
            }
        )


def text_value(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def record_rank(record: Mapping[str, Any]) -> tuple[int, int, str, str]:
    metadata = record.get("_meta") if isinstance(record.get("_meta"), Mapping) else {}
    official = metadata.get("io.modelcontextprotocol.registry/official", {})
    if not isinstance(official, Mapping):
        official = {}
    return (
        int(official.get("isLatest") is True),
        int(official.get("status") == "active"),
        text_value(official.get("updatedAt") or official.get("publishedAt")),
        text_value(record.get("server", {}).get("version") if isinstance(record.get("server"), Mapping) else ""),
    )


def collect_registry(ctx: ScanContext) -> tuple[list[dict[str, Any]], SourceStats]:
    base = "https://registry.modelcontextprotocol.io/v0.1/servers"
    stats = SourceStats("mcp-registry", base)
    records: dict[str, dict[str, Any]] = {}
    cursor: str | None = None
    seen_cursors: set[str] = set()
    for _ in range(ctx.max_pages):
        query: dict[str, Any] = {"limit": ctx.page_size}
        if cursor:
            query["cursor"] = cursor
        url = f"{base}?{urlencode(query)}"
        stats.pages_attempted += 1
        try:
            payload = ctx.transport.get_json(url, "mcp-registry")
            if not isinstance(payload, Mapping) or not isinstance(payload.get("servers"), list):
                raise FetchError("response is missing servers array")
        except Exception as exc:
            ctx.failure("mcp-registry", "page", url, exc)
            stats.stop_reason = "request_failed"
            break
        stats.pages_succeeded += 1
        page_records = payload["servers"]
        stats.records_seen += len(page_records)
        for item in page_records:
            if not isinstance(item, Mapping) or not isinstance(item.get("server"), Mapping):
                continue
            name = text_value(item["server"].get("name")).casefold()
            if not name:
                continue
            candidate = dict(item)
            candidate["_scannerSourceUrl"] = url
            current = records.get(name)
            if current is None or record_rank(candidate) > record_rank(current):
                records[name] = candidate
        metadata = payload.get("metadata") if isinstance(payload.get("metadata"), Mapping) else {}
        next_cursor = text_value(metadata.get("nextCursor"))
        if not next_cursor or not page_records:
            stats.pagination_exhausted = True
            stats.stop_reason = "source_exhausted"
            break
        if next_cursor in seen_cursors:
            ctx.failure("mcp-registry", "pagination", url, FetchError("source repeated nextCursor"))
            stats.stop_reason = "repeated_cursor"
            break
        seen_cursors.add(next_cursor)
        cursor = next_cursor
    observations: list[dict[str, Any]] = []
    for item in records.values():
        server = item["server"]
        official = item.get("_meta", {}).get("io.modelcontextprotocol.registry/official", {})
        observations.append(
            {
                "protocol": "mcp",
                "source": "mcp-registry",
                "sourceUrl": item["_scannerSourceUrl"],
                "publisherRelationship": "registry_submission",
                "serviceId": text_value(server.get("name")),
                "serviceName": text_value(server.get("title")) or text_value(server.get("name")),
                "serviceUrl": None,
                "serviceDescription": text_value(server.get("description")),
                "tool": None,
                "metadata": {
                    "version": server.get("version"),
                    "registryStatus": official.get("status") if isinstance(official, Mapping) else None,
                    "isLatest": official.get("isLatest") if isinstance(official, Mapping) else None,
                    "remotes": server.get("remotes", []),
                },
                "evidenceFields": {
                    "service.description": text_value(server.get("description")),
                    "service.title": text_value(server.get("title")),
                },
            }
        )
    return observations, stats


def collect_webmcp(ctx: ScanContext) -> tuple[list[dict[str, Any]], SourceStats]:
    base = "https://webmcp.com/api/v1/tools"
    stats = SourceStats("webmcp.com", base)
    records: dict[tuple[str, str], dict[str, Any]] = {}
    offset = 0
    for _ in range(ctx.max_pages):
        url = f"{base}?{urlencode({'limit': ctx.page_size, 'offset': offset})}"
        stats.pages_attempted += 1
        try:
            payload = ctx.transport.get_json(url, "webmcp.com")
            if not isinstance(payload, Mapping) or not isinstance(payload.get("tools"), list):
                raise FetchError("response is missing tools array")
        except Exception as exc:
            ctx.failure("webmcp.com", "page", url, exc)
            stats.stop_reason = "request_failed"
            break
        stats.pages_succeeded += 1
        tools = payload["tools"]
        stats.records_seen += len(tools)
        for tool in tools:
            if not isinstance(tool, Mapping):
                continue
            host = text_value(tool.get("host")).casefold()
            name = text_value(tool.get("name")).casefold()
            if not host or not name:
                continue
            item = dict(tool)
            item["_scannerSourceUrl"] = url
            key = (host, name)
            current = records.get(key)
            if current is None or len(text_value(item.get("description"))) > len(text_value(current.get("description"))):
                records[key] = item
        total = payload.get("total")
        offset += len(tools)
        if not tools or (isinstance(total, int) and offset >= total) or (not isinstance(total, int) and len(tools) < ctx.page_size):
            stats.pagination_exhausted = True
            stats.stop_reason = "source_exhausted"
            break
    observations: list[dict[str, Any]] = []
    for tool in records.values():
        host = text_value(tool.get("host"))
        observations.append(
            {
                "protocol": "webmcp",
                "source": "webmcp.com",
                "sourceUrl": tool["_scannerSourceUrl"],
                "publisherRelationship": "third_party_directory",
                "serviceId": host,
                "serviceName": host,
                "serviceUrl": text_value(tool.get("url")) or None,
                "serviceDescription": "",
                "tool": {
                    "name": text_value(tool.get("name")),
                    "title": None,
                    "description": text_value(tool.get("description")),
                    "kind": tool.get("kind"),
                    "page": tool.get("page"),
                },
                "metadata": {"siteType": tool.get("siteType"), "implementation": tool.get("impl")},
                "evidenceFields": {"tool.description": text_value(tool.get("description"))},
            }
        )
    return observations, stats


def collect_wmcp(ctx: ScanContext) -> tuple[list[dict[str, Any]], SourceStats]:
    base = "https://www.wmcp.ai/api/v1/sites"
    stats = SourceStats("wmcp.ai", base)
    site_summaries: dict[str, dict[str, Any]] = {}
    cursor: str | None = None
    seen_cursors: set[str] = set()
    for _ in range(ctx.max_pages):
        query: dict[str, Any] = {"limit": ctx.page_size}
        if cursor:
            query["cursor"] = cursor
        url = f"{base}?{urlencode(query)}"
        stats.pages_attempted += 1
        try:
            payload = ctx.transport.get_json(url, "wmcp.ai")
            if not isinstance(payload, Mapping) or not isinstance(payload.get("sites"), list):
                raise FetchError("response is missing sites array")
        except Exception as exc:
            ctx.failure("wmcp.ai", "page", url, exc)
            stats.stop_reason = "request_failed"
            break
        stats.pages_succeeded += 1
        sites = payload["sites"]
        stats.records_seen += len(sites)
        for site in sites:
            if not isinstance(site, Mapping):
                continue
            domain = text_value(site.get("domain")).casefold()
            if domain and domain not in site_summaries:
                site_summaries[domain] = dict(site)
        next_cursor = text_value(payload.get("nextCursor"))
        if not next_cursor or not sites:
            stats.pagination_exhausted = True
            stats.stop_reason = "source_exhausted"
            break
        if next_cursor in seen_cursors:
            ctx.failure("wmcp.ai", "pagination", url, FetchError("source repeated nextCursor"))
            stats.stop_reason = "repeated_cursor"
            break
        seen_cursors.add(next_cursor)
        cursor = next_cursor

    stats.site_details_available = len(site_summaries)
    stats.site_detail_cap_reached = len(site_summaries) > ctx.max_site_details
    records: dict[tuple[str, str], dict[str, Any]] = {}
    for domain, summary in list(site_summaries.items())[: ctx.max_site_details]:
        url = f"{base}/{quote(domain, safe='.-')}"
        stats.details_attempted += 1
        try:
            detail = ctx.transport.get_json(url, "wmcp.ai-detail")
            if not isinstance(detail, Mapping) or not isinstance(detail.get("tools"), list):
                raise FetchError("response is missing tools array")
        except Exception as exc:
            ctx.failure("wmcp.ai", "site-detail", url, exc)
            continue
        stats.details_succeeded += 1
        for tool in detail["tools"]:
            if not isinstance(tool, Mapping):
                continue
            name = text_value(tool.get("name")).casefold()
            if not name:
                continue
            item = dict(tool)
            item["_scannerDetail"] = dict(detail)
            item["_scannerSummary"] = summary
            item["_scannerSourceUrl"] = url
            key = (domain, name)
            current = records.get(key)
            if current is None or len(text_value(item.get("description"))) > len(text_value(current.get("description"))):
                records[key] = item

    observations: list[dict[str, Any]] = []
    for tool in records.values():
        detail = tool["_scannerDetail"]
        summary = tool["_scannerSummary"]
        domain = text_value(detail.get("domain")) or text_value(summary.get("domain"))
        observations.append(
            {
                "protocol": "webmcp",
                "source": "wmcp.ai",
                "sourceUrl": tool["_scannerSourceUrl"],
                "publisherRelationship": "third_party_directory",
                "serviceId": domain,
                "serviceName": text_value(detail.get("name")) or domain,
                "serviceUrl": text_value(detail.get("homepageUrl")) or None,
                "serviceDescription": text_value(detail.get("description")),
                "tool": {
                    "name": text_value(tool.get("name")),
                    "title": text_value(tool.get("title")) or None,
                    "description": text_value(tool.get("description")),
                    "kind": tool.get("surface"),
                    "page": tool.get("pageUrl"),
                },
                "metadata": {"siteStatus": detail.get("status"), "tags": detail.get("tags", [])},
                "evidenceFields": {
                    "service.description": text_value(detail.get("description")),
                    "tool.description": text_value(tool.get("description")),
                    "tool.title": text_value(tool.get("title")),
                },
            }
        )
    return observations, stats


PRICE_PATTERNS = (
    re.compile(r"(?i)(?:[$€£]\s*\d+(?:\.\d{1,2})?|\b(?:USD|EUR|GBP)\s+\d+(?:\.\d{1,2})?)\s*(?:/|per\s+)(?:call|run|request|query|execution|use|month|year|seat|user)\b"),
    re.compile(r"(?i)\b(?:access|usage|invocation|each\s+(?:call|run|request))\s+(?:costs?|is\s+priced\s+at)\s+(?:[$€£]\s*\d+(?:\.\d{1,2})?|(?:USD|EUR|GBP)\s+\d+(?:\.\d{1,2})?)\b"),
    re.compile(r"(?i)\b(?:costs?|priced\s+at)\s+(?:[$€£]\s*\d+(?:\.\d{1,2})?|(?:USD|EUR|GBP)\s+\d+(?:\.\d{1,2})?)\s+to\s+(?:use|access|invoke|run)\b"),
)
PAID_MODEL_PATTERNS = (
    re.compile(r"(?i)\bpay[- ]per[- ](?:call|run|request|query|execution|use)\b"),
    re.compile(r"(?i)\bpricing\s+(?:starts?|begins?)\s+(?:at|from)\b"),
)
SUBSCRIPTION_PATTERNS = (
    re.compile(r"(?i)\b(?:requires?|needs?)\s+(?:an?\s+)?(?:active\s+)?(?:paid(?:\s+(?:premium|pro))?|premium|pro)\s+(?:plan|subscription|account|membership)\b"),
    re.compile(r"(?i)\b(?:paid(?:\s+(?:premium|pro))?|premium|pro)\s+(?:plan|subscription|membership)\s+(?:is\s+)?required\b"),
    re.compile(r"(?i)\bsubscription[- ]only\b"),
)
INFERRED_PATTERNS = (
    re.compile(r"(?i)\b(?:available|included|unlocked)\s+(?:only\s+)?(?:on|with|in)\s+(?:the\s+)?(?:paid|premium|pro)\s+(?:tier|plan)\b"),
    re.compile(r"(?i)\b(?:upgrade|subscribe)\s+to\s+(?:gain|unlock|get)\s+access\b"),
    re.compile(r"(?i)\bfreemium\b"),
)


def snippet(text: str, match: re.Match[str], limit: int = 240) -> str:
    start = max(0, match.start() - 80)
    end = min(len(text), match.end() + 80)
    value = " ".join(text[start:end].split())
    if start:
        value = "…" + value
    if end < len(text):
        value += "…"
    return value[:limit]


def classify_payment(observation: Mapping[str, Any], observed_at: str) -> dict[str, Any] | None:
    fields = observation.get("evidenceFields", {})
    if not isinstance(fields, Mapping):
        return None
    matches: list[dict[str, Any]] = []
    strongest = 0
    for field_name, value in fields.items():
        if not isinstance(value, str) or not value:
            continue
        for strength, evidence_kind, patterns in (
            (4, "explicit_price", PRICE_PATTERNS),
            (3, "reported_paid_model", PAID_MODEL_PATTERNS),
            (2, "explicit_subscription", SUBSCRIPTION_PATTERNS),
            (1, "inferred_paid_lead", INFERRED_PATTERNS),
        ):
            for pattern in patterns:
                match = pattern.search(value)
                if match:
                    strongest = max(strongest, strength)
                    matches.append(
                        {
                            "kind": evidence_kind,
                            "field": str(field_name),
                            "snippet": snippet(value, match),
                            "sourceUrl": observation["sourceUrl"],
                            "publisherRelationship": observation["publisherRelationship"],
                            "observedAt": observed_at,
                        }
                    )
                    break
    if strongest == 0:
        return None
    if strongest == 4:
        status, confidence = "reported_explicit_price", "medium"
    elif strongest == 3:
        status, confidence = "reported_paid_model", "medium"
    elif strongest == 2:
        status, confidence = "reported_explicit_subscription", "medium"
    else:
        status, confidence = "inferred_paid_lead", "low"
    return {
        "status": status,
        "confidence": confidence,
        "verificationStatus": "reported_unverified" if strongest >= 2 else "inferred_only",
        "evidence": matches,
    }


def identity_key(observation: Mapping[str, Any]) -> str:
    tool = observation.get("tool")
    tool_name = text_value(tool.get("name")) if isinstance(tool, Mapping) else "*"
    return "|".join(
        (
            text_value(observation.get("protocol")).casefold(),
            text_value(observation.get("serviceId")).casefold(),
            tool_name.casefold(),
        )
    )


def build_candidates(observations: Iterable[dict[str, Any]], observed_at: str) -> list[dict[str, Any]]:
    candidates: dict[str, dict[str, Any]] = {}
    for observation in observations:
        payment = classify_payment(observation, observed_at)
        if payment is None:
            continue
        key = identity_key(observation)
        candidate = {
            "identityKey": key,
            "protocol": observation["protocol"],
            "inventoryLevel": "tool" if observation["tool"] is not None else "server",
            "service": {
                "id": observation["serviceId"],
                "name": observation["serviceName"],
                "url": observation["serviceUrl"],
                "description": observation["serviceDescription"],
            },
            "tool": observation["tool"],
            "metadata": observation["metadata"],
            "payment": payment,
            "provenance": [
                {
                    "source": observation["source"],
                    "sourceUrl": observation["sourceUrl"],
                    "observedAt": observed_at,
                }
            ],
        }
        current = candidates.get(key)
        if current is None:
            candidates[key] = candidate
            continue
        existing_sources = {item["source"] for item in current["provenance"]}
        if observation["source"] not in existing_sources:
            current["provenance"].extend(candidate["provenance"])
        status_rank = {
            "inferred_paid_lead": 1,
            "reported_explicit_subscription": 2,
            "reported_paid_model": 3,
            "reported_explicit_price": 4,
        }
        if status_rank[payment["status"]] > status_rank[current["payment"]["status"]]:
            retained_evidence = current["payment"]["evidence"]
            current["payment"] = {**payment, "evidence": retained_evidence}
        seen_evidence = {(item["kind"], item["field"], item["snippet"]) for item in current["payment"]["evidence"]}
        for item in payment["evidence"]:
            marker = (item["kind"], item["field"], item["snippet"])
            if marker not in seen_evidence:
                current["payment"]["evidence"].append(item)
    return [candidates[key] for key in sorted(candidates)]


def run_scan(
    transport: JsonTransport,
    *,
    mode: str,
    sources: Iterable[str],
    max_pages: int,
    page_size: int,
    max_site_details: int,
    observed_at: str | None = None,
) -> dict[str, Any]:
    timestamp = observed_at or utc_now()
    ctx = ScanContext(transport, timestamp, max_pages, page_size, max_site_details)
    observations: list[dict[str, Any]] = []
    source_stats: list[SourceStats] = []
    collectors = {
        "mcp-registry": collect_registry,
        "webmcp.com": collect_webmcp,
        "wmcp.ai": collect_wmcp,
    }
    for source in sources:
        collected, stats = collectors[source](ctx)
        observations.extend(collected)
        source_stats.append(stats)
    candidates = build_candidates(observations, timestamp)
    serialized_stats = [stats.to_json() for stats in source_stats]
    return {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": timestamp,
        "mode": mode,
        "policy": {
            "publicOnly": True,
            "apiHosts": sorted(ALLOWED_API_HOSTS),
            "discoveredEndpointsContacted": False,
            "toolsInvoked": False,
            "authenticationUsed": False,
            "providerPagesFetched": False,
            "directoryClaimsAreProviderVerified": False,
            "mcpRegistryCoverage": "server_metadata_only",
        },
        "bounds": {
            "maxPagesPerSource": max_pages,
            "pageSize": page_size,
            "maxWmcpSiteDetails": max_site_details,
            "maxResponseBytes": MAX_RESPONSE_BYTES,
        },
        "sources": serialized_stats,
        "summary": {
            "observationsScanned": len(observations),
            "paidServiceCandidates": len(candidates),
            "failures": len(ctx.failures),
            "allSelectedSourcesExhausted": all(item["status"] == "ok" for item in serialized_stats),
        },
        "candidates": candidates,
        "failures": ctx.failures,
    }


def bounded_int(name: str, minimum: int, maximum: int):
    def parse(value: str) -> int:
        parsed = int(value)
        if not minimum <= parsed <= maximum:
            raise argparse.ArgumentTypeError(f"{name} must be between {minimum} and {maximum}")
        return parsed

    return parse


def parse_sources(value: str) -> list[str]:
    values = SOURCE_IDS if value == "all" else tuple(part.strip() for part in value.split(",") if part.strip())
    if not values:
        raise argparse.ArgumentTypeError("at least one source is required")
    unknown = sorted(set(values) - set(SOURCE_IDS))
    if unknown:
        raise argparse.ArgumentTypeError(f"unknown source(s): {', '.join(unknown)}")
    return list(values)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("fixture", "live"), default="fixture")
    parser.add_argument("--sources", type=parse_sources, default=list(SOURCE_IDS), help="all or comma-separated source IDs")
    parser.add_argument("--max-pages", type=bounded_int("max-pages", 1, 100), default=3)
    parser.add_argument("--page-size", type=bounded_int("page-size", 1, 100), default=50)
    parser.add_argument("--max-site-details", type=bounded_int("max-site-details", 0, 500), default=100)
    parser.add_argument("--timeout", type=float, default=8.0, help="live HTTP timeout in seconds (0.1-30)")
    parser.add_argument("--fixture-dir", type=Path, default=Path(__file__).parent / "fixtures")
    parser.add_argument("--output", default="-", help="JSON output path, or - for stdout")
    parser.add_argument("--pretty", action="store_true", help="pretty-print JSON")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not 0.1 <= args.timeout <= 30:
        parser.error("timeout must be between 0.1 and 30 seconds")
    transport: JsonTransport
    if args.mode == "live":
        transport = LiveTransport(args.timeout)
    else:
        transport = FixtureTransport(args.fixture_dir)
    result = run_scan(
        transport,
        mode=args.mode,
        sources=args.sources,
        max_pages=args.max_pages,
        page_size=args.page_size,
        max_site_details=args.max_site_details,
    )
    rendered = json.dumps(result, indent=2 if args.pretty else None, sort_keys=True) + "\n"
    if args.output == "-":
        sys.stdout.write(rendered)
    else:
        Path(args.output).write_text(rendered, encoding="utf-8")
    return 0 if not result["failures"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
