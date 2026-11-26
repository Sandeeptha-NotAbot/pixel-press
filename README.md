# Pixel Press

Turn any image into pixel art in the browser. Pick the resolution, reduce the palette (k-means best fit, grayscale, 1-bit or presets), add Floyd–Steinberg or ordered dithering, edit any palette color, and download a scaled PNG.

Everything runs client-side in a single `index.html`; images never leave your machine.

## Privacy

- Images are processed locally with the Canvas API and are never uploaded.
- No analytics, cookies or third-party requests: fonts are self-hosted in `fonts/`, and a Content-Security-Policy restricts the page to its own files.
- Uploads are limited to 25 MB and 50 megapixels.

## License

Code: MIT (see `LICENSE`). Fonts in `fonts/` (Silkscreen, DM Sans, DM Mono) are under the SIL Open Font License 1.1.
