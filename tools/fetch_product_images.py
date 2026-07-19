#!/usr/bin/env python3
"""Find exact product images from open product databases and public image search.

The matcher is intentionally conservative. It checks the product name, brand and package
size/weight before adding an image. Uncertain products keep the category icon.
"""
from __future__ import annotations

import argparse
import csv
import html
import json
import re
import sys
import time
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlparse

import requests
from PIL import Image, ImageOps, UnidentifiedImageError
from rapidfuzz import fuzz
from unidecode import unidecode

ROOT = Path(__file__).resolve().parents[1]
PRODUCTS_PATH = ROOT / "public" / "data" / "products.json"
IMAGES_DIR = ROOT / "public" / "images" / "products"
STATE_PATH = ROOT / "public" / "data" / "image-fetch-state.json"
ATTRIBUTION_PATH = ROOT / "public" / "data" / "image-attribution.json"
REPORT_PATH = ROOT / "reports" / "product-image-report.csv"

OFF_SEARCH = "https://world.openfoodfacts.org/cgi/search.pl"
OPF_SEARCH = "https://world.openproductsfacts.org/cgi/search.pl"
DDG_HOME = "https://duckduckgo.com/"
DDG_IMAGES = "https://duckduckgo.com/i.js"
BING_IMAGES = "https://www.bing.com/images/search"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

STOP_TOKENS = {
    "ак", "б", "без", "в", "ва", "від", "для", "до", "з", "за", "із", "і", "й", "на",
    "та", "у", "уп", "упак", "упаковка", "пак", "пач", "кор", "ящ", "шт", "сп", "жб",
    "сб", "мб", "пет", "пл", "куп", "pro", "ап", "лф", "тп", "от", "pj", "id", "мл",
    "л", "г", "кг", "gr", "kg", "ml", "liter", "litre", "pcs", "pc", "раф", "рафін",
    "дез", "рвд", "нраф", "нераф", "консервований", "консервована",
}
GENERIC_FIRST_TOKENS = {
    "олія", "оливки", "маслини", "соус", "кетчуп", "майонез", "гірчиця", "сироп", "пюре",
    "топінг", "чай", "кава", "цукор", "сіль", "перець", "приправа", "макарони", "печиво",
    "цукерки", "шоколад", "стакан", "кришка", "пакет", "серветки", "рукавички", "рушник",
}
CODE_PREFIXES = {
    "бпг", "бпк", "аква", "акваб", "аквас", "тп", "от", "л", "бі", "мт", "грчц",
    "кетч", "гірч", "гірчиц", "май", "пр", "шок", "деко",
}
DENIED_DOMAINS = {
    "pinterest.com", "pinimg.com", "facebook.com", "instagram.com", "tiktok.com", "youtube.com",
    "youtu.be", "aliexpress.com", "temu.com", "ebay.com", "amazon.com", "amazonaws.com",
    "shutterstock.com", "istockphoto.com", "gettyimages.com", "depositphotos.com",
}

MEASURE_RE = re.compile(
    r"(?P<num>\d+(?:\s*[.,]\s*\d+)?)\s*(?P<unit>кг|kg|г|gr|g|мл|ml|л|l)\b",
    flags=re.IGNORECASE,
)
PARENS_RE = re.compile(r"\([^)]*(?:шт|пак|уп|сп)[^)]*\)", flags=re.IGNORECASE)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--section", choices=["all", "Food", "NONFood"], default="all")
    parser.add_argument("--limit", type=int, default=1000)
    parser.add_argument("--min-score", type=float, default=0.86)
    parser.add_argument("--sleep", type=float, default=0.55)
    parser.add_argument("--providers", default="openfacts,duckduckgo,bing")
    parser.add_argument("--retry-unmatched", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--hotlink",
        action="store_true",
        help=(
            "Do not download or re-encode images. Store the matched image's direct URL in "
            "products.json so the browser loads it straight from the source (no files are "
            "committed to the repo)."
        ),
    )
    return parser.parse_args()


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return default


