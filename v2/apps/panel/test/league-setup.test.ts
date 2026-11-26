import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiError, type LeaguePreview } from '../src/api.js';
import { PreviewOutcome } from '../src/pages/league-setup.js';

const preview: LeaguePreview = {
  previewId: 'preview-1',
  planHash: 'a'.repeat(64),
  plan: {
    divisions: [
      {
        name: 'Premier',
        categoryName: 'Premier - OZL',
        roleName: 'Premier - OZL',
        entries: [
          {
            citadelRosterId: '9400',
            citadelTeamId: '9300',
            name: 'Dev Team 01',
            roleName: 'Dev Team 01 (OZL)',
            channelName: 'Dev Team 01 (OZL)',
          },
        ],
      },
    ],
    counts: { divisions: 1, entries: 1, categories: 1, roles: 2, channels: 1, steps: 7 },
  },
  warnings: [],
  captains: [
    {
      citadelTeamId: '9300',
      citadelUserId: '9200',
      name: 'Dev Player 01',
      discordId: '200000000000000001',
      division: 'Premier',
      entryName: 'Dev Team 01',
      status: 'will-assign',
      roleNames: ['Premier - OZL', 'Dev Team 01 (OZL)'],
    },
  ],
  capacity: {
    status: 'fit',
    roleCount: 2,
    channelCount: 1,
    categoryCount: 1,
    refusals: [],
    splits: [],
  },
};

const props = {
  isPending: false,
  error: null,
  verification: null,
  isVerifying: false,
  onVerify: () => undefined,
};

describe('league setup preview states', () => {
  it('renders divisions, entries and captains from a complete preview', () => {
    const html = renderToStaticMarkup(createElement(PreviewOutcome, { ...props, preview }));
    expect(html).toContain('data-entry-count="1"');
    expect(html).toContain('Dev Team 01');
    expect(html).toContain('Dev Player 01');
    expect(html).toContain('data-testid="preview-counts"');
  });

  it('renders an explicit empty state without entry rows', () => {
    const empty = {
      ...preview,
      plan: {
        ...preview.plan,
        divisions: [],
        counts: { divisions: 0, entries: 0, categories: 0, roles: 0, channels: 0, steps: 0 },
      },
      captains: [],
    };
    const html = renderToStaticMarkup(createElement(PreviewOutcome, { ...props, preview: empty }));
    expect(html).toContain('data-testid="preview-empty"');
    expect(html).not.toContain('data-testid="preview-entry"');
    expect(html).not.toContain('<tbody>');
  });

  it('suppresses every preview row after a 503, including an earlier success', () => {
    const html = renderToStaticMarkup(
      createElement(PreviewOutcome, {
        ...props,
        preview,
        error: new ApiError(503, 'citadel_unavailable'),
      }),
    );
    expect(html).toContain('data-testid="preview-degraded"');
    expect(html).not.toContain('<table');
    expect(html).not.toContain('Dev Team 01');
    expect(html).not.toContain('Dev Player 01');
  });
});
