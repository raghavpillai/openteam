import {
  forwardRef,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { ControlMotion } from "./control-motion";
import { LoadingOrb } from "./loading-orb";
import "./button-primitive.css";

export type ButtonPrimitiveProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  loading?: boolean;
  loadingLabel?: ReactNode;
  loadingSize?: number;
};

/** Shared indicator, also usable in controls with a dedicated trailing slot. */
export function ButtonLoadingIndicator({ size = 20 }: { size?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [theme, setTheme] = useState<"dark" | "light" | "auto">("auto");
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    // Keep the library's native palette readable on both ordinary and inverted
    // controls, including custom plugin fills. Canvas resolves any CSS color.
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    const update = () => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = getComputedStyle(element).color;
      context.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data;
      setTheme(r * 0.2126 + g * 0.7152 + b * 0.0722 > 128 ? "dark" : "light");
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class"],
    });
    const control = element.closest("button, [role=menuitem]");
    if (control) {
      observer.observe(control, {
        attributes: true,
        attributeFilter: ["class", "style", "disabled"],
      });
      // Disabled fills often transition from inverted ink to ordinary ink.
      // The first layout effect sees the starting color of that transition.
      control.addEventListener("transitionend", update);
    }
    return () => {
      observer.disconnect();
      control?.removeEventListener("transitionend", update);
    };
  }, []);
  return (
    <span
      aria-hidden="true"
      className="button-loading-indicator"
      ref={ref}
      style={{ width: size, height: size }}
    >
      <LoadingOrb aria-hidden size={size} state="searching" theme={theme} />
    </span>
  );
}

/** Native button behavior and custom styles, with shared loading and width motion. */
export const ButtonPrimitive = forwardRef<HTMLButtonElement, ButtonPrimitiveProps>(
  function ButtonPrimitive(
    { children, disabled, loading = false, loadingLabel, loadingSize, ...props },
    ref
  ) {
    return (
      <ControlMotion>
        <button
          {...props}
          aria-busy={loading || props["aria-busy"]}
          disabled={disabled || loading}
          ref={ref}
        >
          {loading && <ButtonLoadingIndicator size={loadingSize} />}
          {loading ? (loadingLabel ?? children) : children}
        </button>
      </ControlMotion>
    );
  }
);
