"""Исходящий HTTPS клиент Worker. Конфигурация доступна только владельцу Mac."""
import argparse
import json
import os
import plistlib
import re
import shutil
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from uuid import uuid4
from .pipeline import classify, render
import tempfile

CONFIG=Path(os.environ.get("MABETEK_AGENT_CONFIG",Path.home()/"Library/Application Support/mabetek-tenders/agent.json"))
LABEL="ru.mabetek.tenders.agent"
USER_AGENT="Mabetek-Tenders/1.0"

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args):return None

def settings(path=None):
    path = CONFIG if path is None else path
    if stat.S_IMODE(path.stat().st_mode)&0o077: raise ValueError("Проверьте права файла конфигурации")
    conf=json.loads(path.read_text())
    from urllib.parse import urlsplit
    url=urlsplit(conf["worker"])
    if url.scheme!="https" or not url.hostname or url.username or url.password or url.path not in ("","/"): raise ValueError("Требуется HTTPS адрес Worker")
    if "key" not in conf:
        keychain=subprocess.run(["/usr/bin/security","find-generic-password","-s","mabetek-tenders.agent","-w"],capture_output=True,text=True,timeout=30)
        if keychain.returncode: raise ValueError("Нет доступа к ключу агента в связке Вход")
        conf["key"]=keychain.stdout.strip()
    if len(conf["key"])<32: raise ValueError("Короткий ключ агента")
    return conf

def request(conf,path,data):
    req=urllib.request.Request(conf["worker"].rstrip("/")+"/agent/"+path,json.dumps(data).encode(),{"User-Agent":USER_AGENT,"Authorization":"Bearer "+conf["key"],"Content-Type":"application/json"})
    with urllib.request.build_opener(NoRedirect()).open(req,timeout=30) as res: return json.load(res)

def offer_upload(pdf, original=None):
    if original is None:
        return pdf, 'application/pdf'
    boundary = uuid4().hex
    headers = (f'--{boundary}\r\nContent-Disposition: form-data; name="original"\r\n\r\n')
    content = headers.encode() + original.encode('utf-8')
    if pdf is not None:
        part = (f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="pdf"; filename="KP.pdf"\r\n'
                'Content-Type: application/pdf\r\n\r\n')
        content += part.encode() + pdf
    return content + f'\r\n--{boundary}--\r\n'.encode(), 'multipart/form-data; boundary=' + boundary

def analysis_message(card,evidence):
    title=card.get("title") or "Предмет не указан"
    site=next((line for line in evidence.splitlines()
               if re.search(r"(?:строка|абзац|страница) .{0,20}:.*место (?:оказания услуг|выполнения работ)",line,re.I)
               and re.search(r"(?:пер\.|переулок|ул\.|улица|проспект|шоссе|дома?\s+\d).{0,55}\d",line,re.I)), "")
    own_site=bool(re.search(r"батуевская ветка[, ]+(?:д\.?\s*)?19\b",site,re.I))
    place=site or card.get("place","")
    verdict,reason=classify(title+" "+(card.get("description") or ""),place)
    family="Свободна ли площадка в требуемые даты и какова ставка?"
    buyer="Допускается ли площадка исполнителя и какие операции входят в объём работ?"
    if site and not own_site and verdict in ("рассмотреть", "нужно уточнение"):
        verdict="нужно уточнение"
        reason="В приложении указан другой адрес. Возможность выезда бригады требует подтверждения."
        family="Можем ли направить выездную бригаду по адресу из ТЗ? Какие операции и смены готовы обеспечить?"
        buyer="Какие условия допуска персонала и порядок согласования смен на указанной площадке?"
    elif own_site and verdict in ("рассмотреть", "нужно уточнение"):
        buyer="Какие типы вагонов, объёмы и даты заказчик подтвердит для согласования?"
    parts=[title,"Оценка: "+verdict+" — "+reason,"Сведения из документов: "+(evidence[:2000] or place or "не указано"),
           "Мабетэк: два пути 125 и 111 м на Батуевской Ветке, 19. Погрузка и выгрузка по заявке.",
           "Вопросы семье: "+family,"Вопросы заказчику: "+buyer,"Оригинал: "+card["url"]]
    return "\n".join(parts)

