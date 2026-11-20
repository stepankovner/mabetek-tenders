"""Установка текущему пользователю macOS. Секрет читается из Keychain."""
import hashlib
import json
import os
import plistlib
import shutil
import subprocess
import sys
import time
import tempfile
import urllib.error
import ssl
from pathlib import Path

from .daemon import LABEL, request, settings, tick

class RegistrationError(RuntimeError):
    pass


def register_agent(domain, plist, data):
    target=domain+"/"+LABEL
    def loaded():
        return subprocess.run(["launchctl","print",target],capture_output=True,text=True)
    def running_expected():
        state=loaded()
        return state.returncode==0 and ("working directory = "+data["WorkingDirectory"]+"\n") in state.stdout
    previous=plist.read_bytes() if plist.exists() else None
    desired=plistlib.dumps(data)
    if previous==desired and running_expected():
        return
    if loaded().returncode==0:
        subprocess.run(["launchctl","bootout",target],check=True)
        for _ in range(30):
            if loaded().returncode!=0:break
            time.sleep(0.2)
        else:
            raise SystemExit("launchd пока завершает старую службу. Конфигурация сохранена.")
    def replace(payload):
        with tempfile.NamedTemporaryFile(dir=plist.parent,delete=False) as tmp:
            tmp.write(payload)
        Path(tmp.name).replace(plist)
    if desired!=previous:
        replace(desired)
    for delay in (0.5,1,2,4,8):
        time.sleep(delay)
        run=subprocess.run(["launchctl","bootstrap",domain,str(plist)],capture_output=True,text=True)
        if running_expected():return
        if run.returncode not in (0,5):break
    if previous and previous!=desired:
        if loaded().returncode!=0:
            replace(previous)
            subprocess.run(["launchctl","bootstrap",domain,str(plist)],capture_output=True)
    raise RegistrationError("launchd не подтвердил регистрацию пользовательской службы. Код bootstrap: "+str(run.returncode)+". Проверьте разрешение фоновой работы для Python в настройках macOS.")

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
    except (ValueError, OSError, subprocess.SubprocessError) as exc:
        if isinstance(exc, urllib.error.HTTPError):
            layer = "Приложение" if exc.headers.get_content_type()=="application/json" else "Шлюз"
            reason = f"{layer} вернул HTTP {exc.code}."
        elif isinstance(exc, urllib.error.URLError):
            reason = ("Не удалось проверить сертификат HTTPS." if isinstance(exc.reason, ssl.SSLError)
                      else "Не удалось соединиться с Worker: "+type(exc.reason).__name__+".")
        elif isinstance(exc, ValueError):
            reason = str(exc)
        else:
            reason = type(exc).__name__
        (base/"install-status.txt").write_text(reason+"\n")
        if isinstance(exc, urllib.error.HTTPError) or not isinstance(exc, urllib.error.URLError):
            raise SystemExit("Первичная проверка: "+reason) from None
        print(reason+" Агент повторит подключение после запуска.",flush=True)
    else:
        (base/"install-status.txt").write_text("Первый контакт с Worker подтверждён.\n")
    domain="gui/"+str(os.getuid())
    plist=Path.home()/"Library/LaunchAgents"/(LABEL+".plist")
    plist.parent.mkdir(parents=True,exist_ok=True)
    data={"Label":LABEL,"ProgramArguments":[sys.executable,"-m","agent.daemon"],"WorkingDirectory":str(release),"RunAtLoad":True,"KeepAlive":True,"ThrottleInterval":45,
          "EnvironmentVariables":{"TESSDATA_PREFIX":str(base/"tessdata")},"StandardErrorPath":str(base/"agent-error.log")}
    if plist.exists():
        old=plistlib.loads(plist.read_bytes())
        if old.get("Label")!=LABEL or not str(old.get("WorkingDirectory","")).startswith(str(releases)+"/"):
            raise SystemExit("Обнаружена другая конфигурация с таким именем.")
    try:
        register_agent(domain,plist,data)
    except RegistrationError as exc:
        print(str(exc),flush=True)
        if subprocess.run(["launchctl","print",domain+"/"+LABEL],capture_output=True).returncode==0:
            raise SystemExit("Обнаружена зарегистрированная служба. Проверьте её рабочую версию.") from None
        print("Выполняю один цикл уже установленного агента в текущем окне.",flush=True)
        try:
            tick(settings())
        except (OSError,ValueError,KeyError) as err:
            print("Цикл не завершён:",type(err).__name__,flush=True)
        raise SystemExit("Автозапуск не подтверждён. Файл службы сохранён для следующего входа в macOS.") from None
    print("Автозапуск зарегистрирован. Статус соединения доступен в Telegram по /status.")

if __name__=="__main__":main()
