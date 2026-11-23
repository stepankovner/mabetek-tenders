import unittest
from agent.eis_catalogue import parse


class EIS(unittest.TestCase):
    def test_closed_row_without_subject_does_not_block_pagination(self):
        block = '''<div class="search-registry-entry-block box">
        <span class="registry-entry__header-mid__number"><a href="/epz/order/notice/ezt20/view/common-info.html?regNumber=0191100003326000037">№ 0191100003326000037</a></span>
        <span class="registry-entry__header-mid__title">Определение поставщика завершено</span>'''
        rejected = []
        self.assertEqual(parse(block, 'orders', rejected=rejected), [])
        self.assertEqual(rejected, [])

    def test_past_deadline_overrides_stale_active_status_in_both_registries(self):
        from datetime import date
        for registry, path, number, status, label, dates in (
            ('orders', '/epz/order/notice/notice223/common-info.html?regNumber=', '31604329553',
             'Подача заявок', 'Окончание подачи заявок', '06.12.2016'),
            ('price_requests', '/epz/pricereq/card/common-info.html?reestrNumber=', '0332200065926000089',
             'Подача предложений', 'Предоставление ценовой информации', '20.11.2026 12:00 - 22.11.2026 14:00'),
        ):
            with self.subTest(registry=registry):
                block = f'''<div class="search-registry-entry-block box">
                <span class="registry-entry__header-mid__number"><a href="{path}{number}">№ {number}</a></span>
                <span class="registry-entry__header-mid__title">{status}</span>
                <div class="registry-entry__body-value">Выгрузка вагонов</div>
                <div class="data-block__title">{label}</div><div class="data-block__value">{dates}</div>'''
                self.assertEqual(parse(block, registry, today=date(2026, 11, 23)), [])
                self.assertEqual(len(parse(block, registry, today=date(2016, 12, 6))), 1)

    def test_targeted_search_validates_query_and_accepts_eis_empty_page(self):
        from unittest.mock import patch
        from agent.eis_catalogue import read_page
        response = """<input id="searchString" data-tooltip='<span>Поиск</span>' value="перевалка">
        <input id="pageNumber" value="1"><p class="noRecords">Поиск не дал результатов</p>"""
        with patch('agent.eis_catalogue.read_html', return_value=(response, None)) as read:
            page = read_page('orders', term='перевалка')
            self.assertEqual(parse(page, 'orders'), [])
            self.assertIn('af=on', read.call_args.args[0])
            for number, term in [(2, 'перевалка'), (1, 'другой запрос')]:
                with self.assertRaises(ValueError):
                    read_page('orders', number, term=term)

    def test_targeted_query_error_keeps_other_queries_and_saved_continuation(self):
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        from agent.eis_catalogue import collect_search
        empty = '<p class="noRecords">Поиск не дал результатов</p>'
        first = empty + '<a data-pagenumber="2"></a><a data-pagenumber="3"></a>'
        second = empty + '<a data-pagenumber="3"></a>'
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'inbox.sqlite'
            with patch('agent.eis_catalogue.read_page', side_effect=[OSError(), first, second]):
                result = collect_search('orders', path, terms=('ошибка', 'перевалка'))
            self.assertEqual(result['reason'], 'eis_search_incomplete')
            with patch('agent.eis_catalogue.read_page', side_effect=[first, empty]) as read:
                result = collect_search('orders', path, terms=('перевалка',))
            self.assertEqual(read.call_args.args, ('orders', 3))
            self.assertNotIn('reason', result)

    def test_cloud_outage_does_not_stop_pagination_or_lose_candidates(self):
        import tempfile
        import sqlite3
        from pathlib import Path
        from unittest.mock import patch
        from agent.eis_catalogue import collect
        def page(number, ident):
            return f'''<input id="pageNumber" value="{number}">
            {'<a data-pagenumber="2"></a>' if number == 1 else ''}
            <div class="search-registry-entry-block box">
            <span class="registry-entry__header-mid__number"><a href="/epz/pricereq/card/common-info.html?reestrNumber={ident}">№ {ident}</a></span>
            <span class="registry-entry__header-mid__title">Подача предложений</span>
            <div class="registry-entry__body-value">Выгрузка вагонов</div>'''
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'inbox.sqlite'
            with patch('agent.eis_catalogue.read_page', side_effect=[page(1, '0332200065926000089'), page(2, '0332200065926000090')]):
                def offline(payload):
                    raise OSError('Worker unavailable')
                result = collect('price_requests', path, offline)
            self.assertEqual(result['unique'], 2)
            self.assertTrue(result['publication_pending'])
            self.assertNotIn('reason', result)
            with sqlite3.connect(path) as db:
                self.assertEqual(db.execute('SELECT count(*) FROM publication_queue').fetchone()[0], 2)

    def test_accepting_price_request_uses_exact_original_number(self):
        page = """<div class="search-registry-entry-block box">
        <span class="registry-entry__header-mid__number"><a href="/epz/pricereq/card/common-info.html?reestrNumber=0332200065926000089">№ 0332200065926000089</a></span>
        <span class="registry-entry__header-mid__title">Подача предложений</span>
        <div class="registry-entry__body-value">Погрузка &amp; <span class='highlightColor'>хранен</span>ие</div>"""
        self.assertEqual(parse(page, "price_requests")[0]["title"], "Погрузка & хранение")
        self.assertEqual(parse(page.replace("Подача предложений", "Работа комиссии"), "price_requests"), [])
        for invalid in (page.replace("№ 0332", "№ 1332"), page + page, "<html>Вход</html>"):
            with self.assertRaises(ValueError):
                parse(invalid, "price_requests")

    def test_mixed_orders_include_current_223_path_and_legacy_44_path(self):
        def row(path, number):
            return f"""<div class="search-registry-entry-block box">
            <div class="registry-entry__header-mid__number"><a href="{path}?regNumber={number}">№ {number}</a></div>
            <div class="registry-entry__header-mid__title">Подача заявок</div>
            <div class="registry-entry__body-value">Предмет закупки</div>"""
        rows = row("/223/purchase/public/purchase/info/common-info.html", "32616574907")
        rows += row("/epz/order/notice/zk20/view/common-info.html", "0322200001326000255")
        self.assertEqual([card["procedure"] for card in parse(rows, "orders")],
                         ["32616574907", "0322200001326000255"])

    def test_failed_continuation_preserves_first_page_and_retries_second(self):
        import sqlite3
        import tempfile
        from pathlib import Path
        from urllib.error import HTTPError
        from unittest.mock import patch
        from agent.eis_catalogue import collect
        def page(number, ident):
            return f'''<input id="pageNumber" value="{number}"><a data-pagenumber="2"></a>
            <div class="search-registry-entry-block box">
            <span class="registry-entry__header-mid__number"><a href="/epz/pricereq/card/common-info.html?reestrNumber={ident}">№ {ident}</a></span>
            <span class="registry-entry__header-mid__title">Подача предложений</span>
            <div class="registry-entry__body-value">Предмет закупки</div>'''
        first = page(1, '0332200065926000089')
        second = page(2, '0332200065926000090')
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'inbox.sqlite'
            missing = HTTPError('https://zakupki.gov.ru/', 404, 'Not Found', {}, None)
            with patch('agent.eis_catalogue.read_page', side_effect=[first, missing]):
                result = collect('price_requests', path)
                self.assertEqual(result['inserted'], 1)
                self.assertEqual(result['reason'], 'eis_pagination_404')
            throttled = HTTPError('https://zakupki.gov.ru/', 429, 'Too Many Requests', {'Retry-After':'1800'}, None)
            with patch('agent.eis_catalogue.read_page', side_effect=[first, throttled]):
                result = collect('price_requests', path)
                self.assertEqual(result['retry_after'], 1800)
                self.assertEqual(result['inserted'], 0)
            with patch('agent.eis_catalogue.read_page', side_effect=[first, second]) as read:
                self.assertEqual(collect('price_requests', path)['inserted'], 1)
                self.assertEqual(read.call_args.args, ('price_requests', 2))
            with sqlite3.connect(path) as db:
                self.assertEqual(db.execute('select count(*) from lots').fetchone()[0], 2)
                self.assertEqual(db.execute('select count(*) from catalogue_observations').fetchone()[0], 2)

    def test_invalid_row_keeps_other_active_lots_and_marks_partial(self):
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        from agent.eis_catalogue import collect
        valid = '''<div class="search-registry-entry-block box">
        <span class="registry-entry__header-mid__number"><a href="/epz/pricereq/card/common-info.html?reestrNumber=0332200065926000089">№ 0332200065926000089</a></span>
        <span class="registry-entry__header-mid__title">Подача предложений</span>
        <div class="registry-entry__body-value">Предмет закупки</div>'''
        with tempfile.TemporaryDirectory() as folder:
            with patch('agent.eis_catalogue.read_page', return_value=valid + valid.replace('№ 0332', '№ 1332')):
                result = collect('price_requests', Path(folder) / 'inbox.sqlite')
            self.assertEqual(result['inserted'], 1)
            self.assertEqual(result['reason'], 'eis_unrecognized_rows')

    def test_equivalent_223_links_have_same_registration_number(self):
        from agent.eis_catalogue import original_number
        number = '32616574907'
        for path in ('/223/purchase/public/purchase/info/common-info.html',
                     '/epz/order/notice/notice223/common-info.html'):
            self.assertEqual(original_number('https://zakupki.gov.ru' + path + '?regNumber=' + number, 'orders'), number)
