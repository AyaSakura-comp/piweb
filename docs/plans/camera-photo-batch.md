# Camera photo batch

Implementation checklist. The later UI adjustment places Send beside the shutter
and rebounds closed after confirmed success; [current documentation](../camera-composer.md)
is authoritative.

- Add failing E2E: shutter takes several photos with zero POSTs, remove one, close camera without losing batch, Send uploads exactly the remaining JPEGs plus the agreed research prompt; user text wins; rejected upload keeps photos for retry.
- `camera-composer.js/css`: dedicated shutter and pending photo count. Camera shutter uses existing cropped/mirrored/effected capture; Send never captures implicitly. Preserve drag-to-open and camera controls.
- `app.js`: tag camera attachments, reuse removable thumbnail chips; keep camera batch visible during upload and clear only confirmed-success items; do not revoke retained preview URLs on failure. Guard draft restoration by destination/selection and preserve newer edits.
- Update old camera tests to explicitly use shutter; run camera + image compression + Life regressions and isolated real-backend batch upload/reload. Record and inspect.
- Default camera-batch text: 請幫我辨識並說明這些照片裡的內容。如果需要更多資訊，可以使用以圖搜尋或上網查證，並附上來源；無法確定的部分請明確說明，不要猜測。
- Do not merge unrelated BTW changes or restart an active worker during frontend deployment.
