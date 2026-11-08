/**
 * Files dragged in from Finder / Explorer.
 *
 * Without a handler Chrome treats a dropped file as navigation: it opens the
 * file in a new tab (or offers to save a RAW it cannot show) and nothing is
 * attached (Mac app, 2026-11-08). A Dashboard pane binds its own target, the
 * main chat composer takes the rest of the page, and a file let go anywhere
 * else is swallowed rather than opened.
 */

/** True while the drag carries files from the OS (not text, not a session). */
export function isFileDrag(e) {
  const types = e.dataTransfer?.types;
  return !!types && Array.from(types).includes('Files');
}

/** The dropped files, in order. */
export function droppedFiles(e) {
  return Array.from(e.dataTransfer?.files ?? []);
}

/**
 * Make `target` accept dropped files: `onFiles(files)` gets them, and
 * `activeClass` marks the target while files hover over it. The drop stops
 * here, so an outer target never also takes the same files.
 */
export function bindFileDropTarget(target, onFiles, { activeClass = 'file-drag-over' } = {}) {
  let depth = 0;
  const clear = () => {
    depth = 0;
    target.classList.remove(activeClass);
  };
  target.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    depth += 1;
    target.classList.add(activeClass);
  });
  target.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  target.addEventListener('dragleave', (e) => {
    if (!isFileDrag(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) target.classList.remove(activeClass);
  });
  target.addEventListener('drop', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    clear();
    const files = droppedFiles(e);
    if (files.length > 0) onFiles(files);
  });
  return clear;
}

/**
 * Page-wide fallback for a drop no target claimed: `onFiles(files)` takes it
 * while `accepts()` is true, and otherwise it is swallowed, so the browser
 * never navigates to the file.
 */
export function guardDocumentFileDrops(doc, { accepts = () => false, onFiles = () => {} } = {}) {
  doc.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = accepts() ? 'copy' : 'none';
  });
  doc.addEventListener('drop', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    const files = droppedFiles(e);
    if (files.length > 0 && accepts()) onFiles(files);
  });
}
