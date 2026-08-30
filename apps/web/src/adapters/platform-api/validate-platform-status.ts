import type { PlatformStatus } from '@money-noodle/platform-api-client';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u;
const RFC_3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const STATES = new Set(['available', 'degraded', 'maintenance']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
  );
}

export function isPlatformStatus(value: unknown): value is PlatformStatus {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['asOf', 'requestId', 'schemaVersion', 'service', 'state']) ||
    typeof value.state !== 'string' ||
    !STATES.has(value.state) ||
    typeof value.asOf !== 'string' ||
    !RFC_3339_PATTERN.test(value.asOf) ||
    Number.isNaN(Date.parse(value.asOf)) ||
    value.schemaVersion !== '1' ||
    typeof value.requestId !== 'string' ||
    !REQUEST_ID_PATTERN.test(value.requestId) ||
    !isRecord(value.service) ||
    !hasExactKeys(value.service, ['name', 'version']) ||
    value.service.name !== 'platform-api' ||
    typeof value.service.version !== 'string' ||
    !VERSION_PATTERN.test(value.service.version)
  ) {
    return false;
  }

  return true;
}
