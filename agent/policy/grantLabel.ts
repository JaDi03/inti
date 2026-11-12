/** The label of grants issued before each site named its own. */
export const LEGACY_GRANT_LABEL = "Inti trading";

/** The Agent API accepts labels of 1 to 64 printable ASCII characters. */
const MAX_LABEL = 64;

/**
 * The label of the grants one Inti site holds, e.g. "Inti trading (getinti.xyz)". Each site
 * closes only its own grants when the user renews, so turning Inti on in one place (a local
 * copy, a second server) never turns it off in another. The server and the web app both build it
 * from the site's host, so the app can check the label before the user signs.
 */
export function grantLabel(siteHost: string): string {
  const prefix = `${LEGACY_GRANT_LABEL} (`;
  return `${prefix}${siteHost.slice(0, MAX_LABEL - prefix.length - 1)})`;
}
