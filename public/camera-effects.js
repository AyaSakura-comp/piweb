// Camera controls adapted from fuji_camera/static/index.html. These are
// simulated radial bokeh/focus effects, not physical aperture or depth detection.
export const APERTURES = [1.2, 1.4, 1.8, 2, 2.8, 4, 5.6, 8, 11, 16];
export function bokehSettings(aperture) {
  const t = Math.max(0, Math.min(1, (Number(aperture) - 1.2) / 14.8));
  const inner = Math.round(22 + t * 78);
  return {
    blur: Math.round((1 - t) * 8),
    inner: inner / 100,
    outer: Math.min(130, inner + 34) / 100,
  };
}
export function classifyLens(label) {
  if (/front|前|facetime/i.test(label)) return '前鏡頭';
  if (/ultra|超廣/i.test(label)) return '超廣角';
  if (/tele|望遠/i.test(label)) return '望遠';
  if (/dual|triple|雙|三/i.test(label)) return '自動鏡頭';
  if (/wide|back|rear|後|廣角/i.test(label)) return '廣角';
  return '相機';
}

// Separable, edge-clamped box blur. Capture uses this rather than ctx.filter,
// which is unavailable on some Safari versions. Preview uses CSS blur.
export function blurPixels(input, width, height, radius) {
  let source = new Uint8ClampedArray(input);
  const r = Math.max(0, Math.round(radius));
  if (!r) return source;
  for (const horizontal of [true, false]) {
    const result = new Uint8ClampedArray(source.length);
    const length = horizontal ? width : height;
    const lines = horizontal ? height : width;
    const index = (line, pos) => (horizontal ? line * width + pos : pos * width + line) * 4;
    for (let line = 0; line < lines; line++) {
      const sums = [0, 0, 0, 0];
      for (let k = -r; k <= r; k++) {
        const at = index(line, Math.max(0, Math.min(length - 1, k)));
        for (let c = 0; c < 4; c++) sums[c] += source[at + c];
      }
      for (let pos = 0; pos < length; pos++) {
        const at = index(line, pos);
        const remove = index(line, Math.max(0, pos - r));
        const add = index(line, Math.min(length - 1, pos + r + 1));
        for (let c = 0; c < 4; c++) {
          result[at + c] = sums[c] / (2 * r + 1);
          sums[c] += source[add + c] - source[remove + c];
        }
      }
    }
    source = result;
  }
  return source;
}

