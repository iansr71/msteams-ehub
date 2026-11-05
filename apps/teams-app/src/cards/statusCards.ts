import { retryAction, suggestionAction } from './actions.js';
import {
  adaptiveCard,
  fixedText,
  type AdaptiveCard,
  type CardAction,
  type Container,
  type TextBlock,
} from './adaptiveCard.js';
import { cleanCardText } from './text.js';

/** Shown on every card while the development mock identity is in use. */
export function mockIdentityBanner(): Container {
  return {
    type: 'Container',
    style: 'warning',
    items: [
      fixedText(
        '**Development mode — mock identity.** You are not signed in; answers use a test user and test course access. Not for production use.',
        { size: 'Small' },
      ),
    ],
  };
}

const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** "Reference: <id>" for support requests; IDs that are not log-safe are not shown. */
export function referenceLine(id: string): TextBlock {
  return fixedText(REFERENCE_PATTERN.test(id) ? `Reference: ${id}` : 'Reference unavailable', {
    isSubtle: true,
    size: 'Small',
    spacing: 'Medium',
  });
}

/**
 * Placeholder suggestions: replace them with real questions staff ask (see
 * docs/teams-app.md). They are fixed strings, so they may be rendered as Markdown.
 */
export const DEFAULT_SUGGESTED_QUESTIONS: readonly string[] = [
  'What aftercare should a client follow after a chemical peel?',
  'How do I prepare a client for laser hair removal?',
  'Where do I find the consultation checklist?',
];

export function renderWelcomeCard(options: {
  readonly mockIdentity: boolean;
  readonly suggestions?: readonly string[];
}): AdaptiveCard {
  const suggestions = (options.suggestions ?? DEFAULT_SUGGESTED_QUESTIONS).slice(0, 5);
  return adaptiveCard(
    [
      ...(options.mockIdentity ? [mockIdentityBanner()] : []),
      fixedText('E-Hub Knowledge Assistant', { weight: 'Bolder', size: 'Large' }),
      fixedText(
        'Ask me about procedures, treatments and training material. I answer only from the E-Hub courses you can access, and every answer lists its sources.',
      ),
      fixedText('Try one of these, or type your own question:', {
        spacing: 'Medium',
        isSubtle: true,
      }),
    ],
    suggestions.map(suggestionAction),
  );
}

export type ErrorKind =
  | 'timeout'
  | 'unavailable'
  | 'bad_response'
  | 'busy'
  | 'rate_limited'
  | 'question_too_long'
  | 'invalid_question'
  | 'identity_unavailable'
  | 'sign_in_failed'
  | 'not_permitted'
  | 'no_access'
  | 'not_linked'
  | 'access_check_failed'
  | 'personal_only';

const ERRORS: Readonly<Record<ErrorKind, { title: string; text: string; retry: boolean }>> = {
  timeout: {
    title: 'That took too long',
    text: 'The answer service did not respond in time. Please try again in a moment.',
    retry: true,
  },
  unavailable: {
    title: 'Answers are unavailable',
    text: 'The answer service could not be reached. Please try again later; if it keeps happening, contact IT and quote the reference below.',
    retry: true,
  },
  bad_response: {
    title: 'Something went wrong',
    text: 'The answer service sent a response I could not use. Please try again; if it keeps happening, contact IT and quote the reference below.',
    retry: true,
  },
  busy: {
    title: 'Busy right now',
    text: 'I am answering a lot of questions at the moment. Please ask again in a few seconds.',
    retry: true,
  },
  rate_limited: {
    title: 'Too many questions',
    text: 'You have asked a lot of questions in a short time. Please wait a moment and try again.',
    retry: true,
  },
  question_too_long: {
    title: 'Question too long',
    text: 'Please keep questions under 1000 characters and ask one thing at a time.',
    retry: false,
  },
  invalid_question: {
    title: 'I could not read that question',
    text: 'Please type your question as plain text.',
    retry: false,
  },
  identity_unavailable: {
    title: 'Sign-in is not available',
    text: 'I cannot confirm who you are right now, so I cannot check which E-Hub courses you can see. Please try again later; if it keeps happening, contact IT and quote the reference below.',
    retry: false,
  },
  sign_in_failed: {
    title: 'Sign-in did not work',
    text: 'I could not confirm your Microsoft sign-in. Please ask again; if it keeps happening, contact IT and quote the reference below.',
    retry: true,
  },
  not_permitted: {
    title: 'Not available for your account',
    text: 'Your account is not allowed to use the E-Hub Knowledge Assistant. If you think this is wrong, contact IT and quote the reference below.',
    retry: false,
  },
  no_access: {
    title: 'No E-Hub access found',
    text: 'You do not seem to have access to any E-Hub courses that I can search. If you think this is wrong, contact IT.',
    retry: false,
  },
  not_linked: {
    title: 'Your account is not linked to E-Hub',
    text: 'I could not match your Microsoft account to exactly one active E-Hub account, so I cannot tell which courses you can see. Contact IT and quote the reference below.',
    retry: false,
  },
  access_check_failed: {
    title: 'Course access cannot be checked',
    text: 'I cannot reach E-Hub to check which courses you can see, so I have not searched anything. Please try again in a few minutes.',
    retry: true,
  },
  personal_only: {
    title: 'Personal chat only',
    text: 'I only answer questions in a one-to-one chat. Open the E-Hub Knowledge Assistant app and ask me there.',
    retry: false,
  },
};

export function renderErrorCard(options: {
  readonly kind: ErrorKind;
  readonly reference: string;
  readonly mockIdentity: boolean;
  /** Offered as "Ask again" for retryable errors. */
  readonly question?: string;
}): AdaptiveCard {
  const spec = ERRORS[options.kind];
  const actions: CardAction[] = [];
  if (spec.retry && options.question !== undefined) {
    const retry = retryAction(cleanCardText(options.question, 1_000));
    if (retry !== undefined) {
      actions.push(retry);
    }
  }
  return adaptiveCard(
    [
      ...(options.mockIdentity ? [mockIdentityBanner()] : []),
      {
        type: 'Container',
        style: 'attention',
        items: [fixedText(spec.title, { weight: 'Bolder' }), fixedText(spec.text)],
      },
      referenceLine(options.reference),
    ],
    actions,
  );
}
