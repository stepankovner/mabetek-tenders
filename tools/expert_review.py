"""Prepare and import a blind human review of the frozen v4 lots (UTF-8 CSV)."""
import argparse
import csv
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from agent.evaluate import LABELS, USEFUL, load

ARCHIVE = ROOT / 'reports/archive'
MANIFEST = ARCHIVE / 'v4-held-out.jsonl'
CHECKSUM = 'a761811b975d2af31839adf8337cd36c27c0d37e91a492d6c587cf7dc3b01ad1'
ATTACHMENTS_CHECKSUM = 'c9687dd592b38f387e9b141d72a12ff796fb265d7660e211ca155d6e5552c20d'
FIELDS = ['ID', 'Предмет', 'Оригинал', 'Приложения', 'Решение эксперта', 'Основание в оригинале']


def originals():
    if hashlib.sha256(MANIFEST.read_bytes()).hexdigest() != CHECKSUM:
        raise ValueError('Контрольная сумма закрытого манифеста изменилась')
    cards = load(MANIFEST)
    attachments = ARCHIVE / 'v4-notice-files.jsonl'
    if hashlib.sha256(attachments.read_bytes()).hexdigest() != ATTACHMENTS_CHECKSUM:
        raise ValueError('Контрольная сумма списка приложений изменилась')
    files = load(attachments)
    if cards.keys() != files.keys():
        raise ValueError('Список приложений расходится с закрытым манифестом')
    return cards, files


def display_subject(text):
    return "'" + text if text.lstrip().startswith(("=", "+", "-", "@")) else text


def attachment_list(record):
    return '\n'.join(f"Файл {n}. {f['name']} — {f['url']}" for n, f in enumerate(record['files'], 1))


def prepare(path, priority=None):
    cards, files = originals()
    keys = list(cards)
    if priority is not None:
        audited = load(priority)
        if audited.keys() != cards.keys():
            raise ValueError('Состав проверки ссылок расходится с манифестом')
        def needs_review(key):
            row = audited[key]
            label = row['linked_label']
            return label is None or (label in USEFUL) != row['title_match']
        keys.sort(key=lambda key: not needs_review(key))
    with path.open('x', encoding='utf-8-sig', newline='') as stream:
        writer = csv.writer(stream, delimiter=';')
        writer.writerow(FIELDS)
        for key in keys:
            card = cards[key]
            attachments = attachment_list(files[key])
            writer.writerow([key, display_subject(card['subject']), card['url'], attachments, '', ''])


def read_decisions(path):
    cards, files = originals()
    result = {}
    with path.open(encoding='utf-8-sig', newline='') as stream:
        reader = csv.DictReader(stream, delimiter=';')
        if reader.fieldnames != FIELDS:
            raise ValueError('Столбцы таблицы отличаются от исходного бланка')
        for row in reader:
            key = row['ID']
            if key not in cards or key in result or row['Оригинал'] != cards[key]['url'] or row['Предмет'] != display_subject(cards[key]['subject']):
                raise ValueError(f'Чужой, повторный или изменённый лот: {key}')
            if row['Приложения'] != attachment_list(files[key]):
                raise ValueError(f'Изменён список приложений лота: {key}')
            label = (row['Решение эксперта'] or '').strip()
            evidence = (row['Основание в оригинале'] or '').strip()
            if label not in LABELS or not evidence:
                raise ValueError(f'Нужно решение эксперта и основание для {key}')
            result[key] = dict(id=key, label=label, evidence=evidence, url=cards[key]['url'])
    if result.keys() != cards.keys():
        raise ValueError('Таблица не охватывает все 200 исходных лотов')
    return list(result.values())


if __name__ == '__main__':
    cli = argparse.ArgumentParser(description=__doc__)
    commands = cli.add_subparsers(dest='command', required=True)
    prepare_cli = commands.add_parser('prepare')
    prepare_cli.add_argument('csv', type=Path)
    prepare_cli.add_argument('--priority', type=Path, help='Поставить расхождения и непроверенные ссылки в начало бланка')
    parser = commands.add_parser('import')
    parser.add_argument('csv', type=Path)
    parser.add_argument('jsonl', type=Path)
    args = cli.parse_args()
    try:
        if args.command == 'prepare':
            prepare(args.csv, args.priority)
        else:
            rows = read_decisions(args.csv)
            with args.jsonl.open('x', encoding='utf-8') as stream:
                stream.writelines(json.dumps(r, ensure_ascii=False)+'\n' for r in rows)
            print('Проверено:', len(rows), 'Рассмотреть:', sum(r['label']=='рассмотреть' for r in rows))
    except (ValueError, OSError) as error:
        cli.exit(2, str(error)+'\n')
