"use client";

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  motion,
  useDragControls,
  useMotionValue,
  useMotionValueEvent,
} from "framer-motion";
import {
  buildGridLayout,
  computeVisibleCells,
  filterCellsByViewport,
  positiveMod,
  type PlacedCell,
} from "@/lib/archive/layout";
import { pickCellImage } from "@/lib/archive/pickCellImage";
import type { ArchiveProject } from "@/lib/archive/types";

export interface InfiniteGridProps {
  projects: ArchiveProject[];
  itemGap: number;
  columns: number;
  targetTileArea: number;
  className?: string;
}

interface GridCellProps {
  project: ArchiveProject;
  col: number;
  row: number;
  left: number;
  top: number;
  width: number;
  height: number;
  animateIn: boolean;
  isPending: boolean;
}

function cellKeysSignature(cells: PlacedCell[]): string {
  return cells
    .map(({ col, row }) => `${col}:${row}`)
    .sort()
    .join(",");
}

function readViewportSize(element: HTMLDivElement | null): {
  width: number;
  height: number;
} {
  const width = element?.clientWidth || window.innerWidth;
  const height = element?.clientHeight || window.innerHeight;
  return { width, height };
}

const GridCell = memo(function GridCell({
  project,
  col,
  row,
  left,
  top,
  width,
  height,
  animateIn,
  isPending,
}: GridCellProps) {
  const image = pickCellImage(project, col, row);
  const enterRef = useRef(animateIn);
  if (animateIn) {
    enterRef.current = true;
  }

  let className = "archive-grid-cell";
  if (enterRef.current) {
    className += " archive-grid-cell--enter";
  } else if (isPending) {
    className += " archive-grid-cell--pending";
  }

  return (
    <div
      className={className}
      style={{
        position: "absolute",
        left,
        top,
        width,
        height,
        overflow: "hidden",
        borderRadius: 4,
        contain: "layout paint",
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={image.src}
        alt={project.title}
        width={image.width}
        height={image.height}
        loading="lazy"
        decoding="async"
        draggable={false}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          display: "block",
          pointerEvents: "none",
          userSelect: "none",
        }}
      />
    </div>
  );
});

