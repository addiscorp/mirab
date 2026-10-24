// The station's own certificate authority, for the hosts it opens (the
// `secrets` hosts in station.json): VMs trust its certificate, so the station
// can read a request to such a host and swap a placeholder for the real key.
// Its private key stays in the config directory (0600) and never enters a VM;
// every other host stays a sealed tunnel.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as x509 from '@peculiar/x509'

const ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' }
const DAY = 86_400_000
/** The authority lasts; each station run mints a fresh short-lived leaf. */
const CA_DAYS = 3650
const LEAF_DAYS = 7

export interface StationAuthority {
  /** The certificate a VM trusts (PEM). */
  cert: string
  /** A certificate for exactly these hosts, and its key (PEM), for the station's TLS. */
  leaf(hosts: string[]): Promise<{ cert: string; key: string }>
}

const pemKey = async (key: CryptoKey) => {
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', key))
  return `-----BEGIN PRIVATE KEY-----\n${der
    .toString('base64')
    .match(/.{1,64}/g)!
    .join('\n')}\n-----END PRIVATE KEY-----\n`
}

/** A random positive serial: 16 bytes, top bit clear, never a leading zero. */
function serial() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[0] = (bytes[0] & 0x7f) | 0x10
  return Buffer.from(bytes).toString('hex')
}

/** Loads `<dir>/ca.pem` and `ca.key`, or makes them the first time. */
export async function stationAuthority(dir: string): Promise<StationAuthority> {
  const certPath = join(dir, 'ca.pem')
  const keyPath = join(dir, 'ca.key')
  let caCert: x509.X509Certificate
  let caKey: CryptoKey
  const existing = await Promise.all([
    readFile(certPath, 'utf8'),
    readFile(keyPath, 'utf8'),
  ]).catch(() => undefined)
  if (existing) {
    caCert = new x509.X509Certificate(existing[0])
    const der = Buffer.from(
      existing[1].replace(/-----[^-]+-----|\s/g, ''),
      'base64',
    )
    caKey = await crypto.subtle.importKey('pkcs8', der, ALG, false, ['sign'])
  } else {
    const keys = await crypto.subtle.generateKey(ALG, true, ['sign', 'verify'])
    caCert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: serial(),
      name: 'CN=mirab station',
      notBefore: new Date(Date.now() - DAY),
      notAfter: new Date(Date.now() + CA_DAYS * DAY),
      keys,
      signingAlgorithm: ALG,
      extensions: [
        new x509.BasicConstraintsExtension(true, 0, true),
        new x509.KeyUsagesExtension(
          x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
          true,
        ),
      ],
    })
    caKey = keys.privateKey
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeFile(keyPath, await pemKey(keys.privateKey), { mode: 0o600 })
    await writeFile(certPath, caCert.toString('pem'), { mode: 0o644 })
  }
  return {
    cert: caCert.toString('pem'),
    async leaf(hosts) {
      const keys = await crypto.subtle.generateKey(ALG, true, [
        'sign',
        'verify',
      ])
      const leaf = await x509.X509CertificateGenerator.create({
        serialNumber: serial(),
        subject: `CN=${hosts[0] ?? 'mirab station'}`,
        issuer: caCert.subject,
        notBefore: new Date(Date.now() - DAY),
        notAfter: new Date(Date.now() + LEAF_DAYS * DAY),
        signingKey: caKey,
        publicKey: keys.publicKey,
        signingAlgorithm: ALG,
        extensions: [
          new x509.SubjectAlternativeNameExtension(
            hosts.map((value) => ({ type: 'dns' as const, value })),
          ),
          new x509.ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1']),
          new x509.BasicConstraintsExtension(false),
        ],
      })
      return { cert: leaf.toString('pem'), key: await pemKey(keys.privateKey) }
    },
  }
}
