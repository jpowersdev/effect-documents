#!/usr/bin/env bash
set -euo pipefail

documents_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
consumer_dir="$(mktemp -d "${TMPDIR:-/tmp}/effect-documents.XXXXXX")"
trap 'rm -rf "$consumer_dir"' EXIT

pnpm --dir "$documents_root" --filter @jpowersdev/effect-documents build
pnpm --dir "$documents_root" --filter @jpowersdev/effect-documents pack --pack-destination "$consumer_dir"

# Only built modules ship, and nothing but the package's own public surface resolves.
documents_tarball="$consumer_dir/jpowersdev-effect-documents-0.1.0.tgz"
packed="$(tar -tzf "$documents_tarball")"
for module in Actor Document Documents DocumentStorage Revision SqlDocumentStorage Thread index; do
  grep -qx "package/dist/$module.js" <<<"$packed" || { echo "missing dist/$module.js"; exit 1; }
  grep -qx "package/dist/$module.d.ts" <<<"$packed" || { echo "missing dist/$module.d.ts"; exit 1; }
done
if grep -E '^package/(test|typetest|examples|scripts)/' <<<"$packed"; then
  echo "development files were packed"
  exit 1
fi

cat > "$consumer_dir/package.json" <<'JSON'
{
  "private": true,
  "type": "module",
  "dependencies": {
    "@jpowersdev/effect-documents": "file:./jpowersdev-effect-documents-0.1.0.tgz",
    "@jpowersdev/effect-delta": "0.1.0",
    "@effect/platform-node": "4.1.1",
    "@effect/sql-sqlite-node": "4.1.1",
    "effect": "4.1.1"
  }
}
JSON
cat > "$consumer_dir/pnpm-workspace.yaml" <<'YAML'
minimumReleaseAgeExclude:
  - '@jpowersdev/effect-delta@0.1.0'
YAML
cat > "$consumer_dir/tsconfig.json" <<'JSON'
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023", "ESNext.Disposable", "DOM"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": false,
    "noEmit": true
  },
  "include": ["types.ts"]
}
JSON
cp "$documents_root/test/consumer/smoke.mjs" "$consumer_dir/smoke.mjs"
cp "$documents_root/test/consumer/types.ts" "$consumer_dir/types.ts"
pnpm --dir "$consumer_dir" install --ignore-scripts --lockfile=false
pnpm --dir "$documents_root" exec tsc -p "$consumer_dir/tsconfig.json"
node "$consumer_dir/smoke.mjs"

# Internal modules stay private, and each public module resolves on its own.
cd "$consumer_dir"
node --input-type=module -e '
  import assert from "node:assert/strict"
  await assert.rejects(import("@jpowersdev/effect-documents/internal/patch"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" })
  await assert.rejects(import("@jpowersdev/effect-documents/index"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" })
  const { layerStorage } = await import("@jpowersdev/effect-documents/SqlDocumentStorage")
  assert.equal(typeof layerStorage, "function")
'

# Every example in the docs and examples/, as a reader would paste it.
node "$documents_root/scripts/doc-examples.mjs" "$documents_root" "$consumer_dir/examples"
cp "$documents_root"/examples/*.ts "$consumer_dir/examples/"
cd "$consumer_dir/examples"
for example in *.ts; do
  echo "--- $example"
  timeout 60 node "$example" > /dev/null || { echo "failed: $example"; exit 1; }
done
echo "All examples ran."
