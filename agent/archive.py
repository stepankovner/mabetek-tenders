"""Prepare reproducible time-separated manifests of publicly verified lot numbers."""
import hashlib
import json
import re
from pathlib import Path

CUTOFF='2026-08-20'

def normalize(value):
    return re.sub(r'[^а-яa-z0-9]+',' ',value.casefold().replace('ё','е')).strip()

def split_lots(cards, registers, fields):
    registers={r['url']:r for r in registers}
    fields={r['id']:r for r in fields}
    rows,missing=[],[]
    for card in cards:
        code=card['id']
        facts=fields.get(code,{})
        register=registers.get(card['url'],{})
        lots=register.get('lots') or []
        if not lots or register.get('state')!='verified':
            missing.append(dict(procedure=code,url=card['url'],reason=register.get('state','not-checked')))
            continue
        org=normalize(facts.get('organizer') or '')
        subject=normalize(card['title'])
        group=org+'|'+subject if org and subject else 'procedure|'+code
        for lot in lots:
            rows.append(dict(id='b2b/'+code+'/'+lot['lot'],procedure=code,lot=lot['lot'],group=group,
                         published=card['published'],subject=lot['subject'],procedure_title=card['title'],
                         organizer=facts.get('organizer'),price=lot['price'],deadline=facts.get('deadline_local'),
                         url=card['url']+'?action=positions_groups'))
    keys=[r['id'] for r in rows]
    if len(set(keys))!=len(keys):
        raise ValueError('Повтор номера лота в процедуре')
    late={r['group'] for r in rows if r['published']>=CUTOFF}
    ordered=sorted(rows,key=lambda r:(r['published'],r['id']))
    return [r for r in ordered if r['group'] not in late],[r for r in ordered if r['group'] in late],missing

def prepare(root):
    def load(name):
        return [json.loads(l) for l in (root/name).read_text().splitlines() if l]
    groups=split_lots(load('catalogue.jsonl'),load('lot-register.jsonl'),load('published-fields.jsonl'))
    for name,rows in zip(['development','held-out','unresolved'],groups):
        data=''.join(json.dumps(r,ensure_ascii=False,sort_keys=True)+'\n' for r in rows).encode()
        output=root/(name+'.jsonl')
        if output.exists() and output.read_bytes()!=data:
            raise ValueError('Существующий манифест отличается: '+name)
        if not output.exists():
            output.write_bytes(data)
        print(name,len(rows),hashlib.sha256(data).hexdigest())

if __name__=='__main__':
    prepare(Path(__file__).resolve().parents[1]/'reports/archive')
