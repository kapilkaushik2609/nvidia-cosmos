import { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader }    from 'three/addons/loaders/GLTFLoader.js';
import styles from './ThermalViewer.module.css';

const DEFAULT_PROMPT =
  'Analyze this 3D model or image. Describe what you observe — ' +
  'structures, patterns, anomalies, temperature zones, or any notable features.';

export default function ThermalViewer() {
  const canvasRef  = useRef(null);
  const loadGLBRef = useRef(null);

  const [modelLabel, setModelLabel]   = useState('');
  const [modelLoaded, setModelLoaded] = useState(false);
  const [loading,    setLoading]      = useState(false);
  const [loadPct,    setLoadPct]      = useState(0);
  const [dragging,   setDragging]     = useState(false);

  const [analyzing,  setAnalyzing]    = useState(false);
  const [starting,   setStarting]     = useState(false);
  const [result,     setResult]       = useState('');
  const [isError,    setIsError]      = useState(false);
  const [usage,      setUsage]        = useState(null);
  const [prompt,     setPrompt]       = useState(DEFAULT_PROMPT);

  const [uploadedImage,     setUploadedImage]     = useState(null);
  const [uploadedImageName, setUploadedImageName] = useState('');

  /* ── Three.js setup ──────────────────────────────────────────────── */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;

    const scene  = new THREE.Scene();
    scene.background = new THREE.Color(0x05050a);

    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
    camera.position.set(0, 32, 52);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.minDistance   = 5;
    controls.maxDistance   = 150;

    scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const sun = new THREE.DirectionalLight(0xffffff, 1.1);
    sun.position.set(30, 60, 40);
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0x8899ff, 0.3);
    fill.position.set(-20, 10, -30);
    scene.add(fill);
    scene.add(new THREE.GridHelper(120, 60, 0x111118, 0x111118));

    const loader = new GLTFLoader();
    let currentModel = null;

    loadGLBRef.current = (url, label, onDone) => {
      setLoading(true);
      setLoadPct(0);
      loader.load(url, (gltf) => {
        if (currentModel) scene.remove(currentModel);
        currentModel = gltf.scene;
        const box    = new THREE.Box3().setFromObject(currentModel);
        const center = box.getCenter(new THREE.Vector3());
        const size   = box.getSize(new THREE.Vector3());
        const scale  = 40 / Math.max(size.x, size.y, size.z);
        currentModel.position.sub(center.multiplyScalar(scale));
        currentModel.scale.setScalar(scale);
        scene.add(currentModel);
        camera.position.set(0, 32, 52);
        controls.target.set(0, 0, 0);
        controls.update();
        setModelLabel(label);
        setModelLoaded(true);
        setLoading(false);
        onDone?.();
      }, (xhr) => {
        if (xhr.total) setLoadPct(Math.round(xhr.loaded / xhr.total * 100));
      }, (err) => {
        console.error(err);
        setLoading(false);
      });
    };

    const resize = () => {
      const w = canvas.parentElement?.clientWidth  || canvas.clientWidth;
      const h = canvas.parentElement?.clientHeight || canvas.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    window.addEventListener('resize', resize);

    let animId;
    const animate = () => {
      animId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('resize', resize);
      renderer.dispose();
    };
  }, []);

  /* ── Drag & Drop for GLB ─────────────────────────────────────────── */
  const handleDragEnter = useCallback(e => { e.preventDefault(); setDragging(true); },  []);
  const handleDragOver  = useCallback(e => { e.preventDefault(); },                     []);
  const handleDragLeave = useCallback(e => {
    if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false);
  }, []);
  const handleDrop = useCallback(e => {
    e.preventDefault();
    setDragging(false);
    const file = [...e.dataTransfer.files].find(f => f.name.toLowerCase().endsWith('.glb'));
    if (file && loadGLBRef.current) {
      const url = URL.createObjectURL(file);
      loadGLBRef.current(url, file.name, () => URL.revokeObjectURL(url));
    }
  }, []);

  const handleFilePick = useCallback(e => {
    const file = e.target.files[0];
    if (file && loadGLBRef.current) {
      const url = URL.createObjectURL(file);
      loadGLBRef.current(url, file.name, () => URL.revokeObjectURL(url));
    }
    e.target.value = '';
  }, []);

  /* ── Image upload for Cosmos ─────────────────────────────────────── */
  const handleAnalyzeImageUpload = useCallback(e => {
    const file = e.target.files[0];
    if (file) { setUploadedImage(file); setUploadedImageName(file.name); }
    e.target.value = '';
  }, []);

  /* ── Cosmos analyze ──────────────────────────────────────────────── */
  const analyze = async () => {
    setAnalyzing(true);
    setResult('');
    setIsError(false);
    setUsage(null);
    setStarting(false);

    try {
      const h = await fetch('/api/health').then(r => r.json()).catch(() => ({}));
      if (h.status !== 'running') setStarting(true);

      const fd = new FormData();
      fd.append('prompt', prompt);

      if (uploadedImage) {
        // Use the uploaded image directly
        fd.append('image', uploadedImage);
      } else if (modelLoaded && canvasRef.current) {
        // Screenshot the current 3D view
        const dataUrl = canvasRef.current.toDataURL('image/png');
        const blob    = await (await fetch(dataUrl)).blob();
        fd.append('image', new File([blob], 'viewer.png', { type: 'image/png' }));
      } else {
        setIsError(true);
        setResult('Drop a .glb file onto the viewer, or upload an image to analyze.');
        setAnalyzing(false);
        return;
      }

      const res  = await fetch('/api/analyze-thermal', { method: 'POST', body: fd });
      const data = await res.json();
      setStarting(false);
      setIsError(!!data.error);
      setResult(data.error || data.result || '(no response)');
      if (data.usage?.total_tokens) setUsage(data.usage.total_tokens);
    } catch (e) {
      setStarting(false);
      setIsError(true);
      setResult(e.message);
    } finally {
      setAnalyzing(false);
    }
  };

  /* ── What will be analyzed ───────────────────────────────────────── */
  const sourceLabel = uploadedImageName
    ? `📎 ${uploadedImageName}`
    : modelLoaded
    ? `🔲 3D canvas screenshot — ${modelLabel}`
    : null;

  return (
    <div className={styles.wrap}>

      {/* ── 3D Viewer ── */}
      <div
        className={styles.viewerWrap}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <canvas ref={canvasRef} className={styles.canvas} />

        {dragging && (
          <div className={styles.dropOverlay}>
            <div className={styles.dropIcon}>📦</div>
            <div className={styles.dropText}>Drop .glb to load in 3D viewer</div>
          </div>
        )}

        {loading && (
          <div className={styles.loadOverlay}>
            <div className={styles.spinner} />
            <div className={styles.loadText}>
              {loadPct > 0 ? `Loading ${loadPct}%` : 'Loading model…'}
            </div>
          </div>
        )}

        {!modelLoaded && !loading && (
          <div className={styles.emptyHint}>
            <div className={styles.emptyIcon}>📦</div>
            <div className={styles.emptyText}>Drop a .glb file here</div>
            <div className={styles.emptySub}>or use the button below to browse</div>
          </div>
        )}

        <label className={styles.loadBtn}>
          📂 Load .glb
          <input type="file" accept=".glb" onChange={handleFilePick} hidden />
        </label>

        <div className={styles.bottomBar}>
          <span className={styles.hint}>Drag to orbit · Scroll to zoom · Right-drag to pan</span>
          {modelLabel && <span className={styles.modelTag}>{modelLabel}</span>}
        </div>
      </div>

      {/* ── Side Panel ── */}
      <div className={styles.panel}>
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Cosmos AI Analysis</div>

          {/* Source indicator */}
          <div className={styles.sourceRow}>
            {sourceLabel
              ? <span className={styles.sourceChip}>{sourceLabel}</span>
              : <span className={styles.sourcePlaceholder}>
                  Drop a .glb into the viewer, or upload an image below
                </span>
            }
          </div>

          <textarea
            className={styles.promptBox}
            rows={3}
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
          />

          {/* Optional: upload a specific image instead of the 3D view */}
          <div className={styles.uploadRow}>
            <label className={styles.uploadImgBtn}>
              {uploadedImageName ? <>✔ {uploadedImageName}</> : <>📎 Upload image instead of 3D view</>}
              <input type="file" accept="image/*" onChange={handleAnalyzeImageUpload} hidden />
            </label>
            {uploadedImageName && (
              <button
                className={styles.clearUpload}
                onClick={() => { setUploadedImage(null); setUploadedImageName(''); }}
              >×</button>
            )}
          </div>

          <button className={styles.analyzeBtn} onClick={analyze} disabled={analyzing}>
            {analyzing
              ? <><span className={styles.btnSpin} /> Analyzing…</>
              : '⚡ Analyze with Cosmos'}
          </button>

          {starting && (
            <div className={styles.startingNote}>Model starting — first request takes 2–3 min</div>
          )}

          {result && (
            <div className={`${styles.result} ${isError ? styles.resultErr : ''}`}>
              {result}
            </div>
          )}

          {usage && <div className={styles.usageNote}>{usage} tokens</div>}
        </div>
      </div>

    </div>
  );
}
