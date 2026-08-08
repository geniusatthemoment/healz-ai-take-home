#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# Prefer JDK 21 when it is installed, but support the JDK 25 bundled with
# newer Android Studio versions as well. Gradle's native CMake subprocesses
# need native access explicitly enabled on JDK 25.
if [[ -z "${JAVA_HOME:-}" && -x "/opt/homebrew/opt/openjdk@21/bin/java" ]]; then
  export JAVA_HOME="/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home"
fi

if [[ -z "${JAVA_HOME:-}" && -x "/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java" ]]; then
  export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
fi

if [[ -z "${JAVA_HOME:-}" || ! -x "$JAVA_HOME/bin/java" ]]; then
  echo "Set JAVA_HOME to a JDK 17, 21, or 25 installation before building." >&2
  exit 1
fi

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
export NODE_ENV="${NODE_ENV:-production}"

JAVA_VERSION="$("$JAVA_HOME/bin/java" -version 2>&1 | awk -F'"' '/version/ {print $2; exit}')"
JAVA_MAJOR="${JAVA_VERSION%%.*}"
if [[ "$JAVA_MAJOR" == "1" ]]; then
  JAVA_MAJOR="${JAVA_VERSION#1.}"
  JAVA_MAJOR="${JAVA_MAJOR%%.*}"
fi

if (( JAVA_MAJOR >= 25 )) && [[ " ${JAVA_TOOL_OPTIONS:-} " != *" --enable-native-access=ALL-UNNAMED "* ]]; then
  export JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:+$JAVA_TOOL_OPTIONS }--enable-native-access=ALL-UNNAMED"
fi

java -version
echo "Using JAVA_HOME: $JAVA_HOME"
echo "Using ANDROID_HOME: $ANDROID_HOME"
npx expo prebuild --platform android --no-install
(cd android && ./gradlew assembleRelease)

echo "Release APK: $ROOT_DIR/android/app/build/outputs/apk/release/app-release.apk"
