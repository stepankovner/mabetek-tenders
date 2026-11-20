"""Compare frozen title decisions with independently saved responses, preserving missing IDs."""
import collections
import json
import re
from pathlib import Path
from .archive_v3 import load

def compare(root):
    cards={r['id']:r for r in load(root/'v3-held-out.jsonl')}
    predictions={r['id']:r['title_match'] for r in load(root/'v3-title-results.jsonl')}
    if predictions.keys()!=cards.keys():
        raise ValueError('Результаты фильтра не совпадают с манифестом')
    result={}
    for path in sorted((root/'v3-review').glob('response-*.txt')):
        prompt=(path.parent/path.name.replace('response','prompt')).read_text()
        batch={json.loads(line)['id'] for line in prompt.splitlines() if line.startswith('{"id"')}
        for line in path.read_text().splitlines():
            fields=[field.strip().strip('*`') for field in line.strip().strip('|').split('|')]
            if len(fields)<3:
                continue
            key=re.sub(r'^\s*(?:\d+[.)]\s*)?','',fields[0])
            if key not in batch:
                linked=[k for k in batch if fields[-1].rstrip(' .')==cards[k]['url'] and key==k.split('/')[1]]
                if len(linked)==1:key=linked[0]
            label=fields[1].lower()
            if key not in batch or label not in ('рассмотреть','нужно уточнение','отклонить','недостаточно данных'):
                continue
            if key in result and result[key]!=label:raise ValueError('Противоречивый ответ '+key)
            result[key]=label
    comparison=[dict(id=k,title_match=predictions[k],independent=result.get(k)) for k in cards]
    output=root/'v3-comparison.jsonl'
    output.write_text(''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in comparison))
    print('Результаты по ID:',len(result),'из',len(cards))
    print('Фильтр, класс, количество:',dict(collections.Counter((r['title_match'],r['independent']) for r in comparison)))

if __name__=='__main__':
    compare(Path(__file__).resolve().parents[1]/'reports/archive')
