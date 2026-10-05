// What a read of the platform API can turn out to be, and what each outcome says.
//
// Six outcomes rather than "data or nothing", because the API distinguishes them and a
// reader deserves the distinction. "The record has never been published" and "the
// database is unreachable" are different facts about the simulation, and both are
// different from "this site could not reach the API at all" — which is about this site,
// not about the data.
//
// What no failure here produces is a number. There is no zero balance, no empty
// record, and no last-known value kept from an earlier render: each page states what it
// could not read and shows nothing in its place.

export type ReadFailureKind =
  | 'api-problem'
  | 'api-unusable'
  | 'read-model-invalid'
  | 'read-model-not-published'
  | 'read-model-unreachable'
  | 'transport';

export type ReadOutcome<T> =
  | { readonly failure: ReadFailureKind; readonly ok: false }
  | { readonly ok: true; readonly value: T };

export interface ReadFailurePresentation {
  readonly explanation: string;
  readonly label: string;
}

/**
 * The wording for each outcome.
 *
 * Calm, specific, and about the data rather than the machinery: no status code, no
 * host, no stack, and nothing a reader would have to be an operator to understand.
 */
const FAILURE_PRESENTATION: Readonly<Record<ReadFailureKind, ReadFailurePresentation>> =
  Object.freeze({
    'api-problem': {
      explanation:
        'The platform API refused this read. Nothing is shown in its place; please try again later.',
      label: 'Not available',
    },
    'api-unusable': {
      explanation:
        'The platform API answered with a record this site does not recognise, so none of it is shown.',
      label: 'Not available',
    },
    'read-model-invalid': {
      explanation:
        'The stored record could not be read as this site expects, so no figures are shown for it.',
      label: 'Record unreadable',
    },
    'read-model-not-published': {
      explanation:
        'The simulation has published no such record yet. This is not a zero balance: there is no record to show.',
      label: 'Not published yet',
    },
    'read-model-unreachable': {
      explanation:
        'The stored simulation record could not be reached just now. Nothing is shown in its place.',
      label: 'Record unreachable',
    },
    transport: {
      explanation:
        'This site could not reach the platform API. The figures below are not available; nothing has been estimated.',
      label: 'API unreachable',
    },
  });

export function describeReadFailure(kind: ReadFailureKind): ReadFailurePresentation {
  return FAILURE_PRESENTATION[kind];
}

/** The error code the API publishes on a read-model refusal, as an outcome. */
export function readModelFailure(errorCode: string | undefined): ReadFailureKind {
  if (errorCode === 'MN-READ-MODEL-NOT-PUBLISHED') return 'read-model-not-published';
  if (errorCode === 'MN-READ-MODEL-INVALID') return 'read-model-invalid';
  if (errorCode === 'MN-READ-MODEL-UNREACHABLE') return 'read-model-unreachable';
  // Any other problem document is still a refusal, and is reported as one rather than
  // being guessed into one of the three above.
  return 'api-problem';
}
