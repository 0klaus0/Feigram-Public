# Go Native MTProto Download Roadmap

Feigram 2.0.38 continues the transport migration required to move the media
source away from the Node/GramJS HTTP bridge. The Go downloader now understands
two media source modes:

- `http-bridge`: stable default. Go downloads from the local authenticated
  Node media endpoint and owns queueing, resume, rate limit and persistence.
- `native-mtproto`: experimental boundary for gotd/tdl-style native reads.
  This mode is intentionally guarded until the account/session migration is
  complete.

## What 2.0.38 Changes

- Adds encrypted Go native Telegram account/session storage.
- Syncs Telegram account metadata from Node to the Go downloader sidecar.
- Adds native account health checks in the management diagnostics page.
- Extends download tasks with native file location metadata: peer, message ID,
  file ID, access hash, file reference, DC ID, expected size, MIME type and
  file name.
- Keeps `native-mtproto` guarded until a Go session exists and passes health
  checks. If the operator tries to enable native mode too early, the sidecar
  keeps using the stable HTTP bridge.

## What 2.0.37 Changed

- Adds `transport` to the Go downloader config and task model.
- Adds transport dispatch in the Go download worker.
- Keeps existing HTTP bridge downloads stable while exposing the native MTProto
  boundary in diagnostics.
- Adds management UI controls and status text for the media source transport.
- Documents the next steps required before Node can be removed from the media
  source path.

## Why Native MTProto Is Not Forced Yet

The current Telegram login lives in GramJS `StringSession`. A true Go-native
download path needs its own safe session representation and file metadata:

- encrypted Go session storage per Feiniu account and Telegram account
- API ID/hash injection in the Go process without leaking secrets in logs
- DC-aware auth key handling
- message-to-file-location resolution
- `fileReference` refresh when Telegram expires a media reference
- flood wait and reconnect handling
- compatibility with existing `.part` files and task IDs

Turning on native mode before these pieces exist would break stable downloads,
so 2.0.38 exposes the encrypted session and metadata boundary without making
native download the default.

## Next Version Plan

1. Add a Go re-login flow so each Telegram account can create
   a Go MTProto auth key without exporting GramJS secrets in plain text.
2. Implement gotd/td-style encrypted session validation and small-file health
   reads per account.
3. Implement Go message lookup and `upload.getFile` range reads using the same
   queue, part files, limits and retries that already exist.
4. Implement DC migration, FloodWait handling, and reconnect handling inside
   the Go native transport.
5. Implement file reference refresh: when a read returns
   `FILE_REFERENCE_EXPIRED`, Go asks the server for a fresh message reference or
   refreshes it directly through gotd.
6. Enable native MTProto per account only after a health check proves the Go
   session can read one small media sample.
7. Remove the Node `/api/internal/media/...` dependency for large videos after
   native mode passes the long-running cache tests.
