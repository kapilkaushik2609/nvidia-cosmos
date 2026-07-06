import { useState, useEffect, useRef } from 'react';
import styles from './SimulationPanel.module.css';

const RACK_LAYOUT = [
  {rack_id:"RACK-001",row:1,position_ft:{x:17,y:12}},{rack_id:"RACK-002",row:1,position_ft:{x:19,y:12}},
  {rack_id:"RACK-003",row:1,position_ft:{x:21,y:12}},{rack_id:"RACK-004",row:1,position_ft:{x:23,y:12}},
  {rack_id:"RACK-005",row:1,position_ft:{x:25,y:12}},{rack_id:"RACK-006",row:1,position_ft:{x:27,y:12}},
  {rack_id:"RACK-007",row:1,position_ft:{x:29,y:12}},{rack_id:"RACK-008",row:1,position_ft:{x:31,y:12}},
  {rack_id:"RACK-009",row:1,position_ft:{x:33,y:12}},{rack_id:"RACK-010",row:1,position_ft:{x:35,y:12}},
  {rack_id:"RACK-011",row:1,position_ft:{x:37,y:12}},{rack_id:"RACK-012",row:1,position_ft:{x:39,y:12}},
  {rack_id:"RACK-013",row:1,position_ft:{x:41,y:12}},{rack_id:"RACK-014",row:1,position_ft:{x:43,y:12}},
  {rack_id:"RACK-015",row:1,position_ft:{x:45,y:12}},{rack_id:"RACK-016",row:1,position_ft:{x:47,y:12}},
  {rack_id:"RACK-017",row:1,position_ft:{x:49,y:12}},{rack_id:"RACK-018",row:1,position_ft:{x:51,y:12}},
  {rack_id:"RACK-019",row:2,position_ft:{x:17,y:20}},{rack_id:"RACK-020",row:2,position_ft:{x:19,y:20}},
  {rack_id:"RACK-021",row:2,position_ft:{x:21,y:20}},{rack_id:"RACK-022",row:2,position_ft:{x:23,y:20}},
  {rack_id:"RACK-023",row:2,position_ft:{x:25,y:20}},{rack_id:"RACK-024",row:2,position_ft:{x:27,y:20}},
  {rack_id:"RACK-025",row:2,position_ft:{x:29,y:20}},{rack_id:"RACK-026",row:2,position_ft:{x:31,y:20}},
  {rack_id:"RACK-027",row:2,position_ft:{x:33,y:20}},{rack_id:"RACK-028",row:2,position_ft:{x:35,y:20}},
  {rack_id:"RACK-029",row:2,position_ft:{x:37,y:20}},{rack_id:"RACK-030",row:2,position_ft:{x:39,y:20}},
  {rack_id:"RACK-031",row:2,position_ft:{x:41,y:20}},{rack_id:"RACK-032",row:2,position_ft:{x:43,y:20}},
  {rack_id:"RACK-033",row:2,position_ft:{x:45,y:20}},{rack_id:"RACK-034",row:2,position_ft:{x:47,y:20}},
  {rack_id:"RACK-035",row:2,position_ft:{x:49,y:20}},
  {rack_id:"RACK-036",row:3,position_ft:{x:17,y:30}},{rack_id:"RACK-037",row:3,position_ft:{x:19,y:30}},
  {rack_id:"RACK-038",row:3,position_ft:{x:21,y:30}},{rack_id:"RACK-039",row:3,position_ft:{x:23,y:30}},
  {rack_id:"RACK-040",row:3,position_ft:{x:25,y:30}},{rack_id:"RACK-041",row:3,position_ft:{x:27,y:30}},
  {rack_id:"RACK-042",row:3,position_ft:{x:29,y:30}},{rack_id:"RACK-043",row:3,position_ft:{x:31,y:30}},
  {rack_id:"RACK-044",row:3,position_ft:{x:33,y:30}},{rack_id:"RACK-045",row:3,position_ft:{x:35,y:30}},
  {rack_id:"RACK-046",row:3,position_ft:{x:37,y:30}},{rack_id:"RACK-047",row:3,position_ft:{x:39,y:30}},
  {rack_id:"RACK-048",row:3,position_ft:{x:41,y:30}},{rack_id:"RACK-049",row:3,position_ft:{x:43,y:30}},
  {rack_id:"RACK-050",row:3,position_ft:{x:45,y:30}},{rack_id:"RACK-051",row:3,position_ft:{x:47,y:30}},
  {rack_id:"RACK-052",row:3,position_ft:{x:49,y:30}},
];

