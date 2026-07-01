import { useEffect, useRef, useState, useCallback } from 'react';
import styles from './SimulationPanel.module.css';

/* ── Physics constants (calibrated from actual data) ─────────────── */
const IDLE_KW      = 4.0;
const PEAK_KW      = 18.0;
const AMBIENT_C    = 18.0;
const TEMP_PER_KW  = 0.969;   // °C per kW above idle (derived: (24.66-18)/(10.87-4))
const DESIGN_KW    = 375;
const ROW_FACTORS  = { 1: 1.000, 2: 1.002, 3: 1.004 };  // row heat accumulation

const ASHRAE_REC   = 27.0;
const ASHRAE_ALLOW = 32.0;

/* ── Scenarios ───────────────────────────────────────────────────── */
const SCENARIOS = [
  { label: 'Current',       globalLoad: 0.49, coolingOk: true,  desc: 'Baseline — 565 kW mean state from sensor data' },
  { label: 'Low (Night)',   globalLoad: 0.20, coolingOk: true,  desc: 'Low-load night-time batch window' },
  { label: 'High Load',     globalLoad: 0.70, coolingOk: true,  desc: 'Busy period — 70% utilisation' },
  { label: 'Peak',          globalLoad: 1.00, coolingOk: true,  desc: 'Full peak — 18 kW/rack capacity' },
  { label: 'Cooling Fault', globalLoad: 0.49, coolingOk: false, desc: 'N+1 failure — 50% cooling capacity' },
];

/* ── Temperature colour (blue→cyan→green→yellow→orange→red) ──────── */
function tempColor(t) {
  const stops = [
    [18, [40,  120, 255]],
    [22, [0,   200, 180]],
    [24, [60,  200,  80]],
    [27, [200, 220,   0]],
    [29, [255, 150,   0]],
    [31, [255,  50,   0]],
    [33, [200,   0,   0]],
  ];
  t = Math.max(stops[0][0], Math.min(stops[stops.length-1][0], t));
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i];
    const [t1, c1] = stops[i+1];
    if (t >= t0 && t <= t1) {
      const r = (t - t0) / (t1 - t0);
      const ch = c0.map((v, j) => Math.round(v + (c1[j]-v)*r));
      return `rgb(${ch[0]},${ch[1]},${ch[2]})`;
    }
  }
  return 'red';
}

/* ── Simulation engine ───────────────────────────────────────────── */
function simulate(racks, rowOverrides, globalLoad, coolingOk) {
  const coolDerate = coolingOk ? 1.0 : 2.0;   // cooling failure doubles delta-T

  // Compute power per rack
  const rackLoads = racks.map(r => {
    const rowLoad = rowOverrides[r.row] ?? globalLoad;
    const load = Math.max(0, Math.min(1, rowLoad));
    const power = IDLE_KW + (PEAK_KW - IDLE_KW) * load;
    return { ...r, power_kw: power, load_pct: load };
  });

  // Total IT power
  const totalKW = rackLoads.reduce((s, r) => s + r.power_kw, 0);

  // Cooling stress: if over design, cooling efficiency drops
  const overloadFactor = Math.max(1, totalKW / DESIGN_KW);

  // Temperature per rack
  const results = rackLoads.map(r => {
    const rf = ROW_FACTORS[r.row] ?? 1.0;
    const deltaT = (r.power_kw - IDLE_KW) * TEMP_PER_KW * rf * overloadFactor * coolDerate;
    const temp = AMBIENT_C + deltaT;
    return {
      ...r,
      temp_c: temp,
      ashrae_rec: temp <= ASHRAE_REC,
      ashrae_allow: temp <= ASHRAE_ALLOW,
    };
  });

  const maxTemp    = Math.max(...results.map(r => r.temp_c));
  const violations = results.filter(r => !r.ashrae_rec).length;
  const critical   = results.filter(r => !r.ashrae_allow).length;
  const pue        = coolingOk ? (1 + 0.4 * Math.min(1, totalKW / DESIGN_KW)) : 2.1;
  const facilKW    = totalKW * pue;

  return { racks: results, totalKW, maxTemp, violations, critical, pue, facilKW };
}

