"""Import the public browser collector's JSON into the local inbox."""
import argparse
from contextlib import closing, nullcontext
import hashlib
import json
from pathlib import Path
import re
import sys
import subprocess
from .pipeline import catalogue_subject, classify
from .local import connection, record

CARD = re.compile(r'https://agregatoreat\.ru/purchases/announcement/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/')


def entries(snapshot):
    pages = snapshot.get('pages') if isinstance(snapshot, dict) else snapshot
    if not isinstance(pages, list) or not pages:
        raise ValueError('Отсутствуют страницы ЕАТ')
    numbers, urls = {}, {}
    for index, page in enumerate(pages, 1):
        if not isinstance(page, dict) or type(page.get('page')) is not int or page['page'] != index:
            raise ValueError('Нарушен порядок страниц')
        rows = page.get('rows')
        counts = [page.get(k) for k in ('cards','restricted','inactive')]
        if (not isinstance(rows,list) or any(type(v) is not int or v < 0 for v in counts)
                or not counts[0] or counts[0] != counts[1]+counts[2]+len(rows)):
            raise ValueError('Неполный результат страницы ЕАТ')
        for row in rows:
            number,url,title = (row[k] for k in ('number','url','title'))
            if not (isinstance(title,str) and title.strip() and re.fullmatch('[0-9]{18}',number) and CARD.fullmatch(url)):
                raise ValueError('Некорректная карточка ЕАТ')
            if numbers.setdefault(number,(url,title.strip())) != (url,title.strip()) or urls.setdefault(url,number) != number:
                raise ValueError('Противоречивые карточки ЕАТ')
    return [dict(source='eat',procedure=n,lot='1',url=url,title=title) for n,(url,title) in numbers.items()]


def ingest(db, cards):
    inserted = 0
    differences = []
    for card in cards:
        result = record(db,card,[],catalogue=True)
        if isinstance(result,tuple):
            inserted += 1
        elif result:
            differences.append(dict(procedure=card['procedure'],fields=result))
    return dict(unique=len(cards),inserted=inserted,differences=differences)


def publication_schema(db):
    db.execute("CREATE TABLE IF NOT EXISTS eat_receipts(url TEXT PRIMARY KEY, title TEXT NOT NULL)")
    db.execute("CREATE TABLE IF NOT EXISTS review_receipts(url TEXT PRIMARY KEY, title TEXT NOT NULL)")
    db.execute("""CREATE TABLE IF NOT EXISTS publication_queue (
        url TEXT NOT NULL, review INTEGER NOT NULL, title TEXT NOT NULL,
        payload TEXT NOT NULL, next_at INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL DEFAULT(unixepoch()),
        PRIMARY KEY(url,review))""")


def enqueue_candidates(db, cards, *, sample_nonmatches=False, commit=True):
    publication_schema(db)
    candidates = []
    sample = []
    for card in cards:
        title = catalogue_subject(card)[:4000]
        if classify(title, '')[0] in ('рассмотреть', 'нужно уточнение'):
            candidates.append((card, title, False))
        elif sample_nonmatches:
            sample.append((hashlib.sha256(card['url'].encode()).digest(), card, title))
    # One stable sample per page for semantic review, after normal notifications.
    sample.sort(key=lambda item: item[0])
    with db if commit else nullcontext():
        for card, title, review in candidates + [(card, title, True) for _, card, title in sample]:
            receipts = 'review_receipts' if review else 'eat_receipts'
            if db.execute(f"SELECT 1 FROM {receipts} WHERE url=? AND title=?",
                          (card['url'], title)).fetchone():
                continue
            payload = dict(procedure=card['procedure'], url=card['url'], title=title)
            if card.get('source') in ('otc-small-live', 'otc-commercial-live'):
                payload['section'] = card['source'].split('-')[1]
            if card.get('source') == 'comita-rzd' and card.get('published'):
                payload['published'] = card['published']
            if review:
                payload['review'] = True
            db.execute("""INSERT INTO publication_queue(url,review,title,payload) VALUES(?,?,?,?)
                ON CONFLICT(url,review) DO UPDATE SET title=excluded.title,payload=excluded.payload,
                next_at=0,attempts=0 WHERE publication_queue.title!=excluded.title""",
                (card['url'], int(review), title, json.dumps(payload, ensure_ascii=False)))


def drain_candidates(db, publish, *, limit=3):
    publication_schema(db)
    sent = 0
    for _ in range(limit):
        with db:
            row = db.execute("""UPDATE publication_queue SET next_at=unixepoch()+120,attempts=attempts+1
                WHERE (url,review)=(SELECT url,review FROM publication_queue WHERE next_at<=unixepoch()
                ORDER BY review,created,url LIMIT 1) RETURNING url,review,title,payload,attempts""").fetchone()
        if row is None:
            break
        url, review, title, payload, attempts = row
        try:
            reply = publish(json.loads(payload))
            if not isinstance(reply, dict) or reply.get('status') not in ('accepted', 'filtered'):
                raise ValueError('Worker не подтвердил обработку карточки')
        except Exception as error:
            from urllib.error import HTTPError
            from .sources import retry_after
            delay = min(3600, 45 * 2 ** min(attempts - 1, 7))
            if isinstance(error, HTTPError) and error.code == 429:
                delay = max(delay, retry_after(error.headers))
            with db:
                db.execute("UPDATE publication_queue SET next_at=unixepoch()+? WHERE url=? AND review=? AND payload=?",
                           (delay, url, review, payload))
            raise
        receipts = 'review_receipts' if review else 'eat_receipts'
        with db:
            db.execute(f"INSERT OR REPLACE INTO {receipts} VALUES(?,?)", (url, title))
            db.execute("DELETE FROM publication_queue WHERE url=? AND review=? AND payload=?", (url, review, payload))
        sent += 1
        if review:
            break
    return sent


