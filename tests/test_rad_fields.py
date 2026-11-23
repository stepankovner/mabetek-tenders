import unittest
from tools.rad_fields import Rows, lot_url


class PublishedFields(unittest.TestCase):
    def test_keep_distinct_prices_and_exact_precision_exclude_unrelated_phones(self):
        parser = Rows()
        parser.feed("""<table>
          <tr><td>Начальная (максимальная) цена договора (лота)</td><td>66&nbsp;629&nbsp;564,05 руб.</td></tr>
          <tr><td>Начальная (максимальная) цена договора (лота)</td><td>42,01 руб.</td></tr>
          <tr><td>Дата начала</td><td>01 дек. 2026</td></tr>
          <tr><td><span>Окончание подачи заявок</span></td><td>02 дек. 2026 11:00 МСК</td></tr>
          <tr><td>Телефон службы поддержки</td><td>12345678</td></tr>
          </table>""")
        self.assertEqual(parser.fields, dict(initial_price=['66 629 564,05 руб.', '42,01 руб.'],
                                             deadline=['02 дек. 2026 11:00 МСК'], phone=[]))

    def test_original_link_must_address_expected_lot(self):
        url = 'https://tender.lot-online.ru/etp/app/LotCard/page?LotCard.lotEntity=LT%3Aabc'
        self.assertTrue(lot_url(url, 'abc'))
        self.assertFalse(lot_url(url, 'other'))
        self.assertFalse(lot_url(url.replace('tender.lot-online.ru', 'example.org'), 'abc'))
        self.assertFalse(lot_url(url.replace('/LotCard/', '/SmallPurchaseCard/'), 'abc'))
        self.assertFalse(lot_url(url + '&extra=', 'abc'))