/* ── Floor plan (SVG) ─────────────────────────────────────────────── */
function FloorPlan({ racks, hovered, onHover }) {
  // Room 70x40 ft → scale to ~560x320 px
  const ROOM_W = 70, ROOM_H = 40;
  const SW = 560, SH = 320;
  const scaleX = SW / ROOM_W;
  const scaleY = SH / ROOM_H;
  const RW = 2 * scaleX - 2;  // rack width px
  const RH = 4 * scaleY - 2;  // rack depth px

  return (
    <svg viewBox={`0 0 ${SW} ${SH}`} className={styles.floorSvg}>
      {/* Room background */}
      <rect x={0} y={0} width={SW} height={SH} fill="#08080f" rx={4} />

      {/* Grid lines every 10ft */}
      {[10,20,30,40,50,60].map(x => (
        <line key={`gx${x}`} x1={x*scaleX} y1={0} x2={x*scaleX} y2={SH} stroke="#111" strokeWidth={1} />
      ))}
      {[10,20,30].map(y => (
        <line key={`gy${y}`} x1={0} y1={y*scaleY} x2={SW} y2={y*scaleY} stroke="#111" strokeWidth={1} />
      ))}

      {/* Racks */}
      {racks.map(r => {
        const x = r.position_ft.x * scaleX;
        const y = r.position_ft.y * scaleY;
        const col = tempColor(r.temp_c);
        const isHov = hovered === r.rack_id;
        return (
          <g key={r.rack_id} onMouseEnter={() => onHover(r.rack_id)} onMouseLeave={() => onHover(null)}>
            <rect
              x={x} y={y} width={RW} height={RH}
              fill={col}
              stroke={isHov ? '#fff' : (!r.ashrae_allow ? '#ff2200' : !r.ashrae_rec ? '#ff8800' : '#000')}
              strokeWidth={isHov ? 2 : 1}
              rx={2}
              opacity={0.9}
            />
            {isHov && (
              <text x={x + RW/2} y={y - 4} textAnchor="middle" fontSize={9} fill="#fff" fontWeight="bold">
                {r.temp_c.toFixed(1)}°C
              </text>
            )}
          </g>
        );
      })}

      {/* Row labels */}
      {[1,2,3].map(row => {
        const rr = racks.find(r => r.row === row);
        if (!rr) return null;
        return (
          <text key={row} x={8} y={rr.position_ft.y * scaleY + RH/2 + 4}
            fontSize={9} fill="#444" fontFamily="monospace">
            Row {row}
          </text>
        );
      })}
    </svg>
  );
}

/* ── Legend ──────────────────────────────────────────────────────── */
function Legend() {
  const stops = [18, 22, 25, 27, 29, 31, 33];
  return (
    <div className={styles.legend}>
      <div className={styles.legendBar} style={{
        background: `linear-gradient(to right, ${stops.map(t => tempColor(t)).join(', ')})`
      }} />
      <div className={styles.legendLabels}>
        <span>18°C</span><span>22°C</span><span>27° REC</span><span>32° MAX</span>
      </div>
    </div>
  );
}

