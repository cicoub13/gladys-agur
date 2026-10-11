import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgurClient, AgurError, SESSION_MARGIN_MS, describeError } from '../src/agur/client.js';
import { PROVIDERS } from '../src/config.js';
import { BALANCE, CONTRACTS, LOGIN_REFUSED, SESSION, createFakeFetch } from './fixtures/agur.js';

const PASSWORD = 'pa$$word-never-logged';
const SESSION_END = Date.parse(SESSION.expirationDate);

function createClient(fetchImpl, { now = () => SESSION_END - 60 * 60 * 1000 } = {}) {
  return new AgurClient({
    provider: PROVIDERS.agur,
    username: 'me@example.com',
    password: PASSWORD,
    fetchImpl,
    now,
  });
}

test('logs in with the portal keys, then the credentials, then reads with the auth token', async () => {
  const fetch = createFakeFetch();
  const client = createClient(fetch);

  assert.deepEqual(await client.getContracts(), CONTRACTS);

  const [session, login, contracts] = fetch.calls;
  assert.equal(session.url, 'https://ael.agur.fr/webapi/Acces/generateToken');
  assert.equal(session.method, 'POST');
  assert.equal(session.headers.Token, PROVIDERS.agur.accessKey);
  assert.deepEqual(session.body, {
    ConversationId: client.conversationId,
    ClientId: 'AEL-TOKEN-AGR-PRD',
    AccessKey: PROVIDERS.agur.accessKey,
  });
  assert.equal(login.path, '/Utilisateur/authentification');
  assert.equal(login.headers.Token, SESSION.token);
  assert.deepEqual(login.body, { identifiant: 'me@example.com', motDePasse: PASSWORD });
  assert.equal(contracts.method, 'GET');
  assert.equal(contracts.headers.Token, 'auth-token-123');
  assert.equal(contracts.headers.ConversationId, client.conversationId);
  assert.match(contracts.search, /nbElements=25/);
});

test('uses the host of the chosen water utility', async () => {
  const fetch = createFakeFetch();
  const client = new AgurClient({
    provider: PROVIDERS.eauparis,
    username: 'me@example.com',
    password: PASSWORD,
    fetchImpl: fetch,
  });
  await client.login();
  assert.equal(fetch.calls[0].url, 'https://agence.eaudeparis.fr/webapi/Acces/generateToken');
  assert.equal(fetch.calls[0].body.ClientId, 'AEL-TOKEN-EDP-PRD');
});

test('keeps the session until shortly before it expires, then opens a new one', async () => {
  let now = SESSION_END - 60 * 60 * 1000;
  const fetch = createFakeFetch();
  const client = createClient(fetch, { now: () => now });

  await client.getContracts();
  await client.getBalance('1234567');
  assert.equal(fetch.calls.filter((call) => call.path === '/Acces/generateToken').length, 1);

  now = SESSION_END - SESSION_MARGIN_MS;
  await client.getBalance('1234567');
  assert.equal(fetch.calls.filter((call) => call.path === '/Acces/generateToken').length, 2);
});

test('parallel requests needing a session share one login', async () => {
  const fetch = createFakeFetch();
  const client = createClient(fetch);
  await Promise.all([client.getContract('1'), client.getReadings('1'), client.getBalance('1')]);
  assert.equal(fetch.calls.filter((call) => call.path === '/Acces/generateToken').length, 1);
});

test('an expiration date it cannot read counts as one hour', async () => {
  const now = 1_000_000;
  const fetch = createFakeFetch({
    '/Acces/generateToken': () => ({ body: { token: 'session' } }),
  });
  const client = createClient(fetch, { now: () => now });
  await client.login();
  assert.equal(client.sessionExpiresAt, now + 60 * 60 * 1000);
});

for (const status of [401, 404]) {
  test(`a session Agur no longer accepts (HTTP ${status}) is renewed once`, async () => {
    let refused = 0;
    const fetch = createFakeFetch({
      '/Facturation/soldeComptableContratAbonnement/': () =>
        refused++ === 0 ? { status, body: {} } : { body: BALANCE },
    });
    const client = createClient(fetch);
    await client.getContracts();

    assert.equal(await client.getBalance('1234567'), BALANCE);
    assert.equal(fetch.calls.filter((call) => call.path === '/Acces/generateToken').length, 2);
  });
}

