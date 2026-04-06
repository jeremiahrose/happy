#!/bin/bash
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"

# Use JDK 21 for Android build
export JAVA_HOME="/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home"

# Android SDK
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$ANDROID_HOME/platform-tools:$PATH"

# Load .env
if [ -f "$DIR/.env" ]; then
    set -a
    source "$DIR/.env"
    set +a
    echo "Loaded .env"
else
    echo "No .env found. Create packages/happy-app/.env with:"
    echo "  PIXEL_IP=..."
    echo "  PIXEL_ADB_PORT=5555"
    exit 1
fi

# Prebuild native Android project if needed
if [ ! -d "$DIR/android" ]; then
    echo "Running expo prebuild..."
    cd "$DIR"
    npx expo prebuild --platform android
fi

# Build debug APK
echo "Building APK..."
cd "$DIR/android"
./gradlew assembleDebug -q

APK="app/build/outputs/apk/debug/app-debug.apk"
echo ""
echo "APK built: $DIR/android/$APK"

# Install on device via ADB
PIXEL_IP="${PIXEL_IP:?PIXEL_IP not set}"
PIXEL_ADB_PORT="${PIXEL_ADB_PORT:-5555}"

# Disconnect stale transports
adb disconnect 2>/dev/null || true

if adb connect "$PIXEL_IP:$PIXEL_ADB_PORT" 2>/dev/null | grep -q 'connected'; then
    echo "Installing via ADB ($PIXEL_IP:$PIXEL_ADB_PORT)..."
else
    echo "Could not connect to $PIXEL_IP:$PIXEL_ADB_PORT. Is ADB over network enabled?"
    echo "APK is at: $DIR/android/$APK"
    exit 0
fi

ADB="adb -s $PIXEL_IP:$PIXEL_ADB_PORT"
$ADB install -r "$APK"
echo "Launching..."
$ADB shell am start -n com.slopus.happy.dev/.MainActivity
echo "Done."
