import { CircleHelp, Film, Image as ImageIcon, Music, Type } from "lucide-react";
import { cn } from "../../lib/cn";

/**
 * How a message's photos share one row, as in the reference: every photo keeps
 * its shape at one height (at most 200, the shortest photo's own height when
 * smaller, never under 64). When they don't fit, the row folds to at most three
 * tiles and the last one counts the photos left over.
 */
export const IMAGE_ROW = { height: 200, minHeight: 64, gap: 6, maxFoldedTiles: 3, defaultAspect: 4 / 3 } as const;

export interface ImageRowPlan {
  height: number;
  widths: number[];
  /** Photos behind the last tile's "+N", counting that tile's own photo; 0 when nothing folds. */
  foldedCount: number;
}

type Size = { width?: number; height?: number } | null | undefined;

const aspectOf = (size: Size) =>
  !size?.width || !size.height || size.width <= 0 || size.height <= 0 ? IMAGE_ROW.defaultAspect : size.width / size.height;
const ceilingOf = (size: Size) =>
  !size?.height || size.height <= 0 ? IMAGE_ROW.height : Math.max(Math.min(size.height, IMAGE_ROW.height), IMAGE_ROW.minHeight);
const occupied = (aspects: number[], count: number, height: number, gap: number) => {
  let total = Math.max(0, count - 1) * gap;
  for (let index = 0; index < count; index++) total += Math.round(height * (aspects[index] ?? 0));
  return total;
};
const widthsAt = (aspects: number[], count: number, height: number, available: number) =>
  Array.from({ length: count }, (_, index) => Math.min(Math.round(height * (aspects[index] ?? 0)), available));
const fittedHeight = (aspects: number[], ceilings: number[], count: number, available: number, gap: number) => {
  let height: number = IMAGE_ROW.height;
  let aspectSum = 0;
  for (let index = 0; index < count; index++) {
    height = Math.min(height, ceilings[index] ?? IMAGE_ROW.height);
    aspectSum += aspects[index] ?? 0;
  }
  if (aspectSum <= 0) return 0;
  const room = available - Math.max(0, count - 1) * gap;
  for (height = Math.min(height, Math.ceil(room / aspectSum)); height > 0 && occupied(aspects, count, height, gap) > available; ) height--;
  return height;
};

export function planImageRow(sizes: readonly Size[], available: number, gap: number = IMAGE_ROW.gap): ImageRowPlan {
  const count = sizes.length;
  if (available <= 0) return { height: IMAGE_ROW.height, widths: [], foldedCount: count };
  const aspects = sizes.map(aspectOf);
  const ceilings = sizes.map(ceilingOf);
  const ceiling = ceilings.reduce((lowest, value) => Math.min(lowest, value), IMAGE_ROW.height as number);
  if (occupied(aspects, count, ceiling, gap) <= available) {
    return { height: ceiling, widths: widthsAt(aspects, count, ceiling, available), foldedCount: 0 };
  }
  for (let tiles = Math.min(IMAGE_ROW.maxFoldedTiles, count); tiles > 1; tiles--) {
    const height = fittedHeight(aspects, ceilings, tiles, available, gap);
    if (height >= IMAGE_ROW.minHeight) {
      return { height, widths: widthsAt(aspects, tiles, height, available), foldedCount: tiles < count ? count - (tiles - 1) : 0 };
    }
  }
  const height = ceilings[0] ?? IMAGE_ROW.height;
  return { height, widths: widthsAt(aspects, Math.min(1, count), height, available), foldedCount: count > 1 ? count : 0 };
}

/** The width a message's photo row may take in a chat column, as in the reference. */
export const imageRowWidth = (column: number) => Math.max(0, Math.min(column * 0.8, 560, column - 82));

/** "658B", "74kB", "1.2MB": the reference's compact attachment sizes. */
export function formatAttachmentSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  const units = ["byte", "kilobyte", "megabyte", "gigabyte"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return new Intl.NumberFormat("en", {
    style: "unit",
    unit: units[unit],
    unitDisplay: "narrow",
    maximumFractionDigits: unit === 0 || value >= 10 ? 0 : 1,
  }).format(value);
}

export type FileGlyphVariant =
  | "pdf" | "docx" | "ppt" | "spreadsheet" | "keynote" | "generic" | "json"
  | "zip" | "image" | "video" | "audio" | "font" | "unknown";

