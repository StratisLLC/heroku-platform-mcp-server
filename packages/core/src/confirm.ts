/**
 * Destructive-operation confirmation helper (ARCHITECTURE.md §8.3, Phase 2a
 * Decision 1 / Decision 2).
 *
 * Destructive tools require a `confirm: string` argument from the caller. The
 * model is instructed never to fill the value from the same user turn that
 * requested the destructive op — the verbal confirmation in chat is the audit
 * trail. When `confirm` is missing or mismatched the tool returns a structured
 * "confirmation_required" envelope rather than calling the Heroku API.
 *
 * The check is case-SENSITIVE for safety: deleting `MyApp` is not the same as
 * deleting `myapp`, so a model that fills confirm in lower-case must hear the
 * mismatch.
 */

import { ConfirmationMismatchError } from './errors.js';

/**
 * Kinds of resource a confirmation can target. Used by
 * {@link ConfirmationRequiredError} to label the envelope so MCP hosts can
 * render a helpful prompt.
 */
export type ConfirmTargetKind =
  | 'app'
  | 'addon'
  | 'domain'
  | 'collaborator'
  | 'key'
  | 'drain'
  | 'webhook'
  | 'endpoint'
  | 'release'
  | 'review_app'
  | 'pipeline'
  | 'transfer'
  | 'dyno'
  | 'space'
  | 'team'
  | 'oauth_authorization'
  | 'enterprise'
  | 'identity_provider'
  | 'addon_attachment'
  | 'allowed_addon_service'
  | 'peering'
  | 'vpn_connection'
  | 'topic'
  | 'credentials'
  | 'invitation'
  | 'pipeline_coupling';

/** Common construction options for {@link ConfirmationRequiredError}. */
export interface ConfirmationRequiredOptions {
  /** The value the model should pass as `confirm`. */
  expected: string;
  /** Resource kind, for envelope rendering. */
  targetKind: ConfirmTargetKind;
  /** Override the default message. */
  message?: string;
  /** Optional human reason string. Defaults to "destructive operation". */
  reason?: string;
  /** The value the caller actually passed (if any). Surfaced for debugging. */
  received?: string;
}

/**
 * Returned (as a tool envelope) when a destructive tool was invoked without
 * `confirm`, or with a mismatched value. Carries the expected value so the
 * model can echo it back to the user verbatim.
 *
 * Implemented as a subclass of {@link ConfirmationMismatchError} so the core
 * error hierarchy and the `kind: 'confirmation'` enum continue to apply, while
 * the envelope's `details` payload uses the richer shape required by Phase 2a
 * Decision 2.
 */
export class ConfirmationRequiredError extends ConfirmationMismatchError {
  public readonly targetKind: ConfirmTargetKind;
  public readonly reason: string;

  constructor(opts: ConfirmationRequiredOptions) {
    const received = opts.received ?? '';
    const message =
      opts.message ??
      `This is a destructive operation. To confirm, pass confirm: ${JSON.stringify(opts.expected)}.`;
    super(opts.targetKind, opts.expected, received);
    this.name = 'ConfirmationRequiredError';
    this.message = message;
    this.targetKind = opts.targetKind;
    this.reason = opts.reason ?? 'destructive operation';
  }

  override toToolEnvelope(): ReturnType<ConfirmationMismatchError['toToolEnvelope']> {
    const env = super.toToolEnvelope();
    env.error.details = {
      kind: 'confirmation_required',
      expected: this.expected,
      target_kind: this.targetKind,
      reason: this.reason,
    };
    return env;
  }
}

/** Arguments to {@link assertConfirm}. */
export interface AssertConfirmInput {
  /** The value the caller passed as `confirm`; may be undefined. */
  value: string | undefined;
  /** The value the caller is expected to pass. */
  expected: string;
  /** Resource kind, used in the resulting error envelope. */
  targetKind: ConfirmTargetKind;
}

/**
 * Verify that a destructive tool's caller passed the expected `confirm` value.
 *
 * Throws {@link ConfirmationRequiredError} when the value is missing or does
 * not match (case-sensitive, no whitespace trimming — `confirm` is treated as
 * an exact identifier match for safety). On success, returns silently.
 */
export function assertConfirm(input: AssertConfirmInput): void {
  if (input.value === undefined || input.value === '' || input.value !== input.expected) {
    const opts: ConfirmationRequiredOptions = {
      expected: input.expected,
      targetKind: input.targetKind,
    };
    if (input.value !== undefined) opts.received = input.value;
    throw new ConfirmationRequiredError(opts);
  }
}

/**
 * Build a confirmation envelope for tools that prefer to return an error
 * envelope rather than throw. Equivalent to
 * `new ConfirmationRequiredError({...}).toToolEnvelope()` but spelled in a way
 * that reads naturally inside an early-return.
 */
export function formatConfirmationError(
  opts: ConfirmationRequiredOptions,
): ReturnType<ConfirmationRequiredError['toToolEnvelope']> {
  return new ConfirmationRequiredError(opts).toToolEnvelope();
}
