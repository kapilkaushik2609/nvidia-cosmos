import { useState } from 'react';
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

const IDLE_KW=4.0,PEAK_KW=18.0,AMBIENT_C=18.0,TEMP_PER_KW=0.969,DESIGN_KW=375;
const ROW_FACTORS={1:1.000,2:1.002,3:1.004};
const ASHRAE_REC=27.0,ASHRAE_ALLOW=32.0;

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

function simulate(rowOverrides,globalLoad,coolingOk){
  const coolDerate=coolingOk?1.0:2.0;
  const rackLoads=RACK_LAYOUT.map(r=>{
    const load=Math.max(0,Math.min(1,rowOverrides[r.row]??globalLoad));
    return{...r,power_kw:IDLE_KW+(PEAK_KW-IDLE_KW)*load,load_pct:load};
  });
  const totalKW=rackLoads.reduce((s,r)=>s+r.power_kw,0);
  const overloadFactor=Math.max(1,totalKW/DESIGN_KW);
  const results=rackLoads.map(r=>{
    const rf=ROW_FACTORS[r.row]??1.0;
    const temp=AMBIENT_C+(r.power_kw-IDLE_KW)*TEMP_PER_KW*rf*overloadFactor*coolDerate;
    return{...r,temp_c:temp,ashrae_rec:temp<=ASHRAE_REC,ashrae_allow:temp<=ASHRAE_ALLOW};
  });
  const maxTemp=Math.max(...results.map(r=>r.temp_c));
  const violations=results.filter(r=>!r.ashrae_rec).length;
  const critical=results.filter(r=>!r.ashrae_allow).length;
  const pue=coolingOk?(1+0.4*Math.min(1,totalKW/DESIGN_KW)):2.1;
  return{racks:results,totalKW,maxTemp,violations,critical,pue,facilKW:totalKW*pue};
}

const SVG_W=560,SVG_H=310,SX=SVG_W/70,SY=SVG_H/40;
const RW=2*SX-3,RH=4*SY-3;

function FloorPlan({racks,hovered,onHover}){
  return(
    <svg viewBox={`0 0 ${SVG_W} ${SVG_H}`} className={styles.floorSvg} preserveAspectRatio="xMidYMid meet">
      <rect x={0} y={0} width={SVG_W} height={SVG_H} fill="#07070f" rx={6}/>
      {[10,20,30,40,50,60].map(x=><line key={`gx${x}`} x1={x*SX} y1={0} x2={x*SX} y2={SVG_H} stroke="#141422" strokeWidth={1}/>)}
      {[10,20,30].map(y=><line key={`gy${y}`} x1={0} y1={y*SY} x2={SVG_W} y2={y*SY} stroke="#141422" strokeWidth={1}/>)}
      {racks.map(r=>{
        const px=r.position_ft.x*SX,py=r.position_ft.y*SY;
        const col=tempColor(r.temp_c),isHov=hovered===r.rack_id;
        const sc=isHov?'#fff':(!r.ashrae_allow?'#ff2200':!r.ashrae_rec?'#ff8800':'#000');
        return(
          <g key={r.rack_id} style={{cursor:'pointer'}} onMouseEnter={()=>onHover(r.rack_id)} onMouseLeave={()=>onHover(null)}>
            <rect x={px} y={py} width={RW} height={RH} fill={col} stroke={sc} strokeWidth={isHov?2:0.5} rx={1} opacity={0.92}/>
            {isHov&&<><rect x={px-2} y={py-18} width={44} height={15} fill="#000a" rx={3}/><text x={px+RW/2} y={py-7} textAnchor="middle" fontSize={8} fill="#fff" fontWeight="bold">{r.rack_id} {r.temp_c.toFixed(1)}°C</text></>}
          </g>
        );
      })}
      {[1,2,3].map(row=>{const r=racks.find(r=>r.row===row);return r?<text key={row} x={r.position_ft.x*SX-14} y={r.position_ft.y*SY+RH/2+3} fontSize={8} fill="#555" fontFamily="monospace" textAnchor="end">R{row}</text>:null;})}
    </svg>
  );
}

