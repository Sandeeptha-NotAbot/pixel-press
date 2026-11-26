(() => {
  const $ = id => document.getElementById(id);
  const MAX_BYTES = 25 * 1024 * 1024;   // reject uploads larger than 25 MB
  const MAX_PIXELS = 50e6;              // and images over 50 megapixels
  const PRESETS = {
    bit:   ["#000000", "#ffffff"],
    field: ["#1d2b1f", "#3e6b3a", "#8fb24a", "#d6e8a0"],
    dusk:  ["#1b1530", "#3d2a5c", "#6e3f7a", "#b35a7a", "#e8836b", "#f6c27a", "#7fa7c9", "#f4ead8"],
    ember: ["#140c0a", "#4a1d14", "#9c3a1c", "#e0742a", "#f6c453", "#fff3d6"],
  };
  const state = {
    src: null, width: 96, colors: 12, mode: "auto", dither: "none", ditherAmt: 0.6,
    sat: 1.1, contrast: 1.05, grid: false, view: "pixel", scale: 8, custom: null,
    palette: [], small: null, out: null, W: 0, H: 0, counts: [],
  };

  const hex = c => "#" + c.map(v => v.toString(16).padStart(2, "0")).join("");
  const unhex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));

  // ---------- sample image (drawn, so the tool opens with something to show)
  function sample() {
    const c = document.createElement("canvas"); c.width = 720; c.height = 480;
    const g = c.getContext("2d");
    const sky = g.createLinearGradient(0, 0, 0, 330);
    sky.addColorStop(0, "#26305e"); sky.addColorStop(.45, "#a8527a"); sky.addColorStop(.8, "#f39a5c"); sky.addColorStop(1, "#ffd48a");
    g.fillStyle = sky; g.fillRect(0, 0, 720, 480);
    const sun = g.createRadialGradient(470, 290, 10, 470, 290, 120);
    sun.addColorStop(0, "#fff6d8"); sun.addColorStop(.35, "#ffd27a"); sun.addColorStop(1, "rgba(255,180,100,0)");
    g.fillStyle = sun; g.beginPath(); g.arc(470, 290, 120, 0, Math.PI * 2); g.fill();
    const ridge = (base, amp, freq, phase, col) => {
      g.fillStyle = col; g.beginPath(); g.moveTo(0, 480);
      for (let x = 0; x <= 720; x += 6) g.lineTo(x, base - amp * (Math.sin(x * freq + phase) * .6 + Math.sin(x * freq * 2.7 + phase * 2) * .4));
      g.lineTo(720, 480); g.fill();
    };
    ridge(300, 50, .009, 1, "#7b4a7a");
    ridge(340, 40, .013, 3, "#4d3463");
    const lake = g.createLinearGradient(0, 360, 0, 480);
    lake.addColorStop(0, "#e88a6a"); lake.addColorStop(1, "#3b2d5a");
    g.fillStyle = lake; g.fillRect(0, 362, 720, 118);
    g.fillStyle = "rgba(255,230,170,.55)";
    for (let i = 0; i < 9; i++) g.fillRect(430 - i * 4, 372 + i * 11, 80 + i * 8, 3);
    g.fillStyle = "#1e1a33";
    const tree = (x, h) => { g.beginPath(); g.moveTo(x, 372 - h); g.lineTo(x - h * .28, 372); g.lineTo(x + h * .28, 372); g.fill(); g.fillRect(x - 3, 368, 6, 10); };
    [[60, 150], [110, 110], [150, 170], [205, 95], [640, 140], [685, 100]].forEach(([x, h]) => tree(x, h));
    return c;
  }

  // ---------- downscale with true block averaging
  function downscale(src, W) {
    const sw = src.naturalWidth || src.width, sh = src.naturalHeight || src.height;
    const H = Math.max(1, Math.round(W * sh / sw));
    const f = Math.max(1, Math.min(8, Math.floor(2048 / Math.max(W, H))));
    const c = document.createElement("canvas"); c.width = W * f; c.height = H * f;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
    g.drawImage(src, 0, 0, c.width, c.height);
    const big = g.getImageData(0, 0, c.width, c.height).data;
    const out = new Float32Array(W * H * 4);
    const bw = c.width;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let r = 0, gg = 0, b = 0, a = 0;
      for (let dy = 0; dy < f; dy++) {
        let i = ((y * f + dy) * bw + x * f) * 4;
        for (let dx = 0; dx < f; dx++, i += 4) {
          const al = big[i + 3]; r += big[i] * al; gg += big[i + 1] * al; b += big[i + 2] * al; a += al;
        }
      }
      const o = (y * W + x) * 4;
      if (a > 0) { out[o] = r / a; out[o + 1] = gg / a; out[o + 2] = b / a; }
      out[o + 3] = a / (f * f);
    }
    // saturation + contrast
    const s = state.sat, k = state.contrast;
    for (let i = 0; i < out.length; i += 4) {
      const l = .299 * out[i] + .587 * out[i + 1] + .114 * out[i + 2];
      for (let j = 0; j < 3; j++) {
        let v = l + (out[i + j] - l) * s;
        v = (v - 128) * k + 128;
        out[i + j] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
    return { data: out, W, H };
  }

  // perceptual-ish RGB distance ("redmean")
  function dist(r1, g1, b1, r2, g2, b2) {
    const rm = (r1 + r2) * .5, dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
    return (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
  }

  // ---------- k-means palette (k-means++ init, seeded so results are stable)
  function kmeans(data, k) {
    let seed = 1234567;
    const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const pts = [];
    const total = data.length / 4, step = Math.max(1, Math.floor(total / 14000));
    for (let p = 0; p < total; p += step) { const i = p * 4; if (data[i + 3] >= 128) pts.push(data[i], data[i + 1], data[i + 2]); }
    const n = pts.length / 3;
    if (!n) return [[0, 0, 0]];
    const uniq = new Set(); for (let i = 0; i < n && uniq.size <= k; i++) uniq.add((pts[i*3]|0) << 16 | (pts[i*3+1]|0) << 8 | (pts[i*3+2]|0));
    k = Math.min(k, uniq.size);
    const cent = [];
    let first = Math.floor(rnd() * n); cent.push([pts[first * 3], pts[first * 3 + 1], pts[first * 3 + 2]]);
    const d = new Float64Array(n).fill(Infinity);
    while (cent.length < k) {
      const c = cent[cent.length - 1]; let sum = 0;
      for (let i = 0; i < n; i++) { const v = dist(pts[i*3], pts[i*3+1], pts[i*3+2], c[0], c[1], c[2]); if (v < d[i]) d[i] = v; sum += d[i]; }
      let t = rnd() * sum, idx = 0;
      for (; idx < n - 1; idx++) { t -= d[idx]; if (t <= 0) break; }
      cent.push([pts[idx * 3], pts[idx * 3 + 1], pts[idx * 3 + 2]]);
    }
    const assign = new Int32Array(n);
    for (let it = 0; it < 14; it++) {
      const acc = cent.map(() => [0, 0, 0, 0]);
      for (let i = 0; i < n; i++) {
        const r = pts[i*3], g = pts[i*3+1], b = pts[i*3+2]; let best = 0, bd = Infinity;
        for (let c = 0; c < cent.length; c++) { const v = dist(r, g, b, cent[c][0], cent[c][1], cent[c][2]); if (v < bd) { bd = v; best = c; } }
        assign[i] = best; const a = acc[best]; a[0] += r; a[1] += g; a[2] += b; a[3]++;
      }
      let moved = 0;
      for (let c = 0; c < cent.length; c++) {
        const a = acc[c];
        if (!a[3]) { const j = Math.floor(rnd() * n); cent[c] = [pts[j*3], pts[j*3+1], pts[j*3+2]]; moved += 999; continue; }
        const nc = [a[0] / a[3], a[1] / a[3], a[2] / a[3]];
        moved += Math.abs(nc[0] - cent[c][0]) + Math.abs(nc[1] - cent[c][1]) + Math.abs(nc[2] - cent[c][2]);
        cent[c] = nc;
      }
      if (moved < 1) break;
    }
    return cent.map(c => c.map(v => Math.round(v)));
  }

  function grayPalette(n) {
    return Array.from({ length: n }, (_, i) => { const v = Math.round(i * 255 / (n - 1)); return [v, v, v]; });
  }

  const BAYER = (() => {
    const m = [[0]];
    let cur = m;
    for (let s = 1; s < 8; s *= 2) {
      const nx = Array.from({ length: s * 2 }, () => new Array(s * 2));
      for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
        const v = cur[y][x] * 4;
        nx[y][x] = v; nx[y][x + s] = v + 2; nx[y + s][x] = v + 3; nx[y + s][x + s] = v + 1;
      }
      cur = nx;
    }
    return cur;
  })();

  // ---------- map every pixel to the palette
  function quantize({ data, W, H }, pal) {
    const buf = Float32Array.from(data);
    const out = new ImageData(W, H);
    const o = out.data;
    const counts = new Array(pal.length).fill(0);
    const amt = state.ditherAmt;
    const spread = 96 / Math.sqrt(pal.length);
    const nearest = (r, g, b) => {
      let best = 0, bd = Infinity;
      for (let c = 0; c < pal.length; c++) { const p = pal[c]; const v = dist(r, g, b, p[0], p[1], p[2]); if (v < bd) { bd = v; best = c; } }
      return best;
    };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (buf[i + 3] < 128) { o[i + 3] = 0; continue; }
      let r = buf[i], g = buf[i + 1], b = buf[i + 2];
      if (state.dither === "bayer") {
        const t = (BAYER[y & 7][x & 7] / 64 - .5) * spread * amt * 2;
        r += t; g += t; b += t;
      }
      const ci = nearest(r, g, b), p = pal[ci];
      counts[ci]++;
      o[i] = p[0]; o[i + 1] = p[1]; o[i + 2] = p[2]; o[i + 3] = 255;
      if (state.dither === "fs" && amt > 0) {
        const er = (buf[i] - p[0]) * amt, eg = (buf[i + 1] - p[1]) * amt, eb = (buf[i + 2] - p[2]) * amt;
        const push = (dx, dy, w) => {
          const nx = x + dx, ny = y + dy; if (nx < 0 || nx >= W || ny >= H) return;
          const j = (ny * W + nx) * 4; buf[j] += er * w; buf[j + 1] += eg * w; buf[j + 2] += eb * w;
        };
        push(1, 0, 7 / 16); push(-1, 1, 3 / 16); push(0, 1, 5 / 16); push(1, 1, 1 / 16);
      }
    }
    return { img: out, counts };
  }

  // ---------- pipeline
  const work = document.createElement("canvas");
  const view = $("view"), vctx = view.getContext("2d");
  let pending = false, exportTimer = 0;

  function choosePalette() {
    switch (state.mode) {
      case "auto": return kmeans(state.small.data, state.colors);
      case "gray": return grayPalette(state.colors);
      case "custom": return state.custom ? state.custom.map(c => c.slice()) : kmeans(state.small.data, state.colors);
      default: return PRESETS[state.mode].map(unhex);
    }
  }

  function run(opts = {}) {
    if (!state.src) return;
    if (!opts.keepSmall || !state.small) state.small = downscale(state.src, state.width);
    if (!opts.keepPalette) state.palette = choosePalette();
    const { img, counts } = quantize(state.small, state.palette);
    state.W = img.width; state.H = img.height; state.counts = counts;
    work.width = img.width; work.height = img.height;
    work.getContext("2d").putImageData(img, 0, 0);
    draw();
    if (!opts.keepSwatches) drawPalette();
    else updateCounts();
    $("stats").textContent = `${state.W} × ${state.H} px · ${state.palette.length} colors`;
    clearTimeout(exportTimer); exportTimer = setTimeout(renderExport, 180);
  }
  function schedule(opts) {
    if (pending) { Object.assign(pending, opts); return; }
    pending = Object.assign({}, opts);
    requestAnimationFrame(() => { const o = pending; pending = false; run(o); });
  }

  function draw() {
    const W = state.W, H = state.H;
    const s = Math.max(1, Math.floor(1400 / Math.max(W, H)));
    view.width = W * s; view.height = H * s;
    vctx.clearRect(0, 0, view.width, view.height);
    if (state.view === "orig") {
      vctx.imageSmoothingEnabled = true; vctx.imageSmoothingQuality = "high";
      vctx.drawImage(state.src, 0, 0, view.width, view.height);
      return;
    }
    vctx.imageSmoothingEnabled = false;
    vctx.drawImage(work, 0, 0, view.width, view.height);
    if (state.grid && s >= 4) {
      vctx.strokeStyle = "rgba(0,0,0,.22)"; vctx.lineWidth = 1; vctx.beginPath();
      for (let x = 0; x <= W; x++) { vctx.moveTo(x * s + .5, 0); vctx.lineTo(x * s + .5, view.height); }
      for (let y = 0; y <= H; y++) { vctx.moveTo(0, y * s + .5); vctx.lineTo(view.width, y * s + .5); }
      vctx.stroke();
    }
  }

  let order = [];
  function drawPalette() {
    const total = state.counts.reduce((a, b) => a + b, 0) || 1;
    order = state.palette.map((_, i) => i).sort((a, b) => state.counts[b] - state.counts[a]);
    const box = $("swatches"); box.textContent = "";
    order.forEach(i => {
      const h = hex(state.palette[i]);
      const lab = document.createElement("label"); lab.className = "sw";
      const inp = document.createElement("input"); inp.type = "color"; inp.value = h; inp.id = "sw" + i;
      inp.setAttribute("aria-label", "Palette color " + h);
      const meta = document.createElement("span"); meta.className = "sw-meta";
      const hexEl = document.createElement("span"), pctEl = document.createElement("span");
      hexEl.textContent = h; pctEl.textContent = (state.counts[i] / total * 100).toFixed(1) + "%";
      meta.append(hexEl, pctEl);
      inp.addEventListener("input", () => {
        state.palette[i] = unhex(inp.value);
        state.custom = state.palette.map(c => c.slice());
        state.mode = "custom"; $("mode").value = "custom"; syncControls();
        meta.firstChild.textContent = inp.value;
        schedule({ keepSmall: true, keepPalette: true, keepSwatches: true });
      });
      lab.append(inp, meta); box.append(lab);
    });
    $("hexlist").value = order.map(i => hex(state.palette[i])).join(" ");
  }
  function updateCounts() {
    const total = state.counts.reduce((a, b) => a + b, 0) || 1;
    const metas = $("swatches").querySelectorAll(".sw-meta");
    order.forEach((i, n) => { if (metas[n]) metas[n].lastChild.textContent = (state.counts[i] / total * 100).toFixed(1) + "%"; });
    $("hexlist").value = order.map(i => hex(state.palette[i])).join(" ");
  }

  const exp = document.createElement("canvas");
  function renderExport() {
    let s = state.scale;
    while (s > 1 && Math.max(state.W, state.H) * s > 8192) s >>= 1;
    exp.width = state.W * s; exp.height = state.H * s;
    const g = exp.getContext("2d"); g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, exp.width, exp.height);
    g.drawImage(work, 0, 0, exp.width, exp.height);
    const url = exp.toDataURL("image/png");
    $("exportImg").src = url;
    $("download").href = url;
    $("exportSize").textContent = `PNG · ${exp.width} × ${exp.height} px`;
  }

  // ---------- controls
  function syncControls() {
    const fixed = ["bit", "field", "dusk", "ember", "custom"].includes(state.mode);
    $("colors").disabled = fixed; $("colorsField").style.opacity = fixed ? .45 : 1;
    const nod = state.dither === "none";
    $("ditherAmt").disabled = nod; $("ditherAmtField").style.opacity = nod ? .45 : 1;
  }
  const bindRange = (id, fmt, apply, opts) => {
    const el = $(id), out = $(id + "Val");
    const go = () => { apply(+el.value); out.textContent = fmt(+el.value); schedule(opts()); };
    el.addEventListener("input", go); out.textContent = fmt(+el.value);
  };
  bindRange("width", v => v, v => state.width = v, () => ({}));
  bindRange("colors", v => v, v => state.colors = v, () => ({ keepSmall: true }));
  bindRange("ditherAmt", v => v + "%", v => state.ditherAmt = v / 100, () => ({ keepSmall: true, keepPalette: true, keepSwatches: true }));
  bindRange("sat", v => v + "%", v => state.sat = v / 100, () => ({}));
  bindRange("contrast", v => v + "%", v => state.contrast = v / 100, () => ({}));

  $("mode").addEventListener("change", e => {
    state.mode = e.target.value;
    if (state.mode === "custom" && !state.custom) state.custom = state.palette.map(c => c.slice());
    syncControls(); schedule({ keepSmall: true });
  });
  $("dither").addEventListener("change", e => { state.dither = e.target.value; syncControls(); schedule({ keepSmall: true, keepPalette: true, keepSwatches: true }); });
  $("grid").addEventListener("change", e => { state.grid = e.target.checked; draw(); });
  $("scale").addEventListener("change", e => { state.scale = +e.target.value; renderExport(); });

  const setView = v => {
    state.view = v;
    $("vPixel").setAttribute("aria-pressed", v === "pixel"); $("vOrig").setAttribute("aria-pressed", v === "orig");
    draw();
  };
  $("vPixel").addEventListener("click", () => setView("pixel"));
  $("vOrig").addEventListener("click", () => setView("orig"));

  const status = msg => { $("status").textContent = msg; };
  $("copyHex").addEventListener("click", () => {
    const ta = $("hexlist");
    const p = navigator.clipboard && navigator.clipboard.writeText(ta.value);
    if (p) p.then(() => status("Hex codes copied."), () => { ta.select(); status("Copying was blocked. The codes are selected below; press Ctrl+C or Cmd+C."); });
    else { ta.select(); status("The codes are selected below; press Ctrl+C or Cmd+C."); }
  });
  $("copyImg").addEventListener("click", () => {
    try {
      const blob = new Promise(res => exp.toBlob(res, "image/png"));
      navigator.clipboard.write([new ClipboardItem({ "image/png": blob })])
        .then(() => status("Image copied. Paste it anywhere."), () => status("Your browser blocked image copying. Use Download PNG instead."));
    } catch (e) { status("Your browser can't copy images here. Use Download PNG instead."); }
  });

  // ---------- loading images
  function loadFile(file) {
    if (!file || !file.type.startsWith("image/")) { status("That file isn't an image. Try a PNG, JPG, GIF or WebP."); return; }
    if (file.size > MAX_BYTES) { status(`That image is ${(file.size / 1048576).toFixed(0)} MB. The limit is 25 MB; try a smaller or compressed copy.`); return; }
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => {
      URL.revokeObjectURL(url);
      if (im.naturalWidth * im.naturalHeight > MAX_PIXELS) { status(`That image is ${im.naturalWidth} × ${im.naturalHeight}. The limit is 50 megapixels; try a smaller copy.`); return; }
      state.src = im; state.small = null;
      if (state.mode === "custom") { state.mode = "auto"; $("mode").value = "auto"; state.custom = null; syncControls(); }
      $("download").download = file.name.replace(/\.[^.]+$/, "") + "-pixel.png";
      $("srcChip").textContent = file.name.length > 28 ? file.name.slice(0, 25) + "…" : file.name;
      status(""); run();
    };
    im.onerror = () => { URL.revokeObjectURL(url); status("Couldn't read that image. Try exporting it as PNG or JPG first."); };
    im.src = url;
  }
  $("file").addEventListener("change", e => loadFile(e.target.files[0]));
  const box = $("box");
  ["dragenter", "dragover"].forEach(t => box.addEventListener(t, e => { e.preventDefault(); box.classList.add("drag"); }));
  ["dragleave", "drop"].forEach(t => box.addEventListener(t, e => { e.preventDefault(); box.classList.remove("drag"); }));
  box.addEventListener("drop", e => loadFile(e.dataTransfer.files[0]));
  window.addEventListener("paste", e => {
    const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith("image/"));
    if (item) loadFile(item.getAsFile());
  });

  state.src = sample();
  syncControls();
  run();
})();
