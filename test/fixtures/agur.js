// -----------------------------------------------------------------------------
// Answers of the Agur API, shaped after the field names of a real account
// (October 2026) and the live answers of /Acces/generateToken and a refused
// /Utilisateur/authentification. Values are made up; only the fields the
// integration reads are kept.
// -----------------------------------------------------------------------------

export const SESSION = {
  expirationDate: '2026-10-11T11:45:38.3836529+02:00',
  token: 'openToken-00000000-0000-0000-0000-000000000000',
};

export const LOGIN = { tokenAuthentique: 'auth-token-123' };

export const LOGIN_REFUSED = {
  severity: 'Inconsistant',
  message:
    'Pour des raisons de sécurité, votre mot de passe doit être changé. Cliquez sur le lien Mot de passe oublié ci-dessus.',
  according: 'W/FRONT',
  refLog: 'LogTicket-261011-0945-00000000-0000-0000-0000-000000000000',
};

export const CONTRACTS = {
  resultats: [
    {
      numeroContrat: '1234567',
      nomClientTitulaire: 'M. DUPONT JEAN',
      adresseLivraisonConstruite: '1 RUE DE LA PAIX 64100 BAYONNE',
    },
  ],
};

export const CONTRACT_DETAIL = {
  numeroContrat: '1234567',
  nomClientTitulaire: 'M. DUPONT JEAN',
  // Several lines, as Agur sends it.
  adresseLivraisonConstruite: '1 RUE DE LA PAIX\n RESIDENCE LES PINS\n 64100 BAYONNE',
  identifiantAppareil: '998877',
  numeroPhysiqueAppareil: 'I21FA123456',
  numeroPointLivraison: '5544332211',
  libelleRythmeReleve: 'Semestriel',
};

// Billing readings, newest first; `valeurIndex` in m³.
export const READINGS = {
  resultats: [
    {
      dateReleve: '2026-04-30T00:00:00',
      valeurIndex: 172,
      volumeConsoEnLitres: 45000,
      volumeConsoEnM3: 45,
      moyenne: 0.24590163934426229,
    },
    {
      dateReleve: '2025-10-29T00:00:00',
      valeurIndex: 127,
      volumeConsoEnLitres: 46000,
      volumeConsoEnM3: 46,
      moyenne: 0.25136612021857924,
    },
    // An estimated flat rate: no index, skipped.
    {
      dateReleve: '2025-07-28T00:00:00+02:00',
      volumeConsoEnLitres: 29000,
      volumeConsoEnM3: 29,
      libelleOrigineReleve: '04 Forfait déductible',
    },
    { dateReleve: '2025-04-30T00:00:00', valeurIndex: 81 },
  ],
};

export const INVOICES = {
  resultats: [
    {
      numeroFactureClient: 'F2026-0002',
      montantTTCFacture: 98.76,
      dateEmissionFacture: '2026-09-15T00:00:00',
      dateLimitePaiementFacture: '2026-10-05T00:00:00',
    },
    {
      numeroFactureClient: 'F2026-0001',
      montantTTCFacture: '87,65',
      dateEmissionFacture: '2026-03-15T00:00:00',
      dateLimitePaiementFacture: '2026-04-05T00:00:00',
    },
  ],
};

// The balance endpoint answers a JSON string in French format.
export const BALANCE = '-12,34';

/**
 * A fetch stand-in answering the Agur endpoints from a route table.
 * @param {Record<string, (call: object) => {status?: number, body?: unknown, text?: string}>} [overrides]
 * Keyed by path prefix under /webapi (e.g. '/Facture/listeFactures').
 * @returns {Function & {calls: object[]}} The fake fetch, recording every call.
 */
export function createFakeFetch(overrides = {}) {
  const routes = {
    '/Acces/generateToken': () => ({ body: SESSION }),
    '/Utilisateur/authentification': () => ({ body: LOGIN }),
    '/Abonnement/contrats': () => ({ body: CONTRACTS }),
    '/Abonnement/detailAbonnement/': () => ({ body: CONTRACT_DETAIL }),
    '/Facturation/listeConsommationsFacturees/': () => ({ body: READINGS }),
    '/Facture/listeFactures': () => ({ body: INVOICES }),
    '/Facturation/soldeComptableContratAbonnement/': () => ({ body: BALANCE }),
    ...overrides,
  };
  const calls = [];
  const fakeFetch = async (url, init) => {
    const { pathname, search } = new URL(url);
    const path = pathname.replace(/^\/webapi/, '');
    const call = {
      url,
      path,
      search,
      method: init.method,
      headers: init.headers,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    };
    calls.push(call);
    const route = Object.keys(routes).find((prefix) => path.startsWith(prefix));
    const answer = route ? routes[route](call) : { status: 404, body: {} };
    const status = answer.status ?? 200;
    const text = answer.text ?? (answer.body === undefined ? '' : JSON.stringify(answer.body));
    return {
      status,
      ok: status >= 200 && status < 300,
      text: async () => text,
    };
  };
  fakeFetch.calls = calls;
  return fakeFetch;
}