_catalogue_schedule = {}
_collector_threads = {}
_collector_due = {}


def start_collector(conf, source, name, collect):
    import threading
    now = time.monotonic()
    thread = _collector_threads.get(name)
    if now < _collector_due.get(name, 0) or (thread and thread.is_alive()):
        return

    def run():
        reason = None
        try:
            result = collect()
            reason = result.get('reason')
            partial = reason is not None
            ok = not partial
            detail = f"{result['unique']} карточек, добавлено {result['inserted']}"
            if partial:
                detail += ' (частичный обход: ' + reason + ')'
        except Exception as exc:
            partial = False
            ok = False
            detail = type(exc).__name__
            if isinstance(exc, subprocess.CalledProcessError):
                # Keep the diagnosis without copying arbitrary remote content or command arguments.
                stderr = exc.stderr or ''
                if source == 'rts-rzd-search' and 'Error: RTS_PUBLIC_SEARCH_UNAVAILABLE' in stderr:
                    reason = 'rts_public_search_unavailable'
                    detail = 'РТС вернула HTTP 503 и страницу Anti-DDoS'
                for signature in ('ERR_CERT_AUTHORITY_INVALID', 'TimeoutError', 'ERR_CONNECTION_RESET',
                                  'MODULE_NOT_FOUND', 'TargetClosedError', 'SIGABRT', 'Неполная страница РТС',
                                  'Состав выдачи РТС изменился', 'Нет счётчика закупок региона'):
                    if signature in stderr:
                        detail += ' ' + signature
                        break
            if isinstance(exc, urllib.error.HTTPError):
                detail += f" HTTP {exc.code}"
        try:
            request(conf, 'scan-report', dict(source=source, ok=ok, reason=reason, partial=partial))
        except (OSError, ValueError) as err:
            detail += ' (статус Worker: ' + type(err).__name__ + ')'
        print(time.strftime("%Y-%m-%d %H:%M:%S"), name + ':', detail, file=sys.stderr, flush=True)

    _collector_due[name] = now + 900
    thread = threading.Thread(target=run, daemon=True)
    _collector_threads[name] = thread
    thread.start()


def schedule_catalogues(conf):
    from . import comita, eat_import, eis_catalogue
    for registry, label in (("orders", "ЕИС · закупки"), ("price_requests", "ЕИС · запросы цен")):
        start_collector(conf, "eis-" + registry, label, lambda registry=registry: eis_catalogue.collect(
            registry, CONFIG.parent / ("eis-" + registry + ".sqlite"),
            lambda card: request(conf, "eis-candidate", card)))
    if conf.get('eat_node'):
        start_collector(conf, 'eat', 'ЕАТ', lambda: eat_import.collect_local(
            conf['eat_node'], conf['eat_modules'], CONFIG.parent / 'eat-inbox.sqlite',
            lambda card: request(conf, 'eat-candidate', card)))
        start_collector(conf, 'rts-rzd-search', 'РТС РЖД', lambda: eat_import.collect_browser(
            conf['eat_node'], conf['eat_modules'], CONFIG.parent / 'rts-inbox.sqlite',
            'rts_catalogue.mjs', list, lambda card: request(conf, 'rts-candidate', card)))
        start_collector(conf, 'otc-khab', 'OTC Хабаровский край', lambda: eat_import.collect_browser(
            conf['eat_node'], conf['eat_modules'], CONFIG.parent / 'otc-khab-inbox.sqlite',
            'otc_region.mjs', list, lambda card: request(conf, 'otc-region-candidate', card)))
    start_collector(conf, 'comita-rzd', 'КОМИТА РЖД', lambda: comita.collect(
        CONFIG.parent / 'comita-inbox.sqlite', lambda card: request(conf, 'comita-candidate', card)))


