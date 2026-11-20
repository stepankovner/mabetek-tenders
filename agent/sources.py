"""Проверка доступности витрин. HTTP 200 не является проверкой адаптера."""
import argparse
import concurrent.futures
import datetime
import json
import urllib.error
import urllib.request

SOURCES={
"ЕИС":"https://zakupki.gov.ru/epz/order/extendedsearch/results.html",
"РТС, секция РЖД":"https://rzd.rts-tender.ru/",
"ЕАТ Берёзка":"https://agregatoreat.ru/",
"B2B-Center":"https://www.b2b-center.ru/market/",
"ЭТП ГПБ":"https://etpgpb.ru/",
"ТЭК-Торг":"https://www.tektorg.ru/",
"Роснефть":"https://zakupki.rosneft.ru/",
"Росэлторг":"https://www.roseltorg.ru/",
"Сбербанк-АСТ":"https://www.sberbank-ast.ru/",
"Фабрикант":"https://www.fabrikant.ru/",
"ЗаказРФ":"https://zakazrf.ru/",
"РАД":"https://lot-online.ru/",
"OTC":"https://otc.ru/",
"Хабаровский край":"https://gz.khabkrai.ru/"
}
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args): return None

def probe(pair):
    name,url=pair
    result=dict(name=name,url=url,checked_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),adapter_confirmed=False)
    try:
        with urllib.request.build_opener(NoRedirect()).open(urllib.request.Request(url,headers={"User-Agent":"Mabetek procurement source health/1"}),timeout=8) as r:
            body=r.read(131072).decode("utf8","replace").lower()
            state="captcha" if any(s in body for s in ("smartcaptcha","verify you are human","captcha-container")) else "доступна страница, выдача требует отдельной проверки"
            result.update(status=state,http=r.status)
    except urllib.error.HTTPError as e:result.update(status="HTTP "+str(e.code))
    except (OSError,ValueError) as e: result.update(status=str(e)[:180])
    return result

if __name__=="__main__":
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        print(json.dumps(list(pool.map(probe,SOURCES.items())),ensure_ascii=False,indent=2))
