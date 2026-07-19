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
import type { ArchiveProject, ProjectImage } from "@/lib/archive/types";

export interface InfiniteGridProps {
  projects: ArchiveProject[];
  itemGap: number;
  columns: number;
  targetTileArea: number;
  className?: string;
}

interface GridCellProps {
  cellKey: string;
  project: ArchiveProject;
  col: number;
  row: number;
  left: number;
  top: number;
  width: number;
  height: number;
  animateIn: boolean;
  isPending: boolean;
  isFocused: boolean;
}

interface FocusRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface FocusedCell {
  key: string;
  project: ArchiveProject;
  image: ProjectImage;
  fromRect: FocusRect;
}

const CLICK_MOVE_THRESHOLD_PX = 8;
const FOCUS_MAX_VIEWPORT_RATIO = 0.94;
const FOCUS_MAX_VIEWPORT_RATIO_MOBILE = 0.96;
const FOCUS_MOBILE_BREAKPOINT = 700;
const FOCUS_EASE_OUT = [0.22, 1, 0.36, 1] as const;
const FOCUS_EASE_IN_OUT = [0.45, 0.05, 0.25, 1] as const;
const FOCUS_TRANSITION_OPEN = {
  duration: 0.4,
  ease: FOCUS_EASE_OUT,
};
const FOCUS_TRANSITION_CLOSE = {
  duration: 0.48,
  ease: FOCUS_EASE_IN_OUT,
};
const BLUR_MS = 550;
const BACKDROP_FADE = {
  duration: 0.5,
  ease: FOCUS_EASE_IN_OUT,
};

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

function rectRelativeToViewport(
  cellEl: Element,
  viewportEl: HTMLElement,
): FocusRect {
  const viewportRect = viewportEl.getBoundingClientRect();
  const cellRect = cellEl.getBoundingClientRect();
  return {
    left: cellRect.left - viewportRect.left,
    top: cellRect.top - viewportRect.top,
    width: cellRect.width,
    height: cellRect.height,
  };
}

function sizeForEqualArea(
  aspect: number,
  targetArea: number,
  maxW: number,
  maxH: number,
): { width: number; height: number } {
  let width = Math.sqrt(targetArea * aspect);
  let height = Math.sqrt(targetArea / aspect);
  const fit = Math.min(1, maxW / width, maxH / height);
  width *= fit;
  height *= fit;
  return { width, height };
}

function focusMaxViewportRatio(viewportWidth: number): number {
  return viewportWidth < FOCUS_MOBILE_BREAKPOINT
    ? FOCUS_MAX_VIEWPORT_RATIO_MOBILE
    : FOCUS_MAX_VIEWPORT_RATIO;
}

function computeFocusTarget(
  image: ProjectImage,
  viewportWidth: number,
  viewportHeight: number,
): FocusRect {
  const ratio = focusMaxViewportRatio(viewportWidth);
  const maxW = viewportWidth * ratio;
  const maxH = viewportHeight * ratio;
  const aspect = image.width / Math.max(image.height, 1);
  // Fit as large as possible within the max box (contain). Series images
  // still share this hero's area via sizeForEqualArea below.
  let width = maxW;
  let height = width / aspect;
  if (height > maxH) {
    height = maxH;
    width = height * aspect;
  }
  return {
    left: (viewportWidth - width) / 2,
    top: (viewportHeight - height) / 2,
    width,
    height,
  };
}

