import { useCallback, useEffect, useRef } from "react";

const DEFAULT_REORDER_TRANSITION = "transform 380ms cubic-bezier(0.2, 0.9, 0.2, 1)";

function reducedMotionPreferred(): boolean {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export interface UseListReorderAnimationOptions {
  reorderTransition?: string;
  resetKey?: string;
}

export interface ListReorderAnimation<T extends HTMLElement> {
  bindItemRef: (itemId: string) => (node: T | null) => void;
  removeItem: (itemId: string) => void;
}

export function useListReorderAnimation<T extends HTMLElement>(
  itemIds: string[],
  options: UseListReorderAnimationOptions = {},
): ListReorderAnimation<T> {
  const itemRefs = useRef<Map<string, T>>(new Map());
  const prevTopByItemId = useRef<Map<string, number>>(new Map());
  const reorderTransition = options.reorderTransition ?? DEFAULT_REORDER_TRANSITION;

  useEffect(() => {
    prevTopByItemId.current = new Map();
  }, [options.resetKey]);

  useEffect(() => {
    const nextTopByItemId = new Map<string, number>();
    for (const itemId of itemIds) {
      const node = itemRefs.current.get(itemId);
      if (!node) continue;
      nextTopByItemId.set(itemId, node.getBoundingClientRect().top);
    }

    if (reducedMotionPreferred()) {
      prevTopByItemId.current = nextTopByItemId;
      return;
    }

    if (prevTopByItemId.current.size > 0) {
      for (const itemId of itemIds) {
        const node = itemRefs.current.get(itemId);
        const nextTop = nextTopByItemId.get(itemId);
        const prevTop = prevTopByItemId.current.get(itemId);
        if (!node || nextTop === undefined || prevTop === undefined) continue;

        const deltaY = prevTop - nextTop;
        if (Math.abs(deltaY) < 0.5) continue;

        node.style.transition = "none";
        node.style.transform = `translateY(${deltaY}px)`;
        node.style.willChange = "transform";
        void node.getBoundingClientRect();
        requestAnimationFrame(() => {
          node.style.transition = reorderTransition;
          node.style.transform = "translateY(0)";
          node.addEventListener(
            "transitionend",
            () => {
              node.style.transition = "";
              node.style.transform = "";
              node.style.willChange = "";
            },
            { once: true },
          );
        });
      }
    }

    prevTopByItemId.current = nextTopByItemId;
  }, [itemIds, reorderTransition]);

  const bindItemRef = useCallback(
    (itemId: string) =>
      (node: T | null): void => {
        if (!node) {
          itemRefs.current.delete(itemId);
          return;
        }
        itemRefs.current.set(itemId, node);
      },
    [],
  );

  const removeItem = useCallback((itemId: string): void => {
    itemRefs.current.delete(itemId);
    prevTopByItemId.current.delete(itemId);
  }, []);

  return {
    bindItemRef,
    removeItem,
  };
}
