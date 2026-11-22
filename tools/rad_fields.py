"""Read published fields from the exact original lot pages of a frozen RAD sample."""
import argparse
import hashlib
import json
import re
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[1]
FIELDS = {
    "initial_price": {"начальная (максимальная) цена договора (лота)", "начальная (максимальная) цена договора"},
    "deadline": {"окончание подачи заявок", "окончание подачи коммерческих предложений"},
    "phone": {"телефон", "номер контактного телефона", "контактный телефон", "телефон контактного лица"},
}


class Rows(HTMLParser):
    def __init__(self):
        super().__init__()
        self.stack = []
        self.fields = {key: [] for key in FIELDS}

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self.stack.append([[], None])
        elif self.stack and tag in ("td", "th"):
            self.stack[-1][1] = []
        elif self.stack and tag == "br" and self.stack[-1][1] is not None:
            self.stack[-1][1].append(" ")

    def handle_data(self, text):
        if self.stack and self.stack[-1][1] is not None:
            self.stack[-1][1].append(text)

    def handle_endtag(self, tag):
        if not self.stack:
            return
        cells, parts = self.stack[-1]
        if tag in ("td", "th") and parts is not None:
            cells.append(" ".join("".join(parts).split()))
            self.stack[-1][1] = None
        if tag == "tr":
            self.stack.pop()
            if len(cells) != 2 or not cells[1]:
                return
            for key, labels in FIELDS.items():
                if cells[0].casefold().rstrip(":").strip() in labels and cells[1] not in self.fields[key]:
                    self.fields[key].append(cells[1])


def lot_url(url, ident):
    u = urlsplit(url)
    path = re.fullmatch(r"/(?:etp/)?app/(?:section/[a-z0-9_-]+/)?(LotCard|SmallPurchaseCard)/page", u.path)
    if u.scheme != "https" or u.netloc != "tender.lot-online.ru" or not path:
        return False
    expected = ({"LotCard.lotEntity": ["LT:" + ident]} if path[1] == "LotCard"
                else {"SmallPurchaseCard.smallPurchaseEntity": ["MT:" + ident]})
    return parse_qs(u.query, keep_blank_values=True) == expected


def fetch(row):
    ident = row["id"].removeprefix("rad/")
    url = row["url"]
    evidence = {"id": row["id"], "url": url}
    if not lot_url(url, ident):
        raise ValueError("Неверная ссылка в манифесте")
    try:
        with urllib.request.urlopen(url, timeout=9) as response:
            body = response.read(2_500_001)
            if not lot_url(response.url, ident) or len(body) > 2_500_000 or ident.encode() not in body:
                raise ValueError("Не подтверждена оригинальная карточка лота")
            parser = Rows()
            parser.feed(body.decode("utf-8"))
            parser.close()
            evidence.update(sha256=hashlib.sha256(body).hexdigest(), fields=parser.fields)
    except (OSError, ValueError) as err:
        evidence["error"] = str(err)
    return evidence


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("output", type=Path)
    args = cli.parse_args()
    manifest = (ROOT / "reports/archive/v4-held-out.jsonl").read_bytes()
    lots = [json.loads(line) for line in manifest.splitlines()]
    originals = {r["id"]: r for r in map(json.loads, (ROOT / "reports/archive/v4-notice-files.jsonl").read_text().splitlines())}
    with ThreadPoolExecutor(max_workers=3) as pool:
        rows = list(pool.map(fetch, [originals[r["id"]] for r in lots]))
    verified = [row for row in rows if "fields" in row]
    report = {"checked_utc": datetime.now(timezone.utc).isoformat(),
              "manifest_sha256": hashlib.sha256(manifest).hexdigest(), "lots": len(rows), "pages_read": len(verified),
              "with_named_field": {k: sum(bool(r["fields"][k]) for r in verified) for k in FIELDS},
              "rows": rows}
    stage = args.output.with_suffix(".tmp")
    stage.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    stage.replace(args.output)
    print({k: v for k, v in report.items() if k != "rows"})


if __name__ == "__main__":
    main()
