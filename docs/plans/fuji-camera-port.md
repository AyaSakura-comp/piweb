# Fuji camera controls port

Historical port plan. See [current camera documentation](../camera-composer.md)
for the shipped default-off blur, batch shutter and separate Send behavior.

Source: `/home/chihmin/src/fuji_camera/static/index.html`, camera sections 458–645 and associated CSS. Port aperture wheel f/1.2–f/16, focus ring/radial fake bokeh, two-finger zoom, capability-driven lens discovery and mirrored selfie preview. Preserve PiWeb split-pane drag/snap and normal send transport.

1. RED tests for aperture mapping/blur math and mobile focus + aperture + pinch without resize/close.
2. Add `public/camera-effects.js`: shared bokeh parameters and capture compositor; CSS preview uses a second video on the same MediaStream. Exported capture applies blur through CPU/canvas without relying on Safari Canvas filter.
3. Integrate camera lifecycle, crop/zoom/mirroring and lens switches in `camera-composer.js`; separate two-finger gestures from one-finger panel drags; ignore controls for focus gestures.
4. GREEN Chromium fake-camera real touch tests and real isolated PiWeb upload/reload. Verify bokeh changes saved pixels, not only labels. Record and inspect workflow.
5. Test lifecycle/permission regressions, document simulated effects and hardware limits, deploy only verified camera assets without unrelated worker changes.

Fuji's server-side FLUX/film job pipeline, gallery and burst uploader are not being ported: PiWeb sends one locally rendered frame per explicit Send. Simulated bokeh is radial, not depth-aware or physical aperture.
