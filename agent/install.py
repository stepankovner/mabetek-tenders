"""Установка текущему пользователю macOS. Секрет читается из Keychain."""
import hashlib
import json
import os
import plistlib
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from .daemon import LABEL, request, settings

def main():
    os.umask(0o077)
    root=Path(__file__).resolve().parents[1]
    base=Path.home()/"Library/Application Support/mabetek-tenders"
    base.mkdir(parents=True,exist_ok=True)
    source=root.parent/"Мабетэк_Коммерческое_предложение.pdf"
    brand=base/"letterhead.pdf"
    if source.exists():shutil.copyfile(source,brand)
    if not brand.exists():raise SystemExit("Поместите исходное фирменное КП рядом с каталогом mabetek-tenders.")
    sources=sorted((root/"agent").glob("*.py"))
    digest=hashlib.sha256()
    for f in sources:digest.update(f.name.encode()+b'\0'+f.read_bytes())
    releases=base/"releases";releases.mkdir(exist_ok=True)
    release=releases/digest.hexdigest()[:16]
    if not release.exists():
        tmp=Path(tempfile.mkdtemp(dir=releases))
        try:
            (tmp/"agent").mkdir()
            for f in sources:shutil.copyfile(f,tmp/"agent"/f.name)
            tmp.rename(release)
        finally:
            if tmp.exists():shutil.rmtree(tmp)
    tess=root/".private/tessdata"
    if tess.is_dir():shutil.copytree(tess,base/"tessdata",dirs_exist_ok=True)
    conf=base/"agent.json"
    candidate=base/"agent.json.new"
    candidate.write_text(json.dumps({"worker":"https://mabetek-zakupki.flight-tracker.workers.dev","template":str(brand)},ensure_ascii=False))
    candidate.replace(conf)
    print("Проверяю доступ к ключу агента и связь с Worker.",flush=True)
    try:
        config=settings()
        request(config,"heartbeat",{"free_bytes":shutil.disk_usage(base).free})
    except Exception as e:
        raise SystemExit("Первичная проверка не прошла: "+type(e).__name__+". Проверьте связку ключей и интернет.") from None
    domain="gui/"+str(os.getuid())
    plist=Path.home()/"Library/LaunchAgents"/(LABEL+".plist")
    plist.parent.mkdir(parents=True,exist_ok=True)
    data={"Label":LABEL,"ProgramArguments":[sys.executable,"-m","agent.daemon"],"WorkingDirectory":str(release),"RunAtLoad":True,"KeepAlive":True,"ThrottleInterval":45,
          "EnvironmentVariables":{"TESSDATA_PREFIX":str(base/"tessdata")},"StandardErrorPath":str(base/"agent-error.log")}
    if plist.exists():
        old=plistlib.loads(plist.read_bytes())
        if old.get("Label")!=LABEL or not str(old.get("WorkingDirectory","")).startswith(str(releases)+"/"):
            raise SystemExit("Обнаружена другая конфигурация с таким именем.")
        if subprocess.run(["launchctl","print",domain+"/"+LABEL],capture_output=True).returncode==0:
            subprocess.run(["launchctl","bootout",domain+"/"+LABEL],check=True)
    staging=plist.with_suffix(".new");staging.write_bytes(plistlib.dumps(data));staging.replace(plist)
    subprocess.run(["launchctl","bootstrap",domain,str(plist)],check=True)
    subprocess.run(["launchctl","kickstart","-k",domain+"/"+LABEL],check=True)
    subprocess.run(["launchctl","print",domain+"/"+LABEL],check=True,stdout=subprocess.DEVNULL)
    print("Агент установлен. Первый контакт с Worker подтверждён. Статус доступен в Telegram.")

if __name__=="__main__":main()
