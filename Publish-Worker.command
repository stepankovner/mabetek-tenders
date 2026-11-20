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
npx --yes wrangler@4 d1 execute mabetek-tenders --remote --yes --file migrations/0003.sql
npx --yes wrangler@4 d1 execute mabetek-tenders --remote --yes --file migrations/0004.sql
revision=$(git rev-parse --short=12 HEAD)
npx --yes wrangler@4 deploy --var "RELEASE:$revision" --name mabetek-zakupki --keep-vars 2>&1 | tee .private/deploy-latest.log

python3 -m agent.deployment_check "$revision"
