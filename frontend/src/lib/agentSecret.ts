// The agent kind's secret, generated HERE, in the browser: 32 random bytes as unpadded base64url
// (src/launcher/kinds/agent.mjs `validateConfig` accepts exactly that). It touches `crypto`, so it
// lives outside lib/cardState.mjs, whose functions are pure.

const SECRET_BYTES = 32;

export function newSecret(): string {
  const bytes = new Uint8Array(SECRET_BYTES);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
