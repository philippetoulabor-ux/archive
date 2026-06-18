import fs from "fs";
import path from "path";
import sharp from "sharp";

const ARCHIVE_ROOT = path.join(process.cwd(), "database-archive");
const THUMB_ROOT = path.join(process.cwd(), "public/database-archive-thumbs");
const MAX_WIDTH = 800;
const WEBP_QUALITY = 80;
const IMAGE_EXTENSIONS = new Set([".webp", ".jpg", ".jpeg", ".png"]);

function findAllImages(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const images = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      images.push(...findAllImages(fullPath));
      continue;
    }
    if (entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      images.push(fullPath);
    }
  }

  return images;
}

function toThumbPath(imagePath) {
  const relative = path.relative(ARCHIVE_ROOT, imagePath);
  const parsed = path.parse(relative);
  return path.join(THUMB_ROOT, parsed.dir, `${parsed.name}.webp`);
}

async function generateThumb(sourcePath, destPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  await sharp(sourcePath)
    .rotate()
    .resize({ width: MAX_WIDTH, withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY })
    .toFile(destPath);
}

async function main() {
  if (!fs.existsSync(ARCHIVE_ROOT)) {
    console.log("database-archive/ not found, skipping thumbnail generation.");
    return;
  }

  const images = findAllImages(ARCHIVE_ROOT);
  let created = 0;
  let skipped = 0;

  for (const imagePath of images) {
    const thumbPath = toThumbPath(imagePath);

    if (fs.existsSync(thumbPath)) {
      const sourceMtime = fs.statSync(imagePath).mtimeMs;
      const thumbMtime = fs.statSync(thumbPath).mtimeMs;
      if (thumbMtime >= sourceMtime) {
        skipped++;
        continue;
      }
    }

    await generateThumb(imagePath, thumbPath);
    created++;
  }

  console.log(
    `Thumbnails: ${created} generated, ${skipped} up-to-date (${images.length} total images).`,
  );
}

main().catch((error) => {
  console.error("Thumbnail generation failed:", error);
  process.exit(1);
});
