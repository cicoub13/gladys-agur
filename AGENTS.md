# AGENTS.md: gladys-agur

Project-specific notes. Generic rules (SDK contract, commands, kit-owned files, runtime) are in
`CLAUDE.md`; the module tree and user-facing features are in `README.md`.

## Data flow

- `index.js` -> `AgurIntegration` (`src/integration.js`) holds everything: `client`, `poller`,
  last `snapshot`, `lastError` ({en, fr}), `publisher` (`StatePublisher`).
- `applyConfig()` bumps `generation`, builds a new client, starts a `Poller` (6 h, 30 min after a
  failed poll). It only resets the publisher when the account (provider + username) changes: every
  WebSocket reconnection applies the config again, and must not resend years of history.
- `poll()`: `fetchSnapshot()` -> `reportConnection(true)` -> `publishDiscoveredDevices` (every
  poll: new contracts, current params) -> `publishCreatedDevicesStates()` (only devices returned by
  `getDevices()`; the host drops states of devices not created). `poll()` never throws.
- An `auth` failure stops the poller (account lockout risk) until a config change or
  `test_connection`.
- Handlers that may take minutes are NOT awaited (5 s SDK ack): `onConfigUpdated`,
  `onDeviceCreated`/`onDeviceUpdated` (history backfill). `handleScan` without a snapshot starts
  a poll in the background.

## Agur API (`src/agur/client.js`)

- Private API of the portal web page, `https://<host>/webapi`, ported from tbouron/ha-agur. Hosts
  and public portal keys per utility in `PROVIDERS` (`src/config.js`).
- Login: `POST /Acces/generateToken` (header `Token: <accessKey>`, body ConversationId/ClientId/
  AccessKey) -> `{token, expirationDate}` (2 h, checked live 2026-10-11); then
  `POST /Utilisateur/authentification` `{identifiant, motDePasse}` with `Token: <session>` ->
  `{tokenAuthentique}`. Data requests send `Token: <tokenAuthentique>` and `ConversationId`.
- A refused login is HTTP 412 with `{severity, message}` (French): kept as `serverMessage` and
  shown to the user. Unknown token -> 404, missing token -> 401: one re-login then retry.
- Session renewed 5 min before `expirationDate`; `login()` is single-flight (the 4 reads of a
  contract run in parallel).
- Reads: `Abonnement/contrats` (list), `Abonnement/detailAbonnement/<id>` (meter),
  `Facturation/listeConsommationsFacturees/<id>` (BILLING readings, every few months:
  `dateReleve`, `valeurIndex` in M³ despite what ha-agur says, `volumeConsoEnM3`,
  `volumeConsoEnLitres`), `Facture/listeFactures?numeroContrat=<id>` (`montantTTCFacture`,
  `dateEmissionFacture`), `Facturation/soldeComptableContratAbonnement/<id>` (a JSON STRING,
  French format "-56,12"; NEGATIVE = amount the customer owes, confirmed by the account owner).
- Field names checked against a real account (2 contracts, October 2026, `npm run smoke`); the
  detail `adresseLivraisonConstruite` is multi-line (joined with ", "). Readings: dates carry an
  offset (`+02:00`), `volumeConsoEnM3` equals the index difference, `moyenne` is m³/day over the
  period, "04 Forfait déductible" entries have no `valeurIndex` and are skipped.
  `libelleRythmeReleve` of the detail: `SEMESTRIEL`. Parsing in
  `src/agur/snapshot.js` stays defensive (numbers as number or French string, dates ISO /
  date-only / dd/mm/yyyy, local time when no offset); a malformed entry is dropped, never thrown.
- `http`/`invalid_response` on one data endpoint only drop that part (warning logged); other kinds
  fail the poll.

## Devices: must stay stable

- One device per contract: `gladys.externalIds('water-meter', <numeroContrat>)`, features
  `<device>:<key>` with keys in `FEATURE_KEYS` (`src/devices.js`): `index` (volume-sensor/decimal,
  m³), `consumption` (volume-sensor/decimal, m³: Agur's `volumeConsoEnM3`, else
  `volumeConsoEnLitres`, else the index difference, skipped when the index drops: new meter),
  `daily_average` (volume-sensor/integer, L/day from `moyenne`), `invoice` and `amount_due`
  (currency/decimal, euro; `amount_due` = -balance, positive = to pay). Params
  `CONTRACT_NUMBER`, `METER_SERIAL_NUMBER`, `ADDRESS`. Never key on the meter id/serial (changes
  with the meter).
- `index`, `consumption`, `daily_average` and `invoice` are published with `created_at` = reading
  / issue date: the core files them in history (deduplicated on feature + date + value) and keeps
  the most recent as `last_value`. `amount_due` is undated.

## Publisher (`src/publisher.js`)

- Per feature: dated -> watermark (last `created_at` sent), undated -> last value. Batches of 100,
  at most 250 states per rolling minute (core: 300 per fixed minute). Publications are queued.
- In memory only: a restart resends the history (the core ignores duplicates). `forget(prefix)` on
  device created/deleted, `reset()` on account change.

## Config and storage

- Keys: `provider` (`agur` | `grandparissud` | `eauparis`, else `agur`), `username` (trimmed),
  `password` (secret). Nothing is written to `/data`.
