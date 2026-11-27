import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import {
  ApiError,
  approveLeaguePreview,
  createLeaguePreview,
  getCitadelKey,
  getLeague,
  type LeaguePreview,
  type PreviewVerification,
  revokeCitadelKey,
  setCitadelKey,
  verifyLeaguePreview,
} from '../api.js';
import { ErrorNote } from '../layout.js';

interface PreviewOutcomeProps {
  isPending: boolean;
  error: unknown;
  preview: LeaguePreview | null;
  verification: PreviewVerification | null;
  isVerifying: boolean;
  onVerify: () => void;
}

/** A complete preview, or one explicit state - never a mixture of old and new rows. */
export function PreviewOutcome({
  isPending,
  error,
  preview,
  verification,
  isVerifying,
  onVerify,
}: PreviewOutcomeProps) {
  if (isPending) {
    return (
      <p className="muted" role="status">
        Building a fresh preview from Citadel…
      </p>
    );
  }
  if (error) {
    if (error instanceof ApiError && error.status === 503) {
      return (
        <div className="notice degraded" role="alert" data-testid="preview-degraded">
          <strong>Citadel is unavailable.</strong>
          <p>No preview rows were loaded. Start Citadel, then retry the preview.</p>
        </div>
      );
    }
    return <ErrorNote error={error} />;
  }
  if (!preview) {
    return (
      <section className="card">
        <h2>No preview yet</h2>
        <p className="muted">
          Build a read-only plan to inspect its divisions, entries, captains, warnings and capacity.
          Nothing is written to Discord.
        </p>
      </section>
    );
  }

  const entries = preview.plan.divisions.flatMap((division) =>
    division.entries.map((entry) => ({ division, entry })),
  );
  const linkedCaptains = preview.captains.filter((captain) => captain.status === 'will-assign');

  return (
    <div className="stack">
      <div className="section-head">
        <div>
          <h2>Plan {preview.planHash.slice(0, 12)}</h2>
          <p className="muted small">Read from Citadel. No Discord changes have been made.</p>
        </div>
        <button
          type="button"
          className="ghost"
          disabled={isVerifying}
          onClick={onVerify}
          data-testid="verify-button"
        >
          {isVerifying ? 'Verifying…' : 'Verify refresh'}
        </button>
      </div>

      {verification ? (
        <div
          className={`notice ${verification.changed ? 'warning' : 'success'}`}
          role="status"
          data-testid="preview-verification"
        >
          {verification.changed
            ? 'Citadel has changed since this preview was created. Build a new preview before approval.'
            : 'Citadel still matches this preview.'}
          {verification.changedPaths.length ? (
            <ul>
              {verification.changedPaths.map((path) => (
                <li key={path} className="mono">
                  {path}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <dl className="card summary-list" data-testid="preview-counts">
        <div>
          <dt>Divisions</dt>
          <dd>{preview.plan.counts.divisions}</dd>
        </div>
        <div>
          <dt>Entries</dt>
          <dd>{preview.plan.counts.entries}</dd>
        </div>
        <div>
          <dt>Captains</dt>
          <dd>{preview.captains.length}</dd>
        </div>
        <div>
          <dt>Linked captains</dt>
          <dd>{linkedCaptains.length}</dd>
        </div>
        <div>
          <dt>Roles</dt>
          <dd>{preview.plan.counts.roles}</dd>
        </div>
        <div>
          <dt>Channels</dt>
          <dd>{preview.plan.counts.channels}</dd>
        </div>
      </dl>

      <section className="card">
        <h2>Warnings</h2>
        {preview.warnings.length ? (
          <ul className="warning-list">
            {preview.warnings.map((warning) => (
              <li key={`${warning.code}:${warning.subject}:${warning.message}`}>
                <span className="tag mono">{warning.code}</span> {warning.message}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No warnings. The plan is ready for review.</p>
        )}
      </section>

      <section>
        <div className="section-head">
          <h2>Divisions, entries and captains</h2>
          <span className="muted small">{entries.length} planned entries</span>
        </div>
        {entries.length ? (
          <div className="table-wrap">
            <table
              className="table"
              data-testid="preview-entries"
              data-entry-count={entries.length}
            >
              <thead>
                <tr>
                  <th>Division</th>
                  <th>Entry</th>
                  <th>Role</th>
                  <th>Channel</th>
                  <th>Captains</th>
                </tr>
              </thead>
              <tbody>
                {entries.map(({ division, entry }) => {
                  const captains = preview.captains.filter(
                    (captain) =>
                      captain.citadelTeamId === entry.citadelTeamId &&
                      captain.division === division.name &&
                      captain.entryName === entry.name,
                  );
                  return (
                    <tr
                      key={`${division.name}:${entry.citadelRosterId}:${entry.citadelTeamId}`}
                      data-testid="preview-entry"
                    >
                      <td>
                        <strong>{division.name}</strong>
                        <div className="muted small">{division.categoryName}</div>
                      </td>
                      <td>
                        <strong>{entry.name}</strong>
                        <div className="muted small mono">Roster {entry.citadelRosterId}</div>
                      </td>
                      <td className="mono">{entry.roleName}</td>
                      <td className="mono">{entry.channelName}</td>
                      <td>
                        {captains.length ? (
                          <div className="captain-list">
                            {captains.map((captain) => (
                              <div className="captain" key={captain.citadelUserId}>
                                <span>{captain.name}</span>
                                <span className={`pill ${captain.status}`}>
                                  {captain.status === 'will-assign' ? 'linked' : 'not linked'}
                                </span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <span className="muted">No captain</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="card" role="status" data-testid="preview-empty">
            Citadel returned an empty plan. Add at least one approved roster, then retry.
          </div>
        )}
      </section>

      <section className="card">
        <div className="section-head">
          <h2>Capacity</h2>
          <span className={`pill ${preview.capacity.status}`}>{preview.capacity.status}</span>
        </div>
        <p className="muted">
          {preview.capacity.roleCount} roles · {preview.capacity.channelCount} channels ·{' '}
          {preview.capacity.categoryCount} categories
        </p>
        {preview.capacity.refusals.length ? (
          <ul className="warning-list">
            {preview.capacity.refusals.map((refusal) => (
              <li key={`${refusal.scope}:${refusal.message}`}>{refusal.message}</li>
            ))}
          </ul>
        ) : null}
        {preview.capacity.splits.map((split) => (
          <p key={split.name} className="small">
            {split.name} splits into {split.parts.map((part) => part.name).join(', ')}.
          </p>
        ))}
      </section>
    </div>
  );
}

export function LeagueSetupPage() {
  const { leagueId } = useParams({ from: '/authed/leagues/$leagueId/setup' });
  const detail = useQuery({ queryKey: ['league', leagueId], queryFn: () => getLeague(leagueId) });
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const canManageKeys = detail.data?.access.capabilities.includes('citadel.keys.manage') ?? false;
  const canPreview = detail.data?.access.capabilities.includes('tournament.setup') ?? false;
  const keyStatus = useQuery({
    queryKey: ['citadel-key', leagueId],
    queryFn: () => getCitadelKey(leagueId),
    enabled: canManageKeys,
  });
  const [keyValue, setKeyValue] = useState('');
  const [keyLabel, setKeyLabel] = useState('');

  const verify = useMutation({
    mutationFn: (previewId: string) => verifyLeaguePreview(previewId),
  });
  const preview = useMutation({
    mutationFn: () => createLeaguePreview(leagueId),
    onMutate: () => {
      verify.reset();
    },
  });
  const approve = useMutation({
    mutationFn: (previewId: string) => approveLeaguePreview(previewId),
    onSuccess: async ({ job }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['jobs', leagueId] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ]);
      await navigate({ to: '/jobs/$jobId', params: { jobId: job.id } });
    },
  });
  const saveKey = useMutation({
    mutationFn: () => setCitadelKey(leagueId, keyValue, keyLabel.trim()),
    onSuccess: async () => {
      setKeyValue('');
      await queryClient.invalidateQueries({ queryKey: ['citadel-key', leagueId] });
    },
  });
  const revokeKey = useMutation({
    mutationFn: () => revokeCitadelKey(leagueId),
    onSuccess: async () => {
      setKeyValue('');
      await queryClient.invalidateQueries({ queryKey: ['citadel-key', leagueId] });
    },
  });

  if (detail.isLoading) return <p className="muted">Loading league setup…</p>;
  if (detail.error) return <ErrorNote error={detail.error} />;
  if (!detail.data) return null;

  const { league } = detail.data;
  const previewError = preview.error ?? verify.error;
  const visiblePreview = previewError ? null : (preview.data ?? null);
  const keyBusy = saveKey.isPending || revokeKey.isPending;

  return (
    <div className="stack">
      <div className="section-head">
        <div>
          <h1>{league.name} setup</h1>
          <p className="muted">
            Citadel #{league.citadelLeagueId} · {league.shortcode}
          </p>
        </div>
        <Link to="/leagues/$leagueId" params={{ leagueId }} className="button ghost">
          League details
        </Link>
      </div>

      <section className="stack">
        <div className="section-head">
          <div>
            <h2>Tournament preview</h2>
            <p className="muted">Inspect a fresh, read-only plan before any approval.</p>
          </div>
          <div className="actions">
            <button
              type="button"
              className="ghost"
              disabled={!canPreview || preview.isPending || approve.isPending}
              onClick={() => preview.mutate()}
              data-testid="preview-button"
            >
              {preview.isPending ? 'Building…' : preview.error ? 'Retry preview' : 'Preview'}
            </button>
            {visiblePreview && canPreview ? (
              <button
                type="button"
                disabled={approve.isPending || verify.data?.changed === true}
                onClick={() => approve.mutate(visiblePreview.previewId)}
                data-testid="approve-preview"
              >
                {approve.isPending ? 'Approving…' : 'Approve and run'}
              </button>
            ) : null}
          </div>
        </div>
        {approve.error ? (
          <div data-testid="approve-error">
            <ErrorNote error={approve.error} />
          </div>
        ) : null}
        {!canPreview ? (
          <p className="muted">You need the tournament.setup capability to build a preview.</p>
        ) : null}
        <PreviewOutcome
          isPending={preview.isPending}
          error={previewError}
          preview={visiblePreview}
          verification={verify.data ?? null}
          isVerifying={verify.isPending}
          onVerify={() => {
            if (preview.data) verify.mutate(preview.data.previewId);
          }}
        />
      </section>

      {canManageKeys ? (
        <section className="card stack">
          <div className="section-head">
            <h2>Citadel key</h2>
            {keyStatus.data ? (
              <span className={`pill ${keyStatus.data.status}`}>{keyStatus.data.status}</span>
            ) : null}
          </div>
          <p className="muted small">
            Keys are verified before storage and sealed. Only status and verification metadata are
            shown here.
          </p>
          {keyStatus.isLoading ? <p className="muted">Loading key status…</p> : null}
          {keyStatus.error ? <ErrorNote error={keyStatus.error} /> : null}
          {keyStatus.data ? (
            <dl className="key-meta">
              <div>
                <dt>Label</dt>
                <dd>{keyStatus.data.label || 'No label'}</dd>
              </div>
              <div>
                <dt>Last verified</dt>
                <dd>
                  {keyStatus.data.lastVerifiedAt
                    ? new Date(keyStatus.data.lastVerifiedAt).toLocaleString()
                    : 'Never'}
                </dd>
              </div>
            </dl>
          ) : null}
          <form
            className="form"
            onSubmit={(event) => {
              event.preventDefault();
              saveKey.mutate();
            }}
          >
            <label>
              {keyStatus.data?.status === 'active' ? 'Replacement key' : 'Citadel API key'}
              <input
                type="password"
                value={keyValue}
                onChange={(event) => setKeyValue(event.target.value)}
                autoComplete="off"
                minLength={8}
                maxLength={500}
                required
              />
            </label>
            <label>
              Label (optional)
              <input
                value={keyLabel}
                onChange={(event) => setKeyLabel(event.target.value)}
                maxLength={100}
                placeholder="Primary development key"
              />
            </label>
            <div className="actions">
              <button type="submit" disabled={keyBusy}>
                {saveKey.isPending
                  ? 'Verifying…'
                  : keyStatus.data?.status === 'active'
                    ? 'Rotate key'
                    : 'Set key'}
              </button>
              {keyStatus.data?.status === 'active' ? (
                <button
                  type="button"
                  className="ghost"
                  disabled={keyBusy}
                  onClick={() => revokeKey.mutate()}
                >
                  {revokeKey.isPending ? 'Revoking…' : 'Revoke key'}
                </button>
              ) : null}
            </div>
          </form>
          {saveKey.error ? <ErrorNote error={saveKey.error} /> : null}
          {revokeKey.error ? <ErrorNote error={revokeKey.error} /> : null}
        </section>
      ) : null}
    </div>
  );
}
