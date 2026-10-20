import { Component, type ReactNode } from "react";

/** Shows a recovery screen instead of a blank page if rendering ever fails. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="main" style={{ maxWidth: 640, margin: "60px auto" }}>
        <div className="card">
          <div className="card-body stack">
            <h1>Something went wrong</h1>
            <p className="muted">The dashboard hit an unexpected error. Your saved cluster data may be damaged. Reload first; if the error comes back, reset the local data.</p>
            <pre className="code" style={{ whiteSpace: "pre-wrap" }}>{String(this.state.error.message)}</pre>
            <div className="row">
              <button className="btn primary" onClick={() => location.reload()}>
                Reload
              </button>
              <button
                className="btn danger"
                onClick={() => {
                  try {
                    localStorage.removeItem("hpc-autopilot/v1");
                  } catch {
                    /* storage blocked: reload starts fresh anyway */
                  }
                  location.reload();
                }}
              >
                Reset local data and reload
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
