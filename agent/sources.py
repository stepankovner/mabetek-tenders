"""Проверка доступности витрин. HTTP 200 не является проверкой адаптера."""
import argparse
import concurrent.futures
import datetime
import json
import re
import urllib.error
import urllib.request

SOURCES={
"ЕИС":"https://zakupki.gov.ru/epz/order/extendedsearch/results.html",
"РТС, секция РЖД":"https://rzd.rts-tender.ru/",
"ЕАТ Берёзка":"https://agregatoreat.ru/",
"B2B-Center":"https://www.b2b-center.ru/market/",
"ЭТП ГПБ":"https://etpgpb.ru/",
"ТЭК-Торг":"https://www.tektorg.ru/",
"Роснефть":"https://zakupki.rosneft.ru/",
"Росэлторг":"https://www.roseltorg.ru/",
"Сбербанк-АСТ":"https://www.sberbank-ast.ru/",
"Фабрикант":"https://www.fabrikant.ru/",
"ЗаказРФ":"https://zakazrf.ru/",
"РАД":"https://lot-online.ru/",
"OTC":"https://otc.ru/",
"Хабаровский край":"https://gz.khabkrai.ru/"
}
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args): return None

def probe(pair):
    name,url=pair
    result=dict(name=name,url=url,checked_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),adapter_confirmed=False)
    try:
        with urllib.request.build_opener(NoRedirect()).open(urllib.request.Request(url,headers={"User-Agent":"Mabetek procurement source health/1"}),timeout=8) as r:
            body=r.read(131072).decode("utf8","replace").lower()
            state="captcha" if any(s in body for s in ("smartcaptcha","verify you are human","captcha-container")) else "доступна страница, выдача требует отдельной проверки"
            result.update(status=state,http=r.status)
    except urllib.error.HTTPError as e:result.update(status="HTTP "+str(e.code))
    except (OSError,ValueError) as e: result.update(status=str(e)[:180])
    return result

if __name__=="__main__":
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        print(json.dumps(list(pool.map(probe,SOURCES.items())),ensure_ascii=False,indent=2))

CATALOGUES = {
    'roseltorg': 'https://www.roseltorg.ru/procedures/search',
    'tektorg': 'https://www.tektorg.ru/procedures',
    'gpb': 'https://etpgpb.ru/procedures/',
}

def fetch_catalogue(source):
    return fetch_html(CATALOGUES[source])

def fetch_lot_card(url):
    if not re.fullmatch(r'https://www\.roseltorg\.ru/procedure/[A-Za-z0-9_-]+/\d+', url):
        raise ValueError('Требуется HTTPS-ссылка на лот Росэлторга')
    return fetch_html(url)

def fetch_html(url):
    req = urllib.request.Request(url, headers={'User-Agent':'Mabetek-Tenders/1.0', 'Accept':'text/html'})
    with urllib.request.build_opener(NoRedirect()).open(req, timeout=12) as response:
        data = response.read(3000001)
        if len(data) > 3000000 or response.headers.get_content_type() != 'text/html':
            raise ValueError('Не удалось прочитать каталог')
        return data.decode(response.headers.get_content_charset() or 'utf-8', 'replace')

def poll_fallback(failed, schedule, now, publish):
    due = [name for name in CATALOGUES if name in failed and schedule.get(name, 0) <= now]
    if not due:
        return
    source = min(due, key=lambda key: schedule.get(key, 0))
    schedule[source] = now + 900
    try:
        html = fetch_catalogue(source)
    except (OSError, ValueError, LookupError):
        publish(dict(source=source, html='', error='unavailable'))
        return
    publish(dict(source=source, html=html))