const EXTENSION_VARIANTS: Record<string, FileGlyphVariant> = {
  doc: "docx", docx: "docx", key: "keynote", numbers: "spreadsheet", odp: "ppt", ods: "spreadsheet",
  odt: "docx", otf: "font", pages: "docx", ppt: "ppt", pptx: "ppt", rtf: "docx", ttf: "font",
  woff: "font", woff2: "font",
  pdf: "pdf", zip: "zip", gz: "zip", tgz: "zip", tar: "zip", "7z": "zip", rar: "zip",
  json: "json", csv: "spreadsheet", tsv: "spreadsheet", xls: "spreadsheet", xlsx: "spreadsheet",
  md: "generic", markdown: "generic", txt: "generic", log: "generic", html: "generic", xml: "generic",
  yaml: "generic", yml: "generic", js: "generic", ts: "generic", py: "generic", swift: "generic",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", heic: "image", svg: "image",
  mp4: "video", mov: "video", m4v: "video", webm: "video", mkv: "video",
  mp3: "audio", m4a: "audio", wav: "audio", aac: "audio", ogg: "audio", flac: "audio",
};

/** The reference picks a file's icon from its name; a name with no known extension is "unknown". */
export function fileGlyphVariant(fileName: string): FileGlyphVariant {
  const dot = fileName.lastIndexOf(".");
  return EXTENSION_VARIANTS[dot > 0 ? fileName.slice(dot + 1).toLowerCase() : ""] ?? "unknown";
}

const STRIPES: Partial<Record<FileGlyphVariant, string>> = {
  pdf: "bg-[#fb2b3e] dark:bg-[#fc2c3e]",
  docx: "bg-[#1680f3] dark:bg-[#116dd2]",
  keynote: "bg-[#1680f3] dark:bg-[#116dd2]",
  ppt: "bg-[#ee620d] dark:bg-[#cd5309]",
  spreadsheet: "bg-[#10ab61] dark:bg-[#0e9f5a]",
};
const INK = "rounded-[2px] bg-[#1c1c1c2e] dark:bg-[#f5f5f53d]";

/** A 40pt paper icon for a file, drawn like the reference's: lines of ink and a colored band by type. */
export function FileGlyph({ variant, className }: { variant: FileGlyphVariant; className?: string }) {
  const stripe = STRIPES[variant];
  const Glyph =
    variant === "image" ? ImageIcon : variant === "video" ? Film : variant === "audio" ? Music
      : variant === "font" ? Type : variant === "unknown" ? CircleHelp : null;
  return (
    <span aria-hidden className={cn("relative grid size-10 shrink-0 place-items-center", className)} data-variant={variant}>
      <span className="relative flex h-10 w-8 flex-col overflow-hidden rounded-[6px] bg-white shadow-[0_0_0_0.5px_#1c1c1c1f,0_2px_6px_0_rgba(28,28,28,0.06)] dark:bg-[#2c2c2c] dark:shadow-[0_0_0_0.5px_#f5f5f529]">
        {Glyph ? (
          <span className="grid flex-1 place-items-center text-[#1c1c1c85] dark:text-[#f5f5f580]">
            {variant === "unknown" ? (
              <span className="text-[17px] font-normal leading-none text-[#1c1c1c85] dark:text-[#f5f5f580]">?</span>
            ) : (
              <Glyph className="size-4" strokeWidth={1.8} />
            )}
          </span>
        ) : variant === "zip" ? (
          <span className="flex flex-1 flex-col items-center gap-[3px] pt-1">
            {[0, 1, 2, 3, 4].map((index) => (
              <span className={cn("h-[3px] w-[5px]", INK, index % 2 ? "translate-x-[2.5px]" : "-translate-x-[2.5px]")} key={index} />
            ))}
          </span>
        ) : (
          <span className={cn("flex flex-col gap-[3px] p-1", stripe ? "h-7" : "flex-1")}>
            <span className={cn("h-1 w-6", INK)} />
            {stripe ? (
              <span className="flex h-[11px] gap-[2px]">
                <span className="flex w-[11px] flex-col gap-[3px]">
                  <span className={cn("h-1 w-[11px]", INK)} />
                  <span className={cn("h-1 w-[11px]", INK)} />
                </span>
                <span className={cn("h-[11px] w-[11px]", INK)} />
              </span>
            ) : (
              <>
                <span className={cn("h-1 w-5", INK)} />
                <span className={cn("h-1 w-6", INK)} />
                <span className={cn("h-1 w-4", INK)} />
              </>
            )}
          </span>
        )}
        {stripe ? <span className={cn("h-3 w-8", stripe)} /> : null}
      </span>
    </span>
  );
}
