import { isIP, isIPv4, isIPv6 } from "node:net";

function unwrapAddress(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed.slice(1, -1);
  return trimmed;
}

function ipv4Number(address: string): number | undefined {
  if (!isIPv4(address)) return undefined;
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return undefined;
  return (((octets[0]! << 24) >>> 0) + (octets[1]! << 16) + (octets[2]! << 8) + octets[3]!) >>> 0;
}

function inIpv4Cidr(address: number, network: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) >>> 0 === (network & mask) >>> 0;
}

function ipv6Bytes(address: string): Uint8Array | undefined {
  if (!isIPv6(address) || address.includes("%")) return undefined;
  const [leftText, rightText, extra] = address.split("::");
  if (extra !== undefined) return undefined;

  const parseSide = (text: string | undefined): number[] | undefined => {
    if (!text) return [];
    const parts = text.split(":");
    const words: number[] = [];
    for (const [index, part] of parts.entries()) {
      if (part.includes(".")) {
        if (index !== parts.length - 1) return undefined;
        const mapped = ipv4Number(part);
        if (mapped === undefined) return undefined;
        words.push((mapped >>> 16) & 0xffff, mapped & 0xffff);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(part)) return undefined;
      words.push(Number.parseInt(part, 16));
    }
    return words;
  };

  const left = parseSide(leftText);
  const right = parseSide(rightText);
  if (!left || !right) return undefined;
  const compressed = address.includes("::");
  const missing = 8 - left.length - right.length;
  if ((!compressed && missing !== 0) || (compressed && missing < 1)) return undefined;
  const words = [...left, ...Array.from({ length: missing }, () => 0), ...right];
  if (words.length !== 8) return undefined;
  const bytes = new Uint8Array(16);
  words.forEach((word, index) => {
    bytes[index * 2] = word >>> 8;
    bytes[index * 2 + 1] = word & 0xff;
  });
  return bytes;
}

function ipv4FromMappedIpv6(bytes: Uint8Array): string | undefined {
  const mappedPrefix = bytes.slice(0, 10).every((byte) => byte === 0);
  if (!mappedPrefix || bytes[10] !== 0xff || bytes[11] !== 0xff) return undefined;
  return `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
}

export function isPublicIpv4(address: string): boolean {
  const numeric = ipv4Number(unwrapAddress(address));
  if (numeric === undefined) return false;
  const blocked: ReadonlyArray<readonly [number, number]> = [
    [0x00000000, 8],
    [0x0a000000, 8],
    [0x64400000, 10],
    [0x7f000000, 8],
    [0xa9fe0000, 16],
    [0xac100000, 12],
    [0xc0000000, 24],
    [0xc0000200, 24],
    [0xc0586300, 24],
    [0xc0a80000, 16],
    [0xc6120000, 15],
    [0xc6336400, 24],
    [0xcb007100, 24],
    [0xe0000000, 4],
    [0xf0000000, 4],
  ];
  return !blocked.some(([network, prefix]) => inIpv4Cidr(numeric, network, prefix));
}

export function isPublicIpv6(address: string): boolean {
  const bytes = ipv6Bytes(unwrapAddress(address));
  if (!bytes) return false;
  const mapped = ipv4FromMappedIpv6(bytes);
  if (mapped) return isPublicIpv4(mapped);

  // Public global unicast is currently allocated from 2000::/3. Keeping the
  // allow-list narrow also rejects loopback, ULA, link-local and multicast.
  if ((bytes[0]! & 0xe0) !== 0x20) return false;

  // Documentation and special-purpose ranges inside global unicast.
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) {
    return false;
  }
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3]! <= 0x03) {
    return false;
  }
  if (
    bytes[0] === 0x20 &&
    bytes[1] === 0x01 &&
    bytes[2] === 0x00 &&
    (bytes[3]! & 0xf0) === 0x10
  ) {
    return false;
  }
  if (
    bytes[0] === 0x20 &&
    bytes[1] === 0x01 &&
    bytes[2] === 0x00 &&
    (bytes[3]! & 0xf0) === 0x20
  ) {
    return false;
  }
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return false;
  return true;
}

export function isPublicIpAddress(address: string): boolean {
  const normalized = unwrapAddress(address);
  if (isIPv4(normalized)) return isPublicIpv4(normalized);
  if (isIPv6(normalized)) return isPublicIpv6(normalized);
  return false;
}

export function normalizeIpAddress(address: string): string | undefined {
  const normalized = unwrapAddress(address);
  return isIP(normalized) === 0 ? undefined : normalized;
}

export function isForbiddenSourceHostname(hostname: string): boolean {
  const normalized = unwrapAddress(hostname).replace(/\.$/, "");
  return (
    !normalized.includes(".") ||
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".test") ||
    normalized.endsWith(".example") ||
    normalized.endsWith(".invalid") ||
    normalized.endsWith(".arpa") ||
    normalized === "metadata" ||
    normalized.startsWith("metadata.")
  );
}
