#!/usr/bin/env bash
set -euo pipefail

documents_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
delta_root="${EFFECT_DELTA_ROOT:-$documents_root/../effect-delta}"
consumer_dir="$(mktemp -d "${TMPDIR:-/tmp}/effect-documents.XXXXXX")"
trap 'rm -rf "$consumer_dir"' EXIT

pnpm --dir "$delta_root" --filter effect-delta build
pnpm --dir "$delta_root" --filter effect-delta pack --pack-destination "$consumer_dir"
pnpm --dir "$documents_root" --filter effect-documents build
pnpm --dir "$documents_root" --filter effect-documents pack --pack-destination "$consumer_dir"

# Only built modules ship, and nothing but the package's own public surface resolves.
documents_tarball="$consumer_dir/effect-documents-0.1.0.tgz"
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
    "effect-documents": "file:./effect-documents-0.1.0.tgz",
    "effect-delta": "file:./effect-delta-0.1.0.tgz",
    "effect": "4.0.6"
  }
}
JSON
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
  await assert.rejects(import("effect-documents/internal/patch"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" })
  await assert.rejects(import("effect-documents/index"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" })
  const { layerStorage } = await import("effect-documents/SqlDocumentStorage")
  assert.equal(typeof layerStorage, "function")
'
