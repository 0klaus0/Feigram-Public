# Go Native MTProto Download Roadmap

Feigram 2.0.37 introduces the transport boundary required to move the media
source away from the Node/GramJS HTTP bridge. The Go downloader now understands
two media source modes:

- `http-bridge`: stable default. Go downloads from the local authenticated
  Node media endpoint and owns queueing, resume, rate limit and persistence.
- `native-mtproto`: experimental boundary for gotd/tdl-style native reads.
  This mode is intentionally guarded until the account/session migration is
  complete.

## What 2.0.37 Changes

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
so 2.0.37 exposes the boundary without making it the default.

## Next Version Plan

1. Add a Go account/session store using gotd session storage, encrypted under
   the same Feigram server secret model.
2. Add a session migration or re-login flow so each Telegram account can create
   a Go MTProto auth key without exporting GramJS secrets in plain text.
3. Extend queued tasks with native file identity metadata: peer ID, message ID,
   media kind, access hash, file reference, DC ID and expected size.
4. Implement Go message lookup and `upload.getFile` range reads using the same
   queue, part files, limits and retries that already exist.
5. Implement file reference refresh: when a read returns
   `FILE_REFERENCE_EXPIRED`, Go asks the server for a fresh message reference or
   refreshes it directly through gotd.
6. Add a guarded migration switch: enable native MTProto per account only after
   a health check proves the Go session can read one small media sample.
7. Remove the Node `/api/internal/media/...` dependency for large videos after
   native mode passes the long-running cache tests.
