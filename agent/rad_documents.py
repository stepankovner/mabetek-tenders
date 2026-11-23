"""Индекс публичных приложений действующей редакции извещения РАД."""
import argparse
import hashlib
import json
import re
import subprocess
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit

ORIGIN = 'https://tender.lot-online.ru'
DOWNLOAD = re.compile(r'/etp/downloadppf\?uuid=dbfile[a-z0-9]+')
CARD = re.compile(r'/app/(?:section/[a-z0-9_-]+/)?(?:LotCard|SmallPurchaseCard)/page')
LIMIT = 2_500_000


class NoticeFiles(HTMLParser):
    def __init__(self):
        super().__init__()
        self.cells = None
        self.cell = None
        self.links = []
        self.files = {}

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'tr':
            self.cells, self.links = [], []
        elif tag == 'td' and self.cells is not None:
            self.cell = []
            self.file_cell = bool(re.fullmatch(r"fileNameColumnCell(?:_[0-9]+)?", attrs.get("id") or ""))
        elif tag == 'a' and self.cell is not None:
            href = attrs.get('href') or ''
            name = (attrs.get('value') or '').strip()
            if DOWNLOAD.fullmatch(href) and name:
                self.links.append((ORIGIN + href, name))
                if self.file_cell:
                    self.files[ORIGIN + href] = name

    def handle_data(self, data):
        if self.cell is not None:
            self.cell.append(data)

    def handle_endtag(self, tag):
        if tag == 'td' and self.cell is not None:
            self.cells.append(' '.join(' '.join(self.cell).split()).casefold())
            self.cell = None
        if tag == 'tr' and self.cells is not None:
            if (len(self.cells) >= 2 and 'извещение' in self.cells[0]
                    and '(действующая)' in self.cells[1]):
                self.files.update(self.links)
            self.cells, self.cell = None, None


def inventory(row):
    url = urlsplit(row['url'])
    if (url.scheme != 'https' or url.netloc != 'tender.lot-online.ru'
            or not CARD.fullmatch(url.path) or not re.fullmatch(
                r'(?:LotCard\.lotEntity=LT|SmallPurchaseCard\.smallPurchaseEntity=MT)%3A[a-z0-9]+', url.query)):
        raise ValueError('Неподдерживаемая ссылка РАД')
    # Публичные ссылки каталога переходят на тот же путь внутри /etp.
    canonical = ORIGIN + '/etp' + url.path + '?' + url.query
    for _ in range(4):
        result = subprocess.run(['/usr/bin/curl', '--disable', '--silent', '--show-error',
                                 '--max-time', '18', '--max-filesize', str(LIMIT),
                                 '--proto', '=https', '--write-out', '\n%{http_code}\n%{redirect_url}', canonical],
                                capture_output=True)
        body, _, metadata = result.stdout.rpartition(b'\n')
        redirect = metadata.decode('utf-8', 'replace')
        body, _, status = body.rpartition(b'\n')
        if result.returncode or status not in (b'301', b'302', b'307', b'308'):
            break
        dest = urlsplit(redirect)
        if (dest.scheme != 'https' or dest.netloc != 'tender.lot-online.ru'
                or not CARD.fullmatch(dest.path.removeprefix('/etp')) or dest.query != url.query):
            break
        canonical = redirect
    item = {'id': row['id'], 'url': canonical}
    if result.returncode or status != b'200':
        return dict(item, error=f'curl={result.returncode}, HTTP={status.decode(errors="replace")}')
    parser = NoticeFiles()
    html = body.decode('utf-8', 'replace')
    parser.feed(html)
    if not re.search(r'(?i)<html\b', html) or row['id'].split('/')[-1] not in html:
        return dict(item, error='Не подтверждён идентификатор карточки')
    return dict(item, html_sha256=hashlib.sha256(body).hexdigest(),
                files=[{'url': u, 'name': n} for u, n in parser.files.items()])


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument('manifest', type=Path)
    cli.add_argument('output', type=Path)
    args = cli.parse_args()
    rows = list(map(json.loads, args.manifest.read_text().splitlines()))
    prior = {r['id']: r for r in map(json.loads, args.output.read_text().splitlines())} if args.output.exists() else {}
    todo = [r for r in rows if 'html_sha256' not in prior.get(r['id'], {})]
    with ThreadPoolExecutor(max_workers=2) as pool:
        for offset in range(0, len(todo), 2):
            results = list(pool.map(inventory, todo[offset:offset+2]))
            prior.update((r['id'], r) for r in results)
            tmp = args.output.with_name(args.output.name + '.tmp')
            tmp.write_text(''.join(json.dumps(prior[r['id']], ensure_ascii=False)+'\n' for r in rows if r['id'] in prior))
            tmp.replace(args.output)
            if any('HTTP=429' in r.get('error','') for r in results):
                break


if __name__ == '__main__':
    main()
