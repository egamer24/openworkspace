// Choosing mail domains and the hostname from the zones of a Cloudflare
// account, and spotting MX records that would stop Email Routing.

export type Account = { id: string; name: string };

export type Zone = { id: string; name: string; status: string };

export type MxRecord = { name: string; content: string; priority: number };

const HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;

/** Cloudflare Email Routing's own MX hosts (`route1.mx.cloudflare.net` …). */
const CLOUDFLARE_MX = /(?:^|\.)mx\.cloudflare\.net\.?$/iu;

/** Lowercase, without spaces or a trailing dot. */
export function normalizeDomain(value: string) {
  return value.trim().toLowerCase().replace(/\.$/u, "");
}

/** "acme.com, acme.org" or "acme.com acme.org" as a list. */
export function parseDomainList(value: string) {
  return value
    .split(/[\s,]+/u)
    .filter(Boolean)
    .map(normalizeDomain);
}

/** The account a `--account` value names: its id, or its name ignoring case. */
export function findAccount(accounts: readonly Account[], wanted: string) {
  const id = wanted.trim().toLowerCase();

  return (
    accounts.find((account) => account.id.toLowerCase() === id) ??
    accounts.find((account) => account.name.toLowerCase() === id)
  );
}

/** The zone a hostname is in: the longest zone name it equals or ends with. */
export function zoneOf(hostname: string, zones: readonly Zone[]) {
  const host = normalizeDomain(hostname);

  return zones
    .filter((zone) => host === zone.name || host.endsWith(`.${zone.name}`))
    .sort((a, b) => b.name.length - a.name.length)[0];
}

/** Why a hostname can't serve the app, or undefined when it can. */
export function hostnameProblem(hostname: string, zones: readonly Zone[]) {
  const host = normalizeDomain(hostname);

  if (!HOSTNAME.test(host)) return "Use a hostname such as mail.acme.com";

  if (!zoneOf(host, zones)) {
    return `${host} isn't in a zone of this account (${zones.map((zone) => zone.name).join(", ")})`;
  }

  return undefined;
}

/** The suggested hostname: mail.<primary domain>. */
export function suggestedHostname(primary: string) {
  return `mail.${primary}`;
}

/**
 * The zones a list of mail domains names, in the list's order, or the names
 * that aren't zones of the account. Email Routing works on whole zones, so a
 * mail domain must be one.
 */
export function zonesNamed(names: readonly string[], zones: readonly Zone[]) {
  const byName = new Map(zones.map((zone) => [zone.name, zone]));
  const wanted = [...new Set(names.map(normalizeDomain))];
  const found: Zone[] = [];
  const missing: string[] = [];

  for (const name of wanted) {
    const zone = byName.get(name);

    if (zone) found.push(zone);
    else missing.push(name);
  }

  return { found, missing };
}

/** The mail domains with the primary first; the others keep their order. */
export function primaryFirst(domains: readonly string[], primary: string) {
  return [primary, ...domains.filter((domain) => domain !== primary)];
}

/** MX records that send a zone's mail somewhere other than Cloudflare Email Routing. */
export function foreignMx(records: readonly MxRecord[]) {
  return records.filter((record) => !CLOUDFLARE_MX.test(record.content));
}

/** "acme.com  MX 10 aspmx.l.google.com", one line per record. */
export function describeMx(records: readonly MxRecord[]) {
  return [...records]
    .sort((a, b) => a.priority - b.priority)
    .map((record) => `${record.name}  MX ${record.priority} ${record.content}`);
}