// Normalise the 2D-layout API response into { rack_id, row, position_ft:{x,y} }[]
// The API may return several shapes — handles all known variants.
function normaliseLayout(data){
  // Shape A: { racks: [{id|rack_id|rackId, row, x|position.x, y|position.y}] }
  // Shape B: { rows: [{row|rowNumber, racks:[{id|rack_id, x, y}]}] }
  let items=[];
  if(Array.isArray(data)) items=data;
  else if(Array.isArray(data.racks)) items=data.racks;
  else if(Array.isArray(data.layout)) items=data.layout;
  else if(Array.isArray(data.rows)){
    data.rows.forEach(r=>{
      const rowNum=r.row??r.rowNumber??r.row_number??1;
      (r.racks||r.components||[]).forEach(rk=>{
        items.push({...rk, row:rowNum});
      });
    });
  }
  if(!items.length) return null;
  return items.map(r=>{
    const id=r.rack_id??r.id??r.rackId??r.name??'';
    const row=r.row??r.rowNumber??r.row_number??1;
    const x=r.x??r.position?.x??r.position_ft?.x??17;
    const y=r.y??r.position?.y??r.position_ft?.y??12;
    return{rack_id:id, row:Number(row), position_ft:{x:Number(x),y:Number(y)}};
  }).filter(r=>r.rack_id);
}

// Fallback: distribute thermal-data racks evenly across 3 rows when 2D layout API unavailable
function buildLayoutFromThermal(rackItems){
  const sorted=[...rackItems].sort((a,b)=>a.id.localeCompare(b.id,undefined,{numeric:true}));
  const n=sorted.length;
  const r1=Math.ceil(n/3), r2=Math.ceil((n-r1)/2), r3=n-r1-r2;
  const rowCounts=[r1,r2,r3], yPositions=[12,20,30];
  const layout=[]; let idx=0;
  for(let row=0;row<3;row++){
    for(let i=0;i<rowCounts[row];i++){
      if(idx>=n) break;
      layout.push({rack_id:sorted[idx].id, row:row+1, position_ft:{x:17+i*2, y:yPositions[row]}});
      idx++;
    }
  }
  return layout;
}

const IDLE_KW=4.0,PEAK_KW=18.0,AMBIENT_C=18.0,TEMP_PER_KW=0.969,DESIGN_KW=375;
const ROW_FACTORS={1:1.000,2:1.002,3:1.004};
const ASHRAE_REC=27.0,ASHRAE_ALLOW=32.0;
const RISK_COLOR={SAFE:'#76b900',WARNING:'#f5a623',CRITICAL:'#ff2200',UNKNOWN:'#555'};

const SCENARIOS=[
  {label:'Current',      globalLoad:0.49,coolingOk:true, desc:'Baseline — 565 kW mean from sensor data'},
  {label:'Low (Night)',  globalLoad:0.20,coolingOk:true, desc:'Low-load night-time batch window'},
  {label:'High Load',    globalLoad:0.70,coolingOk:true, desc:'Busy period — 70% utilisation'},
  {label:'Peak',         globalLoad:1.00,coolingOk:true, desc:'Full peak — 18 kW/rack capacity'},
  {label:'Cooling Fault',globalLoad:0.49,coolingOk:false,desc:'N+1 failure — 50% cooling capacity'},
];

function tempColor(t){
  const stops=[[18,[40,120,255]],[22,[0,200,180]],[24,[60,200,80]],[27,[200,220,0]],[29,[255,150,0]],[31,[255,50,0]],[33,[200,0,0]]];
  t=Math.max(stops[0][0],Math.min(stops[stops.length-1][0],t));
  for(let i=0;i<stops.length-1;i++){
    const[t0,c0]=stops[i],[t1,c1]=stops[i+1];
    if(t>=t0&&t<=t1){const r=(t-t0)/(t1-t0);return `rgb(${c0.map((v,j)=>Math.round(v+(c1[j]-v)*r)).join(',')})`;}
  }
  return 'red';
}

