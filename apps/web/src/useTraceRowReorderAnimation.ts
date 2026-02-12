import { useCallback, useEffect, useRef } from "react";

const SESSION_REORDER_TRANSITION = "transform 360ms cubic-bezier(0.2, 0.9, 0.2, 1)";

function reducedMotionPreferred(): boolean {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export interface TraceRowReorderAnimation {
  bindTraceRowRef: (traceId: string) => (node: HTMLDivElement | null) => void;
  removeTraceRow: (traceId: string) => void;
}

export function useTraceRowReorderAnimation(traceIds: string[]): TraceRowReorderAnimation {
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const prevRowTopByTraceId = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const nextRowTopByTraceId = new Map<string, number>();
    for (const traceId of traceIds) {
      const row = rowRefs.current.get(traceId);
      if (!row) continue;
      nextRowTopByTraceId.set(traceId, row.getBoundingClientRect().top);
    }

    if (reducedMotionPreferred()) {
      prevRowTopByTraceId.current = nextRowTopByTraceId;
      return;
    }

    if (prevRowTopByTraceId.current.size > 0) {
      for (const traceId of traceIds) {
        const row = rowRefs.current.get(traceId);
        const nextTop = nextRowTopByTraceId.get(traceId);
        const prevTop = prevRowTopByTraceId.current.get(traceId);
        if (!row || nextTop === undefined || prevTop === undefined) continue;

        const deltaY = prevTop - nextTop;
        if (Math.abs(deltaY) < 0.5) continue;

        row.style.transition = "none";
        row.style.transform = `translateY(${deltaY}px)`;
        row.style.willChange = "transform";
        void row.getBoundingClientRect();
        requestAnimationFrame(() => {
          row.style.transition = SESSION_REORDER_TRANSITION;
          row.style.transform = "translateY(0)";
          row.addEventListener(
            "transitionend",
            () => {
              row.style.transition = "";
              row.style.transform = "";
              row.style.willChange = "";
            },
            { once: true },
          );
        });
      }
    }

    prevRowTopByTraceId.current = nextRowTopByTraceId;
  }, [traceIds]);

  const bindTraceRowRef = useCallback(
    (traceId: string) =>
      (node: HTMLDivElement | null): void => {
        if (!node) {
          rowRefs.current.delete(traceId);
          return;
        }
        rowRefs.current.set(traceId, node);
      },
    [],
  );

  const removeTraceRow = useCallback((traceId: string): void => {
    rowRefs.current.delete(traceId);
    prevRowTopByTraceId.current.delete(traceId);
  }, []);

  return {
    bindTraceRowRef,
    removeTraceRow,
  };
}
