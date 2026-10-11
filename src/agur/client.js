// -----------------------------------------------------------------------------
// Minimal client of the Agur customer portal API (`https://<host>/webapi/...`),
// the private API the portal web page itself calls. Ported from the Home
// Assistant integration (https://github.com/tbouron/ha-agur,
// custom_components/agur/agur_client.py).
//
// Authentication is two-step:
//   1. POST /Acces/generateToken with the public keys of the portal -> a
//      session token, valid 2 hours (`expirationDate`);
//   2. POST /Utilisateur/authentification with that token and the user's
//      credentials -> `tokenAuthentique`, sent as the `Token` header of every
//      data request.
// The session is renewed shortly before it expires, and once more when a data
// request is refused (401, or 404 which the API answers to an unknown token).
//
// Every failure is thrown as an AgurError whose `kind` tells what went wrong
// (unreachable, timeout, auth, session, http, invalid_response), so callers
// can turn it into an actionable message with describeError(). Credentials are
// kept in private fields and never copied into an error message. `fetchImpl`
// is injectable so unit tests never touch the real network.
// -----------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';

export const DEFAULT_TIMEOUT_MS = 20 * 1000;
// Renew the session this long before Agur expires it, so a poll never starts
// with a token about to die halfway through.
export const SESSION_MARGIN_MS = 5 * 60 * 1000;
// Some reverse proxies in front of the portal refuse unknown clients.
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:109.0) Gecko/20100101 Firefox/113.0';
const MAX_SERVER_MESSAGE_LENGTH = 300;

/**
 * Error of an Agur request.
 * `kind`: 'unreachable' | 'timeout' | 'auth' | 'session' | 'http' | 'invalid_response'.
 */
export class AgurError extends Error {
  /**
   * @param {string} kind - Failure category.
   * @param {string} message - Technical message (never contains credentials).
   * @param {{status?: number, code?: string, serverMessage?: string}} [details] - HTTP status,
   * system error code, or the explanation Agur gave (shown to the user on a refused login).
   */
  constructor(kind, message, { status, code, serverMessage } = {}) {
    super(message);
    this.name = 'AgurError';
    this.kind = kind;
    if (status !== undefined) {
      this.status = status;
    }
    if (code !== undefined) {
      this.code = code;
    }
    if (serverMessage !== undefined) {
      this.serverMessage = serverMessage;
    }
  }
}

/**
 * Convert a rejection of fetch (or of the body read) into an AgurError.
 * Only the system error code is kept: the original error is dropped rather
 * than chained, so nothing from the request can leak through it.
 * @param {unknown} err - What fetch threw.
 * @param {string} label - `METHOD /path` of the request.
 * @returns {AgurError} The normalized error.
 */
function networkError(err, label) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return new AgurError('timeout', `${label}: Agur did not answer in time`);
  }
  // undici wraps the system error: TypeError('fetch failed', { cause }).
  const code = err?.cause?.code ?? err?.code;
  const suffix = typeof code === 'string' ? ` (${code})` : '';
  return new AgurError('unreachable', `${label}: Agur is unreachable${suffix}`, {
    code: typeof code === 'string' ? code : undefined,
  });
}

/**
 * The `message` of an Agur error body (`{severity, message, ...}`), if any.
 * @param {unknown} body - Parsed JSON body, or undefined.
 * @returns {string|undefined} The message, trimmed and capped.
 */
function serverMessageOf(body) {
  const message = body?.message;
  if (typeof message !== 'string' || message.trim() === '') {
    return undefined;
  }
  return message.trim().slice(0, MAX_SERVER_MESSAGE_LENGTH);
}

export class AgurClient {
  #username;
  #password;
  #authToken = null;
  #loginInFlight = null;

  /**
   * @param {object} options
   * @param {{host: string, clientId: string, accessKey: string}} options.provider - Portal of the water utility.
   * @param {string} options.username - Login (email) of the customer account.
   * @param {string} options.password - Password of the customer account.
   * @param {typeof fetch} [options.fetchImpl] - Injectable for tests.
   * @param {number} [options.timeoutMs] - Deadline of one request (headers AND body).
   * @param {() => number} [options.now] - Injectable clock, for tests.
   */
  constructor({
    provider,
    username,
    password,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    now = Date.now,
  }) {
    this.baseUrl = `https://${provider.host}/webapi`;
    this.clientId = provider.clientId;
    this.accessKey = provider.accessKey;
    this.#username = username;
    this.#password = password;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.now = now;
    // The portal tags every request of a browser tab with one conversation id.
    this.conversationId = randomUUID();
    this.sessionExpiresAt = 0;
  }

