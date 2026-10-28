import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

/**
 * 兜底错误边界：任何一个渲染异常都不该把整页刷成白屏，
 * 至少给出原因和"重新加载"的出口。
 */
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[crash]', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash">
        <div className="crash-card">
          <h2>界面遇到了问题</h2>
          <p className="crash-msg">{error.message || String(error)}</p>
          <div className="crash-ops">
            <button className="primary" onClick={() => location.reload()}>重新加载</button>
            <button className="ghost" onClick={() => this.setState({ error: null })}>忽略并继续</button>
          </div>
          <small>如果反复出现，把浏览器控制台里的 [crash] 日志发给开发者。</small>
        </div>
      </div>
    );
  }
}

window.addEventListener('unhandledrejection', e => {
  console.warn('[unhandled]', e.reason);
});

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
