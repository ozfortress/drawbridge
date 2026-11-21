const messages: Record<string, string> = {
  callback: 'Discord did not return a usable response. Try again.',
  state: 'The sign-in attempt expired or was tampered with. Start again.',
  oauth: 'Discord sign-in failed. Try again.',
  disabled: 'That account is disabled. Ask an administrator.',
};

export function SignInPage() {
  const error = new URLSearchParams(window.location.search).get('error');
  return (
    <div className="signin">
      <div className="card">
        <h1>Drawbridge</h1>
        <p className="muted">Tournament operations for Citadel leagues.</p>
        {error ? <div className="error">{messages[error] ?? 'Sign-in failed.'}</div> : null}
        <a className="button" href="/api/v1/auth/discord">
          Sign in with Discord
        </a>
        <p className="muted small">
          We request only your Discord identity. Access to leagues is granted by invitation.
        </p>
      </div>
    </div>
  );
}
