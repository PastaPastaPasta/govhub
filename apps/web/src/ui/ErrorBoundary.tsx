// Contains a crash in user-content rendering (discussion, owner post) to that section instead of unmounting the app.
import { Component, type ReactNode } from 'react';
import { errText } from '../lib/format.ts';

export class ErrorBoundary extends Component<{ what: string; children: ReactNode }, { error: string | null }> {
  override state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { error: errText(e) };
  }
  override render() {
    if (this.state.error) {
      return (
        <p className="error" role="alert">
          The {this.props.what} could not be shown ({this.state.error}).{' '}
          <button type="button" className="btn btn-s" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </p>
      );
    }
    return this.props.children;
  }
}
