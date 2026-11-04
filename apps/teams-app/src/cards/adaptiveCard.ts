/*
 * The subset of the Adaptive Card 1.5 schema this app renders. Teams desktop, web and mobile
 * support 1.5. Untrusted text (answers, Moodle names, excerpts) is only ever placed in
 * TextRun elements, which do not interpret Markdown; TextBlock (which does) carries fixed
 * strings written in this repository.
 */

export const ADAPTIVE_CARD_VERSION = '1.5';
export const ADAPTIVE_CARD_CONTENT_TYPE = 'application/vnd.microsoft.card.adaptive';

export interface TextBlock {
  readonly type: 'TextBlock';
  readonly text: string;
  readonly wrap: true;
  readonly weight?: 'Bolder';
  readonly size?: 'Small' | 'Medium' | 'Large';
  readonly isSubtle?: boolean;
  readonly spacing?: 'None' | 'Small' | 'Medium' | 'Large';
}

export interface TextRun {
  readonly type: 'TextRun';
  readonly text: string;
  readonly weight?: 'Bolder';
  readonly italic?: boolean;
  readonly isSubtle?: boolean;
  readonly size?: 'Small';
}

export interface RichTextBlock {
  readonly type: 'RichTextBlock';
  readonly inlines: readonly TextRun[];
  readonly spacing?: 'None' | 'Small' | 'Medium';
}

export interface Container {
  readonly type: 'Container';
  readonly items: readonly CardElement[];
  readonly style?: 'emphasis' | 'warning' | 'attention' | 'good' | 'accent';
  readonly separator?: boolean;
  readonly spacing?: 'None' | 'Small' | 'Medium';
}

export interface ActionSet {
  readonly type: 'ActionSet';
  readonly actions: readonly CardAction[];
}

export type CardElement = TextBlock | RichTextBlock | Container | ActionSet;

export interface OpenUrlAction {
  readonly type: 'Action.OpenUrl';
  readonly title: string;
  readonly url: string;
}

/** Universal Action: Teams sends an `adaptiveCard/action` invoke to the bot. */
export interface ExecuteAction {
  readonly type: 'Action.Execute';
  readonly title: string;
  readonly verb: string;
  readonly data: Readonly<Record<string, string>>;
  readonly fallback?: SubmitAction;
}

/** Older clients: Teams posts `data` back as a message value, or the imBack text. */
export interface SubmitAction {
  readonly type: 'Action.Submit';
  readonly title: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export type CardAction = OpenUrlAction | ExecuteAction | SubmitAction;

export interface AdaptiveCard {
  readonly type: 'AdaptiveCard';
  readonly $schema: 'http://adaptivecards.io/schemas/adaptive-card.json';
  readonly version: typeof ADAPTIVE_CARD_VERSION;
  readonly body: readonly CardElement[];
  readonly actions?: readonly CardAction[];
}

export function adaptiveCard(
  body: readonly CardElement[],
  actions?: readonly CardAction[],
): AdaptiveCard {
  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: ADAPTIVE_CARD_VERSION,
    body,
    ...(actions === undefined || actions.length === 0 ? {} : { actions }),
  };
}

/** Fixed text written in this repository (may use Teams' limited Markdown). */
export function fixedText(
  text: string,
  options: Omit<TextBlock, 'type' | 'text' | 'wrap'> = {},
): TextBlock {
  return { type: 'TextBlock', text, wrap: true, ...options };
}

export function cardBytes(card: AdaptiveCard): number {
  return Buffer.byteLength(JSON.stringify(card), 'utf8');
}
