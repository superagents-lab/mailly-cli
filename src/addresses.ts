// Cc/Bcc options: repeatable, each value may also be comma-separated. Lowercased and deduplicated;
// the server validates the addresses and returns the final list it used.
export function collectAddresses(value: string, previous: string[]): string[] {
  const next = [...previous];
  for (const raw of value.split(',')) {
    const address = raw.trim().toLowerCase();
    if (address && !next.includes(address)) next.push(address);
  }
  return next;
}

export function formatAddresses(addresses: unknown): string {
  return Array.isArray(addresses) ? addresses.filter((item) => typeof item === 'string').join(', ') : '';
}
