export interface ProjectImage {
  src: string;
  fullSrc: string;
  width: number;
  height: number;
}

export interface ArchiveProject {
  slug: string;
  title: string;
  images: ProjectImage[];
}
