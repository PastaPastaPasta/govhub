// Frame buster. GitHub Pages cannot send frame-ancestors / X-Frame-Options, so another page could show govhub in a frame and trick
// clicks on its buttons ("Use these settings" of a ?config= link, a profile switch, a vote). A same-site frame even shares govhub's
// storage and session. There is no reason to embed govhub, so inside a frame it renders only a way out.

/** Whether govhub is shown inside another page's frame. */
export function isFramed(): boolean {
  try {
    return window.top !== window.self;
  } catch {
    return true; // a cross-origin parent can make even the comparison throw
  }
}

export function FramedNotice() {
  return (
    <main className="main dh-container dh-page">
      <section className="page-narrow" data-testid="framed-notice">
        <h1 className="dh-page-header__title">Governance only works in its own tab</h1>
        <p>
          This page shows Governance inside another site, where clicks can be redirected without you seeing it. Nothing here can be changed from inside a
          frame.
        </p>
        <p>
          <a className="btn dh-btn btn-primary dh-btn--primary" href={location.href} target="_blank" rel="noopener noreferrer">
            Open Governance in its own tab
          </a>
        </p>
      </section>
    </main>
  );
}