// baseline: Map of rack_id → { temp_c, power_kw } from thermal_overlay.json
// opts:     { idleKW, peakKW, designKW } — overrides module constants when loaded from API
// When baseline loaded: temp = baseline_temp + (simulated_power - baseline_power) × physics_delta
// When null:            falls back to pure formula from AMBIENT_C
function simulate(rowOverrides,globalLoad,coolingOk,baseline,opts={},layout=RACK_LAYOUT){
  const idleKw  = opts.idleKW  ?? IDLE_KW;
  const peakKw  = opts.peakKW  ?? PEAK_KW;
  const designKw= opts.designKW?? DESIGN_KW;
  const coolDerate=coolingOk?1.0:2.0;
  const rackLoads=layout.map(r=>{
    const load=Math.max(0,Math.min(1,rowOverrides[r.row]??globalLoad));
    return{...r,power_kw:idleKw+(peakKw-idleKw)*load,load_pct:load};
  });
  const totalKW=rackLoads.reduce((s,r)=>s+r.power_kw,0);
  const overloadFactor=Math.max(1,totalKW/designKw);
  const results=rackLoads.map(r=>{
    const rf=ROW_FACTORS[r.row]??1.0;
    const base=baseline?.[r.rack_id];
    let temp;
    if(base){
      // Real sensor baseline (thermal_overlay.json) + physics delta from that point
      const powerDelta=r.power_kw-base.power_kw;
      temp=base.temp_c+(powerDelta*TEMP_PER_KW*rf*overloadFactor*coolDerate);
    } else {
      // Pure formula fallback — no baseline loaded yet
      temp=AMBIENT_C+(r.power_kw-IDLE_KW)*TEMP_PER_KW*rf*overloadFactor*coolDerate;
    }
    return{...r,temp_c:temp,ashrae_rec:temp<=ASHRAE_REC,ashrae_allow:temp<=ASHRAE_ALLOW};
  });
  const maxTemp=Math.max(...results.map(r=>r.temp_c));
  const violations=results.filter(r=>!r.ashrae_rec).length;
  const critical=results.filter(r=>!r.ashrae_allow).length;
  const pue=coolingOk?(1+0.4*Math.min(1,totalKW/designKw)):2.1;
  return{racks:results,totalKW,maxTemp,violations,critical,pue,facilKW:totalKW*pue};
}

const SVG_W=560,SVG_H=310,SX=SVG_W/70,SY=SVG_H/40;
const RW=2*SX-3,RH=4*SY-3;

