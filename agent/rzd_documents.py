"""Чтение публичных приложений, перечисленных в оригинале карточки РЖД."""
import hashlib
import json
import re
import subprocess
import tempfile
from zipfile import BadZipFile
from xml.etree.ElementTree import ParseError
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
from urllib.request import build_opener, HTTPRedirectHandler
from .pipeline import extract
from .model import analyze, select_fragments

MAX_BYTES = 12 * 1024 * 1024
FILE_URL = re.compile(r'https://223\.rts-tender\.ru/files/FileDownloadHandler\.ashx\?FileGuid=[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}')
EXT = re.compile(r'\.(?:docx?|xlsx|pdf|zip)$', re.I)

class Table(HTMLParser):
    def __init__(self):
        super().__init__()
        self.cells = None
        self.links = []
        self.files = {}

    def handle_starttag(self, tag, attrs):
        if tag == 'tr':
            self.cells, self.links = [], []
        if self.cells is not None and tag == 'a':
            url = dict(attrs).get('href') or ''
            if FILE_URL.fullmatch(url):
                self.links.append(url)

    def handle_data(self, data):
        if self.cells is not None and data.strip():
            self.cells.append(data.strip())

    def handle_endtag(self, tag):
        if tag == 'tr' and self.cells is not None:
            names = [s for s in self.cells if EXT.search(s)]
            if len(names) == len(self.links) == 1:
                self.files[self.links[0]] = Path(names[0]).name
            self.cells = None

def attachment_links(html):
    table = Table()
    table.feed(html)
    return [(name, url) for url, name in table.files.items()]

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None

def fetch(url, limit):
    with build_opener(NoRedirect()).open(url, timeout=8) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError('Лимит размера документа')
    return data

def summarize(rows):
    found = []
    for i, row in enumerate(rows):
        text = row['text'].strip()
        if not re.match(r'^(?:[0-9.]+\s*)?мест[оа] (?:выполнения работ|оказания услуг|исполнения)', text, re.I):
            continue
        if len(text) < 45 and i+1 < len(rows):
            text += ' '+rows[i+1]['text'].strip()
        if re.search('указано в техническом|указывается|указываются',text,re.I):
            continue
        found.append(f"{row['file']}, {row['location']}: {text[:250]}")
    return '\n'.join(found[:2])

def form_evidence(rows):
    headings = re.compile(r'^форма (?:сведений об участнике|технического предложения|сведений о персонале|согласия на обработку персональных данных|ценового предложения)\b', re.I)
    format_rule = re.compile(r'^техническое предложение оформляется.{0,240}в формате MS Word', re.I)
    vat_rule = re.compile(r'применяемая ставка НДС составляет [_ ]+ процентов', re.I)
    result = []
    seen = set()
    for row in rows:
        line = ' '.join(row['text'].split())
        match = headings.match(line) or format_rule.match(line) or vat_rule.search(line)
        if match and match.group().casefold() not in seen:
            result.append(f"{row['file']}, {row['location']}: {line[:220]}")
            seen.add(match.group().casefold())
    if not result:
        return ''
    return 'Формы заказчика:\n' + '\n'.join(result[:7])


def review(card, cache):
    url = urlsplit(card['url'])
    ident = parse_qs(url.query).get('tenderId',[''])[0]
    if url.netloc!='rzd.rts-tender.ru' or url.scheme!='https' or url.path!='/TenderInterests/LogViewAndRedirect' or not re.fullmatch(r'\d{1,16}',ident):
        return ''
    attachments = attachment_links(fetch(card['url'], 1024*1024).decode('utf-8','replace'))
    cache = cache/ident
    cache.mkdir(parents=True, exist_ok=True, mode=0o700)
    notes = []
    fragments = []
    for name, link in attachments[:6]:
        try:
            data = fetch(link, MAX_BYTES)
            digest = hashlib.sha256(data).hexdigest()
            suffix = Path(name).suffix.lower()
            target = cache/(digest+suffix)
            if not target.exists():
                with tempfile.NamedTemporaryFile(dir=cache, delete=False) as f:
                    f.write(data)
                Path(f.name).replace(target)
            if suffix == '.doc':
                if not data.startswith(bytes.fromhex('d0cf11e0a1b11ae1')):
                    raise ValueError('Неверная сигнатура DOC')
                result=subprocess.run(['/usr/bin/textutil','-convert','txt','-stdout',str(target)],capture_output=True,check=True,timeout=15)
                rows=[dict(location=f'строка {i}',text=t) for i,t in enumerate(result.stdout.decode().splitlines(),1)]
            else:
                rows = extract(target)
            for row in rows:
                row['file'] = name
            fragments.extend(select_fragments(rows))
            evidence = "\n".join(filter(None, (summarize(rows), form_evidence(rows))))
            index = dict(name=name,url=link,sha256=digest,excerpts=evidence)
            with tempfile.NamedTemporaryFile(dir=cache,mode='w',encoding='utf8',delete=False) as f:
                json.dump(index,f,ensure_ascii=False)
            Path(f.name).replace(cache/(digest+'.json'))
            if evidence:
                notes.append(evidence)
        except (OSError,ValueError,RuntimeError,BadZipFile,ParseError,subprocess.SubprocessError) as exc:
            notes.append(f'{name}: не удалось проверить ({type(exc).__name__})')
    if len(attachments)>6:
        notes.append('Обработаны первые шесть приложений.')
    if not notes:
        notes.append('Конкретное место в обработанных приложениях установить не удалось.')
    notes.append(analyze(fragments[:48],cache.parent.parent))
    return '\n'.join(notes)
