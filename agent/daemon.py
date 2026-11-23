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
    parts = [title, "Оценка: "+verdict+" — "+reason]
    if card.get("place"):
        parts.append("Место из карточки: "+card["place"][:500])
    if evidence:
        parts.append("Сведения из приложений: "+evidence[:1800])
    elif card.get("documentsPage"):
        parts.append("Приложения для сверки: "+card["documentsPage"])
    parts.extend(("Мабетэк: два пути 125 и 111 м на Батуевской Ветке, 19. Погрузка и выгрузка по заявке.",
                  "Вопросы семье: "+family, "Вопросы заказчику: "+buyer, "Оригинал: "+card["url"]))
    return "\n".join(parts)

_catalogue_schedule = {}
_collector_threads = {}
_collector_due = {}
_collector_failures = {}
_collectors_paused = None
_publication_thread = None
_maintenance_thread = None
_maintenance_due = 0
_document_thread = None
_document_due = 0
_document_turn = 0


def schedule_documents(conf):
    import threading
    global _document_thread, _document_due
    if time.monotonic() < _document_due or (_document_thread and _document_thread.is_alive()):
        return
    _document_due = time.monotonic() + 240
    _document_thread = threading.Thread(target=inspect_background, args=(conf,), daemon=True)
    _document_thread.start()


def inspect_background(conf):
    global _document_turn
    from .procurement_documents import inspect
    try:
        _document_turn += 1
        task = request(conf, "document-claim", {"discovery":_document_turn % 3 == 0})
        if not task:
            return
        try:
            report, _ = inspect(task["url"])
        except (OSError, ValueError, LookupError):
            report = {}
        request(conf, "document-result", {**report, "key":task["key"], "lease":task["lease"]})
    except (OSError, ValueError) as error:
        print(time.strftime("%Y-%m-%d %H:%M:%S"), "Документы закупок:",
              type(error).__name__, file=sys.stderr, flush=True)


def verify_release(conf, job, data, *, form=False):
    from .customer_forms import approved_values
    from .procurement_documents import inspect
    try:
        selected = data["form"]["url"] if form else None
        report, output = inspect(job["card"]["url"], parse=False, selected=selected,
                                 values=approved_values(data["terms"]) if form else None)
    except (OSError, ValueError, LookupError):
        report, output = {}, None
    proof = request(conf, "document-proof", {**report, "id":job["id"], "lease":job["lease"]})
    return bool(proof.get("current")), report, output


def send_form(conf, job, data):
    current, _, output = verify_release(conf, job, data, form=True)
    if not current:
        return
    from .customer_forms import approved_values
    approved = approved_values(data["terms"])
    fields = data["form"]["fields"]
    filled = [item["label"] for item in fields if item["fillable"] and approved.get(item["field"])]
    manual = [item["label"] for item in fields if not item["fillable"] or not approved.get(item["field"])]
    if output:
        notes = "Черновик для проверки. Перенесены: " + ", ".join(dict.fromkeys(filled)) + "."
        if manual:
            notes += " Проверьте или заполните вручную: " + ", ".join(dict.fromkeys(manual)) + "."
        notes = notes[:790] + " Проверьте реквизиты, подпись и приложения."
    else:
        notes = "В исходном бланке не удалось однозначно заполнить поля. Используйте значения из сводки и сверьте форму вручную."
    boundary = uuid4().hex
    content = f'--{boundary}\r\nContent-Disposition: form-data; name="notes"\r\n\r\n'.encode() + notes.encode()
    if output:
        name, file = output
        suffix = Path(name).suffix.lower()
        content += (f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="draft{suffix}"\r\n'
                    'Content-Type: application/octet-stream\r\n\r\n').encode() + file
    content += f"\r\n--{boundary}--\r\n".encode()
    upload = urllib.request.Request(conf["worker"].rstrip("/") + "/agent/form", content, {
        "User-Agent": USER_AGENT, "Authorization": "Bearer " + conf["key"],
        "x-job": str(job["id"]), "x-lease": job["lease"],
        "Content-Type": "multipart/form-data; boundary=" + boundary,
    })
    with urllib.request.build_opener(NoRedirect()).open(upload, timeout=50) as result:
        result.read()

