/**
 * Per-deployment home-screen / install icons.
 *
 * One checkout serves several deployments (the Linux host, the Mac mini), and
 * each may want its own icon. The page links the icons through root-level
 * URLs — `/apple-touch-icon*.png` and `/manifest.webmanifest` — which serve
 * the default set from `public/`. With WEB_ICON_SET=<name>, those same URLs
 * are answered from `public/icons/<name>/apple-<size>.png` and
 * `public/manifest.<name>.webmanifest` instead; the manifest names its own
 * icon files under `icons/<name>/`.
 *
 * The aliases are served `no-cache`: they are stable URLs whose bytes depend
 * on configuration, unlike `icons/`, which is immutable by path.
 */

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const APPLE_TOUCH = /^\/apple-touch-icon(?:-(\d{2,3})x\1)?(?:-precomposed)?\.png$/;

/** The public/-relative file that answers `path` for `iconSet`, or undefined for the default. */
export function iconSetTarget(path: string, iconSet: string): string | undefined {
  if (!iconSet || !NAME.test(iconSet)) return undefined;
  if (path === '/manifest.webmanifest') return `manifest.${iconSet}.webmanifest`;
  const apple = path.match(APPLE_TOUCH);
  if (apple) return `icons/${iconSet}/apple-${apple[1] ?? '180'}.png`;
  return undefined;
}
