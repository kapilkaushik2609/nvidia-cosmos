import { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader }    from 'three/addons/loaders/GLTFLoader.js';
import styles from './ThermalViewer.module.css';

const THERMAL_MAPS = [
  { key: 'thermal_map_composite.png', label: 'Composite' },
  { key: 'thermal_map_floor.png',     label: 'Floor'     },
  { key: 'thermal_map_ceiling.png',   label: 'Ceiling'   },
  { key: 'thermal_map_rack.png',      label: 'Rack'      },
];

const DEFAULT_PROMPT =
  'Analyze this thermal map of a datacenter. Identify hot spots, cold zones, ' +
  'aisle temperature patterns, and ASHRAE compliance concerns.';

export default function ThermalViewer() {
  const canvasRef   = useRef(null);
  const loadGLBRef  = useRef(null);   // stable function set inside useEffect

  const [modelLabel, setModelLabel] = useState('');
  const [loading,    setLoading]    = useState(false);
  const [loadPct,    setLoadPct]    = useState(0);
  const [dragging,   setDragging]   = useState(false);
  const [stats,      setStats]      = useState(null);
  const [activeMap,  setActiveMap]  = useState('thermal_map_composite.png');
  const [analyzing,  setAnalyzing]  = useState(false);
  const [starting,   setStarting]   = useState(false);
  const [result,     setResult]     = useState('');
  const [isError,    setIsError]    = useState(false);
  const [usage,      setUsage]      = useState(null);
  const [prompt,     setPrompt]     = useState(DEFAULT_PROMPT);
  const [uploadedImage,     setUploadedImage]     = useState(null);
  const [uploadedImageName, setUploadedImageName] = useState('');

  /* ── Three.js setup ──────────────────────────────────────────────── */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;

    const scene  = new THREE.Scene();
    scene.background = new THREE.Color(0x05050a);

    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
    camera.position.set(0, 32, 52);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping  = true;
    controls.dampingFactor  = 0.06;
    controls.minDistance    = 5;
    controls.maxDistance    = 150;

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

    /* Stable load function exposed via ref */
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
        setLoading(false);
        onDone?.();
      }, (xhr) => {
        if (xhr.total) setLoadPct(Math.round(xhr.loaded / xhr.total * 100));
      }, (err) => {
        console.error(err);
        setLoading(false);
      });
    };

    /* No default model — user drops their own GLB */
    setLoading(false);

    /* Resize */
    const resize = () => {
      const w = canvas.parentElement?.clientWidth  || canvas.clientWidth;
      const h = canvas.parentElement?.clientHeight || canvas.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    window.addEventListener('resize', resize);

    /* Animate */
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

  /* ── Load stats ──────────────────────────────────────────────────── */
  useEffect(() => {
    Promise.all([
      fetch('/config.json').then(r => r.json()).catch(() => null),
      fetch('/thermal/thermal_overlay.json').then(r => r.json()).catch(() => null),
      fetch('/powerdraw/powerdraw_summary.json').then(r => r.json()).catch(() => null),
    ]).then(([cfg, thermal, pw]) => {
      setStats({ cfg, thermal, pw });
    });
  }, []);

  /* ── Drag & Drop ─────────────────────────────────────────────────── */
  const handleDragEnter = useCallback(e => { e.preventDefault(); setDragging(true); },  []);
  const handleDragOver  = useCallback(e => { e.preventDefault(); },                      []);
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

  /* ── File picker ─────────────────────────────────────────────────── */
  const handleFilePick = useCallback(e => {
    const file = e.target.files[0];
    if (file && loadGLBRef.current) {
      const url = URL.createObjectURL(file);
      loadGLBRef.current(url, file.name, () => URL.revokeObjectURL(url));
    }
    e.target.value = '';
  }, []);

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
        fd.append('image', uploadedImage);
      } else {
        fd.append('thermal_file', activeMap);
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

  const s = stats;

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

        {/* Drop overlay */}
        {dragging && (
          <div className={styles.dropOverlay}>
            <div className={styles.dropIcon}>📦</div>
            <div className={styles.dropText}>Drop .glb model to load</div>
            <div className={styles.dropSub}>Replaces current 3D model</div>
          </div>
        )}

        {/* Loading overlay */}
        {loading && (
          <div className={styles.loadOverlay}>
            <div className={styles.spinner} />
            <div className={styles.loadText}>
              {loadPct > 0 ? `Loading… ${loadPct}%` : 'Loading 3D thermal model…'}
            </div>
          </div>
        )}

        {/* Load GLB button */}
        <label className={styles.loadBtn}>
          📂 Load .glb
          <input type="file" accept=".glb" onChange={handleFilePick} hidden />
        </label>

        {/* Bottom bar */}
        <div className={styles.bottomBar}>
          <span className={styles.hint}>Drag to orbit · Scroll to zoom · Right-drag to pan</span>
          <span className={styles.modelTag}>{modelLabel || 'Drop a .glb to load'}</span>
        </div>
      </div>

      {/* ── Side Panel ── */}
      <div className={styles.panel}>

        {/* Stats */}
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Allocation Stats</div>
          <div className={styles.grid}>
            <div className={styles.card}>
              <div className={styles.cardLabel}>Racks</div>
              <div className={styles.cardVal}>{s?.cfg?.rack_specs?.count ?? '—'}</div>
            </div>
            <div className={styles.card}>
              <div className={styles.cardLabel}>IT Load</div>
              <div className={styles.cardVal}>
                {s?.cfg?.it_load_kw ?? '—'}<span className={styles.unit}>kW</span>
              </div>
            </div>
            <div className={`${styles.card} ${styles.warn}`}>
              <div className={styles.cardLabel}>Peak Power</div>
              <div className={styles.cardVal}>
                {s?.pw ? s.pw.allocation_stats.max_kw.toFixed(0) : '—'}
                <span className={styles.unit}>kW</span>
              </div>
            </div>
            <div className={styles.card}>
              <div className={styles.cardLabel}>Avg Temp</div>
              <div className={styles.cardVal}>
                {s?.thermal ? s.thermal.metadata.temperature_range.mean_c.toFixed(1) : '—'}
                <span className={styles.unit}>°C</span>
              </div>
            </div>
          </div>
          {s?.thermal?.metadata?.ashrae_compliance?.recommended_violations_components > 0 && (
            <div className={styles.ashrae}>
              ⚠️ {s.thermal.metadata.ashrae_compliance.recommended_violations_components} racks
              exceed ASHRAE recommended limit (27°C)
            </div>
          )}
        </div>

        {/* Thermal maps */}
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Thermal Maps</div>
          <div className={styles.tabRow}>
            {THERMAL_MAPS.map(m => (
              <button
                key={m.key}
                className={`${styles.tab} ${activeMap === m.key ? styles.activeTab : ''}`}
                onClick={() => setActiveMap(m.key)}
              >
                {m.label}
              </button>
            ))}
          </div>
          <img
            className={styles.thermalImg}
            src={`/thermal/${activeMap}`}
            alt="Thermal map"
          />
        </div>

        {/* Cosmos */}
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Cosmos AI Analysis</div>
          <textarea
            className={styles.promptBox}
            rows={3}
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
          />
          {/* Upload any image for analysis */}
          <div className={styles.uploadRow}>
            <label className={styles.uploadImgBtn}>
              {uploadedImageName
                ? <>✔ {uploadedImageName}</>
                : <>📎 Upload image to analyze</>}
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
            <div className={styles.startingNote}>
              Model starting — first request takes 2–3 min
            </div>
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
