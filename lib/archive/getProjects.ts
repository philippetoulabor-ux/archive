import fs from "fs";
import path from "path";
import sharp from "sharp";
import type { ArchiveProject, ProjectImage } from "./types";

const IMAGE_EXTENSIONS = new Set([".webp", ".jpg", ".jpeg", ".png"]);

const EXCLUDED_SLUGS = new Set(["logo", "_thumbs", "buttons"]);

function shouldSkipDir(name: string): boolean {
  return name.startsWith("_") || EXCLUDED_SLUGS.has(name);
}

function humanizeSlug(slug: string): string {
  return slug
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

const THUMB_ROOT = path.join(process.cwd(), "public/database-archive-thumbs");

function toPublicSrc(baseUrl: string, relativePath: string): string {
  return `/${baseUrl}/${relativePath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

function toImageSrc(archiveRoot: string, fullPath: string): string {
  const relativePath = path.relative(archiveRoot, fullPath).split(path.sep).join("/");
  return toPublicSrc("database-archive", relativePath);
}

function toThumbSrc(archiveRoot: string, fullPath: string): string {
  const relativePath = path.relative(archiveRoot, fullPath);
  const parsed = path.parse(relativePath);
  const thumbRelative = path.join(parsed.dir, `${parsed.name}.webp`).split(path.sep).join("/");
  return toPublicSrc("database-archive-thumbs", thumbRelative);
}

function resolveThumbFile(archiveRoot: string, imagePath: string): string | null {
  const relativePath = path.relative(archiveRoot, imagePath);
  const parsed = path.parse(relativePath);
  const thumbFile = path.join(THUMB_ROOT, parsed.dir, `${parsed.name}.webp`);
  return fs.existsSync(thumbFile) ? thumbFile : null;
}

function resolveImageSrc(archiveRoot: string, imagePath: string): string {
  if (resolveThumbFile(archiveRoot, imagePath)) {
    return toThumbSrc(archiveRoot, imagePath);
  }
  return toImageSrc(archiveRoot, imagePath);
}

async function readImageDimensions(
  archiveRoot: string,
  imagePath: string,
): Promise<{ width: number; height: number }> {
  const thumbFile = resolveThumbFile(archiveRoot, imagePath);
  const metadata = await sharp(thumbFile ?? imagePath).rotate().metadata();
  return {
    width: metadata.width ?? 1,
    height: metadata.height ?? 1,
  };
}

function findAllImages(dir: string): string[] {
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));

  const images: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name)) {
        continue;
      }
      images.push(...findAllImages(fullPath));
      continue;
    }

    if (entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      images.push(fullPath);
    }
  }

  return images;
}

export async function getArchiveProjects(): Promise<ArchiveProject[]> {
  const archiveRoot = path.join(process.cwd(), "database-archive");

  if (!fs.existsSync(archiveRoot)) {
    return [];
  }

  const slugs = fs
    .readdirSync(archiveRoot, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && !shouldSkipDir(entry.name),
    )
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const projects: ArchiveProject[] = [];

  for (const slug of slugs) {
    const projectDir = path.join(archiveRoot, slug);
    const imagePaths = findAllImages(projectDir);

    if (imagePaths.length === 0) {
      continue;
    }

    const images: ProjectImage[] = await Promise.all(
      imagePaths.map(async (imagePath) => {
        const dimensions = await readImageDimensions(archiveRoot, imagePath);
        return {
          src: resolveImageSrc(archiveRoot, imagePath),
          width: dimensions.width,
          height: dimensions.height,
        };
      }),
    );

    projects.push({
      slug,
      title: humanizeSlug(slug),
      images,
    });
  }

  return projects;
}