test('a session refused right after logging in is a session error', async () => {
  const fetch = createFakeFetch({
    '/Abonnement/contrats': () => ({ status: 401, body: {} }),
  });
  await assert.rejects(createClient(fetch).getContracts(), { name: 'AgurError', kind: 'session' });
  // Fresh session: no second login in a loop.
  assert.equal(fetch.calls.filter((call) => call.path === '/Acces/generateToken').length, 1);
});

test('a refused login is an auth error carrying the explanation of Agur', async () => {
  const fetch = createFakeFetch({
    '/Utilisateur/authentification': () => ({ status: 412, body: LOGIN_REFUSED }),
  });
  const err = await createClient(fetch)
    .getContracts()
    .catch((error) => error);
  assert.equal(err.kind, 'auth');
  assert.equal(err.status, 412);
  assert.equal(err.serverMessage, LOGIN_REFUSED.message);
  assert.doesNotMatch(JSON.stringify({ ...err, message: err.message }), /pa\$\$word/);
});

test('a refused login without explanation is still an auth error', async () => {
  const fetch = createFakeFetch({
    '/Utilisateur/authentification': () => ({ status: 401, text: 'Unauthorized' }),
  });
  const err = await createClient(fetch)
    .login()
    .catch((error) => error);
  assert.equal(err.kind, 'auth');
  assert.equal(err.serverMessage, undefined);
});

test('server errors and malformed answers of the login steps are classified', async () => {
  const cases = [
    [{ '/Acces/generateToken': () => ({ status: 503, text: '' }) }, 'http'],
    [{ '/Acces/generateToken': () => ({ body: {} }) }, 'invalid_response'],
    [{ '/Utilisateur/authentification': () => ({ status: 500, body: {} }) }, 'http'],
    [{ '/Utilisateur/authentification': () => ({ body: {} }) }, 'invalid_response'],
  ];
  for (const [overrides, kind] of cases) {
    await assert.rejects(createClient(createFakeFetch(overrides)).login(), { kind });
  }
});

test('data errors: HTTP error, HTML page', async () => {
  await assert.rejects(
    createClient(
      createFakeFetch({ '/Facture/listeFactures': () => ({ status: 500, body: {} }) }),
    ).getInvoices('1'),
    { kind: 'http', status: 500 },
  );
  await assert.rejects(
    createClient(
      createFakeFetch({ '/Facture/listeFactures': () => ({ text: '<html>maintenance</html>' }) }),
    ).getInvoices('1'),
    { kind: 'invalid_response' },
  );
});

test('network failures become unreachable or timeout errors without the request details', async () => {
  const unreachable = async () => {
    throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
  };
  const err = await createClient(unreachable)
    .login()
    .catch((error) => error);
  assert.equal(err.kind, 'unreachable');
  assert.equal(err.code, 'ENOTFOUND');
  assert.equal(err.cause, undefined);

  const timeout = async () => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  };
  await assert.rejects(createClient(timeout).login(), { kind: 'timeout' });
});

test('contract numbers are escaped in the paths', async () => {
  const fetch = createFakeFetch();
  const client = createClient(fetch);
  await client.getContract('12/34');
  await client.getInvoices('12&x=1');
  assert.ok(fetch.calls.some((call) => call.path === '/Abonnement/detailAbonnement/12%2F34'));
  assert.ok(fetch.calls.some((call) => call.search.includes('numeroContrat=12%26x%3D1')));
});

test('the client never exposes the password', () => {
  const client = createClient(createFakeFetch());
  assert.doesNotMatch(JSON.stringify(client), /pa\$\$word/);
});

test('describeError gives a bilingual message for every kind', () => {
  const kinds = ['auth', 'session', 'timeout', 'http', 'invalid_response', 'unreachable'];
  for (const kind of kinds) {
    const message = describeError(new AgurError(kind, 'x', { status: 500 }), 'Eau de Paris');
    assert.match(message.en, /Eau de Paris/);
    assert.match(message.fr, /Eau de Paris/);
  }
  const auth = describeError(new AgurError('auth', 'x', { serverMessage: 'Compte bloqué' }));
  assert.match(auth.fr, /\(Compte bloqué\)/);
  assert.match(describeError(new Error('boom')).en, /Unexpected error/);
});
