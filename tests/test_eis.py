import unittest
from agent.eis_catalogue import parse


class EIS(unittest.TestCase):
    def test_accepting_price_request_uses_exact_original_number(self):
        page = """<div class="search-registry-entry-block box">
        <span class="registry-entry__header-mid__number"><a href="/epz/pricereq/card/common-info.html?reestrNumber=0332200065926000089">№ 0332200065926000089</a></span>
        <span class="registry-entry__header-mid__title">Подача предложений</span>
        <div class="registry-entry__body-value">Погрузка &amp; хранение</div>"""
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
