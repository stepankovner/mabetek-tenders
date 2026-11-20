#!/bin/zsh
set -eu
cd "${0:A:h}"
export CLOUDFLARE_ACCOUNT_ID=c9a963f743353c47b62e1aa80fd343e7
export WRANGLER_SEND_METRICS=false
mkdir -p .private
umask 077
python3 -m unittest discover -s tests
if [[ -x ../frontend/node_modules/.bin/tsc ]]; then
  export TSC="$PWD/../frontend/node_modules/.bin/tsc"
  node --test tests/*.mjs tests/integration.cjs
else
  npx --yes --package typescript@5.9.3 -c 'node --test tests/*.mjs tests/integration.cjs'
fi
set -o pipefail
npx --yes wrangler@4 d1 execute mabetek-tenders --remote --file migrations/0003.sql
revision=$(git rev-parse --short=12 HEAD)
npx --yes wrangler@4 deploy --var "RELEASE:$revision" --name mabetek-zakupki --keep-vars 2>&1 | tee .private/deploy-latest.log

python3 - "$revision" <<'PYTHON'
import json,sys,time,urllib.request
from agent.daemon import request,settings,USER_AGENT
conf=settings()
for attempt in range(6):
    try:
        health=urllib.request.Request(conf['worker']+'/health',headers={'User-Agent':USER_AGENT})
        with urllib.request.urlopen(health,timeout=12) as response:
            if json.load(response).get('release')==sys.argv[1]:
                break
    except OSError:
        pass
    time.sleep(3)
else:
    raise SystemExit('Новая версия пока не подтверждена по /health.')
# Store only the safe source summary. No access key or owner messages are written.
status=request(conf,'check',{})
from pathlib import Path
Path('.private/live-sources.json').write_text(json.dumps(status,ensure_ascii=False,indent=2))
for row in status['sources']:
    print(row['id'],row['last_error'] or 'Выдача прочитана')
PYTHON
