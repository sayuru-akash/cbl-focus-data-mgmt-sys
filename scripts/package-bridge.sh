#!/bin/sh
set -eu
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
mkdir -p "$repo_dir/web-app/public/downloads"
cp "$repo_dir/android-connector/app/build/outputs/apk/debug/app-debug.apk" "$repo_dir/web-app/public/downloads/focus-bridge.apk"
printf '%s\n' 'Packaged Focus Bridge. Rebuild the web app to serve the latest APK.'
