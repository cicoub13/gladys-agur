# Agur — Gladys Assistant external integration

Follow your [Agur](https://ael.agur.fr) water contract from
[Gladys Assistant](https://gladysassistant.com): meter index, consumption,
invoices and amount due. Also works with **Grand Paris Sud** and **Eau de
Paris**, which run the same customer website. Built as an external integration
running in its own container, on the JavaScript SDK
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
and ported from the Home Assistant integration
[tbouron/ha-agur](https://github.com/tbouron/ha-agur).

> **Requires Gladys ≥ 4.86.0.** `gladys_version` in the manifest declares that
> floor.

## Features

- One **water meter** device per contract of the account, published to the
  Discovery tab as soon as the login works, with 5 sensors:
  - meter index (m³);
  - consumption since the previous reading (m³, as billed);
  - average daily consumption over that period (L);
  - invoice amount (€, the latest invoice);
  - amount due (€, positive = to pay, negative = in your favour).
- Readings and invoices are published **at their own date**: creating a device
  fills its charts with the whole history the customer website keeps, paced
  under the 300 states/minute limit of the host API.
- Polling every 6 hours (Agur only exposes the billing readings, every few
  months, and the invoices), 30 minutes after a failure; suspended after a
  refused password, so the account does not get locked.

## Install

- **From Gladys**: install **Agur** from the integration store, then fill in
  the configuration screen.
- **Development**: run it outside Docker against a local Gladys, see
  [Run locally](#run-locally).

## Configuration

| Field         | Description                                      |
| ------------- | ------------------------------------------------ |
| Water utility | Agur (default), Grand Paris Sud or Eau de Paris. |
| Email         | Login of the customer website.                   |
| Password      | Password of the customer website.                |

The **Test the connection** button checks the credentials and resumes updates
suspended by a refused password. Full user documentation, including
troubleshooting: [`docs/en.md`](./docs/en.md) / [`docs/fr.md`](./docs/fr.md).

## Development

Requires Node.js 20 or later.

```bash
npm ci
npm test               # unit tests (node --test)
npm run lint           # ESLint
npm run format:check   # Prettier
npm run coverage       # tests + coverage thresholds (needs Node >= 22.8)
```

Validate the manifest with the store's checker:

```bash
npx github:GladysAssistant/integration-store .
```

### Run locally

Register the integration in development mode in a Gladys 4.86+ server to get
its token and selector, then:

```bash
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="<selector>" \
LOG_LEVEL=debug \
npm start
```

### Check against a real account

Put `AGUR_USERNAME`, `AGUR_PASSWORD` (and optionally `AGUR_PROVIDER`:
`grandparissud` or `eauparis`) in `.env` (ignored by git), then run
`npm run smoke`. It logs in, reads every contract like a poll does, and prints
what would be published along with the field names of each raw answer.

## Architecture

```
├─ index.js                          # wires the SDK handlers to AgurIntegration, no logic
├─ src/
│  ├─ integration.js                 # AgurIntegration: client, polling, snapshot, every SDK handler
│  ├─ config.js                      # water utilities (hosts, portal keys), config defaults and coercion
│  ├─ devices.js                     # one Gladys device per contract, its 5 features and states
│  ├─ publisher.js                   # sends only new states, paced under the host API rate limit
│  ├─ poller.js                      # self-scheduling polling loop
│  ├─ lifecycle.js                   # init retry with backoff, unhandled-rejection exit
│  └─ agur/
│     ├─ client.js                   # Agur portal API client (session, login), errors and user-facing messages
│     └─ snapshot.js                 # one polling round: API reads reduced to a snapshot
├─ scripts/smoke.mjs                 # manual check against the real Agur API (npm run smoke)
├─ test/                             # node:test unit tests (fake Gladys, fake Agur)
├─ docs/{en,fr}.md                   # user documentation (shown in the Gladys catalog)
├─ gladys-assistant-integration.json # manifest
└─ Dockerfile                        # image run by the Gladys supervisor
```

## Synced files

`.github/workflows/`, `.github/dependabot.yml`, `SECURITY.md` and `CLAUDE.md`
are synced from
[cicoub13/gladys-integration-kit](https://github.com/cicoub13/gladys-integration-kit).
Do not edit them here: the next sync overwrites local changes. Change the
templates in the kit instead.

## License

Apache-2.0. Not affiliated with Agur, Grand Paris Sud or Eau de Paris.
