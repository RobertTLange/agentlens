/* @vitest-environment happy-dom */

import { render } from "@testing-library/react";
import { useCallback } from "react";
import { describe, expect, it, vi } from "vitest";
import { useListReorderAnimation } from "./useListReorderAnimation.js";

function makeRect(top: number): DOMRect {
  return {
    x: 0,
    y: top,
    width: 200,
    height: 24,
    top,
    right: 200,
    bottom: top + 24,
    left: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

interface ReorderHarnessProps {
  parentTop: number;
  itemTop: number;
  parentScrollTop: number;
}

function ReorderHarness({ parentTop, itemTop, parentScrollTop }: ReorderHarnessProps): JSX.Element {
  const { bindItemRef } = useListReorderAnimation<HTMLDivElement>(["row-a"]);
  const bindHookItemRef = bindItemRef("row-a");

  const bindParentRef = useCallback(
    (node: HTMLDivElement | null): void => {
      if (!node) return;
      Object.defineProperty(node, "scrollTop", {
        configurable: true,
        writable: true,
        value: parentScrollTop,
      });
      Object.defineProperty(node, "getBoundingClientRect", {
        configurable: true,
        value: () => makeRect(parentTop),
      });
    },
    [parentScrollTop, parentTop],
  );

  const bindItemRefWithRect = useCallback(
    (node: HTMLDivElement | null): void => {
      bindHookItemRef(node);
      if (!node) return;
      Object.defineProperty(node, "getBoundingClientRect", {
        configurable: true,
        value: () => makeRect(itemTop),
      });
    },
    [bindHookItemRef, itemTop],
  );

  return (
    <div ref={bindParentRef}>
      <div ref={bindItemRefWithRect} />
    </div>
  );
}

describe("useListReorderAnimation", () => {
  it("does not animate when parent container shifts but relative row position stays fixed", () => {
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    const { rerender } = render(<ReorderHarness parentTop={100} itemTop={140} parentScrollTop={24} />);
    rafSpy.mockClear();

    rerender(<ReorderHarness parentTop={124} itemTop={164} parentScrollTop={24} />);

    expect(rafSpy).not.toHaveBeenCalled();
    rafSpy.mockRestore();
  });

  it("animates when row position changes within its parent container", () => {
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    const { rerender } = render(<ReorderHarness parentTop={100} itemTop={140} parentScrollTop={24} />);
    rafSpy.mockClear();

    rerender(<ReorderHarness parentTop={124} itemTop={172} parentScrollTop={24} />);

    expect(rafSpy).toHaveBeenCalled();
    rafSpy.mockRestore();
  });
});

