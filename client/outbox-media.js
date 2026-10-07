import { downloadNameFromMediaUrl } from '../public/media-files.js';

// Piweb's published outbox syntax is an extension, not standard Markdown.
// Transform parsed text only: code, math, HTML and link destinations stay intact.
export function remarkOutboxMedia() {
  return (tree) => visit(tree);
}

function visit(node) {
  if (
    !node.children ||
    ['link', 'image', 'code', 'inlineCode', 'html', 'math', 'inlineMath'].includes(node.type)
  )
    return;
  const children = node.children;
  for (let i = 0; i < children.length; i++) {
    const left = children[i],
      link = children[i + 1],
      right = children[i + 2];
    // GFM splits a bare HTTP URL inside a marker into an auto-link. Rejoin only
    // this marker-shaped triple; unrelated/explicit Markdown links are untouched.
    if (
      left.type === 'text' &&
      /\[\[(?:image|video|file)\s*:\s*$/i.test(left.value) &&
      link?.type === 'link' &&
      !link.position &&
      link.children?.length === 1 &&
      link.children[0].type === 'text' &&
      link.children[0].value === link.url &&
      right?.type === 'text' &&
      /^\s*\]\]/.test(right.value)
    ) {
      children.splice(i, 3, { type: 'text', value: left.value + link.url + right.value });
      i--; // The same text may start another adjacent remote marker.
    }
  }
  node.children = children.flatMap((child) => {
    if (child.type !== 'text') {
      visit(child);
      return [child];
    }
    const parts = [];
    let offset = 0;
    for (const match of child.value.matchAll(/\[\[(image|video|file)\s*:\s*([^\]]+?)\s*\]\]/gi)) {
      const url = match[2].trim();
      // Only published web URLs, never local paths or active URL schemes.
      if (!/^(?:\/media\/|https?:\/\/)/i.test(url)) continue;
      if (match.index > offset)
        parts.push({ type: 'text', value: child.value.slice(offset, match.index) });
      const kind = match[1].toLowerCase();
      const path = url.split(/[?#]/, 1)[0];
      const video = kind === 'video' || /\.(?:mp4|webm|mov)$/i.test(path);
      if (kind === 'file' && !video && !/\.(?:png|jpe?g|gif|webp|bmp|svg)$/i.test(path)) {
        parts.push({
          type: 'link',
          url,
          children: [{ type: 'text', value: downloadNameFromMediaUrl(url) }],
          data: { hProperties: { className: ['file-link'] } },
        });
      } else {
        parts.push({
          type: 'image',
          url,
          alt: 'image',
          ...(video ? { data: { hProperties: { 'data-piweb-media': 'video' } } } : {}),
        });
      }
      offset = match.index + match[0].length;
    }
    if (!offset) return [child];
    if (offset < child.value.length) parts.push({ type: 'text', value: child.value.slice(offset) });
    return parts;
  });
}
