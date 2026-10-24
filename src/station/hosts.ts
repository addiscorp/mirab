// Which hosts a VM may reach, and which addresses are the public internet:
// shared by the station's tunnels, its routes and the hosts it opens.
import { BlockList, isIP } from 'node:net'

/** Whether `host` is on the whitelist: an exact match, or under a `*.` entry. */
export function allowed(host: string, allow: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  return allow.some((entry) => {
    const e = entry.toLowerCase()
    return e.startsWith('*.')
      ? h.endsWith(e.slice(1)) && h.length > e.length - 1
      : h === e
  })
}

/** Addresses a whitelisted name must never lead to: the host itself, the LAN,
 *  link-local (cloud metadata), carrier-grade NAT (Tailscale), documentation,
 *  multicast, and IPv6 forms that carry an IPv4 address or a tunnel. */
const NOT_PUBLIC_V4 = new BlockList()
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  NOT_PUBLIC_V4.addSubnet(net, bits, 'ipv4')
const NOT_PUBLIC_V6 = new BlockList()
for (const [net, bits] of [
  ['::', 96], // unspecified, loopback and IPv4-compatible
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48],
  ['100::', 64], // discard
  ['2001::', 23], // IETF protocol assignments: Teredo, benchmarking, ORCHID, AMT, AS112
  ['100:0:0:1::', 64], // dummy prefix
  ['2620:4f:8000::', 48], // AS112
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['::ffff:0:0:0', 96], // SIIT: IPv4 translated
  ['3fff::', 20], // documentation
  ['5f00::', 16], // segment routing
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local
  ['ff00::', 8], // multicast
] as const)
  NOT_PUBLIC_V6.addSubnet(net, bits, 'ipv6')

/** Whether `address` is on the public internet. Each family has its own list,
 *  and IPv6 is judged in its canonical form, however it was written. */
export function isPublic(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !NOT_PUBLIC_V4.check(address, 'ipv4')
  // A zone id (fe80::1%en0) is never a public address.
  if (family !== 6 || address.includes('%')) return false
  let canonical: string
  try {
    canonical = new URL(`http://[${address}]`).hostname.slice(1, -1)
  } catch {
    return false
  }
  // An IPv4 address written as IPv6 (::ffff:a.b.c.d) is judged as IPv4.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical)
  if (mapped) {
    const hi = parseInt(mapped[1], 16)
    const lo = parseInt(mapped[2], 16)
    return isPublic(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
  }
  return !NOT_PUBLIC_V6.check(canonical, 'ipv6')
}
