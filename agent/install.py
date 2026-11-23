"""Установка текущему пользователю macOS. Секрет читается из Keychain."""
import filecmp
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

from .daemon import LABEL, request, settings

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
    def replace(payload):
        with tempfile.NamedTemporaryFile(dir=plist.parent, delete=False) as tmp:
            staged = Path(tmp.name)
            try:
                tmp.write(payload)
                tmp.flush()
                os.fsync(tmp.fileno())
                staged.replace(plist)
            finally:
                staged.unlink(missing_ok=True)

    # Prepare the login configuration while the previous service is still running.
    if desired != previous:
        replace(desired)
    if loaded().returncode == 0:
        try:
            subprocess.run(["launchctl", "bootout", target], check=True)
        except (OSError, subprocess.CalledProcessError):
            if previous is not None and previous != desired:
                replace(previous)
            raise
        for _ in range(30):
            if loaded().returncode != 0:
                break
            time.sleep(0.2)
        else:
            if previous is not None and previous != desired:
                replace(previous)
            raise RegistrationError("launchd пока завершает старую службу.")
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

def stage_release(root, releases):
    files = sorted((root / "agent").glob("*.py")) + sorted((root / "migrations").glob("*.sql"))
    files.extend(root / "tools" / name for name in ("eat_catalogue.mjs", "rts_catalogue.mjs", "otc_region.mjs"))
    files.extend((root / "src/core.mjs", root / "agent/eis-root.pem"))
    payload = [(f, f.relative_to(root)) for f in files]
    dependency = root / "node_modules/playwright-core"
    if not (dependency / "package.json").is_file():
        dependency = root.parent / "frontend/node_modules/playwright-core"
    if (dependency / "package.json").is_file():
        payload.extend((f, Path("node_modules/playwright-core") / f.relative_to(dependency))
                       for f in sorted(dependency.rglob("*")) if f.is_file())
    digest = hashlib.sha256()
    for src, relative in payload:
        digest.update(str(relative).encode() + b"\0" + hashlib.sha256(src.read_bytes()).digest())
    releases.mkdir(exist_ok=True)
    release = releases / digest.hexdigest()[:16]
    if release.is_dir():
        return release
    with tempfile.TemporaryDirectory(dir=releases) as temporary:
        stage = Path(temporary) / "payload"
        for src, relative in payload:
            dest = stage / relative
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dest)
        stage.rename(release)
    return release


def install_letterhead(source, brand):
    if not source.is_file():
        if brand.is_file():
            return
        raise SystemExit("Поместите исходное фирменное КП рядом с каталогом mabetek-tenders.")
    if brand.is_file() and filecmp.cmp(source, brand, shallow=False):
        return
    with tempfile.TemporaryDirectory(dir=brand.parent) as directory:
        staged = Path(directory) / "letterhead.pdf"
        shutil.copyfile(source, staged)
        staged.replace(brand)


def install_configuration(base, release, brand, domain, plist, data):
    conf = base / "agent.json"
    with tempfile.TemporaryDirectory(dir=base) as directory:
        candidate = Path(directory) / "agent.json"
        backup = Path(directory) / "previous.json"
        values = dict(worker="https://mabetek-zakupki.flight-tracker.workers.dev", template=str(brand),
                      eat_node=shutil.which("node"), eat_modules=str(release))
        if conf.exists():
            # Preserve a previously configured worker or an older private file-based key.
            previous = settings(conf)
            values["worker"] = previous["worker"]
            stored = json.loads(conf.read_text())
            if "key" in stored:
                values["key"] = stored["key"]
            shutil.copy2(conf, backup)
        candidate.write_text(json.dumps(values, ensure_ascii=False))
        verify_connection(candidate, base)
        candidate.replace(conf)
        try:
            register_agent(domain, plist, data)
        except (RegistrationError, OSError, subprocess.SubprocessError):
            if backup.exists():
                backup.replace(conf)
            else:
                conf.unlink(missing_ok=True)
            raise


def verify_connection(candidate, base):
    print("Проверяю доступ к ключу агента и связь с Worker.",flush=True)
    try:
        config=settings(candidate)
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


def main():
    os.umask(0o077)
    root=Path(__file__).resolve().parents[1]
    base=Path.home()/"Library/Application Support/mabetek-tenders"
    base.mkdir(parents=True,exist_ok=True)
    source=root.parent/"Мабетэк_Коммерческое_предложение.pdf"
    brand=base/"letterhead.pdf"
    install_letterhead(source, brand)
    releases = base / "releases"
    release = stage_release(root, releases)
    tess=root/".private/tessdata"
    if tess.is_dir():shutil.copytree(tess,base/"tessdata",dirs_exist_ok=True)
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
        install_configuration(base,release,brand,domain,plist,data)
    except RegistrationError as exc:
        raise SystemExit(str(exc)) from None
    print("Автозапуск зарегистрирован. Статус соединения доступен в Telegram по /status.")

if __name__=="__main__":main()
