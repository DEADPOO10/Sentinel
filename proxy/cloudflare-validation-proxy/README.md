# Sentinel validation Cloudflare Worker proxy

This is a deliberately small forwarding proxy for Sentinel's production validation request. It exists only to avoid the Vercel-to-`*.modal.run` DNS failure.

It accepts only `POST /v1/validations`, sends the incoming raw body unchanged to Modal, and copies the original inbound headers. Sentinel's existing timestamp/signature/body HMAC contract is therefore still verified exclusively by the Modal worker.

## Security boundaries

- It never executes repository code.
- It has no Sentinel HMAC secret, GitHub credential, secret binding, storage binding, or auth logic.
- It does not log bodies, auth headers, signatures, credentials, secrets, or upstream response bodies.
- It logs only `upstream_status`, `client_request_aborted`, or `upstream_request_failed` with safe metadata.
- It disables Cloudflare cache use for upstream requests. Successful responses preserve Modal's `cache-control` header exactly.
- It has no proxy-specific upstream timeout. The request remains open for the
  signed worker's five-minute validation budget while the Sentinel request is
  connected. If that client disconnects, `request_signal_passthrough` cancels
  the Modal subrequest where supported.

The only binding is the non-secret `MODAL_VALIDATION_URL`. It defaults to:

`https://deadpoo10--sentinel-validation-worker-web.modal.run/v1/validations`

## Local checks

From this directory:

```sh
npm install
npm test
npm run lint
npm run typecheck
npm run build
```

No compilation step is needed for this JavaScript Worker; `build` checks syntax. The test suite uses Node's built-in test runner and does not send network requests.

## Manual deployment steps (do not run until ready)

1. Sign in to the intended Cloudflare account:

   ```sh
   npx wrangler login
   ```

2. Review `wrangler.toml`. The supplied `MODAL_VALIDATION_URL` is a non-secret plain variable. To point at a replacement Modal deployment without editing code, deploy with:

   ```sh
   npx wrangler deploy --var MODAL_VALIDATION_URL:https://your-modal-host/v1/validations
   ```

   Otherwise deploy the documented default:

   ```sh
   npx wrangler deploy
   ```

3. Wrangler prints the Cloudflare Workers `workers.dev` URL, typically `https://sentinel-validation-proxy.<your-subdomain>.workers.dev`. Set Sentinel's existing validation worker URL to that URL plus `/v1/validations` through the normal production configuration process.

4. Make one validation request and confirm safe Worker logs show `upstream_status`; do not add a proxy secret or copy Modal/Sentinel secrets into Cloudflare.

This project does not change Sentinel's contract, Modal code or secrets, Vercel variables, feature flags, or PR settings.
