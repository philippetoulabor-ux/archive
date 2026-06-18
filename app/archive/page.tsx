import dynamic from "next/dynamic";
import { getArchiveProjects } from "@/lib/archive/getProjects";

const InfiniteGrid = dynamic(
  () =>
    import("@/components/archive/InfiniteGrid").then((mod) => mod.InfiniteGrid),
  { ssr: false },
);

export default function ArchivePage() {
  const projects = getArchiveProjects();

  return (
    <main
      style={{
        width: "100vw",
        height: "100vh",
        margin: 0,
        padding: 0,
        backgroundColor: "#ffffff",
      }}
    >
      <InfiniteGrid
        projects={projects}
        itemGap={50}
        columns={4}
        targetTileArea={160 * 150 * 2}
        className="archive-grid-viewport"
      />
    </main>
  );
}
