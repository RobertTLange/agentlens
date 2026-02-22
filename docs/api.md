# HTTP API

Base URL (default): `http://127.0.0.1:8787`

## Endpoints

| Endpoint | Description |
| --- | --- |
| `GET /api/healthz` | Health check |
| `GET /api/overview` | Aggregate counters and distributions |
| `GET /api/perf` | Index refresh timings, watcher stats, retention stats |
| `GET /api/traces?agent=<name>&limit=<n>` | Trace summaries |
| `GET /api/trace/:id` | Trace detail by trace id or session id (`limit`, `before`, `include_meta`) |
| `POST /api/trace/:id/stop` | Stop session process (`force=true` optional) |
| `POST /api/trace/:id/open` | Focus/open terminal target for trace |
| `POST /api/trace/:id/input` | Send text input to session process |
| `GET /api/tracefile?path=<base64url>` | Ad-hoc trace detail from absolute file path token |
| `GET /api/config` | Current merged runtime config |
| `POST /api/config` | Merge + persist config and refresh index |
| `GET /api/stream` | SSE stream (`snapshot`, `trace_*`, `events_appended`, `overview_updated`, `heartbeat`) |

## Common Query Params

### `GET /api/trace/:id`

- `limit` (int, max 5000)
- `before` (cursor)
- `include_meta` (`0|1|true|false`)

### `GET /api/traces`

- `agent` (filter by agent id)
- `limit` (default bounded server-side)

### `GET /api/tracefile`

- `path` required, base64url-encoded absolute path
- optional: `limit`, `before`, `include_meta`

## Response Notes

- successful trace endpoints return `TracePage` shape: `summary`, `events`, `toc`, `nextBefore`, `liveCursor`
- unknown trace/session id: `404`
- invalid ad-hoc token/path: `400`
- missing ad-hoc file: `404`
- process resolution failures for stop/open/input: typically `409`

## Examples

Get overview:

```bash
curl "http://127.0.0.1:8787/api/overview"
```

Inspect latest traces:

```bash
curl "http://127.0.0.1:8787/api/traces?limit=20"
```

Load a trace by id/session id:

```bash
curl "http://127.0.0.1:8787/api/trace/<id_or_session>?limit=500&include_meta=0"
```

Stop/open/input:

```bash
curl -X POST "http://127.0.0.1:8787/api/trace/<id_or_session>/stop"
curl -X POST "http://127.0.0.1:8787/api/trace/<id_or_session>/open"
curl -X POST "http://127.0.0.1:8787/api/trace/<id_or_session>/input" \
  -H 'content-type: application/json' \
  -d '{"text":"continue","submit":true}'
```

Ad-hoc file load:

```bash
ENCODED=$(node -e 'console.log(Buffer.from(process.argv[1],"utf8").toString("base64url"))' "/absolute/path/to/log")
curl "http://127.0.0.1:8787/api/tracefile?path=${ENCODED}"
```

## SSE Stream

Connect and watch raw envelopes:

```bash
curl -N "http://127.0.0.1:8787/api/stream"
```

Includes initial `snapshot` then incremental updates.
