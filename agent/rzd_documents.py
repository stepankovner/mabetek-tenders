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
        location = row['location']
        if (re.fullmatch(r'(?:[0-9.]+\s*)?мест[оа] (?:выполнения работ|оказания услуг|исполнения)[ :]*', text, re.I)
                and i+1 < len(rows) and rows[i+1]['file'] == row['file']):
            location += ' / ' + rows[i+1]['location']
            text += ' '+rows[i+1]['text'].strip()
        if re.search('указано в техническом|указывается|указываются',text,re.I):
            continue
        found.append(f"{row['file']}, {location}: {text[:250]}")
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


def cached_attachment(cache, name, link):
    """Reuse one unambiguous, intact copy of an attachment still listed on the card."""
    matches = []
    for index in cache.glob('*.json'):
        digest = index.stem
        if not re.fullmatch(r'[a-f0-9]{64}', digest):
            continue
        try:
            meta = json.loads(index.read_text(encoding='utf8'))
            if not isinstance(meta, dict) or (meta.get('name'), meta.get('url'), meta.get('sha256')) != (name, link, digest):
                continue
            target = index.with_suffix(Path(name).suffix.lower())
            if target.stat().st_size > MAX_BYTES:
                continue
            data = target.read_bytes()
        except (OSError, ValueError):
            continue
        if hashlib.sha256(data).hexdigest() == digest:
            matches.append(data)
            if len(matches) > 1:
                return None
    return matches[0] if matches else None


def review(card, cache):
    url = urlsplit(card['url'])
    ident = parse_qs(url.query).get('tenderId',[''])[0]
    if url.netloc!='rzd.rts-tender.ru' or url.scheme!='https' or url.path!='/TenderInterests/LogViewAndRedirect' or not re.fullmatch(r'\d{1,16}',ident):
        return ''
    attachments = attachment_links(fetch(card['url'], 1024*1024).decode('utf-8','replace'))
    return review_attachments(attachments, cache/ident, fetch, use_cached=True, model_base=cache.parent)


def review_attachments(attachments, cache, download, *, use_cached=False, model_base=None, limit=6):
    if not attachments:
        return 'На вкладке документов не найдены доступные для разбора приложения.'
    cache.mkdir(parents=True, exist_ok=True, mode=0o700)
    notes = []
    fragments = []
    for name, link in attachments[:limit]:
        if not EXT.search(name):
            notes.append(f'{name}: формат приложения пока не поддерживается.')
            continue
        try:
            try:
                data = download(link, MAX_BYTES)
            except OSError:
                data = cached_attachment(cache, name, link) if use_cached else None
                if data is None:
                    raise
                notes.append(f'{name}: сервер приложения недоступен. Использована сохранённая копия с проверенной SHA-256. Актуальность содержимого не подтверждена.')
            digest = hashlib.sha256(data).hexdigest()
            suffix = Path(name).suffix.lower()
            target = cache/(digest+suffix)
            if not target.exists():
                with tempfile.NamedTemporaryFile(dir=cache, delete=False) as f:
                    f.write(data)
                Path(f.name).replace(target)
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
    if len(attachments)>limit:
        notes.append(f'Разбор ограничен первыми {limit} приложениями из {len(attachments)}.')
    if not notes:
        notes.append('Конкретное место в обработанных приложениях установить не удалось.')
    if model_base is not None:
        notes.append(analyze(select_fragments(fragments),model_base))
    return '\n'.join(notes)
