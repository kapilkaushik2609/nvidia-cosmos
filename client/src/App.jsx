import { useState, useCallback, useEffect } from 'react';
import Header from './components/Header';
import ImageInput from './components/ImageInput';
import ResultPanel from './components/ResultPanel';
import ThermalViewer from './components/ThermalViewer';
import styles from './App.module.css';

const DEFAULT_PROMPT = 'Describe what you see in this image in detail.';

export default function App() {
  const [view,        setView]        = useState('analyzer'); // 'analyzer' | 'thermal'
  const [image,       setImage]       = useState(null);
  const [prompt,      setPrompt]      = useState(DEFAULT_PROMPT);
  const [result,      setResult]      = useState('');
  const [usage,       setUsage]       = useState(null);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState('');
  const [modelState,  setModelState]  = useState('stopped');
  const [controlling, setControlling] = useState(false);

  useEffect(() => {
    const poll = () =>
      fetch('/api/health')
        .then(r => r.json())
        .then(d => setModelState(d.status))
        .catch(() => setModelState('stopped'));
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, []);

  const handleImageReady = useCallback((img) => {
    setImage(img); setResult(''); setError('');
  }, []);

  const startModel = async () => {
    setControlling(true); setModelState('starting');
    try { await fetch('/api/start', { method: 'POST' }); setModelState('running'); }
    catch { setModelState('stopped'); }
    finally { setControlling(false); }
  };

  const stopModel = async () => {
    setControlling(true);
    try { await fetch('/api/stop', { method: 'POST' }); setModelState('stopped'); }
    finally { setControlling(false); }
  };

  const analyze = async () => {
    if (!image || !prompt.trim()) return;
    setLoading(true); setResult(''); setError(''); setUsage(null);
    if (modelState === 'stopped') setModelState('starting');
    try {
      const body = new FormData();
      body.append('prompt', prompt);
      if (image.type === 'file') body.append('image', image.file);
      else body.append('image_url', image.url);

      const res  = await fetch('/api/analyze', { method: 'POST', body });
      const data = await res.json();
      if (!res.ok) { setError(data.error || `Request failed (${res.status})`); }
      else { setResult(data.result); setUsage(data.usage); setModelState('running'); }
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  const loadingMsg = (modelState === 'starting' && loading)
    ? 'Starting model… first request takes 2–3 min'
    : 'Analyzing…';

  const canSubmit = !!image && prompt.trim().length > 0 && !loading;

  return (
    <div className={styles.layout}>
      <Header view={view} onViewChange={setView} />

      {view === 'thermal' ? (
        <ThermalViewer />
      ) : (
        <main className={styles.main}>
          <div className={styles.col}>

            {/* Model controls */}
            <div className={styles.controlBar}>
              <span className={`${styles.stateChip} ${styles[modelState]}`}>
                {modelState === 'stopped'  && '● Stopped'}
                {modelState === 'starting' && '◌ Starting…'}
                {modelState === 'running'  && '● Running'}
              </span>
              {modelState === 'stopped' && (
                <button className={styles.ctrlBtn} onClick={startModel} disabled={controlling}>
                  {controlling ? 'Starting…' : 'Start Model'}
                </button>
              )}
              {(modelState === 'running' || modelState === 'starting') && (
                <button className={`${styles.ctrlBtn} ${styles.stopBtn}`} onClick={stopModel} disabled={controlling}>
                  Stop Model
                </button>
              )}
              <span className={styles.idleNote}>Auto-stops after 10 min idle</span>
            </div>

            <ImageInput onImageReady={handleImageReady} />

            <div className={styles.card}>
              <div className={styles.cardTitle}>Prompt</div>
              <textarea
                className={styles.textarea}
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                placeholder="What do you want to know about this image?"
                rows={3}
              />
              <button className={styles.analyzeBtn} onClick={analyze} disabled={!canSubmit}>
                {loading
                  ? <><span className={styles.btnSpinner} /> {loadingMsg}</>
                  : 'Analyze Image'}
              </button>
            </div>

            <ResultPanel result={result} loading={loading} error={error} usage={usage} />
          </div>
        </main>
      )}
    </div>
  );
}