PUBLICATIONS = {
    'eat-inbox.sqlite': 'eat-candidate',
    'comita-inbox.sqlite': 'comita-candidate',
    'rts-inbox.sqlite': 'rts-candidate',
    'otc-khab-inbox.sqlite': 'otc-region-candidate',
    'eis-orders.sqlite': 'eis-candidate',
    'eis-price_requests.sqlite': 'eis-candidate',
}


def replay_publications(conf):
    from contextlib import closing
    from .eat_import import drain_candidates
    from .local import connection
    # Each database is independent: a bad response from one source must not
    # prevent previously collected candidates from the others reaching D1.
    for name, endpoint in PUBLICATIONS.items():
        path = CONFIG.parent / name
        if not path.is_file():
            continue
        try:
            with closing(connection(path)) as db:
                # Targeted searches can discover dozens of candidates together.
                # Drain a bounded batch so the burst does not wait one tick per card.
                drain_candidates(db, lambda card: request(conf, endpoint, card), limit=4)
        except Exception as error:
            print(time.strftime('%Y-%m-%d %H:%M:%S'), 'Передача ' + name + ':',
                  type(error).__name__, file=sys.stderr, flush=True)


def schedule_publications(conf):
    import threading
    global _publication_thread
    if _publication_thread and _publication_thread.is_alive():
        return
    _publication_thread = threading.Thread(target=replay_publications, args=(conf,), daemon=True)
    _publication_thread.start()


def schedule_maintenance():
    import threading
    global _maintenance_thread, _maintenance_due
    if time.monotonic() < _maintenance_due or (_maintenance_thread and _maintenance_thread.is_alive()):
        return
    _maintenance_due = time.monotonic() + 3600
    def run():
        from .maintenance import maintain
        try:
            files = maintain(CONFIG.parent)
            if files:
                print(time.strftime('%Y-%m-%d %H:%M:%S'), 'Проверены резервные копии:',
                      len(files), file=sys.stderr, flush=True)
        except Exception as error:
            print(time.strftime('%Y-%m-%d %H:%M:%S'), 'Резервное копирование:',
                  type(error).__name__, file=sys.stderr, flush=True)
    _maintenance_thread = threading.Thread(target=run, daemon=True)
    _maintenance_thread.start()


def local_health():
    import sqlite3
    from contextlib import closing
    pending, oldest, unreadable = 0, None, 0
    for name in PUBLICATIONS:
        path = CONFIG.parent / name
        if not path.is_file():
            continue
        try:
            with closing(sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=0.5)) as db:
                if db.execute("SELECT 1 FROM sqlite_master WHERE name='publication_queue'").fetchone():
                    count, created = db.execute('SELECT count(*),min(created) FROM publication_queue').fetchone()
                    pending += count
                    if created is not None:
                        oldest = min(oldest, created) if oldest is not None else created
        except sqlite3.Error:
            unreadable += 1
    snapshots = list((CONFIG.parent / 'backups').glob('*.sqlite'))
    backup_at = int(max((p.stat().st_mtime for p in snapshots), default=0))
    release = Path(__file__).resolve().parents[1].name
    return dict(release=release if re.fullmatch('[a-f0-9]{16}', release) else 'development',
                pending=pending, oldest=oldest, unreadable=unreadable, backup_at=backup_at)


