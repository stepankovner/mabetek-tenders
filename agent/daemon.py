"""Исходящий HTTPS клиент Worker. Конфигурация доступна только владельцу Mac."""
import argparse
import json
import os
import plistlib
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

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args):return None

def settings():
    if stat.S_IMODE(CONFIG.stat().st_mode)&0o077: raise ValueError("Проверьте права файла конфигурации")
    conf=json.loads(CONFIG.read_text())
    from urllib.parse import urlsplit
    url=urlsplit(conf["worker"])
    if url.scheme!="https" or not url.hostname or url.username or url.password or url.path not in ("","/"): raise ValueError("Требуется HTTPS адрес Worker")
    if "key" not in conf:
        keychain=subprocess.run(["/usr/bin/security","find-generic-password","-s","mabetek-tenders.agent","-a","mabetek-tenders.agent","-w"],capture_output=True,text=True,timeout=30)
        if keychain.returncode: raise ValueError("Нет доступа к ключу агента в связке Вход")
        conf["key"]=keychain.stdout.strip()
    if len(conf["key"])<32: raise ValueError("Короткий ключ агента")
    return conf

def request(conf,path,data):
    req=urllib.request.Request(conf["worker"].rstrip("/")+"/agent/"+path,json.dumps(data).encode(),{"Authorization":"Bearer "+conf["key"],"Content-Type":"application/json"})
    with urllib.request.build_opener(NoRedirect()).open(req,timeout=30) as res: return json.load(res)

def tick(conf):
    status=request(conf,"heartbeat",{"free_bytes":shutil.disk_usage(CONFIG.parent).free})
    if status["paused"]:return
    job=request(conf,"claim",{})
    if not job:return
    card=job["card"]
    if job["op"].startswith("pdf/"):
        with tempfile.TemporaryDirectory() as td:
            out=Path(td)/"offer.pdf"
            terms=json.loads(job["input"])
            demo=any("демонстрацион" in str(terms.get(k,"")).lower() for k in ("terms","dates","validity","vat"))
            render(terms,out,template=conf["template"],demo=demo)
            req=urllib.request.Request(conf["worker"].rstrip("/")+"/agent/pdf",out.read_bytes(),{"Authorization":"Bearer "+conf["key"],"x-job":str(job["id"]),"x-lease":job["lease"],"Content-Type":"application/pdf"})
            with urllib.request.build_opener(NoRedirect()).open(req,timeout=50) as res:res.read()
        return
    verdict,reason=classify(card.get("title","")+" "+card.get("description",""),card.get("place",""))
    result="Предмет: "+card.get("title","не указано")+"\nОценка: "+verdict+" — "+reason+"\nПодтверждено: два пути 125 и 111 м, ПРР по заявке.\nСемье: доступна ли площадка в требуемые даты и какова ставка?\nЗаказчику: допускается ли площадка исполнителя на Батуевской Ветке, 19?\nОригинал: "+card["url"]
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
            print("Агент:",type(e).__name__,file=sys.stderr,flush=True)
            if args.once:raise SystemExit(1)
        if args.once:return
        time.sleep(45)

if __name__=="__main__":main()