export function createCameraEffects({ view, controls }) {
  const layer = document.createElement('div');
  layer.className = 'camera-bokeh';
  const blurred = document.createElement('video');
  blurred.autoplay = true;
  blurred.muted = true;
  blurred.playsInline = true;
  layer.append(blurred);
  view.querySelector('.camera-frame').after(layer);
  const ring = document.createElement('div');
  ring.className = 'camera-focus-ring';
  ring.hidden = true;
  view.append(ring);
  const wheel = document.createElement('div');
  wheel.className = 'camera-aperture';
  const label = document.createElement('div');
  label.className = 'camera-aperture-label';
  label.textContent = '模擬景深';
  const track = document.createElement('div');
  track.className = 'camera-ap-track';
  track.setAttribute('role', 'group');
  track.setAttribute('aria-label', '模擬光圈');
  const caret = document.createElement('span');
  caret.className = 'camera-ap-caret';
  wheel.append(label, track, caret);
  controls.prepend(wheel);
  let aperture = 16,
    focus = { x: 0.5, y: 0.45 },
    timer = 0;
  const buttons = APERTURES.map((value) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'camera-ap-item';
    button.textContent = `f/${value}`;
    button.setAttribute('aria-label', `模擬光圈 f/${value}`);
    button.addEventListener('click', () => {
      select(value);
      track.scrollTo({
        left: button.offsetLeft - track.clientWidth / 2 + button.offsetWidth / 2,
        behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      });
    });
    return button;
  });
  const spacer = () => {
    const e = document.createElement('span');
    e.className = 'camera-ap-spacer';
    return e;
  };
  track.append(spacer(), ...buttons, spacer());
  const update = () => {
    const b = bokehSettings(aperture);
    blurred.style.filter = `blur(${b.blur}px)`;
    layer.hidden = b.blur === 0;
    const mask = `radial-gradient(circle at ${focus.x * 100}% ${focus.y * 100}%, transparent ${b.inner * 100}%, #000 ${b.outer * 100}%)`;
    layer.style.maskImage = mask;
    layer.style.webkitMaskImage = mask;
    label.textContent = `模擬景深 · f/${aperture}${b.blur === 0 ? '（關閉）' : ''}`;
    buttons.forEach((button, i) =>
      button.setAttribute('aria-pressed', String(APERTURES[i] === aperture)),
    );
  };
  function select(value) {
    aperture = value;
    update();
  }
  track.addEventListener('scroll', () => {
    const center = track.getBoundingClientRect().left + track.clientWidth / 2;
    let best = 0,
      distance = Infinity;
    buttons.forEach((button, i) => {
      const r = button.getBoundingClientRect();
      const d = Math.abs(r.left + r.width / 2 - center);
      if (d < distance) {
        distance = d;
        best = i;
      }
    });
    select(APERTURES[best]);
  });
  update();
  // Centre the selected stop when the initially hidden pane becomes visible,
  // otherwise the first scroll event would silently select f/1.2 again.
  let previousWidth = 0;
  new ResizeObserver(() => {
    const width = track.clientWidth;
    if (width === previousWidth) return;
    previousWidth = width;
    if (!width) return;
    const selected = buttons[APERTURES.indexOf(aperture)];
    track.scrollTo({
      left: selected.offsetLeft - width / 2 + selected.offsetWidth / 2,
      behavior: 'instant',
    });
  }).observe(track);
  return {
    async attach(stream) {
      blurred.srcObject = stream;
      try {
        await blurred.play();
      } catch {
        /* Sharp preview remains usable. */
      }
    },
    detach() {
      blurred.pause();
      blurred.srcObject = null;
      clearTimeout(timer);
      ring.hidden = true;
    },
    transform(value) {
      blurred.style.transform = value;
    },
    focusAt(clientX, clientY) {
      const r = view.getBoundingClientRect();
      focus = {
        x: Math.max(0, Math.min(1, (clientX - r.left) / r.width)),
        y: Math.max(0, Math.min(1, (clientY - r.top) / r.height)),
      };
      ring.style.left = `${focus.x * 100}%`;
      ring.style.top = `${focus.y * 100}%`;
      ring.hidden = false;
      clearTimeout(timer);
      timer = setTimeout(() => {
        ring.hidden = true;
      }, 900);
      update();
    },
    // Composite exactly one captured frame: sharp centre + softened surroundings.
    composite(canvas) {
      const b = bokehSettings(aperture);
      if (!b.blur) return;
      const w = canvas.width,
        h = canvas.height;
      const small = document.createElement('canvas');
      const scale = Math.min(1, 640 / Math.max(w, h));
      small.width = Math.max(1, Math.round(w * scale));
      small.height = Math.max(1, Math.round(h * scale));
      const ctx = small.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(canvas, 0, 0, small.width, small.height);
      const pixels = ctx.getImageData(0, 0, small.width, small.height);
      const radius = Math.max(
        1,
        Math.round((b.blur * small.width) / Math.max(1, view.clientWidth)),
      );
      let data = pixels.data;
      for (let i = 0; i < 3; i++) data = blurPixels(data, small.width, small.height, radius);
      pixels.data.set(data);
      ctx.putImageData(pixels, 0, 0);
      const overlay = document.createElement('canvas');
      overlay.width = w;
      overlay.height = h;
      const oc = overlay.getContext('2d');
      oc.drawImage(small, 0, 0, w, h);
      const x = focus.x * w,
        y = focus.y * h;
      const radiusToCorner = Math.hypot(Math.max(x, w - x), Math.max(y, h - y));
      const mask = oc.createRadialGradient(
        x,
        y,
        radiusToCorner * b.inner,
        x,
        y,
        radiusToCorner * b.outer,
      );
      mask.addColorStop(0, 'rgba(0,0,0,0)');
      mask.addColorStop(1, '#000');
      oc.globalCompositeOperation = 'destination-in';
      oc.fillStyle = mask;
      oc.fillRect(0, 0, w, h);
      canvas.getContext('2d').drawImage(overlay, 0, 0);
    },
  };
}