def tick(conf):
    status=request(conf,"heartbeat",{"free_bytes":shutil.disk_usage(CONFIG.parent).free})
    if status["paused"]:return
    schedule_catalogues(conf)
    job=request(conf,"claim",{})
    if not job:
        from .sources import poll_fallback, fetch_lot_card
        if status.get('pendingCard'):
            task=request(conf, 'card-claim', {})
            if task:
                final_url=task['url']
                try:
                    if final_url.startswith('https://zakupki.gov.ru/'):
                        from .eis_catalogue import read_order
                        html, final_url=read_order(final_url)
                    else:
                        html=fetch_lot_card(final_url)
                except (OSError,ValueError,LookupError):
                    html=''
                request(conf, 'card-result', {**task, 'html':html, 'resolved_url':final_url})
                return
        poll_fallback(status.get('failedCatalogues', []), _catalogue_schedule, time.monotonic(),
                      lambda result: request(conf, 'catalogue', result), status.get('rosneftPage', 1))
        return
    card=job["card"]
    if job["op"].startswith("pdf/"):
        with tempfile.TemporaryDirectory() as td:
            out=Path(td)/"offer.pdf"
            terms=json.loads(job["input"])
            demo=any("демонстрацион" in str(terms.get(k,"")).lower() for k in ("terms","dates","validity","vat"))
            original = None
            if card.get('source') == 'eis-order':
                from .eis_catalogue import read_order
                try:
                    original, returned = read_order(card['url'])
                except (OSError, ValueError):
                    if job.get('attempts', 0) < 4:
                        raise
                    original = ''
                else:
                    if returned != card['url']:
                        # A changed original URL must be reviewed through /watch before issue.
                        original = ''
            pdf = None
            if original != '':
                render(terms,out,template=conf["template"],demo=demo)
                pdf = out.read_bytes()
            body, content_type = offer_upload(pdf, original)
            req=urllib.request.Request(conf["worker"].rstrip("/")+"/agent/pdf",body,{"User-Agent":USER_AGENT,"Authorization":"Bearer "+conf["key"],"x-job":str(job["id"]),"x-lease":job["lease"],"Content-Type":content_type})
            with urllib.request.build_opener(NoRedirect()).open(req,timeout=50) as res:res.read()
        return
    evidence=""
    if card.get("source")=="rzd-rts":
        from .rzd_documents import review
        try:
            evidence=review(card,CONFIG.parent/"documents")
        except (OSError,ValueError):
            evidence="Оригинал с приложениями недоступен."
    result=analysis_message(card,evidence)
    request(conf,"result",dict(id=job["id"],lease=job["lease"],text=result[:3500]))

def install():
    settings()
    plist=Path.home()/"Library/LaunchAgents"/(LABEL+".plist")
    info={"Label":LABEL,"ProgramArguments":[sys.executable,"-m","agent.daemon"],"WorkingDirectory":str(Path(__file__).resolve().parents[1]),"RunAtLoad":True,"KeepAlive":True,"ThrottleInterval":30}
    payload=plistlib.dumps(info)
    if plist.exists() and plist.read_bytes()!=payload:raise ValueError("Другой LaunchAgent с таким именем")
    plist.write_bytes(payload)
    domain="gui/"+str(os.getuid())
    if subprocess.run(["launchctl","print",domain+"/"+LABEL],capture_output=True).returncode:
        subprocess.run(["launchctl","bootstrap",domain,str(plist)],check=True)
    subprocess.run(["launchctl","kickstart","-k",domain+"/"+LABEL],check=True)

def main():
    p=argparse.ArgumentParser();p.add_argument("--install",action="store_true");p.add_argument("--once",action="store_true")
    args=p.parse_args()
    if args.install:install();return
    while True:
        try:tick(settings())
        except (OSError,ValueError,KeyError) as e:
            detail = f"HTTP {e.code}" if isinstance(e, urllib.error.HTTPError) else type(e).__name__
            print(time.strftime("%Y-%m-%d %H:%M:%S"),"Агент:",detail,file=sys.stderr,flush=True)
            if args.once:raise SystemExit(1)
        if args.once:return
        time.sleep(45)

if __name__=="__main__":main()
