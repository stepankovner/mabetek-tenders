"""Fill unambiguous blank fields in the buyer's original DOCX/XLSX packages."""
import io
import re
import zipfile
from collections import Counter
from pathlib import PurePosixPath
from xml.dom import minidom

LIMIT = 32 * 1024 * 1024
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
X = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
LABELS = {
    "номер лота": "lot", "лот №": "lot", "наименование услуги": "service",
    "наименование услуг": "service", "количество": "qty", "единица измерения": "unit",
    "цена за единицу, руб.": "rate", "цена за единицу": "rate",
    "условия оплаты": "terms", "срок действия предложения": "validity",
    "срок оказания услуг": "dates", "сроки оказания услуг": "dates",
    "ставка ндс, %": "vat_percent", "ставка ндс (%)": "vat_percent",
    "режим ндс": "vat", "адрес заказчика": "manual", "инн": "manual",
    "кпп": "manual", "огрн": "manual", "подпись": "manual",
    "наименование участника": "manual", "наименование поставщика": "manual",
    "фио": "manual", "место оказания услуг": "manual",
}
BLANK = re.compile(r"^(?:[_\s]+|\.{3,})?$")
FORM_NAME = re.compile(r"форм[аы]|бланк|предложени[ея]|заявк[аи]|анкет|таблиц", re.I)


def xml(data):
    if b"<!DOCTYPE" in data.upper().replace(b"\0", b""):
        raise ValueError("DTD запрещён")
    return minidom.parseString(data)


def children(node, ns, local):
    return [child for child in node.childNodes
            if child.nodeType == child.ELEMENT_NODE and child.namespaceURI == ns and child.localName == local]


def content(node):
    return "".join(child.data if child.nodeType in (child.TEXT_NODE, child.CDATA_SECTION_NODE)
                   else content(child) for child in node.childNodes)


def tag(doc, ns, local, context):
    return doc.createElementNS(ns, f"{context.prefix}:{local}" if context.prefix else local)


def key(label):
    label = " ".join(label.casefold().replace("ё", "е").split()).rstrip(":").strip()
    normalized = re.sub(r"\s*(?:\*|\(обязательно\))$", "", label).rstrip(":").strip()
    return LABELS.get(normalized) or ("manual" if re.search(r"обязательн|\*", label) else None)


def inspect_package(data, suffix, values=None):
    """Return field inventory and a new archive only if something was filled."""
    changed = {}
    slots = []
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        infos = archive.infolist()
        names = [item.filename for item in infos]
        if (len(infos) > 1500 or len(set(names)) != len(names) or
                sum(x.file_size for x in infos) > LIMIT):
            raise ValueError("Лимит или неоднозначный состав бланка")
        for item in infos:
            path = PurePosixPath(item.filename)
            lower = item.filename.casefold()
            if (path.is_absolute() or ".." in path.parts or "\\" in item.filename or item.flag_bits & 1
                    or "vbaproject" in lower or "/embeddings/" in lower or "/activex/" in lower
                    or lower.startswith("xl/externallinks/")):
                raise ValueError("Небезопасная структура бланка")
        if suffix == ".docx":
            files = ["word/document.xml"]
            shared = []
        elif suffix == ".xlsx":
            files = [n for n in names if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n)]
            shared = ([content(node) for node in xml(archive.read("xl/sharedStrings.xml")).getElementsByTagNameNS(X, "si")]
                      if "xl/sharedStrings.xml" in names else [])
        else:
            raise ValueError("Формат бланка не поддерживается")
        for path in files:
            doc = xml(archive.read(path))
            ns, row_name, cell_name = (W, "tr", "tc") if suffix == ".docx" else (X, "row", "c")
            for row in doc.getElementsByTagNameNS(ns, row_name):
                cells = children(row, ns, cell_name)
                for label_cell, target in zip(cells, cells[1:]):
                    if suffix == ".docx":
                        label = " ".join(content(n) for n in label_cell.getElementsByTagNameNS(W, "t"))
                        existing = "".join(content(n) for n in target.getElementsByTagNameNS(W, "t"))
                        complex_cell = any(target.getElementsByTagNameNS(W, n)
                                           for n in ("tbl", "sdt", "drawing", "fldChar", "instrText", "gridSpan", "vMerge"))
                    else:
                        label = cell_text(label_cell, shared)
                        existing = cell_text(target, shared)
                        complex_cell = (not consecutive(label_cell, target)
                                        or bool(children(target, X, "f"))
                                        or bool(doc.getElementsByTagNameNS(X, "mergeCell")
                                                or doc.getElementsByTagNameNS(X, "sheetProtection")))
                    field = key(label)
                    if field:
                        slots.append((label.strip()[:100], field, doc, path, target,
                                      bool(BLANK.fullmatch(existing)) and not complex_cell))
        multiplicity = Counter(field for _, field, _, _, _, blank in slots if blank)
        inventory = []
        for label, field, doc, path, target, blank in slots:
            editable = blank and field != "manual" and multiplicity[field] == 1
            inventory.append({"label": label, "field": field, "fillable": editable})
            value = (values or {}).get(field) if editable else None
            if value:
                if suffix == ".docx":
                    put_word(doc, target, str(value))
                else:
                    put_sheet(doc, target, str(value), field)
                changed[path] = doc
        if not changed:
            return inventory[:40], None
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as target:
            for item in infos:
                target.writestr(item, changed[item.filename].toxml(encoding="UTF-8")
                                if item.filename in changed else archive.read(item))
        return inventory[:40], output.getvalue()


