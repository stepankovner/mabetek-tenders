"""Проверка доступности витрин. HTTP 200 не является проверкой адаптера."""
import argparse
import concurrent.futures
import datetime
import json
import re
import subprocess
import urllib.error
import urllib.request
from xml.etree import ElementTree as ET

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
    'rosneft': 'https://www.tektorg.ru/rosneft/procedures',
    'roseltorg': 'https://www.roseltorg.ru/procedures/search',
    'tektorg': 'https://www.tektorg.ru/procedures',
    'tektorgRzd': 'https://www.tektorg.ru/org/rzd/procedures',
    'gpb': 'https://etpgpb.ru/procedures/',
    'zakazrf': 'https://zakazrf.ru/NotificationEx',
    'otc': 'https://etp.otc.ru/tenders/small/',
    'fabrikant': 'https://44.fabrikant.ru/44/catalog/procedure',
}

def tektorg_export(section='zakupki'):
    if section not in ('zakupki', 'rzd'):
        raise ValueError('Неизвестная секция ТЭК-Торг')
    endpoint = 'https://api.tektorg.ru/procedures/soap'
    envelope = ('<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/" '
                f'xmlns:t="{endpoint}"><env:Body><t:procedures><t:exportRequestType>'
                f'<sectionCode>{section}</sectionCode><limitPage>12</limitPage><page>1</page>'
                '<sort><field>datePublished</field><operator>DESC</operator></sort>'
                '</t:exportRequestType></t:procedures></env:Body></env:Envelope>')
    req = urllib.request.Request(endpoint, envelope.encode(), {
        'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': '"urn:procedures"'})
    with urllib.request.build_opener(NoRedirect()).open(req, timeout=15) as response:
        raw = response.read(3000001)
    if len(raw) > 3000000 or b'<!DOCTYPE' in raw.upper():
        raise ValueError('Некорректный экспорт ТЭК-Торг')
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as exc:
        raise ValueError('Не распознан ответ SOAP') from exc
    result = root.find('.//{*}proceduresResponse')
    if result is None or result.findtext('sectionCode') != section or result.find('procedures') is None:
        raise ValueError('Не распознана секция ТЭК-Торг')
    clean = ET.Element('proceduresResponse')
    ET.SubElement(clean, 'sectionCode').text = section
    items = ET.SubElement(clean, 'procedures')
    for proc in result.findall('procedures/procedure'):
        item = ET.SubElement(items, 'procedure')
        for key in ('url_to_showcase', 'datePublished'):
            ET.SubElement(item, key).text = proc.findtext(key)
        lots = ET.SubElement(item, 'lots')
        for lot in proc.findall('lots/lot'):
            target = ET.SubElement(lots, 'lot')
            for key in ('number', 'subject', 'status'):
                ET.SubElement(target, key).text = lot.findtext(key)
    return ET.tostring(clean, encoding='unicode', short_empty_elements=False)


def fetch_catalogue(source, page=1):
    if source == 'rosneft':
        if type(page) is not int or page < 1:
            raise ValueError('Неверный номер страницы')
        url = CATALOGUES[source] + (f'?page={page}' if page > 1 else '')
        return fetch_html(url)
    if source in ('tektorg', 'tektorgRzd'):
        return tektorg_export('rzd' if source == 'tektorgRzd' else 'zakupki')
    if source == 'zakazrf':
        # Системный curl использует хранилище доверенных сертификатов macOS.
        result = subprocess.run([
            '/usr/bin/curl', '--disable', '--silent', '--show-error', '--fail',
            '--proto', '=https', '--max-time', '15', '--max-filesize', '3000000',
            '--write-out', '\n%{http_code} %{content_type}', CATALOGUES[source],
        ], capture_output=True)
        body, _, metadata = result.stdout.rpartition(b'\n')
        if (result.returncode or len(body) > 3000000 or
                metadata.split(b';', 1)[0].strip().lower() != b'200 text/html'):
            raise ValueError('Не удалось прочитать каталог ЗаказРФ')
        return body.decode('utf-8')
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

def poll_fallback(failed, schedule, now, publish, rosneft_page=1):
    due = [name for name in CATALOGUES if name in failed and schedule.get(name, 0) <= now]
    if not due:
        return
    source = min(due, key=lambda key: schedule.get(key, 0))
    schedule[source] = now + 900
    try:
        html = fetch_catalogue(source, rosneft_page) if source == 'rosneft' else fetch_catalogue(source)
    except (OSError, ValueError, LookupError):
        publish(dict(source=source, html='', error='unavailable'))
        return
    publish(dict(source=source, html=html))
