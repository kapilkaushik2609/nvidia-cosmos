import { useRef, useState, useCallback } from 'react';
import styles from './ImageInput.module.css';

export default function ImageInput({ onImageReady }) {
  const [tab, setTab]       = useState('upload');
  const [preview, setPreview] = useState(null);
  const [filename, setFilename] = useState('');
  const [url, setUrl]       = useState('');
  const [drag, setDrag]     = useState(false);
  const fileRef = useRef();

  const handleFile = useCallback((file) => {
    if (!file || !file.type.startsWith('image/')) return;
    setFilename(file.name);
    setPreview(URL.createObjectURL(file));
    onImageReady({ type: 'file', file });
  }, [onImageReady]);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setDrag(false);
    handleFile(e.dataTransfer.files[0]);
  }, [handleFile]);

  const handleUrlCommit = () => {
    if (url.trim()) {
      setPreview(url.trim());
      onImageReady({ type: 'url', url: url.trim() });
    }
  };

  return (
    <div className={styles.card}>
      <div className={styles.cardTitle}>Image Input</div>

      <div className={styles.tabs}>
        {['upload', 'url'].map(t => (
          <button
            key={t}
            className={`${styles.tab} ${tab === t ? styles.active : ''}`}
            onClick={() => setTab(t)}
          >
            {t === 'upload' ? '📁 Upload File' : '🔗 Image URL'}
          </button>
        ))}
      </div>

      {tab === 'upload' && (
        <div
          className={`${styles.dropZone} ${drag ? styles.dragging : ''}`}
          onClick={() => fileRef.current.click()}
          onDragOver={e => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={onDrop}
        >
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={e => handleFile(e.target.files[0])}
          />
          {filename
            ? <span className={styles.fileName}>📎 {filename}</span>
            : <>
                <span className={styles.dropIcon}>🖼</span>
                <span className={styles.dropText}>Click or drag & drop an image</span>
                <span className={styles.dropHint}>PNG, JPG, TIFF, etc.</span>
              </>
          }
        </div>
      )}

      {tab === 'url' && (
        <div className={styles.urlRow}>
          <input
            type="text"
            className={styles.urlInput}
            placeholder="https://example.com/thermal-image.jpg"
            value={url}
            onChange={e => setUrl(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleUrlCommit()}
          />
          <button className={styles.urlBtn} onClick={handleUrlCommit}>Load</button>
        </div>
      )}

      {preview && (
        <div className={styles.preview}>
          <img src={preview} alt="preview" onError={() => setPreview(null)} />
        </div>
      )}
    </div>
  );
}
