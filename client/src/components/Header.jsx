import { useEffect, useState } from 'react';
import styles from './Header.module.css';

const STATUS_LABEL = {
  stopped:  'Model stopped',
  starting: 'Model starting…',
  running:  'Model running',
  checking: 'Checking…',
};

export default function Header({ view = 'analyzer', onViewChange }) {
  const [status, setStatus] = useState('checking');

  useEffect(() => {
    const poll = () =>
      fetch('/api/health')
        .then(r => r.json())
        .then(d => setStatus(d.status))
        .catch(() => setStatus('stopped'));
    poll();
    const id = setInterval(poll, 6000);
    return () => clearInterval(id);
  }, []);

  return (
    <header className={styles.header}>
      <div className={styles.left}>
        <span className={styles.logo}>&#9889;</span>
        <div>
          <h1 className={styles.title}>Cosmos3-Nano Reasoner</h1>
          <p className={styles.sub}>NVIDIA Visual AI · vLLM v0.21.0</p>
        </div>
      </div>

      <nav className={styles.tabs}>
        <button
          className={`${styles.tab} ${view === 'analyzer' ? styles.activeTab : ''}`}
          onClick={() => onViewChange?.('analyzer')}
        >
          Image Analyzer
        </button>
        <button
          className={`${styles.tab} ${view === 'thermal' ? styles.activeTab : ''}`}
          onClick={() => onViewChange?.('thermal')}
        >
          Thermal Viewer
        </button>
      </nav>

      <div className={styles.status}>
        <span className={`${styles.dot} ${styles[status]}`} />
        <span className={styles.statusLabel}>{STATUS_LABEL[status] ?? status}</span>
      </div>
    </header>
  );
}
