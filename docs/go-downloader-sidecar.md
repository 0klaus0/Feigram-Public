# Feigram Go Downloader Sidecar

Feigram 2.0.33 starts an embedded Go downloader sidecar with the FPK service.
The service is designed as the replacement foundation for large Telegram media
downloads, especially group video background caching.

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

The current sidecar phase only includes the service shell, task API and admin
integration. The actual Telegram transport bridge will be implemented in a
later version with a clear license review before adding gotd or any tdl-derived
component.

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

## Current limitation

Feigram 2.0.33 keeps Node as the default active Telegram download engine. The
Go sidecar is embedded, configurable and observable, but it does not yet own the
Telegram media transfer. This avoids another risky rewrite of the live Telegram
session path while giving the project a cleaner migration target.
