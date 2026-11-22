"""Verify the deployed release and read source health without exposing credentials."""
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

from .daemon import USER_AGENT, request, settings

WORKER = 'https://mabetek-zakupki.flight-tracker.workers.dev'
SOURCE_QUERY = 'SELECT id,last_ok,last_error,cursor,next_at FROM sources ORDER BY id'


def live_release():
    req = urllib.request.Request(WORKER + '/health', headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(req, timeout=12) as res:
        return json.load(res).get('release')


def source_status():
    try:
        return request(settings(), 'status', {}), 'Проверка через Mac'
    except (OSError, ValueError) as err:
        print('Проверка агента:', getattr(err, 'code', None) or type(err).__name__, flush=True)
    result = subprocess.run(
        ['npx', '--yes', 'wrangler@4', 'd1', 'execute', 'mabetek-tenders', '--remote',
         '--command', SOURCE_QUERY, '--json'],
        check=True, capture_output=True, text=True, timeout=100)
    data = json.loads(result.stdout)
    if not data or not data[0].get('success'):
        raise ValueError('Cloudflare не подтвердил чтение состояния источников')
    return {'sources': data[0]['results']}, 'Последние результаты из облачной базы'


def main():
    expected = sys.argv[1]
    for attempt in range(6):
        try:
            if live_release() == expected:
                break
        except (OSError, ValueError):
            pass
        time.sleep(3)
    else:
        raise SystemExit('Cloudflare пока не подтвердил ожидаемую версию.')
    print('Рабочая версия подтверждена:', expected, flush=True)
    status, method = source_status()
    print(method)
    target = Path('.private/live-sources.json')
    target.parent.mkdir(exist_ok=True, mode=0o700)
    with tempfile.NamedTemporaryFile(mode='w', dir=target.parent, delete=False) as f:
        json.dump(status, f, ensure_ascii=False, indent=2)
    os.replace(f.name, target)
    for row in status['sources']:
        print(row['id'], row['last_error'] or ('Выдача прочитана' if row['last_ok'] else 'Обход пока не подтверждён'))


if __name__ == '__main__':
    main()
