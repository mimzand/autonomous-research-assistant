import { type ToolPermissions } from './tool.js';

/*
 * Capability classes for model-driven tool use (Phase 8.2).
 *
 * Derived from a tool's declared ToolPermissions, never from its name or
 * description. There is deliberately no capability for shell or code
 * execution, arbitrary file access or browser automation: such tools cannot
 * be classified, so a deny-by-default policy can never admit them.
 */
export type ToolCapability =
  /** No network, no files, no effects. */
  | 'read-only'
  /** Reads from the network (search provider or public web); changes nothing locally. */
  | 'network-read'
  /** Reads files the user selected; changes nothing. */
  | 'local-file-read'
  /** Writes the app's own knowledge base (e.g. saves a source). */
  | 'mutation'
  /** Changes something outside the app; always requires approval. */
  | 'external-effect';

/** The capability of a tool, from its declared permissions. */
export function capabilityOf(permissions: ToolPermissions): ToolCapability {
  if (permissions.effects === 'external') return 'external-effect';
  if (permissions.effects === 'knowledge-base') return 'mutation';
  if (permissions.filesystem !== 'none') return 'local-file-read';
  if (permissions.network !== 'none') return 'network-read';
  return 'read-only';
}