def start_collector(conf, source, name, collect):
    import threading
    now = time.monotonic()
    thread = _collector_threads.get(name)
    if now < _collector_due.get(name, 0) or (thread and thread.is_alive()):
        return

    def run():
        from .sources import retry_after
        reason = None
        retry = 0
        try:
            result = collect()
            reason = result.get('reason')
            retry = result.get('retry_after', 0)
            partial = reason is not None
            ok = not partial
            detail = f"{result['unique']} карточек, добавлено {result['inserted']}"
            if 'search_unique' in result:
                detail += f" (по профильным запросам: {result['search_unique']})"
            if partial:
                detail += ' (частичный обход: ' + reason + ')'
            if result.get('publication_pending'):
                detail += ' (передача в Worker сохранена в локальной очереди)'
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
                if exc.code == 429:
                    retry = retry_after(exc.headers)
        if ok or partial:
            _collector_failures.pop(name, None)
        else:
            failures = min(3, _collector_failures.get(name, 0) + 1)
            _collector_failures[name] = failures
            retry = max(retry, 900 * 2 ** (failures - 1))
        if retry:
            _collector_due[name] = max(_collector_due[name], time.monotonic() + retry)
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
            lambda card: request(conf, "eis-candidate", card), targeted=True))
    if conf.get('eat_node'):
        start_collector(conf, 'eat', 'ЕАТ', lambda: eat_import.collect_local(
            conf['eat_node'], conf['eat_modules'], CONFIG.parent / 'eat-inbox.sqlite',
            lambda card: request(conf, 'eat-candidate', card)))
        start_collector(conf, 'rts-rzd-search', 'РТС РЖД', lambda: eat_import.collect_rts(
            conf['eat_node'], conf['eat_modules'], CONFIG.parent / 'rts-inbox.sqlite',
            lambda card: request(conf, 'rts-candidate', card)))
        start_collector(conf, 'otc-khab', 'OTC Хабаровский край', lambda: eat_import.collect_browser(
            conf['eat_node'], conf['eat_modules'], CONFIG.parent / 'otc-khab-inbox.sqlite',
            'otc_region.mjs', list, lambda card: request(conf, 'otc-region-candidate', card)))
    start_collector(conf, 'comita-rzd', 'КОМИТА РЖД', lambda: comita.collect(
        CONFIG.parent / 'comita-inbox.sqlite', lambda card: request(conf, 'comita-candidate', card)))


def tick(conf):
    global _collectors_paused
    schedule_maintenance()
    try:
        status=request(conf,"heartbeat",{"free_bytes":shutil.disk_usage(CONFIG.parent).free, "local":local_health()})
    except OSError:
        # Continue collecting to SQLite while the cloud is briefly unavailable.
        if _collectors_paused is False:
            schedule_catalogues(conf)
        raise
    _collectors_paused = bool(status["paused"])
    if _collectors_paused:return
    schedule_publications(conf)
    schedule_catalogues(conf)
    schedule_documents(conf)
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
    if job["op"].startswith("form/"):
        send_form(conf, job, json.loads(job["input"]))
        return
    if job["op"].startswith("pdf/"):
        with tempfile.TemporaryDirectory() as td:
            out=Path(td)/"offer.pdf"
            data=json.loads(job["input"])
            terms=data.get("terms") if data.get("documentDigest") else data
            demo=any("демонстрацион" in str(terms.get(k,"")).lower() for k in ("terms","dates","validity","vat"))
            original = None
            if data.get("documentDigest"):
                current, report, _ = verify_release(conf, job, data)
                if not current:
                    return
                if card.get('source') == 'eis-order':
                    original = report["html"]
            if card.get('source') == 'eis-order':
                from .eis_catalogue import read_order
                if original is None:
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
    report=None
    if card.get("source") == "eis-order":
        from .procurement_documents import inspect
        try:
            report, _ = inspect(card["url"])
            evidence = "\n".join([*(p["quote"] for p in report["places"]),
                                   *(p["quote"] for p in report["services"][:3]), *report["notes"]])
            if not evidence:
                evidence = "В прочитанных приложениях точное место и профильные работы не найдены."
        except (OSError, ValueError):
            evidence = "Оригинал с приложениями недоступен."
    elif card.get("source") == "rzd-rts":
        from . import rzd_documents
        try:
            evidence=rzd_documents.review(card,CONFIG.parent/"documents")
        except (OSError,ValueError):
            evidence="Оригинал с приложениями недоступен."
    result=analysis_message(card,evidence)
    payload=dict(id=job["id"],lease=job["lease"],text=result[:3500])
    if report is not None:
        payload["report"]=report
    request(conf,"result",payload)

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
    os.umask(0o077)
    p=argparse.ArgumentParser();p.add_argument("--install",action="store_true");p.add_argument("--once",action="store_true")
    args=p.parse_args()
    if args.install:install();return
    while True:
        try:tick(settings())
        except Exception as e:
            detail = f"HTTP {e.code}" if isinstance(e, urllib.error.HTTPError) else type(e).__name__
            print(time.strftime("%Y-%m-%d %H:%M:%S"),"Агент:",detail,file=sys.stderr,flush=True)
            if args.once:raise SystemExit(1)
        if args.once:return
        time.sleep(45)

if __name__=="__main__":main()