def save_json(path: Path, data: Any, *, compact: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, ensure_ascii=False, separators=(",", ":") if compact else None,
                      indent=None if compact else 2)
    path.write_text(text + "\n", encoding="utf-8")


def normalize(text: Any) -> str:
    value = unidecode(str(text or "")).lower()
    value = value.replace("'", "").replace("`", "")
    value = re.sub(r"(?<=\d)\s*[,.]\s*(?=\d)", ".", value)
    value = re.sub(r"[^a-z0-9.]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def clean_query_name(name: str) -> str:
    value = PARENS_RE.sub(" ", name)
    value = re.sub(r"\b\d+\s*(?:шт|pcs?)\b", " ", value, flags=re.IGNORECASE)
    return re.sub(r"\s+", " ", value).strip()


def tokenize(text: Any) -> list[str]:
    return [
        token for token in normalize(text).split()
        if token not in STOP_TOKENS and len(token) >= 3 and not token.replace(".", "").isdigit()
    ]


def first_brand_hint(name: str) -> str:
    raw = re.findall(r"[A-Za-zА-Яа-яІіЇїЄєҐґ0-9&'-]+", name)
    if not raw:
        return ""
    first = normalize(raw[0].strip("-'&"))
    if (not first or first in GENERIC_FIRST_TOKENS or first in CODE_PREFIXES
            or first in STOP_TOKENS or len(first) <= 2):
        return ""
    return first


def measurements(text: Any) -> list[tuple[str, int]]:
    result: list[tuple[str, int]] = []
    for match in MEASURE_RE.finditer(str(text or "")):
        number = float(re.sub(r"\s", "", match.group("num")).replace(",", "."))
        unit = match.group("unit").lower()
        if unit in {"л", "l"}:
            result.append(("volume_ml", round(number * 1000)))
        elif unit in {"мл", "ml"}:
            result.append(("volume_ml", round(number)))
        elif unit in {"кг", "kg"}:
            result.append(("weight_g", round(number * 1000)))
        else:
            result.append(("weight_g", round(number)))
    return result


def measurement_compatible(source_text: str, candidate_text: str) -> tuple[bool, float]:
    source = measurements(source_text)
    if not source:
        return True, 1.0
    candidate = measurements(candidate_text)
    if not candidate:
        return False, 0.0
    hits = 0
    for source_unit, source_value in source:
        matched = any(
            candidate_unit == source_unit
            and abs(candidate_value - source_value) <= max(1, round(source_value * 0.02))
            for candidate_unit, candidate_value in candidate
        )
        hits += int(matched)
    ratio = hits / len(source)
    return ratio == 1.0, ratio


def token_coverage(source_tokens: list[str], candidate_tokens: list[str]) -> float:
    if not source_tokens:
        return 0.0
    hits = 0
    for token in source_tokens:
        best = max((fuzz.ratio(token, other) for other in candidate_tokens), default=0)
        prefix = any(
            (token.startswith(other) or other.startswith(token)) and min(len(token), len(other)) >= 4
            for other in candidate_tokens
        )
        if best >= 82 or prefix:
            hits += 1
    return hits / len(source_tokens)


def brand_compatible(brand_hint: str, candidate_text: str) -> tuple[bool, float]:
    if not brand_hint:
        return True, 1.0
    target = normalize(candidate_text)
    if brand_hint in target.split() or brand_hint in target:
        return True, 1.0
    best = max((fuzz.ratio(brand_hint, token) for token in target.split()), default=0)
    return best >= 86, best / 100


def domain_of(url: str) -> str:
    try:
        return urlparse(url).netloc.lower().removeprefix("www.")
    except Exception:
        return ""


def domain_denied(url: str) -> bool:
    domain = domain_of(url)
    return any(domain == bad or domain.endswith("." + bad) for bad in DENIED_DOMAINS)


def candidate_text(candidate: dict[str, Any]) -> str:
    fields = [
        candidate.get("product_name_uk"), candidate.get("product_name_ru"),
        candidate.get("product_name"), candidate.get("generic_name"), candidate.get("brands"),
        candidate.get("quantity"), candidate.get("title"), candidate.get("description"),
        candidate.get("source_page"), candidate.get("image_url"),
    ]
    return " ".join(str(item) for item in fields if item)


def score_candidate(product: dict[str, Any], candidate: dict[str, Any]) -> tuple[float, str]:
    source_name = str(product.get("name") or product.get("sourceName") or "")
    target_text = candidate_text(candidate)
    image_url = str(candidate.get("image_front_url") or candidate.get("image_url") or "")
    source_page = str(candidate.get("source_page") or "")
    provider = str(candidate.get("provider") or "")

    if not target_text or not image_url:
        return 0.0, "candidate has no useful text or image"
    if domain_denied(source_page) or domain_denied(image_url):
        return 0.0, "source domain is not suitable"

    source_norm = normalize(clean_query_name(source_name))
    target_norm = normalize(target_text)
    source_tokens = tokenize(source_norm)
    target_tokens = tokenize(target_norm)

    text_ratio = fuzz.token_set_ratio(source_norm, target_norm) / 100
    coverage = token_coverage(source_tokens, target_tokens)
    brand_hint = first_brand_hint(source_name)
    brand_ok, brand_score = brand_compatible(brand_hint, target_text)
    measure_ok, measure_score = measurement_compatible(source_name, target_text)

    if not measure_ok:
        return 0.0, "package size/weight does not match or is missing"
    if not brand_ok:
        return 0.0, f"brand does not match ({brand_hint})"

    provider_bonus = 0.05 if provider == "openfacts" else 0.0
    domain_bonus = 0.0
    source_domain = domain_of(source_page)
    if brand_hint and brand_hint in normalize(source_domain):
        domain_bonus = 0.04

    score = (
        text_ratio * 0.49 + coverage * 0.29 + brand_score * 0.12
        + measure_score * 0.10 + provider_bonus + domain_bonus
    )

    if not brand_hint and (text_ratio < 0.90 or coverage < 0.75):
        return 0.0, "generic product match is not specific enough"
    if provider != "openfacts" and (text_ratio < 0.79 or coverage < 0.64):
        return 0.0, "web result name similarity is too low"
    if text_ratio < 0.72 or coverage < 0.58:
        return 0.0, "name similarity is too low"

    return min(1.0, score), "strong name, brand and package match"


def build_queries(product: dict[str, Any]) -> list[str]:
    name = clean_query_name(str(product.get("name") or ""))
    source = clean_query_name(str(product.get("sourceName") or ""))
    brand = first_brand_hint(name)
    measure_text = " ".join(match.group(0).replace(" ", "") for match in MEASURE_RE.finditer(name))
    core = tokenize(name)
    concise = " ".join(([brand] if brand else []) + core[:7] + ([measure_text] if measure_text else []))
    queries: list[str] = []
    for query in [name, source, concise]:
        query = re.sub(r"\s+", " ", query).strip()
        if query and normalize(query) not in {normalize(item) for item in queries}:
            queries.append(query)
    return queries[:3]


def search_openfacts(session: requests.Session, product: dict[str, Any], delay: float) -> list[dict[str, Any]]:
    endpoint = OFF_SEARCH if product.get("section") == "Food" else OPF_SEARCH
    fields = (
        "code,product_name,product_name_uk,product_name_ru,generic_name,brands,quantity,"
        "image_front_url,image_url,countries_tags"
    )
    results: list[dict[str, Any]] = []
    seen: set[str] = set()
    for query in build_queries(product):
        try:
            response = session.get(endpoint, params={
                "search_terms": query, "search_simple": 1, "action": "process", "json": 1,
                "page_size": 15, "fields": fields,
            }, timeout=35)
            response.raise_for_status()
            for item in response.json().get("products", []):
                key = str(item.get("code") or item.get("image_front_url") or item.get("image_url") or "")
                if not key or key in seen:
                    continue
                seen.add(key)
                item = dict(item)
                code = str(item.get("code") or "")
                base = "https://world.openfoodfacts.org/product" if product.get("section") == "Food" else "https://world.openproductsfacts.org/product"
                item.update({"provider": "openfacts", "source_page": f"{base}/{code}" if code else ""})
                results.append(item)
        except (requests.RequestException, ValueError):
            pass
        time.sleep(max(0.0, delay))
        if len(results) >= 15:
            break
    return results


def ddg_vqd(session: requests.Session, query: str) -> str:
    response = session.get(DDG_HOME, params={"q": query}, timeout=30)
    response.raise_for_status()
    text = response.text
    patterns = [r"vqd=['\"]([^'\"]+)", r"'vqd'\s*:\s*'([^']+)'", r'"vqd"\s*:\s*"([^"]+)"']
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            return match.group(1)
    return ""


def search_duckduckgo(session: requests.Session, product: dict[str, Any], delay: float) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    seen: set[str] = set()
    for query in build_queries(product):
        try:
            vqd = ddg_vqd(session, query)
            if not vqd:
                continue
            response = session.get(DDG_IMAGES, params={
                "l": "uk-ua", "o": "json", "q": query, "vqd": vqd, "f": ",,,,,", "p": "1",
            }, headers={"Referer": DDG_HOME}, timeout=35)
            response.raise_for_status()
            for item in response.json().get("results", [])[:25]:
                image_url = str(item.get("image") or "")
                source_page = str(item.get("url") or "")
                key = image_url or source_page
                if not key or key in seen:
                    continue
                seen.add(key)
                results.append({
                    "provider": "duckduckgo", "title": item.get("title") or "",
                    "description": item.get("source") or "", "image_url": image_url,
                    "source_page": source_page,
                })
        except (requests.RequestException, ValueError):
            pass
        time.sleep(max(0.0, delay))
        if len(results) >= 30:
            break
    return results


def search_bing(session: requests.Session, product: dict[str, Any], delay: float) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    seen: set[str] = set()
    for query in build_queries(product):
        try:
            response = session.get(BING_IMAGES, params={"q": query, "form": "HDRSC2", "first": 1}, timeout=35)
            response.raise_for_status()
            for raw in re.findall(r'<a[^>]+class="[^"]*iusc[^"]*"[^>]+m="([^"]+)"', response.text):
                try:
                    data = json.loads(html.unescape(raw))
                except (json.JSONDecodeError, TypeError):
                    continue
                image_url = str(data.get("murl") or "")
                source_page = str(data.get("purl") or "")
                key = image_url or source_page
                if not key or key in seen:
                    continue
                seen.add(key)
                results.append({
                    "provider": "bing", "title": data.get("t") or data.get("desc") or "",
                    "description": data.get("desc") or "", "image_url": image_url,
                    "source_page": source_page,
                })
                if len(results) >= 30:
                    break
        except requests.RequestException:
            pass
        time.sleep(max(0.0, delay))
        if len(results) >= 30:
            break
    return results


def choose_best(product: dict[str, Any], candidates: Iterable[dict[str, Any]], min_score: float) -> tuple[dict[str, Any] | None, float, str]:
    ranked: list[tuple[float, dict[str, Any], str]] = []
    for candidate in candidates:
        score, reason = score_candidate(product, candidate)
        ranked.append((score, candidate, reason))
    ranked.sort(key=lambda item: item[0], reverse=True)
    if not ranked:
        return None, 0.0, "no candidates"
    score, candidate, reason = ranked[0]
    threshold = min_score if candidate.get("provider") == "openfacts" else max(min_score, 0.88)
    if score < threshold:
        return None, score, reason
    if len(ranked) > 1:
        second_score, second, _ = ranked[1]
        second_threshold = min_score if second.get("provider") == "openfacts" else max(min_score, 0.88)
        if second_score >= second_threshold and score - second_score < 0.025:
            if str(candidate.get("image_url")) != str(second.get("image_url")):
                return None, score, "ambiguous: two similarly strong images"
    return candidate, score, reason


def download_image(session: requests.Session, image_url: str, destination: Path) -> tuple[bool, str]:
    try:
        response = session.get(image_url, timeout=45, headers={"Accept": "image/avif,image/webp,image/*,*/*;q=0.8"})
        response.raise_for_status()
        if len(response.content) > 15_000_000:
            return False, "image exceeds 15 MB"
        with Image.open(BytesIO(response.content)) as opened:
            image = ImageOps.exif_transpose(opened)
            if image.width < 180 or image.height < 180:
                return False, "image is too small"
            image = image.convert("RGBA")
            background = Image.new("RGBA", image.size, (255, 255, 255, 255))
            background.alpha_composite(image)
            image = background.convert("RGB")
            image.thumbnail((680, 680), Image.Resampling.LANCZOS)
            canvas = Image.new("RGB", (720, 720), "white")
            canvas.paste(image, ((720 - image.width) // 2, (720 - image.height) // 2))
            destination.parent.mkdir(parents=True, exist_ok=True)
            canvas.save(destination, "WEBP", quality=86, method=6, optimize=True)
        return True, ""
    except (requests.RequestException, UnidentifiedImageError, OSError) as exc:
        return False, str(exc)


def verify_hotlink(session: requests.Session, image_url: str) -> tuple[bool, str]:
    """Confirm the URL actually serves an image, without saving its bytes anywhere.

    We still fetch it once (streamed, capped) so a dead link or an HTML error page never
    lands in products.json, but nothing is written to disk — the browser will re-fetch the
    same URL directly from its source every time a client opens the site.
    """
    try:
        response = session.get(
            image_url,
            timeout=25,
            stream=True,
            headers={"Accept": "image/avif,image/webp,image/*,*/*;q=0.8"},
        )
        response.raise_for_status()
        content_type = response.headers.get("Content-Type", "")
        if not content_type.startswith("image/"):
            return False, f"unexpected content-type: {content_type or 'unknown'}"
        chunk = next(response.iter_content(chunk_size=64_000), b"")
        if len(chunk) < 500:
            return False, "response too small to be a real photo"
        return True, ""
    except (requests.RequestException, StopIteration) as exc:
        return False, str(exc)
    finally:
        try:
            response.close()
        except Exception:
            pass


def write_report(state: dict[str, Any], products: dict[str, dict[str, Any]]) -> None:
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    fields = ["product_id", "section", "product_name", "status", "provider", "score", "matched_name",
              "source_page", "image_url", "reason", "checked_at"]
    with REPORT_PATH.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for product_id in sorted(state):
            entry = state[product_id]
            product = products.get(product_id, {})
            writer.writerow({
                "product_id": product_id, "section": product.get("section", ""),
                "product_name": product.get("name", ""), "status": entry.get("status", ""),
                "provider": entry.get("provider", ""), "score": entry.get("score", ""),
                "matched_name": entry.get("matchedName", ""), "source_page": entry.get("sourcePage", ""),
                "image_url": entry.get("imageUrl", ""), "reason": entry.get("reason", ""),
                "checked_at": entry.get("checkedAt", ""),
            })


def main() -> int:
    args = parse_args()
    if not PRODUCTS_PATH.exists():
        print(f"Catalog not found: {PRODUCTS_PATH}", file=sys.stderr)
        return 2

    providers = {item.strip().lower() for item in args.providers.split(",") if item.strip()}
    products: list[dict[str, Any]] = load_json(PRODUCTS_PATH, [])
    state: dict[str, Any] = load_json(STATE_PATH, {})
    attributions: dict[str, Any] = load_json(ATTRIBUTION_PATH, {})
    products_by_id = {str(item.get("id")): item for item in products}

    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT, "Accept-Language": "uk-UA,uk;q=0.9,en;q=0.7"})

    eligible: list[dict[str, Any]] = []
    for product in products:
        product_id = str(product.get("id") or "")
        if not product_id:
            continue
        if args.section != "all" and product.get("section") != args.section:
            continue
        existing = state.get(product_id, {})
        if args.hotlink:
            if not args.force and product.get("image"):
                continue
        else:
            image_path = IMAGES_DIR / f"{product_id}.webp"
            if not args.force and product.get("image") and image_path.exists():
                continue
            if not args.force and existing.get("status") == "matched" and image_path.exists():
                product["image"] = f"/images/products/{product_id}.webp"
                continue
        if not args.retry_unmatched and existing.get("status") == "no_match":
            continue
        eligible.append(product)

    selected = eligible[:max(0, args.limit)]
    print(f"Products in catalog: {len(products)}")
    print(f"Checking this run: {len(selected)}")
    matched = no_match = errors = 0

    def now_iso() -> str:
        return datetime.now(timezone.utc).replace(microsecond=0).isoformat()

    for index, product in enumerate(selected, 1):
        product_id = str(product["id"])
        print(f"[{index}/{len(selected)}] {product_id}: {product.get('name')}")
        candidate = None
        score = 0.0
        reason = "no exact match"

        provider_functions = []
        if "openfacts" in providers:
            provider_functions.append(("openfacts", search_openfacts))
        if "duckduckgo" in providers:
            provider_functions.append(("duckduckgo", search_duckduckgo))
        if "bing" in providers:
            provider_functions.append(("bing", search_bing))

        for provider_name, search_fn in provider_functions:
            candidates = search_fn(session, product, args.sleep)
            candidate, score, reason = choose_best(product, candidates, args.min_score)
            if candidate is not None:
                print(f"  matched via {provider_name}: {score:.3f}")
                break
            print(f"  {provider_name}: no accepted match ({score:.3f}; {reason})")

        if candidate is None:
            state[product_id] = {
                "status": "no_match", "score": round(score, 4), "reason": reason,
                "checkedAt": now_iso(),
            }
            no_match += 1
            continue

        image_url = str(candidate.get("image_front_url") or candidate.get("image_url") or "")
        source_page = str(candidate.get("source_page") or "")

        if args.hotlink:
            ok, error = (True, "") if args.dry_run else verify_hotlink(session, image_url)
            fail_reason = f"hotlink check failed: {error}"
        else:
            destination = IMAGES_DIR / f"{product_id}.webp"
            ok, error = (True, "") if args.dry_run else download_image(session, image_url, destination)
            fail_reason = f"download failed: {error}"

        if not ok:
            state[product_id] = {
                "status": "error", "provider": candidate.get("provider", ""),
                "score": round(score, 4), "matchedName": candidate_text(candidate),
                "sourcePage": source_page, "imageUrl": image_url,
                "reason": fail_reason, "checkedAt": now_iso(),
            }
            errors += 1
            continue

        provider = str(candidate.get("provider") or "")
        product["image"] = image_url if args.hotlink else f"/images/products/{product_id}.webp"
        state[product_id] = {
            "status": "matched", "provider": provider, "score": round(score, 4),
            "matchedName": candidate_text(candidate), "sourcePage": source_page,
            "imageUrl": image_url, "reason": reason, "checkedAt": now_iso(),
        }
        license_note = "CC BY-SA 3.0" if provider == "openfacts" else "Перевірте умови джерела перед комерційним використанням"
        attributions[product_id] = {
            "productName": product.get("name", ""), "source": provider,
            "sourcePage": source_page, "originalImage": image_url,
            "license": license_note, "retrievedAt": now_iso(),
        }
        matched += 1

    if not args.dry_run:
        save_json(PRODUCTS_PATH, products, compact=True)
        save_json(STATE_PATH, state)
        save_json(ATTRIBUTION_PATH, attributions)
        write_report(state, products_by_id)

    print("\nSummary")
    print(f"  matched:  {matched}")
    print(f"  no match: {no_match}")
    print(f"  errors:   {errors}")
    return 0 if errors == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
