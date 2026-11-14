import { type SettingsView } from '@rka/shared';
import { describe, expect, it } from 'vitest';
import { definitionsFor, optionsWithActive } from './settings';

const view = (chat: string, research: string) =>
  ({ values: { 'engine.chat': chat, 'engine.research': research } }) as unknown as SettingsView;

describe('Settings → Agent Engines', () => {
  it('shows the two engine selectors and the web-search switch in their own category', () => {
    expect(definitionsFor('engines').map((d) => d.key)).toEqual([
      'engine.chat',
      'engine.research',
      'chat.webSearch',
    ]);
  });

  it('lists Legacy and Google ADK with explanations and marks the active choice per engine', () => {
    expect(optionsWithActive(view('legacy', 'adk'), 'engine.chat')).toEqual([
      { value: 'legacy', label: 'Legacy', description: 'Existing chat runtime.', active: true },
      { value: 'adk', label: 'Google ADK', description: 'ADK-based chat runtime.', active: false },
    ]);
    expect(
      optionsWithActive(view('legacy', 'adk'), 'engine.research').map((o) => [o.label, o.active]),
    ).toEqual([
      ['Legacy', false],
      ['Google ADK', true],
    ]);
    expect(optionsWithActive(view('legacy', 'adk'), 'engine.research')[1]?.description).toBe(
      'ADK-backed research pipeline.',
    );
  });
});
