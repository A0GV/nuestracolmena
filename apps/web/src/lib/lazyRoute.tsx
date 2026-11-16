import { Component, lazy, type ComponentType, type ReactNode } from 'react';
import { Button, Result } from 'antd';
import { getChunkError, markChunkError, reloadOnce, subscribeChunkError } from './chunkErrors';

/**
 * React.lazy with the redeploy/dynamic-import guard: the first failure reloads
 * the tab once (new index.html + new chunk hashes); a second failure renders
 * the error boundary instead of looping.
 */
export function lazyRoute<T extends ComponentType<any>>(factory: () => Promise<{ default: T }>) {
  return lazy(() =>
    factory().catch((error: unknown) => {
      if (reloadOnce()) {
        // Keep Suspense spinning while the browser navigates to the fresh build.
        return new Promise<{ default: T }>(() => {});
      }
      markChunkError();
      throw error;
    }),
  );
}

interface ChunkErrorBoundaryState {
  error: Error | null;
}

/** Catches lazy-route failures and Vite preload errors, showing a reload action. */
export class ChunkErrorBoundary extends Component<{ children: ReactNode }, ChunkErrorBoundaryState> {
  state: ChunkErrorBoundaryState = { error: null };
  private unsubscribe?: () => void;

  componentDidMount() {
    this.unsubscribe = subscribeChunkError(() => {
      if (getChunkError()) this.setState({ error: new Error('No se pudo cargar la página') });
    });
    if (getChunkError()) this.setState({ error: new Error('No se pudo cargar la página') });
  }

  componentWillUnmount() {
    this.unsubscribe?.();
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <Result
          status="error"
          title="No se pudo cargar la página"
          subTitle="La aplicación se ha actualizado o la conexión se ha interrumpido. Recarga para continuar."
          extra={<Button type="primary" onClick={() => window.location.reload()}>Recargar</Button>}
        />
      );
    }
    return this.props.children;
  }
}