function FloorPlan({racks,hovered,onHover,cosmosRisk}){
  const rowRisk=cosmosRisk?{1:cosmosRisk.row1,2:cosmosRisk.row2,3:cosmosRisk.row3}:{};
  return(
    <svg viewBox={`0 0 ${SVG_W} ${SVG_H}`} className={styles.floorSvg} preserveAspectRatio="xMidYMid meet">
      <defs>
        <filter id="glow-warn"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        <filter id="glow-crit"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      </defs>
      <rect x={0} y={0} width={SVG_W} height={SVG_H} fill="#07070f" rx={6}/>
      {[10,20,30,40,50,60].map(x=><line key={`gx${x}`} x1={x*SX} y1={0} x2={x*SX} y2={SVG_H} stroke="#141422" strokeWidth={1}/>)}
      {[10,20,30].map(y=><line key={`gy${y}`} x1={0} y1={y*SY} x2={SVG_W} y2={y*SY} stroke="#141422" strokeWidth={1}/>)}

      {/* Cosmos risk row bands */}
      {cosmosRisk && [1,2,3].map(row=>{
        const risk=rowRisk[row];
        if(!risk||risk==='SAFE'||risk==='UNKNOWN') return null;
        const rowR=racks.find(r=>r.row===row);
        if(!rowR) return null;
        const py=rowR.position_ft.y*SY-1;
        const col=risk==='CRITICAL'?'#ff220022':'#f5a62318';
        const stroke=risk==='CRITICAL'?'#ff220066':'#f5a62344';
        return(
          <rect key={`band-${row}`} x={16*SX} y={py} width={36*SX} height={RH+2}
            fill={col} stroke={stroke} strokeWidth={1} rx={3}
            className={risk==='CRITICAL'?styles.criticalBand:styles.warningBand}/>
        );
      })}

      {/* Racks */}
      {racks.map(r=>{
        const px=r.position_ft.x*SX,py=r.position_ft.y*SY;
        const col=tempColor(r.temp_c),isHov=hovered===r.rack_id;
        const risk=rowRisk[r.row];
        const sc=isHov?'#fff':(!r.ashrae_allow?'#ff2200':!r.ashrae_rec?'#ff8800':'#000');
        const filter=risk==='CRITICAL'?'url(#glow-crit)':risk==='WARNING'?'url(#glow-warn)':undefined;
        return(
          <g key={r.rack_id} style={{cursor:'pointer'}} onMouseEnter={()=>onHover(r.rack_id)} onMouseLeave={()=>onHover(null)}>
            <rect x={px} y={py} width={RW} height={RH} fill={col} stroke={sc} strokeWidth={isHov?2:0.5} rx={1} opacity={0.92} filter={filter}/>
            {isHov&&<><rect x={px-2} y={py-18} width={44} height={15} fill="#000a" rx={3}/><text x={px+RW/2} y={py-7} textAnchor="middle" fontSize={8} fill="#fff" fontWeight="bold">{r.rack_id} {r.temp_c.toFixed(1)}°C</text></>}
          </g>
        );
      })}

      {/* Row labels + Cosmos risk badges */}
      {[1,2,3].map(row=>{
        const r=racks.find(r=>r.row===row);
        const risk=rowRisk[row];
        if(!r) return null;
        return(
          <g key={row}>
            <text x={r.position_ft.x*SX-14} y={r.position_ft.y*SY+RH/2+3} fontSize={8} fill="#555" fontFamily="monospace" textAnchor="end">R{row}</text>
            {risk&&risk!=='UNKNOWN'&&(
              <text x={r.position_ft.x*SX-14} y={r.position_ft.y*SY+RH/2+13} fontSize={6} fill={RISK_COLOR[risk]} fontFamily="monospace" textAnchor="end" fontWeight="bold">{risk}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export default function SimulationPanel(){
  const[globalLoad,setGlobalLoad]=useState(0.49);
  const[rowOverrides,setRowOverrides]=useState({});
  const[coolingOk,setCoolingOk]=useState(true);
  const[hovered,setHovered]=useState(null);
  const[scenario,setScenario]=useState(0);

  // Cosmos full analysis — compliance mode
  const[compResult,setCompResult]=useState('');
  const[compLoading,setCompLoading]=useState(false);
  const[compError,setCompError]=useState('');
  const[compUsedImage,setCompUsedImage]=useState(false);

  // Cosmos full analysis — physics/CFD mode
  const[physResult,setPhysResult]=useState('');
  const[physLoading,setPhysLoading]=useState(false);
  const[physError,setPhysError]=useState('');
  const[physUsedImage,setPhysUsedImage]=useState(false);

  // Allocation selector — list from OASIS API + currently selected allocation
  const DEFAULT_ALLOC='20230123-225659-UTC_DFW_375_2800_STD';
  const[allocations,setAllocations]=useState([]);
  const[selectedAlloc,setSelectedAlloc]=useState(DEFAULT_ALLOC);
  const[allocLoading,setAllocLoading]=useState(false);
  const[simOpts,setSimOpts]=useState({});  // {idleKW, peakKW, designKW} from API metadata

  // Fetch allocation list once on mount
  useEffect(()=>{
    fetch('/api/oasis/allocations/CHI1-CHI3')
      .then(r=>r.json())
      .then(data=>{
        // API returns array of { allocationId, customerName, status } objects
        const raw=Array.isArray(data)?data:(data.allocations||data.data||[]);
        // Normalise to objects with at minimum { allocationId, label }
        const list=raw.map(item=>
          typeof item==='string'
            ? { allocationId: item, label: item }
            : { allocationId: item.allocationId, label: item.customerName ? `${item.allocationId} — ${item.customerName}` : item.allocationId }
        ).filter(item=>item.allocationId);
        if(list.length) setAllocations(list);
      })
      .catch(()=>{}); // silently ignore — selector just won't show other options
  },[]);

  // Real sensor baseline — loaded from OASIS API
  const[baseline,setBaseline]=useState(null);        // Map: rack_id → {temp_c, power_kw}
  const[baselineStatus,setBaselineStatus]=useState('loading'); // 'loading'|'loaded'|'error'
  const[rackLayout,setRackLayout]=useState(RACK_LAYOUT); // dynamic layout from API racks

  useEffect(()=>{
    setBaselineStatus('loading');
    setAllocLoading(true);

    // Holds thermal racks so layout fallback can use them
    let thermalRacks=[];

    const loadThermal=(data)=>{
      thermalRacks=(data.component_temperatures||[]).filter(c=>c.type==='rack');
      const map={};
      thermalRacks.forEach(c=>{ map[c.id]={temp_c:c.temperature_c,power_kw:c.power_kw,severity:c.severity}; });
      setBaseline(map);
      setBaselineStatus('loaded');
    };

    // 1. Fetch 2D layout first — this drives rack positions + IDs on the floorplan
    const layoutPromise = fetch(`/api/oasis/allocation/${selectedAlloc}/layout`)
      .then(r=>{ if(!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(data=>{
        const layout=normaliseLayout(data);
        if(layout&&layout.length>0){ setRackLayout(layout); return true; }
        return false;
      })
      .catch(()=>false); // layout API failed — will fall back after thermal loads

    // 2. Fetch thermal baseline (temperatures + power per rack)
    const thermalPromise = fetch(`/api/oasis/allocation/${selectedAlloc}/thermal`)
      .then(r=>{ if(!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(loadThermal)
      .catch(()=>setBaselineStatus('error'));

    // After both settle: if layout API failed, fall back to thermal-derived grid layout
    Promise.all([layoutPromise, thermalPromise]).then(([layoutOk])=>{
      if(!layoutOk && thermalRacks.length>0){
        setRackLayout(buildLayoutFromThermal(thermalRacks));
      }
      setAllocLoading(false);
    });

    // 3. Fetch power-temp-summary for calibration factors
    fetch(`/api/oasis/allocation/${selectedAlloc}/power-temp`)
      .then(r=>r.json())
      .then(data=>{
        const cf=data.metadata?.calibration_factors||data.calibration_factors||{};
        const as=data.allocation_stats||data.power?.allocation_stats||{};
        if(cf.idle_kw_per_rack||cf.peak_kw_per_rack){
          setSimOpts({
            idleKW:  cf.idle_kw_per_rack  ?? IDLE_KW,
            peakKW:  cf.peak_kw_per_rack  ?? PEAK_KW,
            designKW:as.max_kw            ?? DESIGN_KW,
          });
        }
      })
      .catch(()=>{}); // silently ignore — keeps default constants
  },[selectedAlloc]);

  // Cosmos live prediction mode
  const[cosmosMode,setCosmosMode]=useState(false);
  const[cosmosRisk,setCosmosRisk]=useState(null);   // {row1,row2,row3,maxTemp,hotspot,action}
  const[cosmosThinking,setCosmosThinking]=useState(false);
  const abortRef=useRef(null);

  const applyScenario=idx=>{setScenario(idx);setGlobalLoad(SCENARIOS[idx].globalLoad);setRowOverrides({});setCoolingOk(SCENARIOS[idx].coolingOk);};
  const getRowLoad=row=>rowOverrides[row]??globalLoad;
  const sim=simulate(rowOverrides,globalLoad,coolingOk,baseline,simOpts,rackLayout);
  const hoveredRack=sim.racks.find(r=>r.rack_id===hovered);

  // Auto-predict: 1.5s after slider stops, if Cosmos mode is on
  useEffect(()=>{
    if(!cosmosMode) return;
    const rowStats=[1,2,3].map(row=>{
      const rr=sim.racks.filter(r=>r.row===row);
      return{row,count:rr.length,avgTemp:rr.reduce((s,r)=>s+r.temp_c,0)/rr.length,violations:rr.filter(r=>!r.ashrae_rec).length};
    });
    const topRisks=[...sim.racks].sort((a,b)=>b.temp_c-a.temp_c).slice(0,5);

    const timer=setTimeout(async()=>{
      abortRef.current?.abort();
      const ctrl=new AbortController();
      abortRef.current=ctrl;
      setCosmosThinking(true);
      try{
        const res=await fetch('/api/predict-thermal',{
          method:'POST',signal:ctrl.signal,
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({totalKW:sim.totalKW,globalLoad,coolingOk,rowStats,topRisks}),
        });
        const data=await res.json();
        if(data.prediction) setCosmosRisk(data.prediction);
      }catch(e){
        if(e.name!=='AbortError') console.warn('predict-thermal:',e.message);
      }
      setCosmosThinking(false);
    },1500);
    return()=>{clearTimeout(timer);};
  },[globalLoad,rowOverrides,coolingOk,cosmosMode]);

  // Clear risk map when mode turned off
  useEffect(()=>{ if(!cosmosMode){setCosmosRisk(null);abortRef.current?.abort();} },[cosmosMode]);

  const buildSimPayload=(mode)=>{
    const rowStats=[1,2,3].map(row=>{
      const rr=sim.racks.filter(r=>r.row===row);
      return{row,count:rr.length,avgTemp:rr.reduce((s,r)=>s+r.temp_c,0)/rr.length,violations:rr.filter(r=>!r.ashrae_rec).length};
    });
    const topRisks=[...sim.racks].sort((a,b)=>b.temp_c-a.temp_c).slice(0,8);
    const scenarioLabel=scenario>=0?SCENARIOS[scenario]?.label:'Custom';
    // Include real baseline context when loaded so Cosmos can compare sim vs real
    const baselineCtx=baseline ? {
      hasRealBaseline:true,
      baselineNote:'Temperatures are physics deltas from real thermal_overlay.json baseline (measured at 17.5 kW/rack)',
      baselineRowAvg:[1,2,3].map(row=>{
        const ids=rackLayout.filter(r=>r.row===row).map(r=>r.rack_id);
        const vals=ids.map(id=>baseline[id]?.temp_c).filter(Boolean);
        return{row,avgBaseline_c:vals.length?(vals.reduce((s,v)=>s+v,0)/vals.length).toFixed(1):null};
      }),
    } : {hasRealBaseline:false,baselineNote:'Formula-only — thermal_overlay.json not loaded'};
    return{mode,allocationId:selectedAlloc,scenario:scenarioLabel,totalKW:sim.totalKW,facilKW:sim.facilKW,pue:sim.pue,maxTemp:sim.maxTemp,violations:sim.violations,critical:sim.critical,globalLoad,coolingOk,rowStats,topRisks,...baselineCtx};
  };

  const askCompliance=async()=>{
    setCompLoading(true);setCompResult('');setCompError('');setCompUsedImage(false);
    try{
      const res=await fetch('/api/analyze-simulation',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(buildSimPayload('compliance'))});
      const data=await res.json();
      if(!res.ok) throw new Error(data.error||`HTTP ${res.status}`);
      setCompResult(data.result);setCompUsedImage(!!data.used_image);
    }catch(e){setCompError(e.message);}
    finally{setCompLoading(false);}
  };

  const askPhysics=async()=>{
    setPhysLoading(true);setPhysResult('');setPhysError('');setPhysUsedImage(false);
    try{
      const res=await fetch('/api/analyze-simulation',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(buildSimPayload('physics'))});
      const data=await res.json();
      if(!res.ok) throw new Error(data.error||`HTTP ${res.status}`);
      setPhysResult(data.result);setPhysUsedImage(!!data.used_image);
    }catch(e){setPhysError(e.message);}
    finally{setPhysLoading(false);}
  };

  return(
    <div className={styles.wrap}>
      <div className={styles.left}>
        <div className={styles.floorHeader}>
          <span className={styles.floorTitle}>Datacenter Floorplan — 70 × 40 ft · 52 Racks</span>
          <span className={`${styles.baselineChip} ${styles['baseline_'+baselineStatus]}`}>
            {baselineStatus==='loaded'?'📡 Sensor baseline':baselineStatus==='loading'?'⏳ Loading baseline…':'📐 Formula only'}
          </span>
          {cosmosThinking&&<span className={styles.thinkingChip}>🔮 Cosmos predicting…</span>}
          {hoveredRack&&!cosmosThinking&&<span className={styles.hoverChip}>{hoveredRack.rack_id} · {hoveredRack.temp_c.toFixed(1)}°C · {hoveredRack.power_kw.toFixed(1)} kW {!hoveredRack.ashrae_allow?'⛔ ABOVE ALLOWABLE':!hoveredRack.ashrae_rec?'⚠ above rec':'✓ OK'}</span>}
        </div>

        <FloorPlan racks={sim.racks} hovered={hovered} onHover={setHovered} cosmosRisk={cosmosMode?cosmosRisk:null}/>

        <div className={styles.legend}>
          <div className={styles.legendBar} style={{background:`linear-gradient(to right,${[18,22,25,27,29,31,33].map(t=>tempColor(t)).join(',')})`}}/>
          <div className={styles.legendLabels}><span>18°C</span><span>22°C</span><span>27° REC</span><span>32° MAX</span></div>
        </div>

        {/* Cosmos risk summary bar */}
        {cosmosMode&&cosmosRisk&&(
          <div className={styles.riskBar}>
            {[1,2,3].map(row=>{
              const risk=cosmosRisk[`row${row}`]??'UNKNOWN';
              return(<div key={row} className={styles.riskCell} style={{borderColor:RISK_COLOR[risk]}}>
                <span style={{color:RISK_COLOR[risk],fontWeight:700}}>Row {row}</span>
                <span style={{color:RISK_COLOR[risk],fontSize:'0.7rem'}}>{risk}</span>
              </div>);
            })}
            {cosmosRisk.maxTemp&&<div className={styles.riskCell} style={{borderColor:'#555'}}>
              <span style={{color:'#aaa',fontWeight:700}}>AI Peak</span>
              <span style={{color:'#aaa',fontSize:'0.7rem'}}>{cosmosRisk.maxTemp}°C</span>
            </div>}
            {cosmosRisk.action&&<div className={styles.riskAction}>⚡ {cosmosRisk.action}</div>}
          </div>
        )}

        <div className={styles.metricsRow}>
          <div className={`${styles.metric} ${sim.totalKW>DESIGN_KW?styles.metricWarn:''}`}>
            <div className={styles.metricVal}>{sim.totalKW.toFixed(0)}<span className={styles.metricUnit}>kW</span></div>
            <div className={styles.metricLabel}>IT Load / {DESIGN_KW} kW design</div>
          </div>
          <div className={styles.metric}>
            <div className={styles.metricVal}>{sim.facilKW.toFixed(0)}<span className={styles.metricUnit}>kW</span></div>
            <div className={styles.metricLabel}>Facility (PUE {sim.pue.toFixed(2)})</div>
          </div>
          <div className={`${styles.metric} ${sim.maxTemp>ASHRAE_ALLOW?styles.metricDanger:sim.maxTemp>ASHRAE_REC?styles.metricWarn:''}`}>
            <div className={styles.metricVal}>{sim.maxTemp.toFixed(1)}<span className={styles.metricUnit}>°C</span></div>
            <div className={styles.metricLabel}>Peak Temp (formula)</div>
          </div>
          <div className={`${styles.metric} ${sim.critical>0?styles.metricDanger:sim.violations>0?styles.metricWarn:styles.metricOk}`}>
            <div className={styles.metricVal}>{sim.violations}</div>
            <div className={styles.metricLabel}>ASHRAE Violations{sim.critical>0?` (${sim.critical} crit)`:''}</div>
          </div>
        </div>

        {(compResult||compLoading||compError)&&(
          <div className={`${styles.cosmosResult} ${compError?styles.cosmosError:''}`}>
            {compLoading&&<div style={{color:'#76b900',textAlign:'center'}}>⏳ Cosmos running compliance assessment…</div>}
            {compError&&<div>❌ Compliance: {compError}</div>}
            {compResult&&<><div className={styles.cosmosResultHeader}>📋 ASHRAE GL-14 / ASME V&amp;V 20 Compliance Report {compUsedImage?'(thermal image + data)':'(scenario data)'}</div>{compResult}</>}
          </div>
        )}
        {(physResult||physLoading||physError)&&(
          <div className={`${styles.cosmosResult} ${physError?styles.cosmosError:''}`}>
            {physLoading&&<div style={{color:'#76b900',textAlign:'center'}}>⏳ Cosmos running physics/CFD analysis…</div>}
            {physError&&<div>❌ Physics: {physError}</div>}
            {physResult&&<><div className={styles.cosmosResultHeader}>⚙️ Physics / CFD Analysis {physUsedImage?'(thermal image + data)':'(scenario data)'}</div>{physResult}</>}
          </div>
        )}
      </div>

      <div className={styles.panel}>
        {/* Allocation Selector */}
        <div className={styles.section}>
          <div className={styles.sectionTitle}>📁 Allocation</div>
          <select
            className={styles.allocSelect}
            value={selectedAlloc}
            onChange={e=>{setSelectedAlloc(e.target.value);setScenario(0);setRowOverrides({});}}
            disabled={allocLoading}
          >
            {/* Always show current as an option even if list didn't load */}
            {/* Default option always present */}
            {!allocations.find(a=>a.allocationId===DEFAULT_ALLOC) && (
              <option key={DEFAULT_ALLOC} value={DEFAULT_ALLOC}>{DEFAULT_ALLOC}</option>
            )}
            {allocations.map(a=>(
              <option key={a.allocationId} value={a.allocationId}>{a.label}</option>
            ))}
          </select>
          {allocLoading&&<div className={styles.imageNote}>⏳ Loading allocation data…</div>}
          {simOpts.idleKW&&<div className={styles.imageNote}>
            Calibration: idle {simOpts.idleKW} kW · peak {simOpts.peakKW} kW · design {simOpts.designKW?.toFixed(0)} kW
          </div>}
        </div>

        {/* Cosmos Live Prediction Mode toggle */}
        <div className={styles.section}>
          <div className={styles.sectionTitle}>🔮 Cosmos Live Prediction</div>
          <label className={styles.toggle}>
            <input type="checkbox" checked={cosmosMode} onChange={e=>setCosmosMode(e.target.checked)}/>
            <span className={styles.toggleSlider}/>
            <span className={styles.toggleLabel}>{cosmosMode?'ON — auto-predicts on slider change':'OFF — formula only'}</span>
          </label>
          <div className={styles.imageNote}>
            {cosmosMode
              ? 'Move any slider → Cosmos analyses thermal image after 1.5s → risk bands appear on map'
              : 'Enable to overlay AI risk prediction on the floorplan'}
          </div>
          {cosmosThinking&&<div className={styles.thinkingNote}>⏳ Cosmos is reading the thermal state…</div>}
        </div>

        {/* Compliance Analysis */}
        <div className={styles.section}>
          <div className={styles.sectionTitle}>📋 Compliance Analysis</div>
          <button className={`${styles.cosmosBtn} ${compLoading?styles.cosmosBtnLoading:''}`} onClick={askCompliance} disabled={compLoading||physLoading}>
            {compLoading?'⏳ Running compliance check…':'Run Compliance Check'}
          </button>
          <div className={styles.imageNote}>ASHRAE GL-14 (3-level temp measurement) + ASME V&amp;V 20 — violation report &amp; corrective actions</div>
        </div>

        {/* Physics / CFD Analysis */}
        <div className={styles.section}>
          <div className={styles.sectionTitle}>⚙️ Physics / CFD Analysis</div>
          <button className={`${styles.cosmosBtn} ${styles.cosmosBtnPhysics} ${physLoading?styles.cosmosBtnLoading:''}`} onClick={askPhysics} disabled={compLoading||physLoading}>
            {physLoading?'⏳ Running physics analysis…':'Run Physics Analysis'}
          </button>
          <div className={styles.imageNote}>Thermal envelope, cooling headroom, power density, load-delta predictions</div>
        </div>

        <div className={styles.section}>
          <div className={styles.sectionTitle}>Scenario Presets</div>
          <div className={styles.scenarioGrid}>
            {SCENARIOS.map((s,i)=><button key={i} className={`${styles.scBtn} ${scenario===i?styles.scActive:''}`} onClick={()=>applyScenario(i)}>{s.label}</button>)}
          </div>
          <div className={styles.scenarioDesc}>{SCENARIOS[Math.max(0,scenario)]?.desc}</div>
        </div>

        <div className={styles.section}>
          <div className={styles.sectionTitle}>Global Load</div>
          <div className={styles.sliderRow}>
            <span className={styles.sliderLabel}>All Racks</span>
            <input type="range" min={0} max={100} step={1} value={Math.round(globalLoad*100)} onChange={e=>{setGlobalLoad(e.target.value/100);setScenario(-1);}} className={styles.slider}/>
            <span className={styles.sliderVal}>{Math.round(globalLoad*100)}%</span>
          </div>
          <div className={styles.sliderSub}>{(IDLE_KW+(PEAK_KW-IDLE_KW)*globalLoad).toFixed(1)} kW/rack · {(52*(IDLE_KW+(PEAK_KW-IDLE_KW)*globalLoad)).toFixed(0)} kW total</div>
        </div>

        <div className={styles.section}>
          <div className={styles.sectionTitle}>Per-Row Override</div>
          {[1,2,3].map(row=>{
            const rowRacks=sim.racks.filter(r=>r.row===row);
            const avgT=rowRacks.reduce((s,r)=>s+r.temp_c,0)/rowRacks.length;
            const viol=rowRacks.filter(r=>!r.ashrae_rec).length;
            const risk=cosmosRisk?.[`row${row}`];
            return(<div key={row}>
              <div className={styles.sliderRow}>
                <span className={styles.sliderLabel} style={risk?{color:RISK_COLOR[risk]}:{}}>Row {row}{risk&&cosmosMode?` [${risk}]`:''}</span>
                <input type="range" min={0} max={100} step={1} value={Math.round(getRowLoad(row)*100)} onChange={e=>{setRowOverrides(p=>({...p,[row]:e.target.value/100}));setScenario(-1);}} className={styles.slider}/>
                <span className={styles.sliderVal}>{Math.round(getRowLoad(row)*100)}%</span>
              </div>
              <div className={styles.rowStat}>avg {avgT.toFixed(1)}°C · {viol}/{rowRacks.length} violations</div>
            </div>);
          })}
        </div>

        <div className={styles.section}>
          <div className={styles.sectionTitle}>Cooling System</div>
          <label className={styles.toggle}>
            <input type="checkbox" checked={coolingOk} onChange={e=>{setCoolingOk(e.target.checked);setScenario(-1);}}/>
            <span className={styles.toggleSlider}/>
            <span className={styles.toggleLabel}>{coolingOk?'Normal (N+1 online)':'FAULT — 50% capacity'}</span>
          </label>
          {!coolingOk&&<div className={styles.faultNote}>⚠ Cooling failure doubles thermal delta</div>}
        </div>

        {hoveredRack&&(
          <div className={styles.section}>
            <div className={styles.sectionTitle}>Rack Detail</div>
            <div className={styles.rackDetail}>
              {[['ID',hoveredRack.rack_id],['Row',hoveredRack.row],['Position',`${hoveredRack.position_ft.x}ft, ${hoveredRack.position_ft.y}ft`],['Load',`${Math.round(hoveredRack.load_pct*100)}%`],['Power',`${hoveredRack.power_kw.toFixed(2)} kW`]].map(([k,v])=>(
                <div key={k} className={styles.rackDetailRow}><span>{k}</span><strong>{v}</strong></div>
              ))}
              <div className={styles.rackDetailRow}><span>Temp</span><strong style={{color:!hoveredRack.ashrae_allow?'#f55':!hoveredRack.ashrae_rec?'#f5a623':'#76b900'}}>{hoveredRack.temp_c.toFixed(2)}°C</strong></div>
              {cosmosMode&&cosmosRisk&&<div className={styles.rackDetailRow}><span>AI Risk</span><strong style={{color:RISK_COLOR[cosmosRisk[`row${hoveredRack.row}`]??'UNKNOWN']}}>{cosmosRisk[`row${hoveredRack.row}`]??'—'}</strong></div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
