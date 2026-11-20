"""Локальное рабочее место для ручного разбора первичных документов."""
import argparse
import hashlib
import json
import os
import sqlite3
from pathlib import Path
from .pipeline import classify, extract, quote, render

ROOT=Path(__file__).resolve().parents[1]
def connection(path):
    path.parent.mkdir(parents=True,exist_ok=True)
    db=sqlite3.connect(path)
    db.row_factory=sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    version=db.execute("PRAGMA user_version").fetchone()[0]
    for file in sorted((ROOT/"migrations").glob("*.sql")):
        number=int(file.stem)
        if number>version:
            db.executescript("BEGIN;"+file.read_text()+f"\nPRAGMA user_version={number};COMMIT;")
    return db

def record(db, entry, docs):
    mandatory=("source","procedure","lot","url","title")
    if not all(isinstance(entry.get(k),str) and entry[k].strip() for k in mandatory): raise ValueError("Нужны " + ", ".join(mandatory))
    rows=[row for path in docs for row in extract(path)]
    body=dict(entry,attachments=[])
    for doc in docs:
        with open(doc,"rb") as f: body["attachments"].append(dict(name=Path(doc).name,sha256=hashlib.file_digest(f,"sha256").hexdigest()))
    canonical=json.dumps(["eis" if entry.get("eis") else entry["source"],entry.get("eis") or entry["procedure"],entry["lot"]],ensure_ascii=False,separators=(",",":"))
    payload=json.dumps(body,sort_keys=True,ensure_ascii=False)
    digest=hashlib.sha256(payload.encode()).hexdigest()
    db.execute("BEGIN IMMEDIATE")
    with db:
        existing=db.execute("SELECT l.id,l.revision,v.digest FROM lots l JOIN versions v ON l.id=v.lot AND l.revision=v.revision WHERE canonical=?",(canonical,)).fetchone()
        if existing and existing["digest"]==digest: return existing["id"],existing["revision"]
        rev=existing["revision"]+1 if existing else 1
        result,reason=classify(entry["title"]+" "+" ".join(r["text"] for r in rows),entry.get("place",""))
        lot=db.execute("INSERT INTO lots(canonical,procedure_no,lot_no,revision,deadline,status) VALUES(?,?,?,?,?,?) ON CONFLICT(canonical) DO UPDATE SET revision=excluded.revision,deadline=excluded.deadline,status=excluded.status RETURNING id",(canonical,entry["procedure"],entry["lot"],rev,entry.get("deadline"),result)).fetchone()[0]
        db.execute("INSERT INTO versions VALUES(?,?,?,?,unixepoch())",(lot,rev,digest,payload))
        db.execute("INSERT OR IGNORE INTO links VALUES(?,?,?)",(lot,entry["source"],entry["url"]))
        db.execute("INSERT INTO evidence VALUES(?,?,?,?,?)",(lot,rev,"отбор",reason,digest))
        db.executemany("INSERT INTO evidence VALUES(?,?,?,?,?)",[(lot,rev,r["file"]+" · "+r["location"],r["text"],r["sha256"]) for r in rows])
        db.execute("UPDATE offers SET state='устарело' WHERE lot=?",(lot,))
        return lot,rev

def main():
    os.umask(0o077)
    p=argparse.ArgumentParser()
    p.add_argument("--db",type=Path,default=Path.home()/"Library/Application Support/mabetek-tenders/local.sqlite")
    sub=p.add_subparsers(dest="op",required=True)
    imp=sub.add_parser("import");imp.add_argument("card",type=Path);imp.add_argument("docs",nargs="*",type=Path)
    sub.add_parser("inbox")
    show=sub.add_parser("show");show.add_argument("lot",type=int)
    save=sub.add_parser("answer");save.add_argument("lot",type=int);save.add_argument("revision",type=int);save.add_argument("terms",type=Path)
    for op in ("preview","issue"):
        cmd=sub.add_parser(op);cmd.add_argument("lot",type=int)
        if op=="issue":
            cmd.add_argument("--approve-digest",required=True);cmd.add_argument("--template",required=True,type=Path);cmd.add_argument("output",type=Path)
    backup=sub.add_parser("backup");backup.add_argument("output",type=Path)
    args=p.parse_args();db=connection(args.db)
    if args.op=="import": print(record(db,json.loads(args.card.read_text()),args.docs));return
    if args.op=="backup":
        if args.output.exists(): raise ValueError("Файл уже существует")
        with sqlite3.connect(args.output) as target: db.backup(target)
        return
    if args.op=="inbox":
        for r in db.execute("select id,procedure_no,lot_no,revision,status from lots order by id desc"): print(*r,sep=" | ")
        return
    lot=db.execute("SELECT l.*,v.payload FROM lots l JOIN versions v ON v.lot=l.id AND v.revision=l.revision WHERE l.id=?",(args.lot,)).fetchone()
    if not lot: raise ValueError("Лот отсутствует")
    key=("local",lot["id"],lot["revision"])
    if args.op=="show":
        print(lot["payload"],lot["status"])
        for r in db.execute("select location,text from evidence where lot=? and revision=?",key[1:]): print(*r,sep=" · ")
        return
    if args.op=="answer":
        if args.revision!=lot["revision"]: raise ValueError("Проверьте новую версию документов")
        terms=json.loads(args.terms.read_text())
        with db:
            db.execute("INSERT OR REPLACE INTO answers VALUES(?,?,?,'terms',?)",(*key,json.dumps(terms,ensure_ascii=False)))
        return
    saved=db.execute("select value from answers where owner=? and lot=? and revision=? and field='terms'",key).fetchone()
    if not saved: raise ValueError("Нет ответов по текущей версии")
    terms=json.loads(saved[0]);card=json.loads(lot["payload"])
    terms.update(customer=card.get("customer"),lot=lot["procedure_no"]+"/"+lot["lot_no"],confirmed=True)
    summary=json.dumps(quote(terms),ensure_ascii=False,sort_keys=True,indent=2)
    digest=hashlib.sha256((str(lot["revision"])+summary).encode()).hexdigest()
    if args.op=="preview": print(summary,digest);return
    if args.approve_digest!=digest: raise ValueError("Сводка изменилась")
    if args.output.exists(): raise ValueError("Выберите новое имя файла")
    render(terms,args.output,template=args.template)
    with db: db.execute("insert into offers(lot,revision,digest,state) values(?,?,?,'подготовлено локально')",(lot["id"],lot["revision"],digest))

if __name__=="__main__": main()
