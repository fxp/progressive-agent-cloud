# Security

Each signed-in GitHub identity owns a separate private workspace. Sharing a company, Feishu tenant, Linear workspace or writable GitHub repository does not grant access to another Progressive Agent workspace. Every resource mutation verifies ownership. Disabled accounts and disconnected repository credentials cannot authenticate runners.

OAuth and Agent secrets are encrypted in D1. Runtime encryption and signing keys belong in Cloudflare Secrets, never source control. Keep the encryption key stable across deployment; rotating it requires re-encrypting stored credentials. Shared OAuth application credentials belong to the deployment owner. Users provide their own BigModel credentials and authorize the repositories where encrypted Actions secrets may be installed.

The selected repository's administrators and users with suitable GitHub permissions control its workflows. Its validation commands and dependency lifecycle scripts run in a separate job without Progressive Agent or model secrets. Review allowed paths and validation commands before enabling automatic execution. Generated code remains a draft PR requiring human review.

Disconnecting a Connector prevents new use of its local credential and blocks associated runner authentication where applicable. Jobs already executing in an external provider may continue consuming that provider's quota until their configured timeout; disconnecting is not a remote job cancellation API. Revoke provider credentials in that provider when needed.

Report vulnerabilities privately using this repository's GitHub private vulnerability reporting feature. Do not include OAuth tokens, Agent keys, transcripts or personal meeting links in public issues. This first release has automated isolation coverage and live pilot validation; it has not received an independent security audit.
