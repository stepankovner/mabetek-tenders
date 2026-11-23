import csv
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools import expert_review


class BlindReview(unittest.TestCase):
    def test_import_preserves_original_ids_and_requires_explicit_evidence(self):
        cards = {'one': {'subject': '=formula', 'url': 'https://example.org/one'}}
        files = {'one': {'files': [{'name': '+attachment', 'url': 'https://example.org/file'}]}}
        with tempfile.TemporaryDirectory() as folder, patch.object(expert_review, 'originals', return_value=(cards, files)):
            path = Path(folder) / 'review.csv'
            expert_review.prepare(path)
            with path.open(encoding='utf-8-sig', newline='') as stream:
                row = next(csv.DictReader(stream, delimiter=';'))
            self.assertTrue(row['Предмет'].startswith("'"))
            self.assertTrue(row['Приложения'].startswith('Файл 1.'))
            with self.assertRaises(ValueError):
                expert_review.read_decisions(path)
            row.update({'Решение эксперта': 'рассмотреть', 'Основание в оригинале': 'ТЗ, раздел 3'})
            def write(rows):
                with path.open('w', encoding='utf-8-sig', newline='') as stream:
                    writer = csv.DictWriter(stream, fieldnames=expert_review.FIELDS, delimiter=';')
                    writer.writeheader()
                    writer.writerows(rows)
            write([row])
            self.assertEqual(expert_review.read_decisions(path)[0]['label'], 'рассмотреть')
            for invalid in ([], [row, row], [dict(row, Приложения='')], [dict(row, Оригинал='https://example.org/other')]):
                write(invalid)
                with self.assertRaises(ValueError):
                    expert_review.read_decisions(path)

    def test_priority_order_retains_blind_fields_and_validate_before_creating_file(self):
        import json
        cards = {key: dict(subject=key, url='https://example.org/' + key) for key in ('a','b','c')}
        files = {key: dict(files=[]) for key in cards}
        rows = [dict(id='a', linked_label='отклонить', title_match=False),
                dict(id='b', linked_label='рассмотреть', title_match=False),
                dict(id='c', linked_label=None, title_match=False)]
        with tempfile.TemporaryDirectory() as folder, patch.object(expert_review, 'originals', return_value=(cards, files)):
            path = Path(folder)/'out.csv'
            audit = Path(folder)/'audit.jsonl'
            audit.write_text(json.dumps(rows[0]))
            with self.assertRaises(ValueError):
                expert_review.prepare(path, audit)
            self.assertFalse(path.exists())
            audit.write_text('\n'.join(map(json.dumps, rows)))
            expert_review.prepare(path, audit)
            with path.open(encoding='utf-8-sig', newline='') as stream:
                result = list(csv.DictReader(stream, delimiter=';'))
            self.assertEqual([row['ID'] for row in result], ['b','c','a'])
            self.assertTrue(all(row['Решение эксперта'] == '' for row in result))
