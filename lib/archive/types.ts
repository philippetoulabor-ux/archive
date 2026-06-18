export interface ProjectImage {
  src: string;
  width: number;
  height: number;
}

export interface ArchiveProject {
  slug: string;
  title: string;
  images: ProjectImage[];
}
