#!/bin/sh
set -eu
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT
javac -d "$test_dir" "$repo_dir/android-connector/app/src/main/java/com/focus/connector/DiagnosticProtocol.java" "$repo_dir/android-connector/tests/DiagnosticProtocolTest.java"
java -cp "$test_dir" com.focus.connector.DiagnosticProtocolTest
javac -d "$test_dir" "$repo_dir/android-connector/app/src/main/java/com/focus/connector/PrinterProtocol.java" "$repo_dir/android-connector/tests/PrinterProtocolTest.java"
java -cp "$test_dir" com.focus.connector.PrinterProtocolTest
