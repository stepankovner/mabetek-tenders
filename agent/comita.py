"""Сбор опубликованных малых закупок РЖД с доставкой в Хабаровский край."""
import json
import re
import time
import urllib.request
from contextlib import closing
from datetime import datetime, timezone
from .eat_import import ingest, try_publish
from .local import connection
from .sources import NoRedirect

ENDPOINT = 'https://market.comita.ru/rest/elsearch/api/v1/searchPurchase'
UUID = re.compile(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}')


def active_cards(data, now_ms):
    if data.get('success') is not True or not isinstance(data.get('items'), list):
        raise ValueError('Нет списка процедур КОМИТА')
    cards = []
    for row in data['items']:
        if row.get('type') != 'rzd223' or row.get('statusEng') != 'eshop_published':
            continue
        if '27' not in [v.strip() for v in str(row.get('deliveryRegion', '')).split(',')]:
            continue
        end = row.get('endDate')
        if type(end) is not int:
            raise ValueError('Не распознан срок КОМИТА')
        if end <= now_ms:
            continue
        ident, number, title = (row.get(k) for k in ('id', 'number', 'name'))
        if not (isinstance(ident, str) and UUID.fullmatch(ident) and isinstance(number, str)
                and re.fullmatch(r'[0-9]{1,16}', number) and isinstance(title, str) and title.strip()):
            raise ValueError('Неполная карточка КОМИТА')
        card = dict(source='comita-rzd', procedure=number, lot='1', title=title.strip(),
                          url='https://eshoprzd.ru/purchases/' + ident)
        published = row.get('publicDate')
        if type(published) is int and 0 < published <= now_ms and published < end:
            card['published'] = datetime.fromtimestamp(published / 1000, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
        cards.append(card)
    return cards


def collect(path, publish=None):
    query = dict(itemsPerPage=100, page=0, search='', state='home', notChangeCounter=False,
                 searchByField=dict(type='223,rzd223,simplecontest', deliveryRegion='27',
                                    indexes='purchase_223,purchase_rzd223,purchase_uetp_223'),
                 orderBy='publicDate', orderAsc=False)
    req = urllib.request.Request(ENDPOINT, json.dumps(query).encode(),
                                 {'Content-Type':'application/json', 'Accept':'application/json'})
    with urllib.request.build_opener(NoRedirect()).open(req, timeout=20) as response:
        body = response.read(4_000_001)
        if len(body) > 4_000_000 or response.headers.get_content_type() != 'application/json':
            raise ValueError('Не распознана выдача КОМИТА')
    cards = active_cards(json.loads(body), int(time.time() * 1000))
    with closing(connection(path)) as db:
        result = ingest(db, cards)
        if publish is not None:
            try_publish(db, cards, publish, result)
    return result
