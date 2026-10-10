import { dataTableRows } from "./data-table.js";
import { useState } from "react";
import type { NormalizedEvent } from "@agentlens/contracts";
import { InspectorEventContent } from "./InspectorEventContent.js";
import type { InspectorEventGroup } from "./inspector-view-model.js";
import type { TraceTreeMeasurement, TraceGroupUsage } from "./trace-tree-model.js";

interface InspectorStepProps {
  group: InspectorEventGroup;
  details: Record<string, NormalizedEvent>;
  loading: boolean;
  error: string;
  measurement: TraceTreeMeasurement | undefined;
  groupMeasurement: TraceTreeMeasurement | undefined;
  usageScope: "group" | "session";
  groupUsage: TraceGroupUsage | undefined;
}

export function InspectorStep({ group, details, loading, error, measurement, groupMeasurement, usageScope, groupUsage }: InspectorStepProps): JSX.Element {
  const [tab, setTab] = useState<"Preview" | "Usage" | "Data">("Usage");
  const [dataView, setDataView] = useState<"Raw" | "Table">("Raw");
  const event = details[group.event.eventId] ?? group.event;
  const call = group.call ? details[group.call.eventId] ?? group.call : undefined;
  const result = group.result ? details[group.result.eventId] ?? group.result : undefined;
  const usage = event.modelUsage;
  const seconds = measurement?.durationSeconds;
  const groupSeconds = groupMeasurement?.durationSeconds;
  const durationShare = seconds != null && groupSeconds != null && groupSeconds > 0 ? Math.min(100, Math.max(0, seconds / groupSeconds * 100)) : null;
  const tokenShare = usageScope === "session" && measurement?.tokens != null && groupMeasurement?.tokens != null && groupMeasurement.tokens > 0 ? Math.min(100, measurement.tokens / groupMeasurement.tokens * 100) : null;
  const formatSeconds = (value: number): string => value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return <section className="inspector-step" aria-label="Selected step details">
    <header className="inspector-step-head">
      <h2>{call ? `Tool operation · ${call.toolName || call.toolType || "tool"}` : usage ? `Model call · ${usage.model}` : event.eventKind === "reasoning" ? "Reasoning" : event.eventKind === "user" ? "User message" : event.eventKind === "assistant" ? "Assistant message" : event.eventKind}</h2>
      <div className="inspector-step-meta mono">
        <span>#{event.index} · {event.eventKind}</span>
        <span>{event.timestampMs == null ? "Time unavailable" : new Date(event.timestampMs).toLocaleString()}</span>
        <span title={measurement?.durationEstimated ? "Estimated gap to the next event, including waiting time" : "Elapsed span of linked events"}>{measurement?.durationEstimated ? "~" : ""}{measurement?.durationSeconds?.toLocaleString(undefined, { maximumFractionDigits: 2 }) ?? "—"} s</span>
        {measurement?.tokens != null && <span>{measurement.tokens.toLocaleString()} recorded tokens</span>}
      </div>
    </header>
    <div className="inspector-step-tabs" aria-label="Step detail views">
      {(["Usage", "Preview", "Data"] as const).map(name => <button key={name} type="button" aria-pressed={tab === name} onClick={() => setTab(name)}>{name}</button>)}
    </div>
    <div className="inspector-step-content">
      {tab !== "Preview" && loading && <p role="status">Loading full step details…</p>}
      {tab !== "Preview" && error && <p role="alert">{error}</p>}
      {tab === "Preview" && <div className="inspector-preview">{usage ? <section className="inspector-preview-summary">
        <h3>Model call usage</h3>
        <p>{usage.model} consumed {usage.totalTokens.toLocaleString()} recorded tokens: {usage.inputTokens.toLocaleString()} input and {usage.outputTokens.toLocaleString()} output.</p>
        <p className="subtle">The tree groups nearby events around this usage checkpoint. This grouping is inferred.</p>
        <button type="button" className="event-text-button" onClick={() => setTab("Usage")}>View token breakdown</button>
      </section> : <InspectorEventContent event={event} call={call} result={result} expanded loading={loading} error={error} />}</div>}
      {tab === "Usage" && <>
        <h3>Recorded usage</h3>
        {usage ? <><dl className="inspector-step-usage inspector-usage-grid">
          <div className="inspector-usage-card usage-model"><dt><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10v10H7V7m3-4v4m4-4v4m-4 10v4m4-4v4M3 10h4m-4 4h4m10-4h4m-4 4h4" /></svg>Model</dt><dd>{usage.model}</dd></div>
          <div className="inspector-usage-card usage-input"><dt><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M4 15v5h16v-5" /></svg>Input tokens</dt><dd>{usage.inputTokens.toLocaleString()}</dd></div>
          <div className="inspector-usage-card usage-cache"><dt><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7l8-4 8 4-8 4-8-4m0 0v10l8 4 8-4V7m-8 4v10" /></svg>Cached input</dt><dd>{usage.cachedInputTokens.toLocaleString()}</dd></div>
          <div className="inspector-usage-card usage-output"><dt><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3m-4 4 4-4 4 4M4 15v5h16v-5" /></svg>Output tokens</dt><dd>{usage.outputTokens.toLocaleString()}</dd></div>
          <div className="inspector-usage-card usage-total"><dt><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14M5 12h14M5 19h14m-7-17v20" /></svg>Total tokens</dt><dd>{usage.totalTokens.toLocaleString()}</dd></div>
          <div className="inspector-usage-card usage-cost"><dt><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18m5-14c-1-3-10-3-10 1 0 5 10 3 10 8 0 4-9 4-10 1" /></svg>Cost</dt><dd>{usage.costUsd == null ? "Unavailable" : usage.costUsd.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 4 })}</dd></div>
        </dl><p className="subtle">Cached input is included in input tokens. Event grouping into model calls is inferred.</p></> : <p>{measurement?.tokens != null ? `${measurement.tokens.toLocaleString()} tokens summed from recorded model calls in this loaded branch.` : "No model token usage was recorded for this step. Check its model-call parent for usage."}</p>}
        {tokenShare != null && <section className="inspector-token-share" aria-label="Session token consumption">
          <p>{measurement!.tokens!.toLocaleString()} of {groupMeasurement!.tokens!.toLocaleString()} session tokens · {tokenShare.toLocaleString(undefined, { maximumFractionDigits: 1 })}%</p>
          <progress className="inspector-duration-bar" aria-label="Share of session tokens" value={tokenShare} max={100} />
        </section>}
        <section className="inspector-duration-usage" aria-label="Duration usage">
          <h3>Time in this {usageScope}</h3>
          {seconds != null ? <>
            <div className="inspector-group-share">
              <div><span>Duration</span><span>{measurement?.durationEstimated ? "~" : ""}{formatSeconds(seconds)} s{groupSeconds != null && <> of {formatSeconds(groupSeconds)} s {usageScope} duration</>}{durationShare != null && <> · {durationShare.toLocaleString(undefined, { maximumFractionDigits: 1 })}%</>}</span></div>
              {durationShare != null && <progress className="inspector-duration-bar" aria-label={`Share of ${usageScope} duration`} value={durationShare} max={100} />}
            </div>
            <p className="subtle">Elapsed time includes waiting. {measurement?.durationEstimated || groupMeasurement?.durationEstimated ? "Some durations use the gap to the next event." : usageScope === "session" ? "Session duration spans its first and last recorded events." : "Group duration covers the loaded trace span."}</p>
          </> : <p className="subtle">Duration unavailable for this step.</p>}
          {seconds != null && durationShare == null && <p className="subtle">A percentage requires a recorded {usageScope} duration greater than zero.</p>}
        </section>
        {usage && groupUsage && <section className="inspector-group-shares" aria-label="Model call share of group usage">
          <h3>Consumption in this group</h3>
          {([
            { label: "Input tokens", value: usage.inputTokens, total: groupUsage.inputTokens },
            { label: "Output tokens", value: usage.outputTokens, total: groupUsage.outputTokens },
            { label: "Cached input", value: usage.cachedInputTokens, total: groupUsage.cachedInputTokens },
            { label: "Cost", value: usage.costUsd, total: groupUsage.costUsd },
          ]).map(({ label, value, total }) => {
            const percent = value != null && total != null && total > 0 ? Math.min(100, Math.max(0, value / total * 100)) : null;
            const format = (amount: number): string => label === "Cost" ? amount.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 4 }) : amount.toLocaleString();
            return <div className="inspector-group-share" key={label}>
              <div><span>{label}</span><span>{value == null ? "Unavailable" : format(value)}{total != null && <> of {format(total)}</>}{percent != null && <> · {percent.toLocaleString(undefined, { maximumFractionDigits: 1 })}%</>}</span></div>
              {percent != null ? <progress className="inspector-duration-bar" aria-label={`Share of group ${label.toLowerCase()}`} value={percent} max={100} /> : <p className="subtle">{total === 0 ? "No recorded consumption in this group." : "Group total unavailable; some usage is unpriced."}</p>}
            </div>;
          })}
          <p className="subtle">Compared with recorded model calls in the loaded group. Cached input is included in input tokens.</p>
        </section>}
        <p className="subtle">Usage covers loaded events only. Missing counts are not estimated from text.</p>
      </>}
      {tab === "Data" && <>
        <div className="inspector-data-tabs" aria-label="Data format">
          {(["Raw", "Table"] as const).map(name => <button key={name} type="button" aria-pressed={dataView === name} onClick={() => setDataView(name)}>{name}</button>)}
        </div>
        {!loading && !error && (call && result ? [call, result] : [event]).map(item => <section className="inspector-data-section" key={item.eventId}>
          <h3>#{item.index} · {item.eventKind}</h3>
          {dataView === "Raw" ? <pre className="event-raw-json">{JSON.stringify(item.raw, null, 2)}</pre> : <table className="inspector-data-table" aria-label={`Event #${item.index} data`}>
            <thead><tr><th scope="col">Field</th><th scope="col">Value</th></tr></thead>
            <tbody>{dataTableRows(item.raw).map(row => <tr key={row.field}><th scope="row">{row.field}</th><td>{row.value}</td></tr>)}</tbody>
          </table>}
        </section>)}
      </>}
    </div>
  </section>;
}
