#!/usr/bin/env python3
"""Conservatively fetch exact product images from Open Food Facts/Open Products Facts.

The script intentionally rejects uncertain matches. Products without a strong, exact match
keep the site's category icon. Images are converted to optimized WebP and the source/attribution
is recorded next to the catalog.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
import sys
import time
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import Any, Iterable

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

USER_AGENT = (
    "BertaHoReCaCatalog/1.0 "
    "(https://github.com/KStrochan/BertaGroup_order; product image matching)"
)

STOP_TOKENS = {
    "ак", "б", "без", "в", "ва", "від", "для", "до", "з", "за", "із", "і", "й", "на",
    "та", "у", "в\u043f", "уп", "упак", "упаковка", "пак", "пач", "кор", "ящ", "шт", "сп",
    "жб", "сб", "мб", "пет", "пл", "куп", "pro", "ап", "лф", "тп", "от", "pj", "id",
    "мл", "л", "г", "кг", "gr", "kg", "ml", "liter", "litre", "pcs", "pc",
    "раф", "рафін", "дез", "рвд", "нраф", "нераф", "консервований", "консервована",
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

MEASURE_RE = re.compile(
    r"(?P<num>\d+(?:\s*[.,]\s*\d+)?)\s*(?P<unit>кг|kg|г|gr|g|мл|ml|л|l)\b",
    flags=re.IGNORECASE,
)
COUNT_RE = re.compile(r"(?P<num>\d+)\s*(?:шт|pcs?|pieces?)\b", flags=re.IGNORECASE)
PARENS_RE = re.compile(r"\([^)]*(?:шт|пак|уп|сп)[^)]*\)", flags=re.IGNORECASE)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--section", choices=["all", "Food", "NONFood"], default="all")
    parser.add_argument("--limit", type=int, default=1000, help="Maximum new products checked in this run")
    parser.add_argument("--min-score", type=float, default=0.82, help="Acceptance threshold from 0 to 1")
    parser.add_argument("--sleep", type=float, default=0.65, help="Delay between API requests")
    parser.add_argument("--retry-unmatched", action="store_true")
    parser.add_argument("--force", action="store_true", help="Re-download already matched images")
    parser.add_argument("--dry-run", action="store_true")
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
    if compact:
        text = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    else:
        text = json.dumps(data, ensure_ascii=False, indent=2)
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
    value = re.sub(r"\s+", " ", value).strip()
    return value


def tokenize(text: Any) -> list[str]:
    tokens: list[str] = []
    for token in normalize(text).split():
        if token in STOP_TOKENS or len(token) < 3 or token.replace(".", "").isdigit():
            continue
        tokens.append(token)
    return tokens


def first_brand_hint(name: str) -> str:
    original = re.findall(r"[A-Za-zА-Яа-яІіЇїЄєҐґ0-9&'-]+", name)
    if not original:
        return ""
    first_raw = original[0].strip("-'&")
    first = normalize(first_raw)
    if not first or first in GENERIC_FIRST_TOKENS or first in CODE_PREFIXES or first in STOP_TOKENS:
        return ""
    if len(first) <= 2:
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


def brand_compatible(brand_hint: str, candidate_text: str, brands: str) -> tuple[bool, float]:
    if not brand_hint:
        return True, 1.0
    target = normalize(f"{brands} {candidate_text}")
    if brand_hint in target.split() or brand_hint in target:
        return True, 1.0
    best = max((fuzz.ratio(brand_hint, token) for token in target.split()), default=0)
    return best >= 86, best / 100


def candidate_name(candidate: dict[str, Any]) -> str:
    names = [
        candidate.get("product_name_uk"),
        candidate.get("product_name_ru"),
        candidate.get("product_name"),
        candidate.get("generic_name"),
        candidate.get("brands"),
        candidate.get("quantity"),
    ]
    return " ".join(str(item) for item in names if item)


def score_candidate(product: dict[str, Any], candidate: dict[str, Any]) -> tuple[float, str]:
    display_name = str(product.get("name") or product.get("sourceName") or "")
    source_name = display_name
    candidate_text = candidate_name(candidate)
    if not candidate_text:
        return 0.0, "candidate has no name"

    source_norm = normalize(clean_query_name(source_name))
    candidate_norm = normalize(candidate_text)
    source_tokens = tokenize(source_norm)
    candidate_tokens = tokenize(candidate_norm)

    text_ratio = fuzz.token_set_ratio(source_norm, candidate_norm) / 100
    coverage = token_coverage(source_tokens, candidate_tokens)
    brand_hint = first_brand_hint(display_name)
    brand_ok, brand_score = brand_compatible(brand_hint, candidate_text, str(candidate.get("brands") or ""))
    measure_ok, measure_score = measurement_compatible(source_name, candidate_text)

    image_url = candidate.get("image_front_url") or candidate.get("image_url")
    if not image_url:
        return 0.0, "candidate has no front image"
    if not measure_ok:
        return 0.0, "package size/weight does not match"
    if not brand_ok:
        return 0.0, f"brand does not match ({brand_hint})"

    score = (text_ratio * 0.52) + (coverage * 0.28) + (brand_score * 0.12) + (measure_score * 0.08)

    # Generic/no-brand products must match even more tightly.
    if not brand_hint and (text_ratio < 0.88 or coverage < 0.72):
        return 0.0, "generic product match is not specific enough"
    if text_ratio < 0.72 or coverage < 0.58:
        return 0.0, "name similarity is too low"

    return min(1.0, score), "strong name, brand and package match"


def build_queries(product: dict[str, Any]) -> list[str]:
    name = clean_query_name(str(product.get("name") or ""))
    source = clean_query_name(str(product.get("sourceName") or ""))
    brand = first_brand_hint(name)
    measure_text = " ".join(
        match.group(0).replace(" ", "") for match in MEASURE_RE.finditer(name)
    )
    core_tokens = tokenize(name)
    concise = " ".join(([brand] if brand else []) + core_tokens[:6] + ([measure_text] if measure_text else []))

    queries: list[str] = []
    for query in [name, source, concise]:
        query = re.sub(r"\s+", " ", query).strip()
        if query and normalize(query) not in {normalize(item) for item in queries}:
            queries.append(query)
    return queries[:3]


def search_candidates(
    session: requests.Session,
    product: dict[str, Any],
    delay: float,
) -> tuple[list[dict[str, Any]], str]:
    endpoint = OFF_SEARCH if product.get("section") == "Food" else OPF_SEARCH
    fields = (
        "code,product_name,product_name_uk,product_name_ru,generic_name,brands,quantity,"
        "image_front_url,image_url,countries_tags"
    )
    seen_codes: set[str] = set()
    all_candidates: list[dict[str, Any]] = []
    last_error = ""

    for query in build_queries(product):
        params = {
            "search_terms": query,
            "search_simple": 1,
            "action": "process",
            "json": 1,
            "page_size": 12,
            "fields": fields,
        }
        try:
            response = session.get(endpoint, params=params, timeout=35)
            response.raise_for_status()
            payload = response.json()
            for candidate in payload.get("products", []):
                code = str(candidate.get("code") or "")
                key = code or str(candidate.get("image_front_url") or candidate.get("image_url") or "")
                if key and key not in seen_codes:
                    seen_codes.add(key)
                    all_candidates.append(candidate)
        except (requests.RequestException, ValueError) as exc:
            last_error = str(exc)
        time.sleep(max(0.0, delay))
        if len(all_candidates) >= 12:
            break

    return all_candidates, last_error


def choose_best_candidate(
    product: dict[str, Any], candidates: Iterable[dict[str, Any]], min_score: float
) -> tuple[dict[str, Any] | None, float, str]:
    ranked: list[tuple[float, dict[str, Any], str]] = []
    for candidate in candidates:
        score, reason = score_candidate(product, candidate)
        ranked.append((score, candidate, reason))
    ranked.sort(key=lambda item: item[0], reverse=True)
    if not ranked:
        return None, 0.0, "no API candidates"

    score, candidate, reason = ranked[0]
    if score < min_score:
        return None, score, reason

    # Reject ambiguous top results when two distinct products score almost the same.
    if len(ranked) > 1 and ranked[1][0] >= min_score and score - ranked[1][0] < 0.025:
        first_code = str(candidate.get("code") or "")
        second_code = str(ranked[1][1].get("code") or "")
        if first_code != second_code:
            return None, score, "ambiguous: two similarly strong products"

    return candidate, score, reason


def download_and_prepare_image(
    session: requests.Session, image_url: str, destination: Path
) -> tuple[bool, str]:
    try:
        response = session.get(image_url, timeout=45)
        response.raise_for_status()
        content_type = response.headers.get("content-type", "")
        if "image" not in content_type.lower() and len(response.content) < 1000:
            return False, f"unexpected content type: {content_type}"
        if len(response.content) > 15_000_000:
            return False, "image is larger than 15 MB"

        with Image.open(BytesIO(response.content)) as opened:
            image = ImageOps.exif_transpose(opened)
            if image.width < 140 or image.height < 140:
                return False, "image resolution is too small"
            image = image.convert("RGBA")
            background = Image.new("RGBA", image.size, (255, 255, 255, 255))
            background.alpha_composite(image)
            image = background.convert("RGB")
            image.thumbnail((680, 680), Image.Resampling.LANCZOS)

            canvas = Image.new("RGB", (720, 720), "white")
            x = (720 - image.width) // 2
            y = (720 - image.height) // 2
            canvas.paste(image, (x, y))

            destination.parent.mkdir(parents=True, exist_ok=True)
            canvas.save(destination, "WEBP", quality=86, method=6, optimize=True)
        return True, ""
    except (requests.RequestException, UnidentifiedImageError, OSError) as exc:
        return False, str(exc)


def source_page(section: str, code: str) -> str:
    base = "https://world.openfoodfacts.org/product" if section == "Food" else "https://world.openproductsfacts.org/product"
    return f"{base}/{code}" if code else ""


def write_report(state: dict[str, Any], products_by_id: dict[str, dict[str, Any]]) -> None:
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        "product_id", "section", "product_name", "status", "score", "matched_name", "barcode",
        "source_page", "image_url", "reason", "checked_at",
    ]
    with REPORT_PATH.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for product_id in sorted(state):
            entry = state[product_id]
            product = products_by_id.get(product_id, {})
            writer.writerow({
                "product_id": product_id,
                "section": product.get("section", ""),
                "product_name": product.get("name", ""),
                "status": entry.get("status", ""),
                "score": entry.get("score", ""),
                "matched_name": entry.get("matchedName", ""),
                "barcode": entry.get("barcode", ""),
                "source_page": entry.get("sourcePage", ""),
                "image_url": entry.get("imageUrl", ""),
                "reason": entry.get("reason", ""),
                "checked_at": entry.get("checkedAt", ""),
            })


def main() -> int:
    args = parse_args()
    if not PRODUCTS_PATH.exists():
        print(f"Catalog not found: {PRODUCTS_PATH}", file=sys.stderr)
        return 2

    products: list[dict[str, Any]] = load_json(PRODUCTS_PATH, [])
    state: dict[str, Any] = load_json(STATE_PATH, {})
    attributions: dict[str, Any] = load_json(ATTRIBUTION_PATH, {})
    products_by_id = {str(product.get("id")): product for product in products}

    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json,image/*,*/*;q=0.8"})

    eligible: list[dict[str, Any]] = []
    for product in products:
        product_id = str(product.get("id") or "")
        if not product_id:
            continue
        if args.section != "all" and product.get("section") != args.section:
            continue
        image_path = IMAGES_DIR / f"{product_id}.webp"
        existing = state.get(product_id, {})
        if not args.force and product.get("image") and image_path.exists():
            continue
        if not args.force and existing.get("status") == "matched" and image_path.exists():
            product["image"] = f"/images/products/{product_id}.webp"
            continue
        if not args.retry_unmatched and existing.get("status") == "no_match":
            continue
        eligible.append(product)

    selected = eligible[: max(0, args.limit)]
    print(f"Products in catalog: {len(products)}")
    print(f"Eligible now: {len(eligible)}; checking this run: {len(selected)}")

    matched = 0
    no_match = 0
    errors = 0
    now_iso = lambda: datetime.now(timezone.utc).replace(microsecond=0).isoformat()

    for index, product in enumerate(selected, start=1):
        product_id = str(product["id"])
        print(f"[{index}/{len(selected)}] {product_id}: {product.get('name')}")
        candidates, search_error = search_candidates(session, product, args.sleep)
        candidate, score, reason = choose_best_candidate(product, candidates, args.min_score)

        if candidate is None:
            status = "error" if search_error and not candidates else "no_match"
            state[product_id] = {
                "status": status,
                "score": round(score, 4),
                "reason": search_error or reason,
                "checkedAt": now_iso(),
            }
            if status == "error":
                errors += 1
            else:
                no_match += 1
            continue

        image_url = str(candidate.get("image_front_url") or candidate.get("image_url") or "")
        code = str(candidate.get("code") or "")
        destination = IMAGES_DIR / f"{product_id}.webp"

        ok, download_error = (True, "") if args.dry_run else download_and_prepare_image(session, image_url, destination)
        matched_name = candidate_name(candidate)
        page_url = source_page(str(product.get("section")), code)

        if not ok:
            state[product_id] = {
                "status": "error",
                "score": round(score, 4),
                "matchedName": matched_name,
                "barcode": code,
                "sourcePage": page_url,
                "imageUrl": image_url,
                "reason": f"download failed: {download_error}",
                "checkedAt": now_iso(),
            }
            errors += 1
            continue

        product["image"] = f"/images/products/{product_id}.webp"
        state[product_id] = {
            "status": "matched",
            "score": round(score, 4),
            "matchedName": matched_name,
            "barcode": code,
            "sourcePage": page_url,
            "imageUrl": image_url,
            "reason": reason,
            "checkedAt": now_iso(),
        }
        attributions[product_id] = {
            "productName": product.get("name", ""),
            "source": "Open Food Facts" if product.get("section") == "Food" else "Open Products Facts",
            "sourcePage": page_url,
            "originalImage": image_url,
            "license": "CC BY-SA 3.0",
            "retrievedAt": now_iso(),
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
    print(f"  remaining eligible: {max(0, len(eligible) - len(selected))}")
    return 0 if errors == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
