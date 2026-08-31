# voidbind-web

`@rarebit-one/voidbind-web` — the **browser Voidbind web-login client**. A
dependency-light, framework-agnostic ESM module that lets a browser (or a Tizen
`.wgt` webview) log in to a Voidbind relying party by showing a QR that an
enrolled device approves — no password, no third party.

It is a tidy extraction of All Thing's hand-rolled `web/signin.html` +
`web/app.js` login logic, generalised so the **same module serves any RP**:
`baseUrl` is injected, so allthing and heyarr brokers are both spoken with no
per-RP code.

## The Voidbind three-repo topology

| Repo | Language | Role |
|------|----------|------|
| [`voidbind-go`](https://github.com/rarebit-one/voidbind-go)  | Go     | **Server / wire contract** — the `weblogin.Broker`, the source of truth |
| [`voidbind-kmp`](https://github.com/rarebit-one/voidbind-kmp) | Kotlin | **Native authenticator** — the phone app that scans + approves |
| **`voidbind-web`** (this repo) | JavaScript | **Browser/web client** — shows the QR, polls, holds the session token |

`voidbind-web` is the symmetric web peer of `voidbind-kmp`: where the KMP module
lets native apps consume the Voidbind login over the wire, this module lets
browsers and Tizen `.wgt` surfaces do the same. Keeping it in its own
npm-publishable repo keeps `voidbind-go`'s Go CI clean and lets N consumer repos
(allthing-tizen, heyarr-tizen, web clients) depend on one versioned package
instead of re-implementing the flow.

## The protocol (ADR-0006)

1. The browser `POST`s `{baseUrl}/login`; the broker returns a login id and a
   `voidbind:login?rp=<origin>&id=<login-id>` QR payload.
2. The page renders that as a QR. An enrolled device (the voidbind-kmp phone app,
   or the `voidbind login-approve` CLI stand-in) scans and approves it.
3. The browser polls `GET {baseUrl}/login/{id}` until `status` becomes
   `approved`, which carries a short-lived **session token**.
4. The client carries that token as `Authorization: Bearer <token>` on `fetch`
   and as `?token=<token>` on the SSE/`EventSource` URL (which cannot set a
   header). The per-login token is already rotated every login — exactly the
   leak mitigation that makes a query-param token acceptable for SSE.

Tizen scope is **QR-only** — no push (ADR-0009 push is not used here).

## Install

From the GitHub Packages npm registry (scope `@rarebit-one`):

```
# .npmrc
@rarebit-one:registry=https://npm.pkg.github.com
```

```
npm install @rarebit-one/voidbind-web
```

> Note: publishing to GitHub Packages for this org is currently **HTTP 402
> (billing)**-blocked (the same block voidbind-kmp hits). The `publish` workflow
> is ready to `workflow_dispatch` once billing is resolved.

## Usage (a Tizen `.wgt` or web client)

```js
import { signIn, authFetch, sseUrl } from '@rarebit-one/voidbind-web';

const baseUrl = 'https://allthing.example';      // the RP's Voidbind broker
const qrElement = document.getElementById('qr');  // any node with innerHTML

// Full flow: POST /login -> render QR -> poll until the device approves.
const { token, user } = await signIn({
  baseUrl,
  qrElement,
  onStatus: (s) => console.log('voidbind:', s.phase),
});

// Carry the session token on protected calls.
const api = authFetch(token);
const features = await api(`${baseUrl}/api/features/flights`).then((r) => r.json());

// SSE can't set a header, so the token rides as ?token=.
const live = new EventSource(sseUrl(baseUrl, '/api/live/flights', token));
```

Need finer control? The orchestrator is just the sum of the exported parts:

```js
import { startWebLogin, renderQr, pollUntilApproved } from '@rarebit-one/voidbind-web';

const { loginId, qrPayload } = await startWebLogin({ baseUrl });
renderQr(qrElement, qrPayload);
const { token, user } = await pollUntilApproved({ baseUrl, loginId, signal });
```

## API

| Export | Signature | Returns |
|--------|-----------|---------|
| `signIn` | `signIn({ baseUrl, qrElement?, signal?, onStatus?, intervalMs?, fetchImpl? })` | `Promise<{ token, user }>` |
| `startWebLogin` | `startWebLogin({ baseUrl, signal?, fetchImpl? })` | `Promise<{ loginId, qrPayload, expiresAt? }>` |
| `pollUntilApproved` | `pollUntilApproved({ baseUrl, loginId, signal?, intervalMs?, fetchImpl? })` | `Promise<{ token, user }>` |
| `renderQr` | `renderQr(el, qrPayload, opts?)` | `boolean` (false → show the link text) |
| `qrSvg` | `qrSvg(qrPayload, opts?)` | `string` (SVG markup) |
| `authFetch` | `authFetch(token, fetchImpl?)` | `(input, init?) => Promise<Response>` |
| `sseUrl` | `sseUrl(baseUrl, path, token)` | `string` |
| `joinUrl` | `joinUrl(baseUrl, path)` | `string` |
| `POLL_INTERVAL_MS` | constant | `1000` |

`signal` is an `AbortSignal` — aborting unwinds an in-flight poll promptly.
`fetchImpl` defaults to the ambient global `fetch` (browsers, Tizen webviews,
Node 18+) and is injectable for testing.

## Design

Framework-free and tiny by intent: no runtime dependencies, no build step. The
QR encoder is the vendored `qrcode-generator` (MIT, Kazuhiko Arase) under
`src/vendor/` — never a CDN, so a `.wgt` runs offline (ADR-0001 self-hosted
policy). See [`DESIGN.md`](./DESIGN.md) for the why-a-separate-repo rationale and
the ADR-0006 contract this module speaks.

## Development

```
npm install   # no runtime deps; installs nothing today
npm test      # node --test — the CI merge gate
```

## License

[AGPL-3.0-or-later](./LICENSE), matching `voidbind-kmp` and `heyarr-core`.
