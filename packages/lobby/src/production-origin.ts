import { isIP } from 'node:net';

/** Classify a hostname for the Node-only production deployment boundary. */
export function isProductionHostname(hostname: string): boolean {
  let host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (isIP(host) === 0 && !host.includes(':')) {
    try {
      const normalized = new URL(`https://${host}`).hostname.toLowerCase().replace(/^\[|\]$/g, '');
      if (isIP(normalized) === 4) host = normalized;
    } catch {
      // The caller's complete origin parser owns generic malformed-origin errors.
    }
  }
  if (host === 'localhost' || host.endsWith('.localhost')) return false;

  const ipVersion = isIP(host);
  if (ipVersion === 4 && host.split('.')[0] === '127') return false;
  if (ipVersion === 6) {
    const words = parseIPv6(host);
    if (!words) return false;
    if (words.every((word, index) => index === 7 ? word === 1 : word === 0)) return false;
    // IPv4-mapped loopback is still loopback, including hexadecimal and dotted
    // spellings of the mapped 127/8 address.
    if (
      words.slice(0, 5).every((word) => word === 0) &&
      words[5] === 0xffff &&
      words[6] !== undefined &&
      (words[6] >> 8) === 127
    ) return false;
  }

  if (host === 'invalid' || host.endsWith('.invalid')) return false;
  return !hasPlaceholderLabel(host);
}

function hasPlaceholderLabel(host: string): boolean {
  const labels = host.split('.');
  if (labels.some((label) => isPlaceholderLabel(label))) return true;

  // A dot is also a valid separator in the explicit forms (for example,
  // replace.with.host), so keep those sequences bounded to their exact words.
  return labels.some((label, index) =>
    (label === 'replace' && isReplaceSuffix(labels[index + 1])) ||
    (label === 'replace' && labels[index + 1] === 'with' && isReplaceSuffix(labels[index + 2])) ||
    (label === 'your' && isYourSuffix(labels[index + 1])),
  );
}

function isPlaceholderLabel(label: string): boolean {
  if (label === 'placeholder' || label === 'replace') return true;
  if (/^replace(?:with)?(?:host|hostname|domain|this|me)$/.test(label)) return true;
  if (/^your(?:host|hostname|domain)$/.test(label)) return true;
  const segments = label.split(/[-_]/g);
  if (segments.some((segment) => segment === '')) return false;
  if (segments[0] === 'replace') {
    return isReplaceSegments(segments.slice(1));
  }
  if (segments[0] === 'your') {
    return isYourSegments(segments.slice(1));
  }
  return false;
}

function isReplaceSuffix(label: string | undefined): boolean {
  return label === 'host' || label === 'hostname' || label === 'domain' || label === 'this' || label === 'me';
}

function isYourSuffix(label: string | undefined): boolean {
  return label === 'host' || label === 'hostname' || label === 'domain';
}

function isReplaceSegments(segments: string[]): boolean {
  return (
    (segments.length === 1 && isReplaceSuffix(segments[0])) ||
    (segments.length === 2 && segments[0] === 'with' && isReplaceSuffix(segments[1]))
  );
}

function isYourSegments(segments: string[]): boolean {
  return segments.length === 1 && isYourSuffix(segments[0]);
}

function parseIPv6(host: string): number[] | null {
  const halves = host.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];

  const parseWords = (parts: string[]): number[] | null => {
    const words: number[] = [];
    for (const part of parts) {
      if (part.includes('.')) {
        const octets = part.split('.').map(Number);
        if (
          octets.length !== 4 ||
          octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
        ) return null;
        const [first, second, third, fourth] = octets;
        if (first === undefined || second === undefined || third === undefined || fourth === undefined) return null;
        words.push((first << 8) | second, (third << 8) | fourth);
      } else if (/^[0-9a-f]{1,4}$/i.test(part)) {
        words.push(Number.parseInt(part, 16));
      } else {
        return null;
      }
    }
    return words;
  };

  const leftWords = parseWords(left);
  const rightWords = parseWords(right);
  if (!leftWords || !rightWords) return null;
  if (halves.length === 1) return leftWords.length === 8 ? leftWords : null;
  if (leftWords.length + rightWords.length >= 8) return null;
  return [...leftWords, ...Array(8 - leftWords.length - rightWords.length).fill(0), ...rightWords];
}
