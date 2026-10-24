// Evonode discovery: the quorum service lists nodes (CORS *). Usable ones are ENABLED with versionCheck "success".
export const MAINNET_NODE_LIST = 'https://quorums.mainnet.networks.dash.org/masternodes';

export async function fetchNodes(url = MAINNET_NODE_LIST, { signal } = {}) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`node list HTTP ${res.status}`);
  const { data } = await res.json();
  return data
    .filter((n) => n.status === 'ENABLED' && n.versionCheck === 'success' && n.addresses?.platform_https?.length)
    .map((n) => n.addresses.platform_https[0]);
}

/** Fisher-Yates sample of k distinct entries. */
export function sample(arr, k) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, k);
}
