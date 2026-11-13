import { type ComponentType, createElement, lazy } from "react";

/**
 * A lazily loaded component that renders straight away once its code is in.
 *
 * `React.lazy` suspends on its first render even when the module has already been fetched,
 * and React then holds the fallback for its 300 ms reveal throttle. Settings preloads every
 * section when it opens, so after that the component renders synchronously.
 */
export function preloadable<P extends object>(load: () => Promise<{ default: ComponentType<P> }>) {
  let loaded: ComponentType<P> | undefined;
  let pending: Promise<ComponentType<P>> | undefined;
  const preload = () =>
    (pending ??= load().then((module) => {
      loaded = module.default;
      return module.default;
    }));
  const Lazy = lazy(() => preload().then((component) => ({ default: component })));
  function Preloaded(props: P) {
    return createElement(loaded ?? Lazy, props);
  }
  return { Component: Preloaded, preload };
}
