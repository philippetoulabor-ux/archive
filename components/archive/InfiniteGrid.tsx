"use client";

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
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
/** Soft crossfade so thumb→full sharpening isn't a visible flash. */
const FOCUS_FULL_FADE_MS = 1100;
const FOCUS_FULL_FADE_EASE = "cubic-bezier(0.33, 0, 0.2, 1)";
/** In-memory cache so thumb→full upgrades survive floating→scroll remounts. */
const loadedFullSrcs = new Set<string>();

function isSameProjectImage(a: ProjectImage, b: ProjectImage): boolean {
  return a.fullSrc === b.fullSrc || a.src === b.src;
}

function preloadImage(src: string): void {
  if (!src || loadedFullSrcs.has(src)) return;
  const img = new window.Image();
  img.decoding = "async";
  img.onload = () => {
    loadedFullSrcs.add(src);
  };
  img.src = src;
}

/**
 * Thumb stays visible; full fades in on top once decoded.
 * Never swaps `src` on a single img (that reads as a flash).
 */
function ProgressiveFocusImage({
  thumbSrc,
  fullSrc,
  alt,
  width,
  height,
  displayWidth,
  displayHeight,
  priority,
  allowFull = true,
  objectFit = "contain",
}: {
  thumbSrc: string;
  fullSrc: string;
  alt: string;
  width: number;
  height: number;
  displayWidth: number;
  displayHeight: number;
  priority?: boolean;
  /** When false, keep showing only the thumb (e.g. during open morph). */
  allowFull?: boolean;
  objectFit?: "contain" | "cover";
}) {
  const sameSrc = fullSrc === thumbSrc;
  const [fullReady, setFullReady] = useState(
    () => sameSrc || loadedFullSrcs.has(fullSrc),
  );
  const [fullOpaque, setFullOpaque] = useState(false);

  useEffect(() => {
    if (sameSrc) {
      setFullReady(true);
      return;
    }
    let cancelled = false;
    const img = new window.Image();
    img.decoding = "async";
    const markReady = async () => {
      loadedFullSrcs.add(fullSrc);
      try {
        if (typeof img.decode === "function") {
          await img.decode();
        }
      } catch {
        // decode() can reject on abort; still paint via onload path
      }
      if (!cancelled) setFullReady(true);
    };
    img.onload = () => {
      void markReady();
    };
    img.src = fullSrc;
    if (img.complete) void markReady();
    return () => {
      cancelled = true;
    };
  }, [sameSrc, fullSrc]);

  useEffect(() => {
    if (!allowFull || !fullReady || sameSrc) {
      setFullOpaque(false);
      return;
    }
    // Mount full at opacity 0, then fade — avoids a one-frame opaque flash.
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setFullOpaque(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [allowFull, fullReady, sameSrc]);

  const frameStyle: CSSProperties = {
    position: "relative",
    width: displayWidth,
    height: displayHeight,
    flexShrink: 0,
    contentVisibility: priority ? undefined : "auto",
    containIntrinsicSize: `${Math.round(displayWidth)}px ${Math.round(displayHeight)}px`,
  };

  const imgStyle: CSSProperties = {
    width: "100%",
    height: "100%",
    objectFit,
    display: "block",
    userSelect: "none",
    pointerEvents: "none",
  };

  return (
    <div style={frameStyle}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={thumbSrc}
        alt={alt}
        width={width}
        height={height}
        decoding="sync"
        draggable={false}
        style={imgStyle}
      />
      {!sameSrc && allowFull && fullReady ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={fullSrc}
          alt=""
          width={width}
          height={height}
          decoding="async"
          fetchPriority={priority ? "high" : "auto"}
          draggable={false}
          aria-hidden
          style={{
            ...imgStyle,
            position: "absolute",
            inset: 0,
            opacity: fullOpaque ? 1 : 0,
            transition: `opacity ${FOCUS_FULL_FADE_MS}ms ${FOCUS_FULL_FADE_EASE}`,
            willChange: "opacity",
          }}
        />
      ) : null}
    </div>
  );
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
  // Keep floating hero mounted one frame after scroll mounts to avoid a blank handoff.
  const [hideFloating, setHideFloating] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const washRef = useRef<HTMLDivElement>(null);
  const scrollRafRef = useRef<number | null>(null);
  const openHandledRef = useRef(false);

  const restImages = useMemo(
    () =>
      focused.project.images.filter(
        (image) => !isSameProjectImage(image, focused.image),
      ),
    [focused.project.images, focused.image],
  );

  // Warm full-res images as soon as the overlay opens (hero first).
  // Floating morph stays on the grid thumb so mid-animation src swaps can't blank it.
  useEffect(() => {
    preloadImage(focused.image.fullSrc);
    const schedule =
      typeof window !== "undefined" && "requestIdleCallback" in window
        ? (cb: () => void) => window.requestIdleCallback(cb)
        : (cb: () => void) => window.setTimeout(cb, 80);
    const cancel =
      typeof window !== "undefined" && "cancelIdleCallback" in window
        ? (id: number) => window.cancelIdleCallback(id)
        : (id: number) => window.clearTimeout(id);
    const id = schedule(() => {
      for (const image of restImages) {
        preloadImage(image.fullSrc);
      }
    });
    return () => {
      cancel(id as number);
    };
  }, [focused.image.fullSrc, restImages]);

  useLayoutEffect(() => {
    if (!closing) return;
    openHandledRef.current = false;
    setSettled(false);
    setHideFloating(false);
    if (washRef.current) washRef.current.style.opacity = "0";
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [closing]);

  useLayoutEffect(() => {
    if (!settled || closing) return;
    let outer = 0;
    let inner = 0;
    outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setHideFloating(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [settled, closing]);

  const syncScrollWash = useCallback(() => {
    if (scrollRafRef.current != null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const el = scrollRef.current;
      const wash = washRef.current;
      if (!el || !wash) return;
      const range = Math.max(viewportHeight * 1.7, 1);
      const t = Math.min(1, el.scrollTop / range);
      wash.style.opacity = String(t * FOCUS_SCROLL_WASH_MAX);
    });
  }, [viewportHeight]);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current != null) {
        cancelAnimationFrame(scrollRafRef.current);
      }
    };
  }, []);

  const showScroll = settled && !closing;
  const showFloatingHero = closing || !hideFloating;
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
          background: "rgba(255, 255, 255, 0.75)",
          cursor: "zoom-out",
        }}
      />
      <div
        ref={washRef}
        className="archive-focus-scroll-wash"
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background: "#fff",
          opacity: 0,
          pointerEvents: "none",
          willChange: "opacity",
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
            <ProgressiveFocusImage
              thumbSrc={focused.image.src}
              fullSrc={focused.image.fullSrc}
              alt={focused.project.title}
              width={focused.image.width}
              height={focused.image.height}
              displayWidth={target.width}
              displayHeight={target.height}
              priority
              allowFull={hideFloating}
            />
            {restImages.map((image, index) => {
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
                <ProgressiveFocusImage
                  key={image.fullSrc}
                  thumbSrc={image.src}
                  fullSrc={image.fullSrc}
                  alt={focused.project.title}
                  width={image.width}
                  height={image.height}
                  displayWidth={width}
                  displayHeight={height}
                  priority={index < 2}
                  allowFull={hideFloating}
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
            // Framer can fire once per animated value; only settle once.
            if (openHandledRef.current) return;
            openHandledRef.current = true;
            setSettled(true);
          }}
          style={{
            position: "absolute",
            overflow: "hidden",
            pointerEvents: "none",
            willChange: "left, top, width, height",
            // Match grid tile crop during morph; target box is image-aspect so
            // cover ≈ contain at the end.
            zIndex: 2,
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={focused.image.src}
            alt={focused.project.title}
            width={focused.image.width}
            height={focused.image.height}
            decoding="sync"
            draggable={false}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
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
    setClosing(true);
  }, []);

  const handleCloseComplete = useCallback(() => {
    setFocused(null);
    setClosing(false);
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
