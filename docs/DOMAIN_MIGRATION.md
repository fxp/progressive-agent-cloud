# Changing the canonical domain

The hosted workbench uses `https://progressive.xiaopingfeng.com` for browser sessions, OAuth callbacks, new invitations, meeting Webhook URLs and installed runner configuration. Public registration remains enabled.

For self-hosted deployments, use this order:

1. Add the new hostname to the same Cloudflare Worker and verify HTTPS before changing `PA_ORIGIN`.
2. Register the new exact callback in each shared OAuth app: `/api/oauth/github/callback`, `/api/oauth/linear/callback` and, where browser Feishu OAuth is used, `/api/oauth/feishu/callback`. Update application homepage URLs. Retain the old callback temporarily when the provider supports several. User-owned OAuth applications need the same configuration change by their owner. Feishu scan/device authorization does not use a browser redirect URI.
3. Set the deployed `PA_ORIGIN` to the new HTTPS origin, preserving session/encryption keys and the existing database. If it is stored as a Worker secret, update that secret; do not create a second binding with the same name. Preserve the existing open/restricted signup mode.
4. Sign in again on the new domain. Host-only session cookies do not transfer between hostnames; this does not delete existing accounts or provider grants. Verify GitHub login, account-bound GitHub reconnection, Linear callback, and Feishu permissions before removing old callback registrations.
5. Update existing bound repositories' `PA_PLATFORM` Actions secret to the new origin. Reinstall the managed runner through its owning project's install action to refresh that secret and verify the installed workflow hashes. Avoid reinstalling a project with an active run. Do not expose or rotate another user's Agent key during this operation.
6. Update configured external meeting Webhook / Feishu event destinations to the new hostname. Keep their existing paths and authentication. Confirm the receiving route supports that application's event type before changing a vendor callback.

Browser navigation on old aliases redirects to the canonical hostname and preserves its path and query. Authenticated runner, service and meeting-Webhooks retain direct handling on old aliases for compatibility: cross-origin HTTP redirects can remove their Authorization header. These routes still enforce their existing token/signature and ownership checks. Newly generated URLs use the canonical hostname.

Verify `/app` remains on the new hostname, `/api/health` is healthy, anonymous `/api/state` retains the correct signup policy, and each OAuth start uses the new callback. Compare existing project bindings, tasks and provider identities before and after the move. OAuth application settings and live authorization must be verified separately from mocked tests.
