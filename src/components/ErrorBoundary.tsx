import React from 'react';

interface State {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { hasError: false, message: '' };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error?.message || 'Erreur inattendue dans l’interface.' };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            height: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--bg-app)',
            color: 'var(--text-primary)',
            padding: 24,
          }}
        >
          <div
            style={{
              maxWidth: 480,
              background: 'var(--bg-panel)',
              border: '1px solid var(--border-strong)',
              borderRadius: 10,
              padding: 20,
            }}
          >
            <h2 style={{ margin: '0 0 8px 0', color: 'var(--danger)' }}>F-Clonedisk — Récupération d'erreur</h2>
            <p style={{ margin: '0 0 14px 0', color: 'var(--text-secondary)', fontSize: 13 }}>{this.state.message}</p>
            <button className="btn btn-primary" onClick={() => window.location.reload()}>
              Recharger l'application
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
