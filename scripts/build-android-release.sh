#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# AGP currently fails during native configuration on the JDK 25 bundled with
# some Android Studio releases. Prefer a locally installed JDK 21 when found.
if [[ -z "${JAVA_HOME:-}" && -x "/opt/homebrew/opt/openjdk@21/bin/java" ]]; then
  export JAVA_HOME="/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home"
fi

if [[ -z "${JAVA_HOME:-}" || ! -x "$JAVA_HOME/bin/java" ]]; then
  echo "Set JAVA_HOME to a JDK 17 or 21 installation before building." >&2
  exit 1
fi

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
export NODE_ENV="${NODE_ENV:-production}"

java -version
npx expo prebuild --platform android --no-install
(cd android && ./gradlew assembleRelease)

echo "Release APK: $ROOT_DIR/android/app/build/outputs/apk/release/app-release.apk"
