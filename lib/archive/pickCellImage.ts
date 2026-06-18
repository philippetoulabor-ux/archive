import type { ArchiveProject, ProjectImage } from "./types";

function hashString(value: string): number {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 33) ^ value.charCodeAt(i);
  }
  return Math.abs(hash);
}

export function pickCellImage(
  project: ArchiveProject,
  col: number,
  row: number,
): ProjectImage {
  const index = hashString(`${col}:${row}:${project.slug}`) % project.images.length;
  return project.images[index];
}
