"""Локальная обработка документов и подготовка предложения без сетевых запросов."""
import hashlib
import io
import os
import re
import zipfile
from decimal import Decimal, ROUND_HALF_UP
from html import escape
from pathlib import Path, PurePosixPath
from xml.etree import ElementTree as ET

import pymupdf
from .ocr import recognize

MAX_BYTES = 32 * 1024 * 1024
SERVICE = re.compile(r"тупик|пут[ьи].{0,18}необщего|постановк.{0,20}вагон|прием.{0,26}(?:вагон|железнодорож)|перевалк|(?:выгрузк|погрузк).{0,40}(?:вагон|груз)|склад.{0,30}(?:подъездн|железнодорож|жд)|перегрузк|\bпрр\b")
MIXED = re.compile(r"топлив|опасн.{0,12}груз|локомотив|транспортировк|перевозк")

def classify(title, place):
    text = re.sub(r"ж\s*[/.-]\s*д", "жд", title.lower().replace("ё","е"))
    match = SERVICE.search(text)
    if not match:
        if re.search(r"ремонт|закупка вагонов|поставка вагонов", text):
            return "отклонить", "Предмет закупки вне профиля"
        return "недостаточно исходных данных", "Требуется проверка документации"
    if re.search(r"\bванино\b|владивосток|комсомольск-на-амуре",place.lower()):
        return "отклонить", "Указано иное место исполнения: " + place
    if MIXED.search(text) or not re.search(r"\bхабаровск(?:е)?\b",place.lower()):
        return "нужно уточнение", "Уточнить площадку и состав обязательных услуг"
    return "рассмотреть", match.group()

def extract(path):
    path = Path(path)
    if path.stat().st_size > MAX_BYTES: raise ValueError("Слишком большой файл")
    return _extract(path.name,path.read_bytes(),0,[MAX_BYTES])

def _extract(name, data, depth, budget):
    digest=hashlib.sha256(data).hexdigest()
    def row(loc,text,ocr=False):
        return dict(file=name,sha256=digest,location=loc,text=text,ocr=ocr)
    ext=Path(name).suffix.lower()
    if ext==".pdf":
        rows=[]
        with pymupdf.open(stream=data,filetype="pdf") as pdf:
            if len(pdf)>250: raise ValueError("Слишком много страниц")
            for n,p in enumerate(pdf,1):
                text=p.get_text().strip()
                if not text:
                    try: text=recognize(p)
                    except RuntimeError as e: raise ValueError(f"Нужен OCR rus+eng, страница {n}") from e
                    rows.append(row(f"страница {n}",text,True))
                else: rows.append(row(f"страница {n}",text))
        return rows
    if ext not in (".zip",".xlsx",".docx"): raise ValueError("Неподдерживаемый формат: "+ext)
    rows=[]
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        entries=z.infolist()
        if len(entries)>1500 or depth>2: raise ValueError("Лимит вложений")
        for entry in entries:
            path=PurePosixPath(entry.filename.replace("\\","/"))
            if path.is_absolute() or ".." in path.parts or entry.flag_bits & 1: raise ValueError("Небезопасное вложение")
        budget[0]-=sum(e.file_size for e in entries)
        if budget[0]<0: raise ValueError("Лимит распаковки")
        def xml(key):
            raw=z.read(key)
            if b"<!DOCTYPE" in raw.upper(): raise ValueError("DTD запрещён")
            return ET.fromstring(raw)
        def texts(node): return "".join(t.text or "" for t in node.findall(".//{*}t"))
        if ext==".docx":
            for n,p in enumerate(xml("word/document.xml").iterfind(".//{*}p"),1):
                if texts(p): rows.append(row(f"абзац {n}",texts(p)))
        elif ext==".xlsx":
            shared=[texts(s) for s in xml("xl/sharedStrings.xml")] if "xl/sharedStrings.xml" in z.namelist() else []
            rels={r.get("Id"):r.get("Target") for r in xml("xl/_rels/workbook.xml.rels")}
            for sheet in xml("xl/workbook.xml").findall(".//{*}sheet"):
                key=rels[next(v for k,v in sheet.attrib.items() if k.endswith("}id"))]
                key=key.lstrip("/") if key.startswith("/") else "xl/"+key
                for c in xml(key).findall(".//{*}c"):
                    value=c.findtext("{*}v","")
                    if c.get("t")=="s": value=shared[int(value)]
                    if c.get("t")=="inlineStr": value=texts(c)
                    if value: rows.append(row(sheet.get("name")+"!"+c.get("r"),value))
        else:
            for entry in entries:
                if not entry.is_dir():
                    rows.extend(_extract(name+"/"+entry.filename,z.read(entry),depth+1,budget))
    return rows

