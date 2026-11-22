import unittest
from agent.comita import active_cards


class RegionalCatalogue(unittest.TestCase):
    def test_checks_region_stage_deadline_and_market(self):
        row = dict(type='rzd223', statusEng='eshop_published', deliveryRegion='25,27',
                   id='4ee4b3eb-028e-4967-867b-19cfcdd06fba', number='241937',
                   name='Поставка канцелярских товаров', endDate=2000)
        rows = [row, dict(row, endDate=1000), dict(row, deliveryRegion='127'),
                dict(row, statusEng='finished'), dict(row, type='other')]
        cards = active_cards(dict(success=True, items=rows), 1000)
        self.assertEqual([c['procedure'] for c in cards], ['241937'])
        self.assertEqual(cards[0]['url'], 'https://eshoprzd.ru/purchases/' + row['id'])
        dated = active_cards(dict(success=True, items=[dict(row, publicDate=900)]), 1000)[0]
        self.assertEqual(dated['published'], '1970-01-01T00:00:00.900Z')
        self.assertNotIn('published', active_cards(dict(success=True, items=[dict(row, publicDate=1001)]), 1000)[0])
        with self.assertRaises(ValueError):
            active_cards(dict(success=True, items=[dict(row, id='invalid')]), 1000)
