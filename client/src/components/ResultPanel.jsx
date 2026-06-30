import styles from './ResultPanel.module.css';

export default function ResultPanel({ result, loading, error, usage }) {
  if (!loading && !result && !error) return null;

  return (
    <div className={styles.card}>
      <div className={styles.cardTitle}>
        Analysis Result
        {usage?.total_tokens && (
          <span className={styles.tokens}>{usage.total_tokens} tokens</span>
        )}
      </div>

      {error && <div className={styles.error}>⚠ {error}</div>}

      <div className={`${styles.resultBox} ${loading ? styles.loading : ''}`}>
        {loading && !result
          ? <div className={styles.loadingInner}>
              <span className={styles.spinner} />
              Running inference…
            </div>
          : result}
      </div>

      {result && !loading && (
        <button
          className={styles.copyBtn}
          onClick={() => navigator.clipboard.writeText(result)}
        >
          Copy
        </button>
      )}
    </div>
  );
}
