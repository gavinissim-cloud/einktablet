import sharp from "sharp";

/**
 * Cut one corrected line out of its page, to keep as a learning example.
 * `box` is in 0–1000 page coordinates. The margins match how the reading
 * engine cuts lines out of a page, so training images look like reading images.
 */
export async function exampleCrop(buffer, box) {
  const image = sharp(buffer).rotate(); // apply EXIF orientation
  const { width: W, height: H } = await image.metadata().then((m) =>
    m.orientation && m.orientation >= 5 ? { width: m.height, height: m.width } : m
  );
  const h = ((box.bottom - box.top) / 1000) * H;
  const padY = h * 0.12;
  const padX = h * 0.05;
  const left = Math.max(0, Math.floor((box.left / 1000) * W - padX));
  const top = Math.max(0, Math.floor((box.top / 1000) * H - padY));
  const right = Math.min(W, Math.ceil((box.right / 1000) * W + padX));
  const bottom = Math.min(H, Math.ceil((box.bottom / 1000) * H + padY));
  return image
    .extract({ left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) })
    .resize({ height: 160, withoutEnlargement: true }) // the engine reads lines at 64 px high
    .jpeg({ quality: 88 })
    .toBuffer();
}
