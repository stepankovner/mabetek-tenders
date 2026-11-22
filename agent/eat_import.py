"""Import the public browser collector's JSON into the local inbox."""
import argparse
from contextlib import closing
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


def publish_candidates(db, cards, publish):
    # Retry while the catalogue still shows the procedure as open.
    db.execute("CREATE TABLE IF NOT EXISTS eat_receipts(url TEXT PRIMARY KEY, title TEXT NOT NULL)")
    attempted = 0
    for card in cards:
        title = catalogue_subject(card)[:4000]
        if classify(title, '')[0] not in ('рассмотреть', 'нужно уточнение'):
            continue
        if db.execute("SELECT 1 FROM eat_receipts WHERE url=? AND title=?",
                      (card['url'], title)).fetchone():
            continue
        payload = dict(procedure=card['procedure'], url=card['url'], title=title)
        if card.get('source') == 'comita-rzd' and card.get('published'):
            payload['published'] = card['published']
        reply = publish(payload)
        if reply.get('status') not in ('accepted', 'filtered'):
            raise ValueError('Worker не подтвердил обработку карточки ЕАТ')
        with db:
            db.execute("INSERT OR REPLACE INTO eat_receipts VALUES(?,?)", (card['url'], title))
        attempted += 1
        if attempted == 3:
            break


def collect_browser(node, modules, path, script, parse, publish):
    collector = Path(__file__).resolve().parents[1] / 'tools' / script
    run = subprocess.run([node, str(collector), '5'], cwd=modules, capture_output=True,
                         text=True, timeout=150, check=True)
    cards = parse(json.loads(run.stdout))
    with closing(connection(path)) as db:
        result = ingest(db, cards)
        if publish is not None:
            publish_candidates(db, cards, publish)
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