/* ── Main component ──────────────────────────────────────────────── */
export default function SimulationPanel() {
  const [racks,        setRacks]        = useState([]);
  const [globalLoad,   setGlobalLoad]   = useState(0.49);
  const [rowOverrides, setRowOverrides] = useState({});  // {1: 0.49, 2: 0.49, ...}
  const [coolingOk,    setCoolingOk]    = useState(true);
  const [hovered,      setHovered]      = useState(null);
  const [scenario,     setScenario]     = useState(0);
  const [loading,      setLoading]      = useState(true);

  /* Load rack layout from powerdraw summary */
  useEffect(() => {
    fetch('/powerdraw/powerdraw_summary.json')
      .then(r => r.json())
      .then(d => {
        setRacks(d.series.map(s => ({
          rack_id:     s.rack_id,
          row:         s.row,
          position_ft: s.position_ft,
        })));
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  /* Apply scenario */
  const applyScenario = useCallback((idx) => {
    const s = SCENARIOS[idx];
    setScenario(idx);
    setGlobalLoad(s.globalLoad);
    setRowOverrides({});
    setCoolingOk(s.coolingOk);
  }, []);

  const setRowLoad = (row, val) => {
    setRowOverrides(prev => ({ ...prev, [row]: val }));
  };

  const getRowLoad = (row) => rowOverrides[row] ?? globalLoad;

  /* Simulate */
  const sim = racks.length
    ? simulate(racks, rowOverrides, globalLoad, coolingOk)
    : null;

  const hoveredRack = sim?.racks.find(r => r.rack_id === hovered);

  return (
    <div className={styles.wrap}>

      {/* ── Left: floorplan ── */}
      <div className={styles.left}>
        <div className={styles.floorHeader}>
          <span className={styles.floorTitle}>Datacenter Floorplan — 70 × 40 ft · 52 Racks</span>
          {hoveredRack && (
            <span className={styles.hoverChip}>
              {hoveredRack.rack_id} · {hoveredRack.temp_c.toFixed(1)}°C · {hoveredRack.power_kw.toFixed(1)} kW
              {!hoveredRack.ashrae_allow ? ' ⛔ ABOVE ALLOWABLE' : !hoveredRack.ashrae_rec ? ' ⚠ above recommended' : ' ✓ OK'}
            </span>
          )}
        </div>

        {loading ? (
          <div className={styles.loadingMsg}>Loading rack layout…</div>
        ) : (
          <FloorPlan racks={sim?.racks ?? []} hovered={hovered} onHover={setHovered} />
        )}

        <Legend />

        {/* Metrics row */}
        {sim && (
          <div className={styles.metricsRow}>
            <div className={`${styles.metric} ${sim.totalKW > DESIGN_KW ? styles.metricWarn : ''}`}>
              <div className={styles.metricVal}>{sim.totalKW.toFixed(0)}<span className={styles.metricUnit}>kW</span></div>
              <div className={styles.metricLabel}>IT Load{sim.totalKW > DESIGN_KW ? ' ⚠ OVER DESIGN' : ` / ${DESIGN_KW}kW design`}</div>
            </div>
            <div className={styles.metric}>
              <div className={styles.metricVal}>{sim.facilKW.toFixed(0)}<span className={styles.metricUnit}>kW</span></div>
              <div className={styles.metricLabel}>Facility Load (PUE {sim.pue.toFixed(2)})</div>
            </div>
            <div className={`${styles.metric} ${sim.maxTemp > ASHRAE_ALLOW ? styles.metricDanger : sim.maxTemp > ASHRAE_REC ? styles.metricWarn : ''}`}>
              <div className={styles.metricVal}>{sim.maxTemp.toFixed(1)}<span className={styles.metricUnit}>°C</span></div>
              <div className={styles.metricLabel}>Peak Rack Temp</div>
            </div>
            <div className={`${styles.metric} ${sim.critical > 0 ? styles.metricDanger : sim.violations > 0 ? styles.metricWarn : styles.metricOk}`}>
              <div className={styles.metricVal}>{sim.violations}</div>
              <div className={styles.metricLabel}>ASHRAE Violations{sim.critical > 0 ? ` (${sim.critical} critical)` : ''}</div>
            </div>
          </div>
        )}
      </div>

      {/* ── Right: controls ── */}
      <div className={styles.panel}>

        {/* Scenarios */}
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Scenario Presets</div>
          <div className={styles.scenarioGrid}>
            {SCENARIOS.map((s, i) => (
              <button
                key={i}
                className={`${styles.scBtn} ${scenario === i ? styles.scActive : ''}`}
                onClick={() => applyScenario(i)}
              >
                {s.label}
              </button>
            ))}
          </div>
          {SCENARIOS[scenario] && (
            <div className={styles.scenarioDesc}>{SCENARIOS[scenario].desc}</div>
          )}
        </div>

        {/* Global load */}
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Global Load</div>
          <div className={styles.sliderRow}>
            <span className={styles.sliderLabel}>All Racks</span>
            <input
              type="range" min={0} max={100} step={1}
              value={Math.round(globalLoad * 100)}
              onChange={e => { setGlobalLoad(e.target.value / 100); setScenario(-1); }}
              className={styles.slider}
            />
            <span className={styles.sliderVal}>{Math.round(globalLoad * 100)}%</span>
          </div>
          <div className={styles.sliderSub}>
            {(IDLE_KW + (PEAK_KW - IDLE_KW) * globalLoad).toFixed(1)} kW/rack ·{' '}
            {(52 * (IDLE_KW + (PEAK_KW - IDLE_KW) * globalLoad)).toFixed(0)} kW total
          </div>
        </div>

        {/* Per-row overrides */}
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Per-Row Override</div>
          {[1, 2, 3].map(row => (
            <div key={row}>
              <div className={styles.sliderRow}>
                <span className={styles.sliderLabel}>Row {row}</span>
                <input
                  type="range" min={0} max={100} step={1}
                  value={Math.round(getRowLoad(row) * 100)}
                  onChange={e => { setRowLoad(row, e.target.value / 100); setScenario(-1); }}
                  className={styles.slider}
                />
                <span className={styles.sliderVal}>{Math.round(getRowLoad(row) * 100)}%</span>
              </div>
              {sim && (() => {
                const rowRacks = sim.racks.filter(r => r.row === row);
                const avgT = rowRacks.reduce((s,r) => s + r.temp_c, 0) / rowRacks.length;
                const viol = rowRacks.filter(r => !r.ashrae_rec).length;
                return (
                  <div className={styles.rowStat}>
                    avg {avgT.toFixed(1)}°C · {viol}/{rowRacks.length} violations
                  </div>
                );
              })()}
            </div>
          ))}
        </div>

        {/* Cooling */}
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Cooling System</div>
          <label className={styles.toggle}>
            <input
              type="checkbox" checked={coolingOk}
              onChange={e => { setCoolingOk(e.target.checked); setScenario(-1); }}
            />
            <span className={styles.toggleSlider} />
            <span className={styles.toggleLabel}>{coolingOk ? 'Normal (N+1 online)' : 'FAULT — 50% capacity'}</span>
          </label>
          {!coolingOk && (
            <div className={styles.faultNote}>
              ⚠ Cooling failure doubles thermal delta — immediate risk of ASHRAE violations
            </div>
          )}
        </div>

        {/* Hovered rack detail */}
        {hoveredRack && (
          <div className={styles.section}>
            <div className={styles.sectionTitle}>Rack Detail</div>
            <div className={styles.rackDetail}>
              <div className={styles.rackDetailRow}><span>ID</span><strong>{hoveredRack.rack_id}</strong></div>
              <div className={styles.rackDetailRow}><span>Row</span><strong>{hoveredRack.row}</strong></div>
              <div className={styles.rackDetailRow}><span>Position</span><strong>{hoveredRack.position_ft.x}ft, {hoveredRack.position_ft.y}ft</strong></div>
              <div className={styles.rackDetailRow}><span>Load</span><strong>{Math.round(hoveredRack.load_pct * 100)}%</strong></div>
              <div className={styles.rackDetailRow}><span>Power</span><strong>{hoveredRack.power_kw.toFixed(2)} kW</strong></div>
              <div className={styles.rackDetailRow}>
                <span>Temp</span>
                <strong style={{ color: !hoveredRack.ashrae_allow ? '#f55' : !hoveredRack.ashrae_rec ? '#f5a623' : '#76b900' }}>
                  {hoveredRack.temp_c.toFixed(2)}°C
                </strong>
              </div>
              <div className={styles.rackDetailRow}>
                <span>ASHRAE</span>
                <strong style={{ color: !hoveredRack.ashrae_allow ? '#f55' : !hoveredRack.ashrae_rec ? '#f5a623' : '#76b900' }}>
                  {!hoveredRack.ashrae_allow ? '⛔ Exceeds allowable' : !hoveredRack.ashrae_rec ? '⚠ Exceeds recommended' : '✓ Compliant'}
                </strong>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