const GridCell = memo(function GridCell({
  cellKey,
  project,
  col,
  row,
  left,
  top,
  width,
  height,
  animateIn,
  isPending,
  isFocused,
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
      data-cell-key={cellKey}
      style={{
        position: "absolute",
        left,
        top,
        width,
        height,
        overflow: "hidden",
        borderRadius: 4,
        contain: "layout paint",
        visibility: isFocused ? "hidden" : undefined,
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

const FOCUS_SERIES_GAP = 64;
const FOCUS_SCROLL_WASH_MAX = 0.5;

function isSameProjectImage(a: ProjectImage, b: ProjectImage): boolean {
  return a.fullSrc === b.fullSrc || a.src === b.src;
}

function FocusOverlay({
  focused,
  closing,
  viewportWidth,
  viewportHeight,
  onRequestClose,
  onCloseComplete,
}: {
  focused: FocusedCell;
  closing: boolean;
  viewportWidth: number;
  viewportHeight: number;
  onRequestClose: () => void;
  onCloseComplete: () => void;
}) {
  const target = computeFocusTarget(
    focused.image,
    viewportWidth,
    viewportHeight,
  );
  const [settled, setSettled] = useState(false);
  const [heroSrc, setHeroSrc] = useState(focused.image.src);
  const [scrollWash, setScrollWash] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const restImages = useMemo(
    () =>
      focused.project.images.filter(
        (image) => !isSameProjectImage(image, focused.image),
      ),
    [focused.project.images, focused.image],
  );

  useEffect(() => {
    let cancelled = false;
    const full = new window.Image();
    full.src = focused.image.fullSrc;
    if (full.complete) {
      setHeroSrc(focused.image.fullSrc);
      return;
    }
    full.onload = () => {
      if (!cancelled) setHeroSrc(focused.image.fullSrc);
    };
    return () => {
      cancelled = true;
    };
  }, [focused.image.fullSrc]);

  useLayoutEffect(() => {
    if (!closing) return;
    setSettled(false);
    setScrollWash(0);
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [closing]);

  const syncScrollWash = useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      setScrollWash(0);
      return;
    }
    const range = Math.max(viewportHeight * 1.7, 1);
    const t = Math.min(1, el.scrollTop / range);
    setScrollWash(t * FOCUS_SCROLL_WASH_MAX);
  }, [viewportHeight]);

  const showFloatingHero = !settled || closing;
  const showScroll = settled && !closing;
  const layoutTransition = closing
    ? FOCUS_TRANSITION_CLOSE
    : FOCUS_TRANSITION_OPEN;
  const animateTo = closing ? focused.fromRect : target;

  const handleScrollAreaClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if ((event.target as HTMLElement).closest("img")) return;
      onRequestClose();
    },
    [onRequestClose],
  );

  return (
    <div
      className="archive-focus-layer"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 10,
        pointerEvents: "auto",
      }}
    >
      <motion.div
        className="archive-focus-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: closing ? 0 : 1 }}
        transition={
          closing
            ? { duration: 0.38, ease: FOCUS_EASE_IN_OUT }
            : BACKDROP_FADE
        }
        onClick={onRequestClose}
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(255, 255, 255, 0.35)",
          cursor: "zoom-out",
        }}
      />
      <div
        className="archive-focus-scroll-wash"
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background: "#fff",
          opacity: scrollWash,
          pointerEvents: "none",
        }}
      />
      {showScroll ? (
        <div
          ref={scrollRef}
          className="archive-focus-scroll"
          onClick={handleScrollAreaClick}
          onScroll={syncScrollWash}
          style={{
            position: "absolute",
            inset: 0,
            overflowX: "hidden",
            overflowY: "auto",
            overscrollBehavior: "contain",
            touchAction: "pan-y",
            cursor: "zoom-out",
          }}
        >
          <div
            style={{
              width: viewportWidth * focusMaxViewportRatio(viewportWidth),
              margin: "0 auto",
              paddingTop: target.top,
              paddingBottom: Math.max(target.top, viewportHeight * 0.2),
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: FOCUS_SERIES_GAP,
              cursor: "default",
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={heroSrc}
              alt={focused.project.title}
              width={focused.image.width}
              height={focused.image.height}
              draggable={false}
              style={{
                width: target.width,
                height: target.height,
                objectFit: "contain",
                display: "block",
                userSelect: "none",
              }}
            />
            {restImages.map((image) => {
              const aspect = image.width / Math.max(image.height, 1);
              const targetArea = target.width * target.height;
              const ratio = focusMaxViewportRatio(viewportWidth);
              const maxW = viewportWidth * ratio;
              const maxH = viewportHeight * ratio;
              const { width, height } = sizeForEqualArea(
                aspect,
                targetArea,
                maxW,
                maxH,
              );
              return (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={image.fullSrc}
                  src={image.fullSrc}
                  alt={focused.project.title}
                  width={image.width}
                  height={image.height}
                  loading="lazy"
                  decoding="async"
                  draggable={false}
                  style={{
                    width,
                    height,
                    objectFit: "contain",
                    display: "block",
                    userSelect: "none",
                  }}
                />
              );
            })}
          </div>
        </div>
      ) : null}
      {showFloatingHero ? (
        <motion.div
          className="archive-focus-image"
          initial={
            closing
              ? {
                  left: target.left,
                  top: target.top,
                  width: target.width,
                  height: target.height,
                  borderRadius: 0,
                  boxShadow: "0 12px 40px 0 rgba(0, 0, 0, 0.18)",
                }
              : {
                  left: focused.fromRect.left,
                  top: focused.fromRect.top,
                  width: focused.fromRect.width,
                  height: focused.fromRect.height,
                  borderRadius: 4,
                  boxShadow: "0 0 0 0 rgba(0, 0, 0, 0)",
                }
          }
          animate={{
            left: animateTo.left,
            top: animateTo.top,
            width: animateTo.width,
            height: animateTo.height,
            borderRadius: closing ? 4 : 0,
            boxShadow: closing
              ? "0 0 0 0 rgba(0, 0, 0, 0)"
              : "0 12px 40px 0 rgba(0, 0, 0, 0.18)",
          }}
          transition={{
            left: layoutTransition,
            top: layoutTransition,
            width: layoutTransition,
            height: layoutTransition,
            borderRadius: layoutTransition,
            boxShadow: closing
              ? { duration: 0.3, ease: FOCUS_EASE_IN_OUT }
              : { duration: 0.4, ease: FOCUS_EASE_OUT },
          }}
          onAnimationComplete={() => {
            if (closing) {
              onCloseComplete();
              return;
            }
            setSettled(true);
          }}
          style={{
            position: "absolute",
            overflow: "hidden",
            pointerEvents: "none",
            willChange: "left, top, width, height",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={heroSrc}
            alt={focused.project.title}
            width={focused.image.width}
            height={focused.image.height}
            draggable={false}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "contain",
              display: "block",
              userSelect: "none",
              pointerEvents: "none",
            }}
          />
        </motion.div>
      ) : null}
    </div>
  );
}

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

  const [focused, setFocused] = useState<FocusedCell | null>(null);
  const [closing, setClosing] = useState(false);
  const [gridBlurred, setGridBlurred] = useState(false);
  const focusedRef = useRef<FocusedCell | null>(null);
  const closingRef = useRef(false);
  focusedRef.current = focused;
  closingRef.current = closing;

  const pointerDownRef = useRef<{ x: number; y: number } | null>(null);
  const didDragRef = useRef(false);

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

  const isFocusOpen = focused !== null;
  const isFocusLocked = isFocusOpen;

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

  const openFocusFromPoint = useCallback(
    (clientX: number, clientY: number) => {
      const viewportEl = viewportRef.current;
      if (!viewportEl) return;

      const hit = document.elementFromPoint(clientX, clientY);
      const cellEl = hit?.closest("[data-cell-key]") as HTMLElement | null;
      if (!cellEl) return;

      const key = cellEl.dataset.cellKey;
      if (!key) return;

      const [colStr, rowStr] = key.split(":");
      const col = Number(colStr);
      const row = Number(rowStr);
      if (!Number.isFinite(col) || !Number.isFinite(row)) return;

      const project = getProjectAt(col, row);
      const image = pickCellImage(project, col, row);
      const fromRect = rectRelativeToViewport(cellEl, viewportEl);

      setClosing(false);
      setGridBlurred(true);
      setFocused({ key, project, image, fromRect });
    },
    [getProjectAt],
  );

  const requestClose = useCallback(() => {
    const current = focusedRef.current;
    if (!current || closingRef.current) return;

    const viewportEl = viewportRef.current;
    const cellEl = viewportEl?.querySelector(
      `[data-cell-key="${current.key}"]`,
    );
    if (viewportEl && cellEl) {
      const fromRect = rectRelativeToViewport(cellEl, viewportEl);
      setFocused({ ...current, fromRect });
    }
    setGridBlurred(false);
    setClosing(true);
  }, []);

  const handleCloseComplete = useCallback(() => {
    setFocused(null);
    setClosing(false);
    setGridBlurred(false);
  }, []);

  const startDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (focusedRef.current) return;
      pointerDownRef.current = { x: event.clientX, y: event.clientY };
      didDragRef.current = false;
      dragControls.start(event);
    },
    [dragControls],
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (focusedRef.current) return;

      const down = pointerDownRef.current;
      pointerDownRef.current = null;
      if (!down || didDragRef.current) return;

      const dx = event.clientX - down.x;
      const dy = event.clientY - down.y;
      if (Math.hypot(dx, dy) > CLICK_MOVE_THRESHOLD_PX) return;

      openFocusFromPoint(event.clientX, event.clientY);
    },
    [openFocusFromPoint],
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
    if (focusedRef.current) {
      wheelDeltaRef.current = { dx: 0, dy: 0 };
      return;
    }
    const { dx, dy } = wheelDeltaRef.current;
    wheelDeltaRef.current = { dx: 0, dy: 0 };
    if (dx !== 0 || dy !== 0) {
      x.set(x.get() - dx);
      y.set(y.get() - dy);
    }
  }, [x, y]);

  const handleWheel = useCallback(
    (event: WheelEvent) => {
      if (focusedRef.current) return;
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

  useEffect(() => {
    if (!isFocusOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isFocusOpen, requestClose]);

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
      data-focused={isFocusLocked ? "true" : undefined}
      data-blurred={gridBlurred ? "true" : undefined}
      onPointerDown={startDrag}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => {
        pointerDownRef.current = null;
      }}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        overflow: "hidden",
        touchAction: "none",
        cursor: isFocusLocked
          ? "default"
          : isDragging
            ? "grabbing"
            : "grab",
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
        .archive-grid-viewport[data-focused="true"] .archive-grid-cell:hover {
          transform: none;
        }
        .archive-grid-layer {
          filter: blur(0px);
          opacity: 1;
          transition:
            filter ${BLUR_MS}ms cubic-bezier(0.45, 0.05, 0.25, 1),
            opacity ${BLUR_MS}ms cubic-bezier(0.45, 0.05, 0.25, 1);
        }
        .archive-grid-viewport[data-blurred="true"] .archive-grid-layer {
          filter: blur(12px);
          opacity: 0.85;
        }
        .archive-grid-viewport[data-focused="true"] .archive-grid-layer {
          pointer-events: none;
        }
      `}</style>
      <motion.div
        className="archive-grid-layer"
        drag={!isFocusLocked}
        dragControls={dragControls}
        dragListener={false}
        dragMomentum={!isFocusLocked}
        dragElastic={0}
        dragTransition={{ power: 0.3, timeConstant: 250 }}
        initial={false}
        onDragStart={() => {
          didDragRef.current = true;
          setIsDragging(true);
        }}
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
              cellKey={key}
              project={getProjectAt(col, row)}
              col={col}
              row={row}
              left={left}
              top={top}
              width={width}
              height={height}
              animateIn={animateInKeys.has(key)}
              isPending={!strictVisibleKeysRef.current.has(key)}
              isFocused={focused?.key === key}
            />
          );
        })}
      </motion.div>
      {focused ? (
        <FocusOverlay
          focused={focused}
          closing={closing}
          viewportWidth={viewport.width}
          viewportHeight={viewport.height}
          onRequestClose={requestClose}
          onCloseComplete={handleCloseComplete}
        />
      ) : null}
    </div>
  );
};
