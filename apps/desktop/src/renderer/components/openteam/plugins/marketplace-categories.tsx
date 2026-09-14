import { PLUGIN_MARKETPLACE_CATEGORIES } from "@openteam/client-core/plugin-marketplace";
import { ChevronDown } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../../../lib/cn";
import { visiblePluginCategoryCount } from "../../../lib/plugin-category-layout";

const chip =
  "inline-flex h-7 shrink-0 cursor-pointer items-center justify-center gap-1 whitespace-nowrap rounded-full border border-black/[0.06] bg-black/[0.04] px-2.5 text-[13px] leading-4 text-foreground-secondary outline-none transition-colors duration-120 ease-out hover:bg-black/[0.08] focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:border-white/[0.06] dark:bg-white/[0.04] dark:hover:bg-white/[0.08]";

export function MarketplaceCategories({
  category,
  onChange,
}: {
  category: string;
  onChange: (value: string) => void;
}) {
  const measure = useRef<HTMLDivElement>(null);
  const extraId = useId();
  const [visibleCount, setVisibleCount] = useState(6);
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    const row = measure.current;
    const container = row?.parentElement;
    if (!row || !container) return;
    const update = () => {
      if (!container.clientWidth) return;
      const widths = [...row.querySelectorAll<HTMLElement>("[data-category-measure]")].map(
        (item) => item.offsetWidth
      );
      const toggleWidth = Math.max(
        ...[...row.querySelectorAll<HTMLElement>("[data-category-toggle]")].map(
          (item) => item.offsetWidth
        )
      );
      setVisibleCount(visiblePluginCategoryCount(container.clientWidth, widths, 8, toggleWidth));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    observer.observe(row);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const selected = PLUGIN_MARKETPLACE_CATEGORIES.findIndex((item) => item === category);
    if (selected >= visibleCount) setExpanded(true);
  }, [category, visibleCount]);
  const renderCategory = (item: string) => (
    <button
      aria-pressed={category === item}
      className={cn(
        chip,
        category === item &&
          "border-transparent bg-foreground text-background hover:bg-foreground/90 dark:border-transparent dark:bg-foreground dark:text-background dark:hover:bg-foreground/90"
      )}
      key={item}
      onClick={() => onChange(category === item ? "All" : item)}
      type="button"
    >
      {item}
    </button>
  );
  return (
    <div className="relative mt-3 grid shrink-0 gap-2" role="group" aria-label="Plugin categories">
      <div className="flex min-w-0 gap-2">
        {PLUGIN_MARKETPLACE_CATEGORIES.slice(0, visibleCount).map(renderCategory)}
        {visibleCount < PLUGIN_MARKETPLACE_CATEGORIES.length && (
          <button
            aria-expanded={expanded}
            aria-controls={expanded ? extraId : undefined}
            className={chip}
            type="button"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Hide" : "More"}
            <ChevronDown
              className={cn("size-3 transition-transform duration-120 ease-out", expanded && "rotate-180")}
            />
          </button>
        )}
      </div>
      {expanded && visibleCount < PLUGIN_MARKETPLACE_CATEGORIES.length && (
        <div className="flex flex-wrap gap-2" id={extraId}>
          {PLUGIN_MARKETPLACE_CATEGORIES.slice(visibleCount).map(renderCategory)}
        </div>
      )}
      <div
        aria-hidden="true"
        className="pointer-events-none invisible absolute inset-0 overflow-hidden"
      >
        <div className="flex w-max gap-2" ref={measure}>
          {PLUGIN_MARKETPLACE_CATEGORIES.map((item) => (
            <span className={chip} data-category-measure key={item}>
              {item}
            </span>
          ))}
          <span className={chip} data-category-toggle>
            More
            <ChevronDown className="size-3" />
          </span>
          <span className={chip} data-category-toggle>
            Hide
            <ChevronDown className="size-3" />
          </span>
        </div>
      </div>
    </div>
  );
}
