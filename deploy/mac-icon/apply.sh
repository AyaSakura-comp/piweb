#!/bin/sh
# Put the Mac mini piweb icon on the Chrome web-app shim for this Mac's piweb
# (the "piweb 1" app, https://mac-pi.<tailnet>.ts.net/). Chrome can rewrite the
# shim (on a Chrome update or reinstalling the app), which brings the
# manifest's icon back; just run this again.
#
#   deploy/mac-icon/apply.sh ["/path/to/Chrome App.app"]
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
APP=${1:-"$HOME/Applications/Chrome Apps.localized/piweb 1.app"}
[ -d "$APP" ] || { echo "no such app: $APP" >&2; exit 1; }
ICON=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIconFile" "$APP/Contents/Info.plist")
case "$ICON" in *.icns) ;; *) ICON="$ICON.icns" ;; esac
cp "$HERE/piweb.icns" "$APP/Contents/Resources/$ICON"
# The shim is ad-hoc signed and its seal covers Resources/: re-sign, keeping
# its entitlements and hardened-runtime flags, or the seal stays broken.
codesign --force --sign - --preserve-metadata=entitlements,requirements,flags,runtime "$APP"
codesign --verify --strict "$APP"
touch "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP"
killall Dock 2>/dev/null || true
echo "icon applied to $APP (quit and reopen the app if it is running)"
