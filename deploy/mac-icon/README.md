# macOS icon (Mac mini)

The icon for the piweb Chrome web app on this Mac: a smiling Mac mini with π on
its top, under a sakura branch on washi paper. Drawn on the macOS icon grid
(1024 canvas, 824 continuous-corner body, drop shadow).

| file | what |
| --- | --- |
| `piweb-mac.svg` | source, 64 px and up |
| `piweb-mac-small.svg` | simplified source (no branch, bigger mini) used for 16/32 px |
| `piweb.icns` | built iconset, 16–1024 px |
| `piweb-mac-512.png` | preview |
| `apply.sh` | installs it on the Chrome app shim and re-signs it |

It is deliberately not in `manifest.webmanifest`: the manifest also serves
Android and the Linux deployment, which keep the original mark.

Rebuild the `.icns` from the SVGs (Chrome renders them, `sips` scales, `iconutil` packs):

```sh
chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
for f in piweb-mac piweb-mac-small; do
  "$chrome" --headless=new --hide-scrollbars --default-background-color=00000000 \
    --window-size=1024,1024 --screenshot="$PWD/$f.png" "file://$PWD/$f.svg"
done
mkdir -p piweb.iconset
for s in 16 32 64 128 256 512 1024; do
  src=piweb-mac.png; [ $s -le 32 ] && src=piweb-mac-small.png
  sips -z $s $s $src --out piweb.iconset/$s.png >/dev/null
done
cd piweb.iconset
mv 16.png icon_16x16.png; cp 32.png icon_16x16@2x.png; mv 32.png icon_32x32.png
mv 64.png icon_32x32@2x.png; mv 128.png icon_128x128.png; cp 256.png icon_128x128@2x.png
mv 256.png icon_256x256.png; cp 512.png icon_256x256@2x.png; mv 512.png icon_512x512.png
mv 1024.png icon_512x512@2x.png
cd .. && iconutil -c icns piweb.iconset -o piweb.icns && rm -r piweb.iconset piweb-mac*.png
```
