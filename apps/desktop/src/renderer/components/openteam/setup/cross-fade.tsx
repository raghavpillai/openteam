import { useLayoutEffect, useRef, useState } from "react";

/**
 * Text that cross-fades when it changes: the old words fade out in the same spot while
 * the new ones fade in (layers share one grid cell; see .setup-xfade in setup.css).
 */
export function CrossFade({ value, className }: { value: string; className?: string }) {
  const [layers, setLayers] = useState([{ id: 0, value }]);
  const shown = useRef(value);
  const next = useRef(0);
  useLayoutEffect(() => {
    if (shown.current === value) return;
    shown.current = value;
    next.current += 1;
    const id = next.current;
    setLayers((current) => [...current.slice(-1), { id, value }]);
    const timer = window.setTimeout(() => setLayers((current) => current.slice(-1)), 260);
    return () => window.clearTimeout(timer);
  }, [value]);
  return (
    <span className={className ? `setup-xfade ${className}` : "setup-xfade"}>
      {layers.map((layer, index) => {
        const leaving = index < layers.length - 1;
        return (
          <span aria-hidden={leaving || undefined} data-leaving={leaving} key={layer.id}>
            {layer.value}
          </span>
        );
      })}
    </span>
  );
}
