---
title: Team Workspaces
description: Opt-in workspace sign-in, shared conversations and assessment reports.
---

Local use needs no account. Enable team sign-in only when you want workspace
members to share the same engine and retained conversations.

## Create a workspace

```sh
0 team init --config ./team.json --name "Security" --owner alex --display-name "Alex"
0 team add-user --config ./team.json --user morgan --display-name "Morgan" --role editor
0 team list --config ./team.json
0 web --team-config ./team.json
```

The first two commands request a password without displaying it. For automation,
provide the password through standard input from your secret manager. Passwords
are never command arguments; the configuration contains salted scrypt hashes.
Keep the file private (`0600`). Initialization never overwrites an existing file.
Changes to members take effect when the engine restarts; restarting also ends
existing sessions.

Owners and editors can change workspace work. Viewers can read it. Members work independently and can write directly into shared conversations.
Messages keep their authors. Requests in an active conversation queue safely.
Avatars beside chats, reports and workflows show who is viewing or typing. Assessment reports
collect retained runs and findings for review and export.

Team mode does not isolate members into separate data tenants: they share the
configured engine workspace. Each team gets its own retained chat directory,
findings database and reports by default. Existing personal sessions stay personal;
no historical chats are imported automatically. An explicit `--db-path` selects
the database the operator intends to share. The engine still binds to loopback. Remote access,
reverse-proxy configuration and hosted enterprise identity are separate deployment
work; this option does not publish the server.

## Optional provider sign-in

Add an `oidc` object to the configuration and assign each member their provider's
verified `oidcSub`. Provider display names and email claims do not grant membership
or change roles.

```json
{
  "workspace": { "id": "your-workspace-id", "name": "Security" },
  "users": [
    { "id": "alex", "name": "Alex", "role": "owner", "oidcSub": "provider-subject-id" }
  ],
  "oidc": {
    "issuer": "https://identity.example.com",
    "clientId": "your-client-id",
    "clientSecretEnv": "ZERO_TEAM_OIDC_SECRET",
    "redirectUri": "http://127.0.0.1:48123/api/team/auth/callback"
  }
}
```

Register the exact callback URL with your provider and set the client secret in
that environment variable when your provider requires one. Omit `clientSecretEnv`
for a public client. Callback origin and port must match the running engine.
Sign-in uses authorization code flow with PKCE and verifies the issuer, audience,
nonce and signature before looking up workspace membership. Session cookies are
HTTP-only and expire after eight hours; signing out revokes the session.