export default function SimulationPanel(){
  const[globalLoad,setGlobalLoad]=useState(0.49);
  const[rowOverrides,setRowOverrides]=useState({});
  const[coolingOk,setCoolingOk]=useState(true);
  const[hovered,setHovered]=useState(null);
  const[scenario,setScenario]=useState(0);
  const[cosmosResult,setCosmosResult]=useState('');
  const[cosmosLoading,setCosmosLoading]=useState(false);
  const[cosmosError,setCosmosError]=useState('');
  const[usedImage,setUsedImage]=useState(false);

  const applyScenario=idx=>{setScenario(idx);setGlobalLoad(SCENARIOS[idx].globalLoad);setRowOverrides({});setCoolingOk(SCENARIOS[idx].coolingOk);};
  const getRowLoad=row=>rowOverrides[row]??globalLoad;
  const sim=simulate(rowOverrides,globalLoad,coolingOk);
  const hoveredRack=sim.racks.find(r=>r.rack_id===hovered);

  const askCosmos=async()=>{
    setCosmosLoading(true);setCosmosResult('');setCosmosError('');setUsedImage(false);
    try{
      // Build row stats
      const rowStats=[1,2,3].map(row=>{
        const rr=sim.racks.filter(r=>r.row===row);
        return{row,count:rr.length,avgTemp:rr.reduce((s,r)=>s+r.temp_c,0)/rr.length,violations:rr.filter(r=>!r.ashrae_rec).length};
      });
      // Top at-risk racks sorted by temp descending
      const topRisks=[...sim.racks].sort((a,b)=>b.temp_c-a.temp_c).slice(0,8);
      const scenarioLabel=scenario>=0?SCENARIOS[scenario]?.label:'Custom';

      const res=await fetch('/api/analyze-simulation',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          scenario:scenarioLabel,
          totalKW:sim.totalKW,facilKW:sim.facilKW,pue:sim.pue,
          maxTemp:sim.maxTemp,violations:sim.violations,critical:sim.critical,
          globalLoad,coolingOk,rowStats,topRisks,
        }),
      });
      const data=await res.json();
      if(!res.ok)throw new Error(data.error||`HTTP ${res.status}`);
      setCosmosResult(data.result);
      setUsedImage(!!data.used_image);
    }catch(e){setCosmosError(e.message);}
    finally{setCosmosLoading(false);}
  };

  return(
    <div className={styles.wrap}>
      <div className={styles.left}>
        <div className={styles.floorHeader}>
          <span className={styles.floorTitle}>Datacenter Floorplan — 70 × 40 ft · 52 Racks</span>
          {hoveredRack&&<span className={styles.hoverChip}>{hoveredRack.rack_id} · {hoveredRack.temp_c.toFixed(1)}°C · {hoveredRack.power_kw.toFixed(1)} kW {!hoveredRack.ashrae_allow?'⛔ ABOVE ALLOWABLE':!hoveredRack.ashrae_rec?'⚠ above rec':'✓ OK'}</span>}
        </div>
        <FloorPlan racks={sim.racks} hovered={hovered} onHover={setHovered}/>
        <div className={styles.legend}>
          <div className={styles.legendBar} style={{background:`linear-gradient(to right,${[18,22,25,27,29,31,33].map(t=>tempColor(t)).join(',')})`}}/>
          <div className={styles.legendLabels}><span>18°C</span><span>22°C</span><span>27° REC</span><span>32° MAX</span></div>
        </div>
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
            <div className={styles.metricLabel}>Peak Rack Temp</div>
          </div>
          <div className={`${styles.metric} ${sim.critical>0?styles.metricDanger:sim.violations>0?styles.metricWarn:styles.metricOk}`}>
            <div className={styles.metricVal}>{sim.violations}</div>
            <div className={styles.metricLabel}>ASHRAE Violations{sim.critical>0?` (${sim.critical} critical)`:''}</div>
          </div>
        </div>

        {/* Cosmos AI result — shown below the floorplan on the left */}
        {(cosmosResult||cosmosLoading||cosmosError)&&(
          <div className={`${styles.cosmosResult} ${cosmosError?styles.cosmosError:''}`}>
            {cosmosLoading&&<div style={{color:'#76b900',textAlign:'center'}}>⏳ Cosmos is analyzing the thermal scenario…</div>}
            {cosmosError&&<div>❌ {cosmosError}</div>}
            {cosmosResult&&<>
              <div className={styles.cosmosResultHeader}>
                🔮 Cosmos3-Nano Analysis {usedImage?'(thermal image + scenario data)':'(scenario data)'}
              </div>
              {cosmosResult}
            </>}
          </div>
        )}
      </div>

      <div className={styles.panel}>
        {/* Ask Cosmos button — top of panel */}
        <div className={styles.section}>
          <button
            className={`${styles.cosmosBtn} ${cosmosLoading?styles.cosmosBtnLoading:''}`}
            onClick={askCosmos}
            disabled={cosmosLoading}
          >
            {cosmosLoading?'⏳ Asking Cosmos AI…':'🔮 Ask Cosmos AI to Analyze This Scenario'}
          </button>
          <div className={styles.imageNote}>
            Sends current simulation state + real thermal image to Cosmos3-Nano for AI prediction
          </div>
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
            return(<div key={row}>
              <div className={styles.sliderRow}>
                <span className={styles.sliderLabel}>Row {row}</span>
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
          {!coolingOk&&<div className={styles.faultNote}>⚠ Cooling failure doubles thermal delta — immediate ASHRAE risk</div>}
        </div>

        {hoveredRack&&(
          <div className={styles.section}>
            <div className={styles.sectionTitle}>Rack Detail</div>
            <div className={styles.rackDetail}>
              {[['ID',hoveredRack.rack_id],['Row',hoveredRack.row],['Position',`${hoveredRack.position_ft.x}ft, ${hoveredRack.position_ft.y}ft`],['Load',`${Math.round(hoveredRack.load_pct*100)}%`],['Power',`${hoveredRack.power_kw.toFixed(2)} kW`]].map(([k,v])=>(
                <div key={k} className={styles.rackDetailRow}><span>{k}</span><strong>{v}</strong></div>
              ))}
              <div className={styles.rackDetailRow}><span>Temp</span><strong style={{color:!hoveredRack.ashrae_allow?'#f55':!hoveredRack.ashrae_rec?'#f5a623':'#76b900'}}>{hoveredRack.temp_c.toFixed(2)}°C</strong></div>
              <div className={styles.rackDetailRow}><span>ASHRAE</span><strong style={{color:!hoveredRack.ashrae_allow?'#f55':!hoveredRack.ashrae_rec?'#f5a623':'#76b900'}}>{!hoveredRack.ashrae_allow?'⛔ Exceeds allowable':!hoveredRack.ashrae_rec?'⚠ Exceeds rec':'✓ Compliant'}</strong></div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
