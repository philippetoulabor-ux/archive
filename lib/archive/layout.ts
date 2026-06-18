import { pickCellImage } from "./pickCellImage";
import type { ArchiveProject } from "./types";

export function positiveMod(value: number, modulus: number): number {
  if (modulus === 0) return 0;
  return ((value % modulus) + modulus) % modulus;
}

export function getCycle(index: number, period: number): number {
  const remainder = positiveMod(index, period);
  return (index - remainder) / period;
}

export function computeTileSize(
  thumbnailWidth: number,
  thumbnailHeight: number,
  targetTileArea: number,
): { width: number; height: number } {
  const aspectRatio = thumbnailWidth / thumbnailHeight;
  return {
    width: Math.sqrt(targetTileArea * aspectRatio),
    height: Math.sqrt(targetTileArea / aspectRatio),
  };
}

export interface GridLayout {
  columns: number;
  rows: number;
  itemGap: number;
  patternWidth: number;
  columnWidth: number[];
  columnLeft: number[];
  patternHeight: number[];
  gridProjects: ArchiveProject[];
  targetTileArea: number;
  tileSizeCache: Map<string, { width: number; height: number }>;
  tileTopCache: Map<string, number>;
}

function getProjectAt(
  col: number,
  row: number,
  layout: GridLayout,
): ArchiveProject {
  const localCol = positiveMod(col, layout.columns);
  const localRow = positiveMod(row, layout.rows);
  return layout.gridProjects[localRow * layout.columns + localCol];
}

function getTileSize(
  col: number,
  row: number,
  layout: GridLayout,
): { width: number; height: number } {
  const key = `${col}:${row}`;
  const cached = layout.tileSizeCache.get(key);
  if (cached) return cached;

  const project = getProjectAt(col, row, layout);
  const image = pickCellImage(project, col, row);
  const size = computeTileSize(image.width, image.height, layout.targetTileArea);
  layout.tileSizeCache.set(key, size);
  return size;
}

export function buildGridLayout(
  gridProjects: ArchiveProject[],
  columns: number,
  rows: number,
  targetTileArea: number,
  itemGap: number,
): GridLayout {
  const columnWidth: number[] = [];
  const columnLeft: number[] = [];
  const patternHeight: number[] = [];

  let globalMaxWidth = 0;

  for (let c = 0; c < columns; c++) {
    let top = 0;

    for (let r = 0; r < rows; r++) {
      const project = gridProjects[r * columns + c];
      const image = pickCellImage(project, c, r);
      const size = computeTileSize(image.width, image.height, targetTileArea);

      globalMaxWidth = Math.max(globalMaxWidth, size.width);
      top += size.height + itemGap;
    }

    patternHeight[c] = top;
  }

  for (let c = 0; c < columns; c++) {
    columnWidth[c] = globalMaxWidth;
  }

  let left = 0;
  for (let c = 0; c < columns; c++) {
    columnLeft[c] = left;
    left += globalMaxWidth + itemGap;
  }

  const patternWidth = left;

  return {
    columns,
    rows,
    itemGap,
    patternWidth,
    columnWidth,
    columnLeft,
    patternHeight,
    gridProjects,
    targetTileArea,
    tileSizeCache: new Map(),
    tileTopCache: new Map(),
  };
}

function getLocalIndices(col: number, row: number, layout: GridLayout) {
  return {
    localCol: positiveMod(col, layout.columns),
    localRow: positiveMod(row, layout.rows),
  };
}

export function getTileWidth(col: number, row: number, layout: GridLayout): number {
  return getTileSize(col, row, layout).width;
}

export function getTileHeight(col: number, row: number, layout: GridLayout): number {
  return getTileSize(col, row, layout).height;
}

export function getTileTop(col: number, row: number, layout: GridLayout): number {
  const key = `${col}:${row}`;
  const cached = layout.tileTopCache.get(key);
  if (cached !== undefined) return cached;

  let top: number;
  if (row === 0) {
    top = 0;
  } else if (row > 0) {
    top =
      getTileTop(col, row - 1, layout) +
      getTileHeight(col, row - 1, layout) +
      layout.itemGap;
  } else {
    top =
      getTileTop(col, row + 1, layout) -
      getTileHeight(col, row, layout) -
      layout.itemGap;
  }

  layout.tileTopCache.set(key, top);
  return top;
}

export function getTileLeft(col: number, row: number, layout: GridLayout): number {
  const { localCol } = getLocalIndices(col, row, layout);
  const colCycle = getCycle(col, layout.columns);
  const baseLeft = colCycle * layout.patternWidth + layout.columnLeft[localCol];
  const tileW = getTileWidth(col, row, layout);
  return baseLeft + (layout.columnWidth[localCol] - tileW) / 2;
}

export interface PlacedCell {
  col: number;
  row: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

export function computeVisibleCells(
  pan: { x: number; y: number },
  viewport: { width: number; height: number },
  layout: GridLayout,
  buffer = 100,
): PlacedCell[] {
  if (viewport.width <= 0 || viewport.height <= 0) return [];

  const xMin = -pan.x - buffer;
  const xMax = -pan.x + viewport.width + buffer;
  const yMin = -pan.y - buffer;
  const yMax = -pan.y + viewport.height + buffer;

  const avgColStep = layout.patternWidth / layout.columns;
  const colStart = Math.floor(xMin / avgColStep) - 2;
  const colEnd = Math.ceil(xMax / avgColStep) + 2;

  const cells: PlacedCell[] = [];

  for (let col = colStart; col <= colEnd; col++) {
    const localCol = positiveMod(col, layout.columns);
    const colLeft = getCycle(col, layout.columns) * layout.patternWidth + layout.columnLeft[localCol];
    const colRight = colLeft + layout.columnWidth[localCol];

    if (colRight < xMin || colLeft > xMax) continue;

    const avgRowStep = layout.patternHeight[localCol] / layout.rows;
    const rowStart = Math.floor(yMin / avgRowStep) - 2;
    const rowEnd = Math.ceil(yMax / avgRowStep) + 2;

    for (let row = rowStart; row <= rowEnd; row++) {
      const left = getTileLeft(col, row, layout);
      const top = getTileTop(col, row, layout);
      const width = getTileWidth(col, row, layout);
      const height = getTileHeight(col, row, layout);

      if (left + width < xMin || left > xMax) continue;
      if (top + height < yMin || top > yMax) continue;

      cells.push({ col, row, left, top, width, height });
    }
  }

  return cells;
}
