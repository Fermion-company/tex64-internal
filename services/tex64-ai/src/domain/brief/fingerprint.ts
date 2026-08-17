function hash32(value: string, seed: number): number {
  let hash = (0x811c9dc5 ^ seed) >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function deterministicBriefId(seed: string): string {
  const hex = [0, 1, 2, 3]
    .map((index) => hash32(`${seed}:${index}`, index * 0x9e3779b9))
    .map((value) => value.toString(16).padStart(8, "0"))
    .join("")
    .split("");
  hex[12] = "4";
  const variant = Number.parseInt(hex[16] ?? "0", 16);
  hex[16] = ((variant & 0x3) | 0x8).toString(16);
  const compact = hex.join("");
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(
    12,
    16,
  )}-${compact.slice(16, 20)}-${compact.slice(20, 32)}`;
}