def cell_text(cell, shared):
    values = children(cell, X, "v")
    value = content(values[0]) if values else ""
    if cell.getAttribute("t") == "s":
        return shared[int(value)] if value.isdecimal() and int(value) < len(shared) else ""
    if cell.getAttribute("t") == "inlineStr":
        return "".join(content(n) for n in cell.getElementsByTagNameNS(X, "t"))
    return value


def consecutive(left, right):
    def column(cell):
        match = re.fullmatch(r"([A-Z]{1,3})(\d+)", cell.getAttribute("r"))
        if not match:
            return None
        value = 0
        for letter in match[1]:
            value = value * 26 + ord(letter) - 64
        return value, match[2]
    a, b = column(left), column(right)
    return bool(a and b and a[1] == b[1] and b[0] == a[0] + 1)


def put_word(doc, cell, value):
    existing = cell.getElementsByTagNameNS(W, "t")
    if existing:
        node = existing[0]
        for old in existing:
            while old.firstChild:
                old.removeChild(old.firstChild)
    else:
        paragraphs = children(cell, W, "p")
        paragraph = paragraphs[0] if paragraphs else cell.appendChild(tag(doc, W, "p", cell))
        run = paragraph.appendChild(tag(doc, W, "r", cell))
        node = run.appendChild(tag(doc, W, "t", cell))
    node.appendChild(doc.createTextNode(value))


def put_sheet(doc, cell, value, field):
    for node in children(cell, X, "v") + children(cell, X, "is"):
        cell.removeChild(node)
    if field in ("qty", "rate") and re.fullmatch(r"\d{1,9}(?:\.\d{1,3})?", value):
        cell.setAttribute("t", "n")
        cell.appendChild(tag(doc, X, "v", cell)).appendChild(doc.createTextNode(value))
        return
    cell.setAttribute("t", "inlineStr")
    inline = cell.appendChild(tag(doc, X, "is", cell))
    inline.appendChild(tag(doc, X, "t", cell)).appendChild(doc.createTextNode(value))


def approved_values(terms):
    item = terms["items"][0]
    vat = terms["vat"]
    percent = re.fullmatch(r"(?:НДС\s+)?(\d{1,3}(?:[.,]\d{1,2})?)\s*%", vat.strip(), re.I)
    return {**{k: str(item[k]) for k in ("service", "qty", "unit", "rate")},
            **{k: str(terms[k]) for k in ("terms", "dates", "validity", "vat")},
            "lot": terms["lot"].rsplit("/", 1)[-1],
            "vat_percent": percent[1] if percent and float(percent[1].replace(",", ".")) <= 100 else ""}
