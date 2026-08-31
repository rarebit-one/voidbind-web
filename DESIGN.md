# DESIGN — voidbind-web

**Status:** Accepted · **Date:** 2026-08-31

A short design record for the `@rarebit-one/voidbind-web` package: why it is its
own repo, the wire contract it speaks, and its deliberately narrow scope.

## Why a separate repo

`voidbind-web` is the **browser/web protocol-client** for Voidbind login, split
out of All Thing's in-app `web/signin.html` + `web/app.js`. It gets its own repo
for the same reasons `voidbind-kmp` (the native authenticator) is separate from
`voidbind-go` (the server):

- **Consumed by N repos.** The two Tizen `.wgt` surfaces (allthing-tizen,
  heyarr-tizen) and future browser web clients all need the identical
  start → QR → poll → token flow. A shared, versioned package beats copying the
  logic into each surface (which is how it drifted before — allthing had its own
  copy).
- **npm-publishable.** A JS package belongs on the GitHub Packages npm registry
  (`@rarebit-one` scope), so consumers `npm install` a pinned version rather than
  vendoring source.
- **Symmetric peer of `voidbind-kmp`.** The topology is intentionally three
  repos: `voidbind-go` (server + wire contract, the source of truth),
  `voidbind-kmp` (native authenticator — the device that approves), and
  `voidbind-web` (the browser/web relying-party client). Each RP language surface
  is its own consumer library.
- **Keeps `voidbind-go`'s CI clean.** A JS package with a Node test job doesn't
  belong in the Go module's build; separating it keeps each repo's CI single-stack
  (Go stays Go, this stays Node).

## The contract it speaks (ADR-0006)

The module mirrors — does not invent — the `weblogin.Broker` HTTP contract from
[allthing `docs/adr/0006-voidbind-web-login.md`](https://github.com/rarebit-one/allthing/blob/main/docs/adr/0006-voidbind-web-login.md),
as exercised by allthing's `web/signin.html`:

```
POST {baseUrl}/login        -> { id, qr [, expiresAt] }
GET  {baseUrl}/login/{id}   -> { status: 'pending'|'approved'|'expired'|'denied', token?, user? }
```

- `qr` is the `voidbind:login?rp=<origin>&id=<login-id>` payload the broker mints
  (byte-identical to voidbind-go's `weblogin.EncodeLogin`); the client only
  displays it — it never constructs the tuple.
- On `approved`, the poll response carries the short-lived **session token** and
  the authenticated `user`.
- The token is carried as `Authorization: Bearer <token>` for `fetch` and, for
  the SSE live route whose `EventSource` cannot set a header, as `?token=<token>`.
  A short-lived per-login token is a fine query token: it is already rotated
  every login, which is exactly the leak mitigation the separate-SSE-token rule
  reached for.
- The **broker is the authority on expiry**. It returns `status: 'expired'` once
  its ChallengeTTL (ADR-0006) lapses, so the client polls until a terminal
  status rather than running a local timeout clock. `expiresAt` is surfaced when
  the broker sends it, for UI countdowns only.

### Where the wire forced a detail

- allthing's `signin.html` uses the wire field names `id` and `qr` and reads no
  `expiresAt`. This module keeps the wire names on the boundary but exposes them
  to callers as `loginId` / `qrPayload`, and surfaces `expiresAt` **only if the
  broker includes it** (optional, may be `undefined`).
- `signin.html` handles `approved` and `expired`; ADR-0006 also implies denial.
  This module additionally treats `status: 'denied'` as a reject, so a declined
  approval fails fast rather than polling forever. A broker that never sends
  `denied` is unaffected.

## Scope

- **QR-only, no push.** ADR-0009 (device push approval) is explicitly out of
  scope: a Tizen `.wgt` is a QR surface. The flow is start → show QR → poll.
- **Framework-free and tiny.** No runtime dependencies, no build step, plain ESM.
  The only bundled code is the vendored `qrcode-generator` (MIT) under
  `src/vendor/` — self-hosted, never a CDN (ADR-0001), so a `.wgt` runs offline.
- **RP-agnostic.** `baseUrl` is injected; no allthing- or heyarr-specific code
  lives here.

## License

AGPL-3.0-or-later, consistent with `voidbind-kmp` and `heyarr-core`. The repo is
private today; the license is written as if public, pending a "make public"
go-ahead.