export const InfiniteGrid = ({
  projects,
  itemGap,
  columns,
  targetTileArea,
  className,
}: InfiniteGridProps) => {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState(() => readViewportSize(null));
  const [visibleCells, setVisibleCells] = useState<PlacedCell[]>([]);

  const rows = Math.ceil(projects.length / columns);

  const gridProjects = useMemo(() => {
    if (projects.length === 0) return [];
    const totalCells = rows * columns;
    const padded: ArchiveProject[] = [];
    for (let i = 0; i < totalCells; i++) {
      padded.push(projects[i % projects.length]);
    }
    return padded;
  }, [projects, rows, columns]);

  const layout = useMemo(
    () => buildGridLayout(gridProjects, columns, rows, targetTileArea, itemGap),
    [gridProjects, columns, rows, targetTileArea, itemGap],
  );

  const layoutRef = useRef(layout);
  const viewportSizeRef = useRef(viewport);
  const visibleKeysRef = useRef("");
  const strictKeysRef = useRef("");
  const prevStrictVisibleKeysRef = useRef<Set<string>>(new Set());
  const strictVisibleKeysRef = useRef<Set<string>>(new Set());
  const skipEntryAnimationRef = useRef(true);
  const panRafRef = useRef<number | null>(null);
  const [animateInKeys, setAnimateInKeys] = useState<Set<string>>(() => new Set());

  layoutRef.current = layout;
  viewportSizeRef.current = viewport;

  const getProjectAt = useCallback(
    (col: number, row: number): ArchiveProject => {
      const c = positiveMod(col, columns);
      const r = positiveMod(row, rows);
      return gridProjects[r * columns + c];
    },
    [columns, rows, gridProjects],
  );

  const [isDragging, setIsDragging] = useState(false);
  const dragControls = useDragControls();
  const x = useMotionValue(0);
  const y = useMotionValue(0);

  const syncGrid = useCallback(
    (panX: number, panY: number, force = false) => {
      const nextViewport = readViewportSize(viewportRef.current);
      viewportSizeRef.current = nextViewport;
      setViewport((current) =>
        current.width === nextViewport.width &&
        current.height === nextViewport.height
          ? current
          : nextViewport,
      );

      const pan = { x: panX, y: panY };
      const cells = computeVisibleCells(pan, nextViewport, layoutRef.current, 100);
      const strictCells = filterCellsByViewport(cells, pan, nextViewport, 0);
      const keys = cellKeysSignature(cells);
      const strictKeys = cellKeysSignature(strictCells);
      if (
        force ||
        keys !== visibleKeysRef.current ||
        strictKeys !== strictKeysRef.current
      ) {
        const strictKeySet = new Set(
          strictCells.map(({ col, row }) => `${col}:${row}`),
        );
        const animateIn = new Set<string>();

        if (!skipEntryAnimationRef.current) {
          strictKeySet.forEach((key) => {
            if (!prevStrictVisibleKeysRef.current.has(key)) {
              animateIn.add(key);
            }
          });
        } else {
          skipEntryAnimationRef.current = false;
        }

        strictVisibleKeysRef.current = strictKeySet;
        prevStrictVisibleKeysRef.current = strictKeySet;
        visibleKeysRef.current = keys;
        strictKeysRef.current = strictKeys;
        setAnimateInKeys(animateIn);
        setVisibleCells(cells);
      }
    },
    [],
  );

  useLayoutEffect(() => {
    syncGrid(x.get(), y.get(), true);
  }, [layout, syncGrid, x, y]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;

    const observer = new ResizeObserver(() => {
      syncGrid(x.get(), y.get(), true);
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, [syncGrid, x, y]);

  const startDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      dragControls.start(event);
    },
    [dragControls],
  );

  const scheduleVisibleCellsUpdate = useCallback(() => {
    if (panRafRef.current !== null) return;
    panRafRef.current = requestAnimationFrame(() => {
      panRafRef.current = null;
      syncGrid(x.get(), y.get());
    });
  }, [x, y, syncGrid]);

  useMotionValueEvent(x, "change", scheduleVisibleCellsUpdate);
  useMotionValueEvent(y, "change", scheduleVisibleCellsUpdate);

  useEffect(() => {
    return () => {
      if (panRafRef.current !== null) {
        cancelAnimationFrame(panRafRef.current);
      }
    };
  }, []);

  const wheelDeltaRef = useRef({ dx: 0, dy: 0 });
  const wheelRafRef = useRef<number | null>(null);

  const applyWheelDelta = useCallback(() => {
    wheelRafRef.current = null;
    const { dx, dy } = wheelDeltaRef.current;
    wheelDeltaRef.current = { dx: 0, dy: 0 };
    if (dx !== 0 || dy !== 0) {
      x.set(x.get() - dx);
      y.set(y.get() - dy);
    }
  }, [x, y]);

  const handleWheel = useCallback(
    (event: WheelEvent) => {
      event.preventDefault();
      wheelDeltaRef.current.dx += event.deltaX;
      wheelDeltaRef.current.dy += event.deltaY;
      if (wheelRafRef.current === null) {
        wheelRafRef.current = requestAnimationFrame(applyWheelDelta);
      }
    },
    [applyWheelDelta],
  );

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;

    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      element.removeEventListener("wheel", handleWheel);
      if (wheelRafRef.current !== null) {
        cancelAnimationFrame(wheelRafRef.current);
      }
    };
  }, [handleWheel]);

  if (gridProjects.length === 0) {
    return (
      <div
        ref={viewportRef}
        className={className}
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          overflow: "hidden",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#666",
          fontFamily: "system-ui, sans-serif",
          fontSize: 14,
        }}
      >
        No images found in database-archive/
      </div>
    );
  }

  return (
    <div
      ref={viewportRef}
      className={className}
      data-dragging={isDragging ? "true" : undefined}
      onPointerDown={startDrag}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        overflow: "hidden",
        touchAction: "none",
        cursor: isDragging ? "grabbing" : "grab",
      }}
    >
      <style>{`
        .archive-grid-cell {
          transition: transform 0.2s ease;
        }
        .archive-grid-cell--enter {
          animation: archive-cell-fade-in 1s ease forwards;
        }
        .archive-grid-cell--pending {
          opacity: 0;
        }
        @keyframes archive-cell-fade-in {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }
        .archive-grid-cell:hover {
          transform: scale(1.03);
        }
        .archive-grid-viewport[data-dragging="true"] .archive-grid-cell {
          transition: none;
        }
        .archive-grid-viewport[data-dragging="true"] .archive-grid-cell:hover {
          transform: none;
        }
      `}</style>
      <motion.div
        drag
        dragControls={dragControls}
        dragListener={false}
        dragMomentum
        dragElastic={0}
        dragTransition={{ power: 0.3, timeConstant: 250 }}
        initial={false}
        onDragStart={() => setIsDragging(true)}
        onDragEnd={() => setIsDragging(false)}
        style={{
          x,
          y,
          position: "absolute",
          inset: 0,
          willChange: "transform",
        }}
      >
        {visibleCells.map(({ col, row, left, top, width, height }) => {
          const key = `${col}:${row}`;
          return (
            <GridCell
              key={key}
              project={getProjectAt(col, row)}
              col={col}
              row={row}
              left={left}
              top={top}
              width={width}
              height={height}
              animateIn={animateInKeys.has(key)}
              isPending={!strictVisibleKeysRef.current.has(key)}
            />
          );
        })}
      </motion.div>
    </div>
  );
};
