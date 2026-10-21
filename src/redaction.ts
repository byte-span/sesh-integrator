// Best-effort redaction for command output that the integrator persists as
// failure evidence. It removes the values of secret-looking environment
// variables plus common credential shapes. It is a safeguard for diagnostics,
// not a guarantee: commands must still avoid printing credentials.

const placeholder = "[REDACTED]";

// Environment names whose values must never be persisted. PWD/OLDPWD and
// socket paths such as SSH_AUTH_SOCK are ordinary locations, and GIT_AUTHOR_*
// identifies a person rather than a credential.
const secretName =
  /(?:TOKEN|SECRET|PASSW(?:OR)?D|PASSPHRASE|CREDENTIAL|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|SIGNING_?KEY|_KEY$|^KEY$|COOKIE|SESSION_?ID|DSN$|AUTH(?!_SOCK|OR))/i;

const patterns: Array<[RegExp, string]> = [
  // PEM private keys, including a block cut off by the output bound.
  [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    "[REDACTED:private-key]",
  ],
  // Authorization headers keep their name and drop the scheme and value.
  [
    /\b((?:proxy-)?authorization["']?\s*[:=]\s*["']?)(?:(?:bearer|basic|token|digest|negotiate)\s+)?[^\s"',;]+/gi,
    `$1${placeholder}`,
  ],
  [/\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${placeholder}`],
  // Credentials embedded in URLs: scheme://user:password@host.
  [/(:\/\/[^\s:/@"']{1,256}:)[^\s@/"']{1,256}@/g, `$1${placeholder}@`],
  // Signed URL and token query parameters.
  [
    /([?&](?:x-amz-[a-z-]+|x-goog-[a-z-]+|signature|sig|token|access_token|id_token|refresh_token|api_key|apikey|key|password|secret|client_secret)=)[^&\s"'#]+/gi,
    `$1${placeholder}`,
  ],
  // Well-known token formats.
  [/\bgithub_pat_[A-Za-z0-9_]{10,}/g, placeholder],
  [/\bgh[pousr]_[A-Za-z0-9]{10,}/g, placeholder],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, placeholder],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, placeholder],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g, placeholder],
  [/\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g, placeholder],
  [/\bAIza[0-9A-Za-z_-]{35}/g, placeholder],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, placeholder],
  [
    /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    placeholder,
  ],
  // name=value and "name": "value" assignments for secret-looking names. The
  // match starts at the keyword (any name prefix is left as is) and every
  // repetition is bounded, so long unbroken output cannot backtrack badly.
  [
    /((?:password|passwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)[A-Za-z0-9_.-]{0,64}["']?\s{0,8}[:=]\s{0,8}["']?)(?!\[REDACTED)[^\s"',;&]{4,}/gi,
    `$1${placeholder}`,
  ],
];

export function redactSecrets(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  let result = text;
  const values = Object.entries(env)
    .filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" &&
        entry[1].trim().length >= 8 &&
        secretName.test(entry[0]),
    )
    .sort((a, b) => b[1].length - a[1].length);
  for (const [name, value] of values)
    result = result.split(value).join(`[REDACTED:${name}]`);
  for (const [pattern, replacement] of patterns)
    result = result.replace(pattern, replacement);
  return result;
}
