import { describe, expect, test } from "bun:test";
import { renderSanitizedDocumentProgressively } from "../../src/renderer/components/openteam/document-preview/progressive-dom";

class TestNode {
  children: TestNode[] = [];
  parent: TestNode | null = null;

  constructor(readonly value: string) {}

  get firstChild() {
    return this.children[0] ?? null;
  }

  get nextSibling() {
    if (!this.parent) return null;
    const index = this.parent.children.indexOf(this);
    return this.parent.children[index + 1] ?? null;
  }

  appendChild(child: TestNode) {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  cloneNode() {
    return new TestNode(this.value);
  }

  replaceChildren() {
    this.children = [];
  }
}

const node = (value: string, ...children: TestNode[]) => {
  const parent = new TestNode(value);
  for (const child of children) parent.appendChild(child);
  return parent;
};

const signature = (value: TestNode): string =>
  `${value.value}[${value.children.map(signature).join(",")}]`;

const asParentNode = (value: TestNode) => value as unknown as ParentNode;
const asElement = (value: TestNode) => value as unknown as HTMLElement;

describe("progressive document preview DOM rendering", () => {
  test("rebuilds the exact full hierarchy over bounded frames without mutating the source", () => {
    const source = node(
      "source",
      ...Array.from({ length: 8 }, (_, index) => node(`p${index}`, node(`text${index}`)))
    );
    const target = node("target", node("stale"));
    const sourceBefore = signature(source);
    const scheduled: FrameRequestCallback[] = [];
    let completed = 0;

    renderSanitizedDocumentProgressively(asParentNode(source), asElement(target), {
      maxNodesPerFrame: 3,
      now: () => 0,
      onComplete: () => {
        completed += 1;
      },
      scheduleFrame: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
    });

    expect(target.children.length).toBeLessThan(source.children.length);
    while (scheduled.length > 0) scheduled.shift()?.(0);
    expect(signature(target).replace("target", "source")).toBe(sourceBefore);
    expect(signature(source)).toBe(sourceBefore);
    expect(completed).toBe(1);
  });

  test("cancels queued work when the preview closes", () => {
    const source = node("source", node("one"), node("two"), node("three"));
    const target = node("target");
    const scheduled: FrameRequestCallback[] = [];
    const cancelled: number[] = [];
    let completed = false;

    const stop = renderSanitizedDocumentProgressively(asParentNode(source), asElement(target), {
      cancelFrame: (handle) => cancelled.push(handle),
      maxNodesPerFrame: 1,
      now: () => 0,
      onComplete: () => {
        completed = true;
      },
      scheduleFrame: (callback) => {
        scheduled.push(callback);
        return 41;
      },
    });
    stop();
    scheduled.shift()?.(0);

    expect(cancelled).toEqual([41]);
    expect(target.children.map((child) => child.value)).toEqual(["one"]);
    expect(completed).toBe(false);
  });
});
