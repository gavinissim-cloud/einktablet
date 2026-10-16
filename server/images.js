import sharp from "sharp";

// The largest image Claude looks at without shrinking it (long edge, pixels).
export const MAX_VISION_EDGE = 2576;

/** A page image ready for repeated cropping. Boxes are 0–1000 of width/height. */
export async function openPage(buffer) {
  const image = sharp(buffer).rotate(); // apply EXIF orientation
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  const raw = { raw: { width: info.width, height: info.height, channels: info.channels } };
  const source = () => sharp(data, raw);

  const toJpeg = (img) => img.jpeg({ quality: 90 }).toBuffer();

  return {
    width: info.width,
    height: info.height,

    /** The whole page, no larger than Claude's limit. */
    async whole() {
      return toJpeg(source().resize(MAX_VISION_EDGE, MAX_VISION_EDGE, { fit: "inside", withoutEnlargement: true }));
    },

    /**
     * A region, enlarged so small handwriting fills the image (up to `maxScale`
     * times its size on the page, never past Claude's limit).
     */
    async region(box, { padY = 0, padX = 0, maxScale = 3, minHeight = 0 } = {}) {
      const W = info.width, H = info.height;
      const y0 = Math.max(0, Math.floor((box.top / 1000) * H - padY * H));
      const y1 = Math.min(H, Math.ceil((box.bottom / 1000) * H + padY * H));
      const x0 = Math.max(0, Math.floor((box.left / 1000) * W - padX * W));
      const x1 = Math.min(W, Math.ceil((box.right / 1000) * W + padX * W));
      const width = Math.max(1, x1 - x0), height = Math.max(1, y1 - y0);
      const fit = MAX_VISION_EDGE / Math.max(width, height);
      let scale = Math.min(maxScale, fit);
      // Very thin lines get extra enlargement so the letters are tall enough to read.
      if (minHeight && height * scale < minHeight) scale = Math.min(fit, minHeight / height);
      const img = source()
        .extract({ left: x0, top: y0, width, height })
        .resize(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)), { kernel: "lanczos3" });
      return toJpeg(img);
    },
  };
}

/** One handwritten line, cut out generously (marks above and below the letters). */
export function lineCrop(page, box) {
  const h = Math.max(1, box.bottom - box.top);
  return page.region(box, { padY: (h / 1000) * 0.35, padX: 0.01, maxScale: 3, minHeight: 220 });
}

/** A small, light crop kept as a learning example. */
export async function exampleCrop(buffer, box) {
  const page = await openPage(buffer);
  const h = Math.max(1, box.bottom - box.top);
  const jpeg = await page.region(box, { padY: (h / 1000) * 0.3, padX: 0.01, maxScale: 1.5 });
  return sharp(jpeg).resize(1400, 400, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
}
