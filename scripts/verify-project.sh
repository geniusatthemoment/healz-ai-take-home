#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

required_files=(
  "app.json"
  "assets/icon.png"
  "assets/android-icon-foreground.png"
  "assets/android-icon-monochrome.png"
  "assets/splash-heart.png"
  "plugins/withAndroidShareTarget.js"
)

for file in "${required_files[@]}"; do
  if [[ ! -f "$file" ]]; then
    echo "Missing required project file: $file" >&2
    exit 1
  fi
done

node <<'NODE'
const fs = require('fs');
const config = JSON.parse(fs.readFileSync('app.json', 'utf8')).expo;

if (config.scheme !== 'healz') {
  throw new Error('Expected the healz:// URL scheme');
}

if (config.android?.package !== 'ai.healz.mobile') {
  throw new Error('Unexpected Android package name');
}

const splash = config.plugins?.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-splash-screen');
if (!splash || splash[1]?.image !== './assets/splash-heart.png') {
  throw new Error('Splash configuration must use the transparent heart asset');
}
NODE

npx tsc --noEmit
npx expo-doctor

echo "Project verification passed."
