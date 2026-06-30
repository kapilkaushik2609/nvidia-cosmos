import { useEffect, useState } from 'react';
import styles from './Header.module.css';

const STATUS_LABEL = {
  stopped:  'Model stopped',
  starting: 'Model starting…',
  running:  'Model running',
  checking: 'Checking…',
};

export default function Header() {
  const [status, setStatus] = useState('checking');

  useEffect(() => {
    const poll = () =>
      fetch('/api/health')
        .then(r => r.json())
        .then(d => setStatus(d.status))
        .catch(() => setStatus('stopped'));

    poll();
    // Poll every 6s so UI reflects state changes (starting → running, idle shutdown)
    const id = setInterval(poll, 6000);
    return () => clearInterval(id);
  }, []);

  return (
    <header className={styles.header}>
      <div className={styles.left}>
        <span className={styles.logo}>⚡</span>
        <div>
          <h1 className={styles.title}>Cosmos3-Nano Reasoner</h1>
          <p className={styles.sub}>NVIDIA Visual AI · vLLM v0.21.0</p>
        </div>
      </div>
      <div className={styles.status}>
        <span className={`${styles.dot} ${styles[status]}`} />
        <span className={styles.statusLabel}>{STATUS_LABEL[status] ?? status}</span>
      </div>
    </header>
  );
}