  /**
   * Send one request to the API.
   * @param {string} method - HTTP method.
   * @param {string} path - Path under /webapi, e.g. '/Abonnement/contrats'.
   * @param {object} [options]
   * @param {string|null} [options.token] - Value of the `Token` header.
   * @param {unknown} [options.body] - JSON body.
   * @returns {Promise<{status: number, ok: boolean, body: unknown, label: string}>} The answer,
   * body parsed when it is JSON (undefined otherwise), and `METHOD /path` for error messages.
   */
  async send(method, path, { token = null, body } = {}) {
    const label = `${method} ${path.split('?')[0]}`;
    const headers = {
      Accept: 'application/json, text/plain, */*',
      ConversationId: this.conversationId,
      'User-Agent': USER_AGENT,
    };
    if (token) {
      headers.Token = token;
    }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json;charset=utf-8';
    }

    let response;
    let text;
    try {
      // The same signal also aborts the body read below.
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = await response.text();
    } catch (err) {
      throw networkError(err, label);
    }

    let parsed;
    try {
      parsed = text === '' ? undefined : JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    return { status: response.status, ok: response.ok, body: parsed, label };
  }

  /**
   * Open a new session: portal token, then the customer login. Concurrent
   * callers (the requests of a contract run in parallel) share one login.
   * @returns {Promise<void>}
   * @throws {AgurError} `auth` when Agur refuses the credentials.
   * @example
   * await client.login();
   */
  login() {
    if (!this.#loginInFlight) {
      this.#loginInFlight = this.#openSession().finally(() => {
        this.#loginInFlight = null;
      });
    }
    return this.#loginInFlight;
  }

  async #openSession() {
    this.#authToken = null;
    const session = await this.send('POST', '/Acces/generateToken', {
      token: this.accessKey,
      body: {
        ConversationId: this.conversationId,
        ClientId: this.clientId,
        AccessKey: this.accessKey,
      },
    });
    if (!session.ok) {
      throw new AgurError('http', `${session.label}: HTTP ${session.status}`, {
        status: session.status,
      });
    }
    const sessionToken = session.body?.token;
    if (typeof sessionToken !== 'string' || sessionToken === '') {
      throw new AgurError('invalid_response', `${session.label}: no session token in the answer`);
    }
    const expiresAt = Date.parse(session.body.expirationDate);
    // Without a usable date, assume the shortest lifetime seen in the wild.
    const sessionExpiresAt = Number.isNaN(expiresAt) ? this.now() + 60 * 60 * 1000 : expiresAt;

    const auth = await this.send('POST', '/Utilisateur/authentification', {
      token: sessionToken,
      body: { identifiant: this.#username, motDePasse: this.#password },
    });
    // A refused login is a 4xx (412 with an explanation in `message`).
    if (auth.status >= 400 && auth.status < 500) {
      throw new AgurError('auth', `${auth.label}: login refused (HTTP ${auth.status})`, {
        status: auth.status,
        serverMessage: serverMessageOf(auth.body),
      });
    }
    if (!auth.ok) {
      throw new AgurError('http', `${auth.label}: HTTP ${auth.status}`, { status: auth.status });
    }
    const authToken = auth.body?.tokenAuthentique;
    if (typeof authToken !== 'string' || authToken === '') {
      throw new AgurError(
        'invalid_response',
        `${auth.label}: no authentication token in the answer`,
      );
    }
    this.#authToken = authToken;
    this.sessionExpiresAt = sessionExpiresAt;
  }

  /**
   * Open a session when there is none or it is about to expire.
   * @returns {Promise<boolean>} True when this call had to (re)open the session.
   */
  async ensureSession() {
    if (
      this.#loginInFlight !== null ||
      this.#authToken === null ||
      this.now() >= this.sessionExpiresAt - SESSION_MARGIN_MS
    ) {
      await this.login();
      return true;
    }
    return false;
  }

  /**
   * GET a data endpoint with the current session, renewing it once when Agur
   * no longer accepts it.
   * @param {string} path - Path under /webapi.
   * @returns {Promise<unknown>} The parsed JSON body.
   */
  async get(path) {
    const fresh = await this.ensureSession();
    let answer = await this.send('GET', path, { token: this.#authToken });
    if ((answer.status === 401 || answer.status === 404) && !fresh) {
      await this.login();
      answer = await this.send('GET', path, { token: this.#authToken });
    }
    if (answer.status === 401) {
      throw new AgurError('session', `${answer.label}: session refused (HTTP 401)`, {
        status: 401,
      });
    }
    if (!answer.ok) {
      throw new AgurError('http', `${answer.label}: HTTP ${answer.status}`, {
        status: answer.status,
      });
    }
    if (answer.body === undefined) {
      // Typically an HTML page: maintenance, or a proxy error page.
      throw new AgurError('invalid_response', `${answer.label}: the answer is not JSON`, {
        status: answer.status,
      });
    }
    return answer.body;
  }

  /** @returns {Promise<unknown>} The contracts of the account (`resultats`). */
  getContracts() {
    return this.get(
      '/Abonnement/contrats?userWebId=&recherche=&tri=NumeroContrat&triDecroissant=false&indexPage=0&nbElements=25',
    );
  }

  /**
   * @param {string} contractId - Contract number.
   * @returns {Promise<unknown>} Details of the contract, meter included.
   */
  getContract(contractId) {
    return this.get(`/Abonnement/detailAbonnement/${encodeURIComponent(contractId)}`);
  }

  /**
   * @param {string} contractId - Contract number.
   * @returns {Promise<unknown>} Billing readings (`resultats`: `dateReleve`, `valeurIndex` in m³,
   * `volumeConsoEnM3` / `volumeConsoEnLitres` over the period).
   */
  getReadings(contractId) {
    return this.get(`/Facturation/listeConsommationsFacturees/${encodeURIComponent(contractId)}`);
  }

  /**
   * @param {string} contractId - Contract number.
   * @returns {Promise<unknown>} Invoices (`resultats`).
   */
  getInvoices(contractId) {
    return this.get(
      `/Facture/listeFactures?numeroContrat=${encodeURIComponent(contractId)}&recherche=&tri=&triDecroissant=false&indexPage=0&nbElements=25&dateDebut=&dateFin=&listeColonnes=&profondeurHistorique=-1`,
    );
  }

  /**
   * @param {string} contractId - Contract number.
   * @returns {Promise<unknown>} Accounting balance, a French-formatted number string ("1.234,56").
   */
  getBalance(contractId) {
    return this.get(
      `/Facturation/soldeComptableContratAbonnement/${encodeURIComponent(contractId)}`,
    );
  }
}

/**
 * User-facing, actionable message for any error (AgurError or not).
 * @param {unknown} err - The error to describe.
 * @param {string} [portal] - Name of the water utility portal, e.g. 'Agur'.
 * @returns {{en: string, fr: string}} The message.
 * @example
 * describeError(new AgurError('auth', '...', { status: 412 }), 'Agur');
 */
export function describeError(err, portal = 'Agur') {
  if (!(err instanceof AgurError)) {
    return {
      en: `Unexpected error while talking to ${portal}. Check the integration logs.`,
      fr: `Erreur inattendue en communiquant avec ${portal}. Consultez les journaux de l'intégration.`,
    };
  }
  switch (err.kind) {
    case 'auth': {
      // Agur explains the refusal in French only.
      const reason = err.serverMessage ? ` (${err.serverMessage})` : '';
      return {
        en: `${portal} refused the email or password${reason}. Check them in the integration settings, or log in on the ${portal} website.`,
        fr: `${portal} a refusé l'adresse e-mail ou le mot de passe${reason}. Vérifiez-les dans les paramètres de l'intégration, ou connectez-vous sur le site ${portal}.`,
      };
    }
    case 'session':
      return {
        en: `${portal} refused the session right after logging in. Try again later.`,
        fr: `${portal} a refusé la session juste après la connexion. Réessayez plus tard.`,
      };
    case 'timeout':
      return {
        en: `${portal} did not answer in time. Its website may be slow or under maintenance: the integration will try again.`,
        fr: `${portal} n'a pas répondu à temps. Son site est peut-être lent ou en maintenance : l'intégration réessaiera.`,
      };
    case 'http':
      return {
        en: `${portal} answered with an error (HTTP ${err.status}). Its website may be under maintenance: the integration will try again.`,
        fr: `${portal} a répondu par une erreur (HTTP ${err.status}). Son site est peut-être en maintenance : l'intégration réessaiera.`,
      };
    case 'invalid_response':
      return {
        en: `${portal} sent an unexpected answer. Its website may be under maintenance, or its API changed: check the integration logs.`,
        fr: `${portal} a envoyé une réponse inattendue. Son site est peut-être en maintenance, ou son API a changé : consultez les journaux de l'intégration.`,
      };
    default:
      return {
        en: `${portal} cannot be reached. Check the internet connection of Gladys: the integration will try again.`,
        fr: `${portal} est injoignable. Vérifiez la connexion internet de Gladys : l'intégration réessaiera.`,
      };
  }
}