def publish_candidates(db, cards, publish, *, sample_nonmatches=False):
    enqueue_candidates(db, cards, sample_nonmatches=sample_nonmatches)
    return drain_candidates(db, publish)


def try_publish(db, cards, publish, result, **kwargs):
    try:
        publish_candidates(db, cards, publish, **kwargs)
    except (OSError, ValueError):
        # Collection and pagination continue even when the delivery channel fails.
        result['publication_pending'] = True


def collect_browser(node, modules, path, script, parse, publish, *, args=('5',)):
    collector = Path(__file__).resolve().parents[1] / 'tools' / script
    run = subprocess.run([node, str(collector), *args], cwd=modules, capture_output=True,
                         text=True, timeout=150, check=True)
    snapshot = json.loads(run.stdout)
    cards = parse(snapshot)
    with closing(connection(path)) as db:
        result = ingest(db, cards)
        if publish is not None:
            try_publish(db, cards, publish, result)
        return result


def collect_rts(node, modules, path, publish=None):
    def checked(snapshot):
        nonlocal reason
        if not isinstance(snapshot, dict):
            raise ValueError('РТС не отдала результат обхода')
        pages = snapshot.get('pages')
        total = snapshot.get('totalPages')
        cards = snapshot.get('cards')
        reason = snapshot.get('reason')
        if (type(pages) is not int or type(total) is not int or not 1 <= pages <= total
                or not isinstance(cards, list)
                or reason != ('rts_pagination_incomplete' if pages < total else None)):
            raise ValueError('РТС не подтвердила объём обхода')
        return cards

    reason = None
    result = collect_browser(node, modules, path, 'rts_catalogue.mjs', checked, publish, args=('--partial',))
    if reason:
        result['reason'] = reason
    return result


def collect_otc_market(node, modules, path, section, publish=None):
    if section not in ('small', 'commercial'):
        raise ValueError('Неизвестная секция ОТС')
    with closing(connection(path)) as db:
        db.execute("""CREATE TABLE IF NOT EXISTS otc_market_cursor(
            section TEXT PRIMARY KEY, page INTEGER NOT NULL, gaps TEXT NOT NULL)""")
        state = db.execute("SELECT page,gaps FROM otc_market_cursor WHERE section=?", (section,)).fetchone()
        cursor, gaps = state if state else (2, '[]')
        script = Path(__file__).resolve().parents[1] / 'tools/otc_market.mjs'
        run = subprocess.run([node, str(script), section, str(cursor), gaps], cwd=modules,
                             capture_output=True, text=True, timeout=150, check=True)
        snapshot = json.loads(run.stdout)
        if snapshot.get('section') != section:
            raise ValueError('ОТС вернула другую секцию')
        delay = snapshot.get('retryAfter', 0)
        if type(delay) is not int or delay < 0:
            raise ValueError('Некорректный интервал ОТС')
        if snapshot.get('blocked') is True and delay:
            return dict(unique=0, inserted=0, reason='otc_pagination_incomplete', retry_after=delay)
        cards = []
        pages = snapshot.get('totalPages')
        next_page = snapshot.get('next')
        gaps = snapshot.get('gaps')
        complete = snapshot.get('complete')
        rows = snapshot.get('cards')
        if (type(pages) is not int or not 1 <= pages <= 2000 or type(next_page) is not int
                or not 2 <= next_page <= max(2, pages) or not isinstance(gaps, list)
                or any(type(n) is not int or n < 2 or n > pages for n in gaps)
                or type(complete) is not bool or (complete and (gaps or next_page != 2))
                or not isinstance(rows, list) or len(rows) > 20 * pages):
            raise ValueError('ОТС не подтвердила объём обхода')
        for row in rows:
            url, title = row['url'], row['title']
            link = re.fullmatch(r'https://etp\.otc\.ru/tender/(\d{1,16})', url)
            if not link or not isinstance(title, str) or not title.strip():
                raise ValueError('Некорректная карточка ОТС')
            cards.append(dict(source=f'otc-{section}-live', procedure=link[1], lot='1', url=url, title=title))
        result = ingest(db, cards)
        with db:
            db.execute("INSERT OR REPLACE INTO otc_market_cursor VALUES(?,?,?)",
                       (section, next_page, json.dumps(gaps)))
        if not complete:
            result['reason'] = 'otc_pagination_incomplete'
        if delay:
            result['retry_after'] = delay
        if publish is not None:
            try_publish(db, cards, publish, result)
        return result


def collect_local(node, modules, path, publish=None):
    return collect_browser(node, modules, path, 'eat_catalogue.mjs', entries, publish)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db',required=True,type=Path)
    args = parser.parse_args()
    cards = entries(json.load(sys.stdin))
    with closing(connection(args.db)) as db:
        print(json.dumps(ingest(db,cards),ensure_ascii=False))