def number(value, fractional):
    s=str(value).replace(",",".")
    if not re.fullmatch(r"[0-9]{1,12}(?:\.[0-9]{1,"+str(fractional)+r"})?",s) or Decimal(s)<=0:
        raise ValueError("Требуется положительное число допустимой точности")
    return Decimal(s)

def quote(data):
    for key in ("customer","lot","vat","terms","dates","validity"):
        if not isinstance(data.get(key),str) or not data[key].strip(): raise ValueError("Заполните "+key)
    if data.get("confirmed") is not True or not data.get("items"): raise ValueError("Требуется подтверждение условий")
    if data.get("unable") or data.get("stale"): raise ValueError("Условия требуют пересмотра")
    if data.get("currency","RUB")!="RUB": raise ValueError("Поддерживаются рубли")
    total=Decimal(0)
    lines=[]
    for item in data["items"]:
        if not item.get("service") or not item.get("unit"): raise ValueError("Нужны услуга и единица")
        amount=(number(item.get("rate"),2)*number(item.get("qty"),3)).quantize(Decimal(".01"),rounding=ROUND_HALF_UP)
        total+=amount
        lines.append(dict(item,amount=str(amount)))
    return dict(data,items=lines,total=str(total))

def render(data, output, *, demo=False, template=None):
    q=quote(data)
    if not demo and not template: raise ValueError("Требуется фирменный бланк")
    def h(s): return escape(str(s))
    rows="".join("<tr>"+"".join("<td>"+h(i[k])+"</td>" for k in ("service","qty","unit","rate","amount"))+"</tr>" for i in q["items"])
    title="Демонстрационный пример КП" if demo else "Коммерческое предложение"
    html=f"<h2>{title}</h2><p>Заказчик: {h(q['customer'])}<br>Лот: {h(q['lot'])}</p><table><tr><th>Услуга</th><th>Количество</th><th>Ед.</th><th>Цена, ₽</th><th>Сумма, ₽</th></tr>{rows}</table><h3>Итого {q['total']} ₽</h3><p>{h(q['vat'])}</p>"
    for k,label in (("dates","Срок исполнения"),("terms","Условия оплаты"),("validity","Предложение действует")):
        html+="<p>"+label+": "+h(q[k])+"</p>"
    story=pymupdf.Story(html=html,user_css="body{font-family:sans-serif;font-size:11pt}td,th{padding:4pt;border-bottom:1px solid #999}")
    buf=io.BytesIO()
    writer=pymupdf.DocumentWriter(buf)
    more=True
    while more:
        device=writer.begin_page(pymupdf.paper_rect("a4"))
        more,_=story.place(pymupdf.Rect(44,75,550,690))
        story.draw(device)
        writer.end_page()
    writer.close()
    with pymupdf.open(stream=buf.getvalue(),filetype="pdf") as pdf:
        if template:
            with pymupdf.open(template) as brand:
                original=brand[0]
                original.add_redact_annot(pymupdf.Rect(0,52,original.rect.width,708),fill=(1,1,1))
                original.apply_redactions()
                for page in pdf:
                    page.show_pdf_page(page.rect,brand,0,overlay=False)
        pdf.save(output)
