import { isIP } from 'node:net';

/*
 * Hosts a server-side request must never be steered to: this machine, link-local addresses
 * (which include the cloud metadata service at 169.254.169.254) and the unspecified address.
 * Private ranges (10/8, 172.16/12, 192.168/16) are not refused: a Moodle server on the internal
 * network is a legitimate target.
 *
 * Pass `URL.hostname`: the URL parser has already normalised decimal, octal and hexadecimal
 * IPv4 forms (http://2130706433/ and http://0x7f.1/ both become 127.0.0.1). A host name that
 * resolves to one of these addresses is not detected here (docs/threat-model.md).
 */

const LOCAL_NAMES = /^(?:localhost|.+\.localhost|metadata\.google\.internal|metadata)\.?$/i;

function ipv4Octets(address: string): number[] {
  return address.split('.').map((part) => Number(part));
}

function isLocalIpv4(address: string): boolean {
  const [first = -1, second = -1] = ipv4Octets(address);
  return first === 0 || first === 127 || (first === 169 && second === 254);
}

function isLocalIpv6(address: string): boolean {
  const value = address.toLowerCase();
  // IPv4-mapped (::ffff:127.0.0.1, also written ::ffff:7f00:1) and IPv4-compatible forms.
  const mapped = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (mapped?.[1] !== undefined) {
    return isLocalIpv4(mapped[1]);
  }
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(value);
  if (hexMapped?.[1] !== undefined && hexMapped[2] !== undefined) {
    const high = Number.parseInt(hexMapped[1], 16);
    const low = Number.parseInt(hexMapped[2], 16);
    return isLocalIpv4(
      `${String(high >> 8)}.${String(high & 0xff)}.${String(low >> 8)}.${String(low & 0xff)}`,
    );
  }
  if (value === '::' || value === '::1') {
    return true;
  }
  // fe80::/10 link-local.
  return /^fe[89ab][0-9a-f]:/.test(value);
}

/** True for loopback, link-local, unspecified and metadata hosts (see the note above). */
export function isLocalNetworkHost(hostname: string): boolean {
  const host =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  const version = isIP(host);
  if (version === 4) {
    return isLocalIpv4(host);
  }
  if (version === 6) {
    return isLocalIpv6(host);
  }
  return LOCAL_NAMES.test(host);
}
