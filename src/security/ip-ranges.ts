/**
 * Address classification used by the media-URL guard.
 *
 * Everything that is not a routable public address is blocked, so a media URL
 * can never be used to make the local VectCutAPI reach back into the user's
 * own machine, their LAN, or a cloud metadata endpoint.
 */

export interface BlockedAddress {
  blocked: true;
  /** Human-readable reason, safe to show in an error message. */
  reason: string;
}

export interface AllowedAddress {
  blocked: false;
}

export type AddressVerdict = BlockedAddress | AllowedAddress;

const ALLOWED: AllowedAddress = { blocked: false };

function blocked(reason: string): BlockedAddress {
  return { blocked: true, reason };
}

/** Parse a dotted-quad IPv4 literal into its four octets, or null. */
export function parseIPv4(value: string): number[] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

/** Classify a dotted-quad IPv4 address. */
export function classifyIPv4(value: string): AddressVerdict {
  const octets = parseIPv4(value);
  if (!octets) return blocked(`"${value}" is not a well-formed IPv4 address`);
  const [a, b] = octets;

  if (a === 0) return blocked(`${value} is in 0.0.0.0/8 ("this network")`);
  if (a === 10) return blocked(`${value} is a private address (10.0.0.0/8)`);
  if (a === 127) return blocked(`${value} is a loopback address (127.0.0.0/8)`);
  if (a === 100 && b >= 64 && b <= 127) {
    return blocked(`${value} is carrier-grade NAT space (100.64.0.0/10)`);
  }
  if (a === 169 && b === 254) {
    return blocked(
      `${value} is link-local (169.254.0.0/16); this range includes the cloud metadata endpoint 169.254.169.254`
    );
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return blocked(`${value} is a private address (172.16.0.0/12)`);
  }
  if (a === 192 && b === 168) return blocked(`${value} is a private address (192.168.0.0/16)`);
  if (a === 192 && b === 0) return blocked(`${value} is IETF protocol assignment space (192.0.0.0/24)`);
  if (a === 198 && (b === 18 || b === 19)) {
    return blocked(`${value} is benchmarking space (198.18.0.0/15)`);
  }
  if (a >= 224 && a <= 239) return blocked(`${value} is multicast (224.0.0.0/4)`);
  if (a >= 240) return blocked(`${value} is reserved or broadcast (240.0.0.0/4)`);

  return ALLOWED;
}

/** Expand an IPv6 literal (no brackets, no zone id) into its 8 groups, or null. */
export function parseIPv6(value: string): number[] | null {
  let text = value.trim();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  if (text === '') return null;

  // A trailing dotted-quad (v4-mapped/compatible/NAT64 forms) becomes two groups.
  const lastColon = text.lastIndexOf(':');
  if (lastColon !== -1 && text.slice(lastColon + 1).includes('.')) {
    const v4 = parseIPv4(text.slice(lastColon + 1));
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;

  const toGroups = (segment: string): number[] | null => {
    if (segment === '') return [];
    const out: number[] = [];
    for (const piece of segment.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
      out.push(parseInt(piece, 16));
    }
    return out;
  };

  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];
  if (head === null || tail === null) return null;

  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    return [...head, ...new Array(fill).fill(0), ...tail];
  }
  return head.length === 8 ? head : null;
}

/** Classify an IPv6 address, following embedded IPv4 where one is present. */
export function classifyIPv6(value: string): AddressVerdict {
  const groups = parseIPv6(value);
  if (!groups) return blocked(`"${value}" is not a well-formed IPv6 address`);

  const embeddedV4 = (hi: number, lo: number): string =>
    `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

  const isZeroPrefix = (count: number): boolean => groups.slice(0, count).every(g => g === 0);

  // ::, ::1
  if (isZeroPrefix(7)) {
    if (groups[7] === 0) return blocked(`${value} is the unspecified address (::)`);
    if (groups[7] === 1) return blocked(`${value} is the IPv6 loopback address (::1)`);
  }

  // ::ffff:a.b.c.d (v4-mapped) and ::a.b.c.d (v4-compatible) -> judge the IPv4.
  if (isZeroPrefix(5) && groups[5] === 0xffff) {
    const v4 = embeddedV4(groups[6], groups[7]);
    const verdict = classifyIPv4(v4);
    return verdict.blocked
      ? blocked(`${value} maps to IPv4 ${v4}, which is blocked: ${verdict.reason}`)
      : ALLOWED;
  }
  if (isZeroPrefix(6) && !(groups[6] === 0 && groups[7] <= 1)) {
    const v4 = embeddedV4(groups[6], groups[7]);
    const verdict = classifyIPv4(v4);
    return verdict.blocked
      ? blocked(`${value} embeds IPv4 ${v4}, which is blocked: ${verdict.reason}`)
      : ALLOWED;
  }

  // 64:ff9b::/96 NAT64 -> judge the embedded IPv4.
  if (groups[0] === 0x64 && groups[1] === 0xff9b && isZeroPrefixFrom(groups, 2, 6)) {
    const v4 = embeddedV4(groups[6], groups[7]);
    const verdict = classifyIPv4(v4);
    return verdict.blocked
      ? blocked(`${value} is NAT64 for IPv4 ${v4}, which is blocked: ${verdict.reason}`)
      : ALLOWED;
  }

  // 2002::/16 6to4 -> the next 32 bits are an embedded IPv4.
  if (groups[0] === 0x2002) {
    const v4 = embeddedV4(groups[1], groups[2]);
    const verdict = classifyIPv4(v4);
    return verdict.blocked
      ? blocked(`${value} is 6to4 for IPv4 ${v4}, which is blocked: ${verdict.reason}`)
      : ALLOWED;
  }

  const first = groups[0];
  if ((first & 0xfe00) === 0xfc00) return blocked(`${value} is a unique local address (fc00::/7)`);
  if ((first & 0xffc0) === 0xfe80) return blocked(`${value} is link-local (fe80::/10)`);
  if ((first & 0xff00) === 0xff00) return blocked(`${value} is multicast (ff00::/8)`);
  if (first === 0x0100 && groups[1] === 0) return blocked(`${value} is discard-only space (100::/64)`);
  if (first === 0x2001 && groups[1] === 0x0db8) return blocked(`${value} is documentation space (2001:db8::/32)`);

  return ALLOWED;
}

function isZeroPrefixFrom(groups: number[], from: number, to: number): boolean {
  for (let i = from; i < to; i++) {
    if (groups[i] !== 0) return false;
  }
  return true;
}

/** Classify any IP literal, dispatching on family. */
export function classifyAddress(value: string): AddressVerdict {
  return value.includes(':') ? classifyIPv6(value) : classifyIPv4(value);
}
