# Feigram Go Downloader Sidecar

Feigram 2.0.37 runs an embedded Go downloader sidecar with the FPK service.
The service now owns the large-file download queue, resumable `.part` files,
rate limits, concurrency and completion validation for manual video caching and
group video background caching.

## Why this exists

The previous Node/GramJS download path shares the same Telegram client session
with chat loading, updates, callbacks, and media streaming. Large background
downloads can therefore interfere with foreground chat access, and repeated
retry patches made the cache state machine too fragile.

The Go sidecar separates large-file download orchestration from the web server:

- independent process lifecycle
- independent task store
- explicit queue and configuration API
- resumable task metadata
- management UI visibility
- future gotd/MTProto transport boundary

## Relationship with iyear/tdl

`iyear/tdl` is licensed under AGPL-3.0. Feigram does not copy tdl source code
into this repository. The sidecar is an original implementation that follows
the same broad architectural ideas that are useful for Telegram downloads:

- DC-aware download workers
- 1 MB part metadata
- controlled concurrency
- resumable queue state
- retry and flood-wait aware transport layer

The current sidecar phase does not copy or embed tdl. Go owns orchestration and
file writing. The media source is now represented as an explicit transport
layer:

- `http-bridge`: stable default, Node exposes a localhost-only authenticated
  Telegram media stream because the logged-in Telegram session still lives in
  GramJS.
- `native-mtproto`: experimental boundary for the next gotd/tdl-style native
  transport. It is visible in diagnostics but not ready for production until
  GramJS sessions and Telegram file locations are migrated to Go.

## Runtime

The FPK launcher starts:

- Node web server on the configured app port
- Go downloader sidecar on `127.0.0.1:3090`

Environment variables:

- `FEIGRAM_DOWNLOADER_URL`
- `FEIGRAM_DOWNLOADER_PORT`
- `FEIGRAM_DOWNLOADER_DATA`
- `FEIGRAM_DOWNLOADER_LOG`

## API

- `GET /health`
- `GET /api/state`
- `PUT /api/config`
- `GET /api/tasks`
- `POST /api/tasks`
- `POST /api/tasks/:id/cancel`
- `POST /api/tasks/:id/queue`
- `DELETE /api/tasks/:id`

## Current boundary

Feigram 2.0.37 no longer uses the old Node task state machine for large-file
download scheduling. Node still owns Telegram authentication and provides the
internal `/api/internal/media/...` byte stream consumed by the Go sidecar. This
avoids duplicating Telegram auth keys while removing the fragile Node download
queue from the user-visible task flow.

When the HTTP bridge is unavailable, Go keeps the `.part` file and retries with
backoff. The remaining migration work is to replace the source URL with native
Go MTProto reads after the account/session migration is complete.
