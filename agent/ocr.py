import os
import re
from pathlib import Path
import pymupdf

def recognize(page):
    default=Path(__file__).resolve().parents[1]/".private/tessdata"
    root=os.environ.get("TESSDATA_PREFIX") or (str(default) if default.is_dir() else None)
    if root is None:
        root=pymupdf.get_tessdata()
    if page.rect.width*page.rect.height>4_000_000: raise ValueError("Страница превышает лимит площади")
    best=""
    best_score=-1
    for angle in (0,90,180,270):
        pix=page.get_pixmap(matrix=pymupdf.Matrix(2,2).prerotate(angle),alpha=False)
        data=pix.pdfocr_tobytes(language="rus+eng",tessdata=root)
        with pymupdf.open(stream=data,filetype="pdf") as doc: text=doc[0].get_text().strip()
        words=re.findall(r"[а-яА-ЯёЁ]{3,}",text)
        common=re.findall(r"вагон|склад|услуг|цена|хабаровск|срок|работ|договор|руб|постав|заказ|количеств",text.lower())
        score=sum(len(w) for w in words)+sum(len(w) for w in common)*3
        if score>best_score: best,best_score=text,score
    if not best: raise ValueError("OCR не распознал текст")
    return best
