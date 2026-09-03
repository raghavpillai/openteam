const BLOCKED_PREVIEW_ELEMENTS =
  "script,style,iframe,object,embed,form,input,button,textarea,select,link,meta";

export const sanitizePreviewDocument = (value: string) => {
  const document = new DOMParser().parseFromString(value, "text/html");
  for (const element of document.querySelectorAll(BLOCKED_PREVIEW_ELEMENTS)) element.remove();
  for (const element of document.querySelectorAll<HTMLElement>("*")) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || name === "srcdoc") element.removeAttribute(attribute.name);
      if (
        ["href", "src"].includes(name) &&
        !/^(?:https?:|data:image\/|#|\/)/i.test(attribute.value)
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  }
  return document.body;
};

type TraversalFrame = {
  next: ChildNode | null;
  target: Node;
};

type ProgressiveRenderOptions = {
  cancelFrame?: (handle: number) => void;
  frameBudgetMs?: number;
  maxNodesPerFrame?: number;
  now?: () => number;
  onComplete?: () => void;
  scheduleFrame?: (callback: FrameRequestCallback) => number;
};

/**
 * Rebuilds a sanitized DOM tree in bounded animation-frame slices. Shallow
 * cloning preserves the exact hierarchy and attributes without ever handing a
 * large subtree to Chromium for insertion in one task.
 */
export const renderSanitizedDocumentProgressively = (
  source: ParentNode,
  target: HTMLElement,
  {
    cancelFrame = (handle) => cancelAnimationFrame(handle),
    frameBudgetMs = 4,
    maxNodesPerFrame = 320,
    now = () => performance.now(),
    onComplete,
    scheduleFrame = (callback) => requestAnimationFrame(callback),
  }: ProgressiveRenderOptions = {}
) => {
  target.replaceChildren();
  const stack: TraversalFrame[] = [{ next: source.firstChild, target }];
  let cancelled = false;
  let frameHandle: number | null = null;

  const renderBatch = () => {
    frameHandle = null;
    if (cancelled) return;
    const startedAt = now();
    let renderedNodes = 0;

    while (stack.length > 0 && renderedNodes < maxNodesPerFrame) {
      if (renderedNodes > 0 && now() - startedAt >= frameBudgetMs) break;
      const frame = stack.at(-1);
      if (!frame) break;
      const sourceNode = frame.next;
      if (!sourceNode) {
        stack.pop();
        continue;
      }

      frame.next = sourceNode.nextSibling;
      const targetNode = sourceNode.cloneNode(false);
      frame.target.appendChild(targetNode);
      renderedNodes += 1;
      if (sourceNode.firstChild) {
        stack.push({ next: sourceNode.firstChild, target: targetNode });
      }
    }

    if (stack.length > 0) frameHandle = scheduleFrame(renderBatch);
    else onComplete?.();
  };

  renderBatch();
  return () => {
    cancelled = true;
    if (frameHandle !== null) cancelFrame(frameHandle);
  };
};
