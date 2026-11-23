#!/usr/bin/env bash
# Print only the verified bundle identifier to stdout for the caller's health check.
set -euo pipefail
bundle_dir=$(mktemp -d)
trap 'rm -rf "$bundle_dir"' EXIT
wrangler=(npx --yes wrangler@4.165.0 --config "$PWD/wrangler.toml")
"${wrangler[@]}" deploy --dry-run --outdir "$bundle_dir" >&2
module="$bundle_dir/worker.js"
digest=$(shasum -a 256 "$module")
revision=${digest:0:12}
deploy=(deploy "$module" --no-bundle --var "RELEASE:$revision" --name mabetek-zakupki --keep-vars)
preview=$("${wrangler[@]}" "${deploy[@]}" --dry-run 2>&1) || { printf '%s\n' "$preview" >&2; exit 1; }
printf '%s\n' "$preview" >&2
if ! grep -Eq 'env\.DB \(mabetek-tenders\)' <<<"$preview" || ! grep -Eq 'env\.AI[[:space:]]+AI' <<<"$preview"; then
  echo "Wrangler не подтвердил привязки D1 и AI. Выпуск остановлен." >&2
  exit 1
fi
for migration in migrations/000{3,4,5,6}.sql; do
  "${wrangler[@]}" d1 execute mabetek-tenders --remote --yes --file "$migration" >&2
done
"${wrangler[@]}" "${deploy[@]}" >&2
printf '%s\n' "$revision"
