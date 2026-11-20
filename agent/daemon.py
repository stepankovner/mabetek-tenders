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
from .pipeline import classify, render
import tempfile

CONFIG=Path(os.environ.get("MABETEK_AGENT_CONFIG",Path.home()/"Library/Application Support/mabetek-tenders/agent.json"))
LABEL="ru.mabetek.tenders.agent"
USER_AGENT="Mabetek-Tenders/1.0"

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args):return None

def settings():
    if stat.S_IMODE(CONFIG.stat().st_mode)&0o077: raise ValueError("Проверьте права файла конфигурации")
    conf=json.loads(CONFIG.read_text())
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
    if site and not own_site:
        verdict="нужно уточнение"
        reason="В приложении указан другой адрес. Возможность выезда бригады требует подтверждения."
        family="Можем ли направить выездную бригаду по адресу из ТЗ? Какие операции и смены готовы обеспечить?"
        buyer="Какие условия допуска персонала и порядок согласования смен на указанной площадке?"
    elif own_site:
        buyer="Какие типы вагонов, объёмы и даты заказчик подтвердит для согласования?"
    parts=[title,"Оценка: "+verdict+" — "+reason,"Сведения из документов: "+(evidence[:2000] or place or "не указано"),
           "Мабетэк: два пути 125 и 111 м на Батуевской Ветке, 19. Погрузка и выгрузка по заявке.",
           "Вопросы семье: "+family,"Вопросы заказчику: "+buyer,"Оригинал: "+card["url"]]
    return "\n".join(parts)

_catalogue_schedule = {}

def tick(conf):
    status=request(conf,"heartbeat",{"free_bytes":shutil.disk_usage(CONFIG.parent).free})
    if status["paused"]:return
    job=request(conf,"claim",{})
    if not job:
        from .sources import poll_fallback, fetch_lot_card
        if status.get('pendingCard'):
            task=request(conf, 'card-claim', {})
            if task:
                try:
                    html=fetch_lot_card(task['url'])
                except (OSError,ValueError,LookupError):
                    html=''
                request(conf, 'card-result', {**task, 'html':html})
                return
        poll_fallback(status.get('failedCatalogues', []), _catalogue_schedule, time.monotonic(),
                      lambda result: request(conf, 'catalogue', result))
        return
    card=job["card"]
    if job["op"].startswith("pdf/"):
        with tempfile.TemporaryDirectory() as td:
            out=Path(td)/"offer.pdf"
            terms=json.loads(job["input"])
            demo=any("демонстрацион" in str(terms.get(k,"")).lower() for k in ("terms","dates","validity","vat"))
            render(terms,out,template=conf["template"],demo=demo)
            req=urllib.request.Request(conf["worker"].rstrip("/")+"/agent/pdf",out.read_bytes(),{"User-Agent":USER_AGENT,"Authorization":"Bearer "+conf["key"],"x-job":str(job["id"]),"x-lease":job["lease"],"Content-Type":"application/pdf"})
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
