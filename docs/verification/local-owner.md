# Local owner and device sessions

Run the identity checks from the repository root. The HTTP fixture starts its own server in a temporary home and data directory.

```sh
pnpm exec vitest run server/local-identity.e2e.test.ts server/sessions.test.ts server/dots/inbox-owner.test.ts src/lib/session.test.ts src/pair/PairPage.test.ts
```

The HTTP test pairs two full-access devices, a chat-only device and a script token. It checks the owner ID, pairing permissions and retirement of email sign-in and list editing. The session tests cover upgrades from shared and personal installations, restart, independent device revocation and copied session files. The Dots tests check that a former owner binding moves only when its original identity matches.
