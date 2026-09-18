// Output allowlisting for public evidence.
//
// Everything these adapters emit — journal events, witness records, refusal
// reasons, log lines — is public and permanently copyable. The catalog's
// custody inventory draws the line: public records carry safe logical labels,
// bounded counts and allowlisted comparisons; native names, URLs, IAM members,
// etags, raw plans, responses and tokens stay out.
//
// Two rules here are easy to get subtly wrong, so they are enforced rather than
// documented:
//
//   1. A refusal must not quote what it refused. The marker's *kind* is
//      reportable; its value is not. Otherwise the leak path is the error path.
//   2. Hashing is not sanitisation. "A digest of a secret value or a
//      low-entropy private identifier is not sanitization and must not be
//      published" — a digest of a project number or a service URL is a verifier
//      for a guessable value, so `digestForPublication` refuses it.

import { canonicalize, sha256Hex } from './canonical-json.mjs';
import { RefusalError, refuse } from './refusals.mjs';

/**
 * Shapes that must never reach public evidence.
 *
 * Named by kind only. A match reports the kind and the JSON path; the matched
 * text is deliberately never carried out of this module.
 */
const FORBIDDEN_SHAPES = Object.freeze([
  { kind: 'github-token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/ },
  { kind: 'github-fine-grained-token', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { kind: 'google-oauth-token', pattern: /\bya29\.[A-Za-z0-9._-]{10,}/ },
  { kind: 'google-api-key', pattern: /\bAIza[A-Za-z0-9_-]{30,}/ },
  { kind: 'bearer-credential', pattern: /\bBearer\s+[A-Za-z0-9._-]{16,}/i },
  { kind: 'private-key-block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: 'service-account-key-field', pattern: /"?private_key(?:_id)?"?\s*[:=]/ },
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  {
    kind: 'native-project-path',
    pattern: /\bprojects\/[^/\s"]+\/(?:locations|secrets|serviceAccounts)\//,
  },
  {
    kind: 'service-account-member',
    pattern: /\bserviceAccount:[^\s"]+@[^\s"]+\.iam\.gserviceaccount\.com/,
  },
  { kind: 'cloud-run-url', pattern: /https:\/\/[A-Za-z0-9-]+\.[a-z0-9-]+\.run\.app/ },
  { kind: 'raw-plan-payload', pattern: /"(?:resource_changes|prior_state|terraform_version)"\s*:/ },
  { kind: 'provider-etag', pattern: /\betag"?\s*[:=]\s*"/i },
]);

/**
 * Private identifier shapes whose digest is a verifier for a guessable value.
 *
 * These deny in `digestForPublication` even when the caller claims entropy,
 * because the claim is about the wrong thing: a 12-digit project number has
 * roughly 40 bits of entropy however long the string is.
 */
const LOW_ENTROPY_SHAPES = Object.freeze([
  { kind: 'numeric-identifier', pattern: /^\d{1,24}$/ },
  { kind: 'billing-account-id', pattern: /^[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}$/ },
  { kind: 'email-address', pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
  { kind: 'url', pattern: /^[a-z][a-z0-9+.-]*:\/\// },
  // A separated label ("platform-api", "config-1") is a name, not a secret.
  // Undifferentiated alphanumerics fall through to the entropy estimate so a
  // genuine 256-bit hex value is not refused for looking plain.
  { kind: 'dotted-or-dashed-name', pattern: /^[a-z0-9]+(?:[.-][a-z0-9]+){1,8}$/i },
  { kind: 'iso-timestamp', pattern: /^\d{4}-\d{2}-\d{2}T/ },
]);

/**
 * The floor below which a digest is a lookup table rather than a one-way
 * function. 128 bits is the conventional pre-image target; nothing here needs a
 * value between "clearly guessable" and "clearly not".
 */
export const MINIMUM_PUBLISHABLE_ENTROPY_BITS = 128;

function alphabetSize(value) {
  let size = 0;
  if (/[a-z]/.test(value)) size += 26;
  if (/[A-Z]/.test(value)) size += 26;
  if (/[0-9]/.test(value)) size += 10;
  if (/[^A-Za-z0-9]/.test(value)) size += 32;
  return size;
}

/** A deliberately conservative upper bound on the entropy of `value`. */
export function estimatedEntropyBits(value) {
  if (typeof value !== 'string' || value.length === 0) return 0;
  const size = alphabetSize(value);
  if (size <= 1) return 0;
  const distinct = new Set(value).size;
  // A long run of one character is not entropy, so the distinct-character count
  // caps the estimate as well as the length does.
  return Math.min(value.length, distinct * 4) * Math.log2(size);
}

/** Reports whether `value` matches a shape whose digest would be guessable. */
export function isLowEntropyIdentifier(value) {
  if (typeof value !== 'string') return true;
  if (LOW_ENTROPY_SHAPES.some(({ pattern }) => pattern.test(value))) return true;
  return estimatedEntropyBits(value) < MINIMUM_PUBLISHABLE_ENTROPY_BITS;
}

function walk(value, path, found) {
  if (typeof value === 'string') {
    for (const { kind, pattern } of FORBIDDEN_SHAPES) {
      // The matched text is never captured: only the kind and the location.
      if (pattern.test(value)) found.push({ kind, path: path || '(root)' });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walk(entry, `${path}[${index}]`, found));
    return;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      for (const { kind, pattern } of FORBIDDEN_SHAPES) {
        if (pattern.test(key)) found.push({ kind, path: path ? `${path}.${key}` : key });
      }
      walk(value[key], path ? `${path}.${key}` : key, found);
    }
  }
}

/**
 * Every forbidden shape reachable from `value`, as `{kind, path}` pairs.
 *
 * The result is safe to print: it describes what was found and where, never
 * what the value was.
 */
export function findForbiddenMarkers(value) {
  const found = [];
  walk(value, '', found);
  return found;
}

/**
 * Refuses `value` if it carries anything that must not be published.
 *
 * Returns the value unchanged when it is clean, so call sites can wrap the
 * record they are about to append rather than remembering a separate check.
 */
export function assertPublishable(value, label = 'evidence') {
  const markers = findForbiddenMarkers(value);
  if (markers.length === 0) return value;
  const kinds = [...new Set(markers.map((marker) => marker.kind))].sort().join(',');
  throw new RefusalError(
    refuse(
      'catalog.custody',
      'evidence-unsanitised',
      `${label} carries material that must not enter public evidence`,
      // Kinds and the first path only. Bounded, and free of the offending text.
      `kinds=${kinds} at=${markers[0].path}`,
    ).refusal,
  );
}

/**
 * Digests `value` for publication, refusing when the digest would be a verifier
 * for a guessable input.
 *
 * `declaredEntropyBits` is the caller's explicit claim about the input. It can
 * only lower the result, never raise it above what the value itself supports:
 * claiming 256 bits for a project number does not make the digest safe.
 */
export function digestForPublication(
  value,
  { declaredEntropyBits = 0, label = 'identifier' } = {},
) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RefusalError(
      refuse('catalog.custody', 'evidence-unsanitised', 'only strings are digested', label).refusal,
    );
  }
  const effective = Math.min(declaredEntropyBits, estimatedEntropyBits(value));
  if (isLowEntropyIdentifier(value) || effective < MINIMUM_PUBLISHABLE_ENTROPY_BITS) {
    throw new RefusalError(
      refuse(
        'catalog.custody',
        'evidence-unsanitised',
        'a digest of a low-entropy identifier is not sanitisation and must not be published',
        label,
      ).refusal,
    );
  }
  return sha256Hex(value);
}

/**
 * Canonical text for a record that is about to become public evidence.
 *
 * Sanitisation runs before encoding so nothing forbidden is ever serialised,
 * not even into a string that is then discarded.
 */
export function publishableCanonicalText(value, label = 'evidence') {
  return canonicalize(assertPublishable(value, label));
}
