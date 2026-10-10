import { useState } from "react";
import type { NormalizedEvent } from "@agentlens/contracts";
import { inspectorEventText } from "./inspector-view-model.js";

interface InspectorEventContentProps {
  event: NormalizedEvent;
  call: NormalizedEvent | undefined;
  result: NormalizedEvent | undefined;
  expanded: boolean;
  loading: boolean;
  error: string;
}

function ReadableSection({ title, event }: { title: string; event: NormalizedEvent }): JSX.Element {
  const [copyStatus, setCopyStatus] = useState("");
  const text = inspectorEventText(event);
  return (
    <section className="event-readable-section">
      <div className="event-readable-head">
        <strong>{title}</strong>
        <button type="button" className="event-text-button" onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopyStatus("Copied");
          } catch {
            setCopyStatus("Copy unavailable. Select the text to copy it.");
          }
        }}>Copy {title.toLowerCase()}</button>
      </div>
      {copyStatus && <span className="event-copy-status" role="status">{copyStatus}</span>}
      <pre className={`event-readable-text ${event.eventKind === "tool_use" || event.eventKind === "tool_result" ? "event-code-text" : ""}`}>{text || "No readable content recorded"}</pre>
      <details className="event-raw-details">
        <summary>View raw JSON · #{event.index}</summary>
        <pre className="event-raw-json">{JSON.stringify(event.raw, null, 2)}</pre>
      </details>
    </section>
  );
}

export function InspectorEventContent({ event, call, result, expanded, loading, error }: InspectorEventContentProps): JSX.Element {
  const isTool = !!call || !!result;
  const toolName = call?.toolName || call?.functionName || call?.toolType || result?.toolType || "tool";
  const title = isTool
    ? call ? `Tool operation · ${toolName}` : `Unmatched tool result · ${toolName}`
    : event.eventKind === "reasoning" && (!event.preview || event.preview === "[]")
      ? "Reasoning text unavailable"
      : event.eventKind === "compaction" ? `Context compacted · ${event.preview}` : event.preview;
  return (
    <>
      <h3>{title}</h3>
      {isTool && <div className="event-operation-status">
        {result ? result.hasError ? "Error recorded" : "Result received" : "No result in the loaded events"}
        {result && !call && <span>Call is outside the loaded events or hidden by filters.</span>}
        {call && <span>{`Call #${call.index} · ${call.timestampMs === null ? "Time unavailable" : new Date(call.timestampMs).toLocaleString()}`}</span>}
        {result && <span>{`Result #${result.index} · ${result.timestampMs === null ? "Time unavailable" : new Date(result.timestampMs).toLocaleString()}`}</span>}
      </div>}
      {expanded && <div className="event-readable-details">
        {loading && <div className="event-raw-status" role="status">Loading readable details…</div>}
        {error && <div className="event-raw-status" role="alert">{error}</div>}
        {!loading && !error && (isTool ? <>
          {call && <ReadableSection title="Input" event={call} />}
          {result && <ReadableSection title="Output" event={result} />}
        </> : <ReadableSection title={event.eventKind === "compaction" ? "Context reduction" : "Message"} event={event} />)}
      </div>}
    </>
  );
}
