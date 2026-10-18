'use strict';
const $=s=>document.querySelector(s),R=6371000,MPH=2.23694;
const DEF_SPOTS=[["Beacons",33.0645,-117.3065],["Tamarack",33.1494,-117.3487],["Terramar",33.1290,-117.3361],["Ponto",33.0868,-117.3123],["Oceanside Pier",33.1934,-117.3866],["Swami's",33.0346,-117.2945],["Cardiff Reef",33.0136,-117.2829]];
let spots=JSON.parse(localStorage.spots||'null')||DEF_SPOTS;const saveSpots=()=>localStorage.spots=JSON.stringify(spots);
// ---------- IndexedDB ----------
let dbp=new Promise((ok,no)=>{const r=indexedDB.open('swelllog',1);r.onupgradeneeded=()=>r.result.createObjectStore('s',{keyPath:'id'});r.onsuccess=()=>ok(r.result);r.onerror=no});
const tx=async(m,f)=>{const d=await dbp;return new Promise((ok,no)=>{const t=d.transaction('s',m),st=t.objectStore('s'),q=f(st);t.oncomplete=()=>ok(q&&q.result);t.onerror=no})};
const allS=()=>tx('readonly',s=>s.getAll()),putS=o=>tx('readwrite',s=>s.put(o)),delS=id=>tx('readwrite',s=>s.delete(id));
// ---------- geo ----------
const rad=d=>d*Math.PI/180,deg=r=>r*180/Math.PI;
function dist(a,b){const dl=rad(b.lat-a.lat),dn=rad(b.lon-a.lon),x=Math.sin(dl/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dn/2)**2;return 2*R*Math.asin(Math.sqrt(x))}
function bear(a,b){const y=Math.sin(rad(b.lon-a.lon))*Math.cos(rad(b.lat)),x=Math.cos(rad(a.lat))*Math.sin(rad(b.lat))-Math.sin(rad(a.lat))*Math.cos(rad(b.lat))*Math.cos(rad(b.lon-a.lon));return (deg(Math.atan2(y,x))+360)%360}
const adiff=(a,b)=>Math.abs(((a-b+540)%360)-180);
function nearestSpot(p){let best=null,bd=1e12;for(const s of spots){const d=dist(p,{lat:s[1],lon:s[2]});if(d<bd){bd=d;best=s[0]}}return bd<5000?best:(best?best+' (area)':'Unknown')}
// ---------- wave detection ----------
// rides: speed >= 3 m/s sustained >= 3 s, net heading toward shore (shore bearing inferred from fast segments), dist >= 10 m
function analyze(pts){
  pts=pts.filter(p=>isFinite(p.lat)&&isFinite(p.lon)&&p.t).sort((a,b)=>a.t-b.t);
  if(pts.length<2)return null;
  const n=pts.length,sp=new Array(n).fill(0);
  for(let i=1;i<n;i++){const dt=(pts[i].t-pts[i-1].t)/1000;sp[i]=dt>0?dist(pts[i-1],pts[i])/dt:0;if(sp[i]>15)sp[i]=sp[i-1]}// reject GPS spikes >33 mph
  const sm=sp.map((v,i)=>{let s=0,c=0;for(let j=Math.max(0,i-1);j<=Math.min(n-1,i+1);j++){s+=sp[j];c++}return s/c});
  let segs=[],st=-1;
  for(let i=0;i<=n;i++){const fast=i<n&&sm[i]>=3;if(fast&&st<0)st=i;if(!fast&&st>=0){segs.push([Math.max(0,st-1),i-1]);st=-1}}
  segs=segs.filter(([a,b])=>(pts[b].t-pts[a].t)/1000>=3&&dist(pts[a],pts[b])>=10);
  // infer shore bearing: circular mean of segment bearings weighted by length
  let sx=0,sy=0;segs.forEach(([a,b])=>{const br=rad(bear(pts[a],pts[b])),d=dist(pts[a],pts[b]);sx+=Math.sin(br)*d;sy+=Math.cos(br)*d});
  const shore=(deg(Math.atan2(sx,sy))+360)%360;
  const waves=segs.filter(([a,b])=>adiff(bear(pts[a],pts[b]),shore)<100).map(([a,b])=>{let d=0,top=0;for(let i=a+1;i<=b;i++){d+=dist(pts[i-1],pts[i]);top=Math.max(top,sp[i])}return{a,b,dist:d,top,dur:(pts[b].t-pts[a].t)/1000,t:pts[a].t}});
  let total=0;for(let i=1;i<n;i++)total+=dist(pts[i-1],pts[i]);
  const wd=waves.reduce((s,w)=>s+w.dist,0);
  return{start:pts[0].t,end:pts[n-1].t,dur:(pts[n-1].t-pts[0].t)/1000,waves,count:waves.length,top:Math.max(0,...waves.map(w=>w.top)),longest:Math.max(0,...waves.map(w=>w.dist)),longestDur:Math.max(0,...waves.map(w=>w.dur)),total,waveDist:wd,paddle:total-wd,shore,spot:nearestSpot(pts[0]),pts:pts.map(p=>[p.t,+p.lat.toFixed(6),+p.lon.toFixed(6)])};
}
// ---------- parsers ----------
function parseXML(txt){const d=new DOMParser().parseFromString(txt,'application/xml');const out=[];
  d.querySelectorAll('trkpt').forEach(e=>{const t=e.getElementsByTagName('time')[0];out.push({lat:+e.getAttribute('lat'),lon:+e.getAttribute('lon'),t:t?Date.parse(t.textContent):0})});
  if(!out.length)[...d.getElementsByTagName('Trackpoint')].forEach(e=>{const g=n=>e.getElementsByTagName(n)[0];if(!g('LatitudeDegrees'))return;out.push({lat:+g('LatitudeDegrees').textContent,lon:+g('LongitudeDegrees').textContent,t:Date.parse(g('Time').textContent)})});
  return out}
function parseFIT(buf){const v=new DataView(buf),hs=v.getUint8(0),ds=v.getUint32(4,true);let p=hs,end=hs+ds,defs={},out=[],lastT=0;const SC=180/2**31;
  while(p<end){const h=v.getUint8(p++);
    if(h&0x80){const lt=(h>>5)&3,off=h&31,d=defs[lt];let t=lastT-(lastT&31)+off;if(off<(lastT&31))t+=32;lastT=t;p=readData(d,p,t);continue}
    const lt=h&15;
    if(h&0x40){const le=v.getUint8(p+1)===0,g=v.getUint16(p+2,le),nf=v.getUint8(p+4);p+=5;const f=[];for(let i=0;i<nf;i++){f.push([v.getUint8(p),v.getUint8(p+1),v.getUint8(p+2)]);p+=3}let dev=0;if(h&0x20){const nd=v.getUint8(p++);for(let i=0;i<nd;i++){dev+=v.getUint8(p+1);p+=3}}defs[lt]={le,g,f,dev}}
    else p=readData(defs[lt],p,null)}
  function readData(d,p,ct){if(!d)throw Error('Bad FIT');let r={};for(const[num,sz,bt]of d.f){if(d.g===20&&(num===0||num===1||num===253)&&sz===4){r[num]=num===253?v.getUint32(p,d.le):v.getInt32(p,d.le)}p+=sz}p+=d.dev;
    if(d.g===20){if(r[253]!=null)lastT=r[253];const t=r[253]!=null?r[253]:ct;if(r[0]!=null&&r[0]!==0x7fffffff&&t!=null)out.push({lat:r[0]*SC,lon:r[1]*SC,t:(t+631065600)*1000})}else if(r[253]!=null)lastT=r[253];return p}
  return out}
async function importFiles(files){const msg=[];for(const f of files){try{let pts;if(/\.fit$/i.test(f.name))pts=parseFIT(await f.arrayBuffer());else pts=parseXML(await f.text());const a=analyze(pts);if(!a)throw Error('no GPS points');a.id='s'+a.start;a.src=f.name;await putS(a);await addConditions(a);msg.push(`✓ ${f.name}: ${a.count} waves at ${a.spot}`)}catch(e){msg.push(`✗ ${f.name}: ${e.message}`)}}
  $('#impMsg').innerHTML=msg.map(m=>`<div class="mu">${m}</div>`).join('');render();}
// ---------- live tracking ----------
let watch=null,live=[],wl=null,tick=null;
async function startLive(){if(!navigator.geolocation)return alert('No GPS');live=[];try{wl=await navigator.wakeLock?.request('screen')}catch(e){}
  watch=navigator.geolocation.watchPosition(p=>{if(p.coords.accuracy>30)return;live.push({lat:p.coords.latitude,lon:p.coords.longitude,t:p.timestamp});if(live.length===1)$('#spotNow').textContent='Spot: '+nearestSpot(live[0]);liveUpdate()},e=>$('#spotNow').textContent='GPS: '+e.message,{enableHighAccuracy:true,maximumAge:0,timeout:20000});
  tick=setInterval(liveUpdate,1000);$('#go').textContent='End session';localStorage.liveBackup='[]'}
function liveUpdate(){const a=analyze(live.slice());if(!a)return;$('#lw').textContent=a.count;$('#lt').textContent=fmtD(a.dur);$('#ls').textContent=(a.top*MPH).toFixed(1);$('#ld').textContent=(a.total/1609).toFixed(2);if(live.length%20===0)localStorage.liveBackup=JSON.stringify(live)}
async function stopLive(){navigator.geolocation.clearWatch(watch);clearInterval(tick);wl&&wl.release();watch=null;$('#go').textContent='Start session';const a=analyze(live);if(a){a.id='s'+a.start;a.src='live';await putS(a);await addConditions(a);render();show('log');openS(a.id)}localStorage.removeItem('liveBackup')}
// ---------- render ----------
const fmtD=s=>{s=Math.round(s);const h=Math.floor(s/3600),m=Math.floor(s%3600/60);return h?`${h}:${String(m).padStart(2,'0')}h`:`${m}:${String(s%60).padStart(2,'0')}`};
const dstr=t=>new Date(t).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'});
let S=[];
async function render(){S=(await allS()).sort((a,b)=>b.start-a.start);$('#hdr').textContent=S.length+(S.length===1?' session ›':' sessions ›');renderLatest();
  $('#logT tbody').innerHTML=S.map(s=>`<tr class="clk" data-id="${s.id}"><td data-v="${s.start}">${dstr(s.start)}</td><td>${s.spot}${s.sample?' <span class="pill">sample</span>':''}</td><td>${s.count}</td><td>${(s.top*MPH).toFixed(1)}</td><td>${Math.round(s.longest/0.3048)}</td><td data-v="${s.dur}">${fmtD(s.dur)} <span class="mu">›</span></td></tr>`).join('')||'<tr><td colspan=6 class="mu">No sessions yet — track one or import a file.</td></tr>';
  const mx=(f)=>S.reduce((b,s)=>f(s)>f(b||s)?s:(b||s),null);const pb=[['Most waves',s=>s.count,v=>v],['Top speed',s=>s.top,v=>(v*MPH).toFixed(1)+' mph'],['Longest wave',s=>s.longest,v=>Math.round(v)+' m'],['Longest ride time',s=>s.longestDur||0,v=>Math.round(v)+' s'],['Longest session',s=>s.dur,fmtD],['Most distance',s=>s.total,v=>(v/1609).toFixed(2)+' mi']];
  $('#pb').innerHTML=S.length?pb.map(([l,f,fm])=>{const b=mx(f);return`<div class="st"><div class="v">${fm(f(b))}</div><div class="l">${l}</div><div class="mu">${dstr(b.start)} · ${b.spot}</div></div>`}).join('')+`<div class="st"><div class="v">${S.reduce((a,s)=>a+s.count,0)}</div><div class="l">Career waves</div></div><div class="st"><div class="v">${(S.reduce((a,s)=>a+s.dur,0)/3600).toFixed(1)}</div><div class="l">Hours in water</div></div>`:'<span class="mu">No sessions yet</span>';
  const grp=(k)=>{const g={};S.forEach(s=>{const key=k(s);(g[key]=g[key]||[]).push(s)});return Object.entries(g).map(([k,a])=>`<tr><td>${k}</td><td>${a.length}</td><td>${a.reduce((x,s)=>x+s.count,0)}</td><td>${(a.reduce((x,s)=>x+s.dur,0)/3600).toFixed(1)}</td><td>${(Math.max(...a.map(s=>s.top))*MPH).toFixed(1)}</td></tr>`).join('')};
  $('#monT tbody').innerHTML=grp(s=>new Date(s.start).toISOString().slice(0,7));$('#spotT tbody').innerHTML=grp(s=>s.spot);$('#boardT tbody').innerHTML=grp(s=>s.board||'(no board)');renderSpots()}
let map=null,rep=null;
function openS(id){const s=S.find(x=>x.id===id);if(!s)return;const P=s.pts.map(p=>[p[1],p[2]]);
  $('#detail').innerHTML=`<div class="dtop"><button class="back" id="back">‹ Sessions</button><div id="map" class="dmap"></div></div>
  <div class="sheet"><div class="grab"></div><h2 style="margin:4px 0">${s.spot}</h2><div class="mu">${dstr(s.start)} · ${new Date(s.start).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}–${new Date(s.end).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}${s.sample?' · <span class="pill">sample</span>':''}</div>
  <div class="grid" style="margin-top:10px">${[['Waves',s.count],['Top speed',(s.top*MPH).toFixed(1)+' mph'],['Longest wave',Math.round(s.longest/0.3048)+' ft'],['Time in water',fmtD(s.dur)],['Surf distance',Math.round(s.waveDist/0.9144)+' yd'],['Paddle distance',(s.paddle/1609.34).toFixed(1)+' mi']].map(([l,v])=>`<div class="st"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('')}</div>
  <div style="margin:10px 0"><button class="btn sec" id="replay">▶ Replay</button> <button class="btn sec" id="shImg">Share image</button> <button class="btn sec" id="shGpx">GPX</button></div>
  <h3>Waves</h3><table id="wvT"><thead><tr><th>#</th><th>Time</th><th>Length ft</th><th>Secs</th><th>Top mph</th></tr></thead><tbody>${s.waves.map((w,i)=>`<tr class="clk" data-w="${i}"><td>${i+1}</td><td data-v="${w.t}">${new Date(w.t).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}</td><td>${Math.round(w.dist/0.3048)}</td><td>${Math.round(w.dur)}</td><td>${(w.top*MPH).toFixed(1)}</td></tr>`).join('')}</tbody></table>
  <h3 style="margin-top:14px">Conditions</h3><div>${s.cond&&s.cond.pills?s.cond.pills.map(p=>`<span class="pill">${p}</span>`).join(''):s.cond?`<span class="pill">Surf ${s.cond.ft?.toFixed(1)} ft</span><span class="pill">${Math.round(s.cond.per)} s</span><span class="pill">Wind ${Math.round(s.cond.wind)} mph</span><span class="pill">Tide ${s.cond.tide?.toFixed(1)} ft</span>`:'<span class="mu">No conditions saved</span>'}</div>
  <h3 style="margin-top:14px">Board</h3><input id="board" list="boards" value="${s.board||''}" placeholder="e.g. 6'0 shortboard" style="width:100%"><datalist id="boards">${[...new Set(S.map(x=>x.board).filter(Boolean))].map(b=>`<option value="${b}">`).join('')}</datalist>
  <div class="mu" style="margin-top:14px">Source: ${s.src}</div><button class="btn sec" id="del" style="margin-top:10px;width:100%">Delete session</button></div>`;
  $('#detail').classList.add('open');$('#detail').scrollTop=0;if(!history.state||!history.state.d)history.pushState({d:1},'');
  $('#back').onclick=()=>history.back();
  if(map)map.remove();map=L.map('map',{zoomControl:false});L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'}).addTo(map);
  L.polyline(P,{color:'#6c8aa6',weight:2,opacity:.7}).addTo(map);const wl=s.waves.map((w,i)=>L.polyline(P.slice(w.a,w.b+1),{color:'#2ee6d6',weight:5}).bindTooltip('Wave '+(i+1)).addTo(map));map.fitBounds(P,{padding:[20,20]});setTimeout(()=>{map.invalidateSize();map.fitBounds(P,{padding:[30,30]})},350);
  $('#wvT tbody').onclick=e=>{const r=e.target.closest('tr');if(!r)return;const l=wl[r.dataset.w];map.fitBounds(l.getBounds(),{padding:[40,40]});l.setStyle({color:'#ffd23f'});setTimeout(()=>l.setStyle({color:'#2ee6d6'}),1500)};
  $('#replay').onclick=()=>{clearInterval(rep);const m=L.circleMarker(P[0],{radius:7,color:'#fff',fillColor:'#ff5d73',fillOpacity:1}).addTo(map);let i=0;const step=Math.max(1,Math.floor(P.length/400));rep=setInterval(()=>{i+=step;if(i>=P.length){clearInterval(rep);setTimeout(()=>m.remove(),800);return}m.setLatLng(P[i])},25)};
  $('#shGpx').onclick=()=>shareFile(new Blob([toGPX(s)],{type:'application/gpx+xml'}),`session-${new Date(s.start).toISOString().slice(0,10)}.gpx`);
  $('#shImg').onclick=()=>shareImg(s);$('#board').onchange=async e=>{s.board=e.target.value.trim();await putS(s);render()};$('#del').onclick=async()=>{if(confirm('Delete session?')){await delS(s.id);closeS();render()}};}
function renderLatest(){const el=$('#latest'),s=S[0];if(!s){el.innerHTML='';return}
  const P=s.pts,la=P.map(p=>p[1]),lo=P.map(p=>p[2]),a0=Math.min(...la),a1=Math.max(...la),o0=Math.min(...lo),o1=Math.max(...lo),k=Math.min(300/((o1-o0)||1e-6),110/((a1-a0)||1e-6)),X=p=>(10+(p[2]-o0)*k).toFixed(1),Y=p=>(120-(p[1]-a0)*k).toFixed(1),st=Math.max(1,Math.floor(P.length/500));
  const line=P.filter((p,i)=>i%st===0).map(p=>X(p)+','+Y(p)).join(' '),wv=s.waves.map(w=>`<polyline points="${P.slice(w.a,w.b+1).map(p=>X(p)+','+Y(p)).join(' ')}" stroke="#2ee6d6" stroke-width="4" fill="none" stroke-linecap="round"/>`).join('');
  el.innerHTML=`<div class="card latest" data-id="${s.id}"><div style="display:flex;justify-content:space-between;align-items:center"><h3 style="margin:0">Latest session</h3><span class="mu">Open ›</span></div>
  <div style="font-size:18px;font-weight:700;margin-top:4px">${s.spot} <span class="mu">${dstr(s.start)}${s.sample?' · sample':''}</span></div>
  <svg viewBox="0 0 320 130" style="width:100%;height:120px;background:#08243b;border-radius:12px;margin:8px 0"><polyline points="${line}" stroke="#5d7f9c" stroke-width="1.5" fill="none"/>${wv}</svg>
  <div class="grid" style="grid-template-columns:repeat(3,1fr)"><div class="st"><div class="v">${s.count}</div><div class="l">Waves</div></div><div class="st"><div class="v">${Math.round(s.longest/0.3048)}<small>ft</small></div><div class="l">Longest</div></div><div class="st"><div class="v">${(s.top*MPH).toFixed(1)}</div><div class="l">Top mph</div></div></div></div>`}
function closeS(){$('#detail').classList.remove('open');if(history.state&&history.state.d)history.back()}
window.addEventListener('popstate',()=>$('#detail').classList.remove('open'));
{let x0=null;$('#detail').addEventListener('touchstart',e=>{const t=e.touches[0];x0=t.clientX<40?t.clientX:null},{passive:true});$('#detail').addEventListener('touchend',e=>{if(x0!=null&&e.changedTouches[0].clientX-x0>80)history.back();x0=null})}
const toGPX=s=>`<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Swell Log" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${s.spot} ${dstr(s.start)}</name><trkseg>\n${s.pts.map(p=>`<trkpt lat="${p[1]}" lon="${p[2]}"><time>${new Date(p[0]).toISOString()}</time></trkpt>`).join('\n')}\n</trkseg></trk></gpx>`;
async function shareFile(b,name){const f=new File([b],name,{type:b.type});if(navigator.canShare&&navigator.canShare({files:[f]})){try{await navigator.share({files:[f],title:name});return}catch(e){}}const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=name;a.click()}
function shareImg(s){const c=document.createElement('canvas');c.width=1080;c.height=1350;const g=c.getContext('2d');const gr=g.createLinearGradient(0,0,0,1350);gr.addColorStop(0,'#021220');gr.addColorStop(1,'#0a4a75');g.fillStyle=gr;g.fillRect(0,0,1080,1350);
  const P=s.pts,la=P.map(p=>p[1]),lo=P.map(p=>p[2]),mnA=Math.min(...la),mxA=Math.max(...la),mnO=Math.min(...lo),mxO=Math.max(...lo),sc=Math.min(900/((mxO-mnO)||1e-5),560/((mxA-mnA)||1e-5));const X=p=>90+(p[2]-mnO)*sc,Y=p=>720-(p[1]-mnA)*sc;
  g.strokeStyle='#5d7f9c';g.lineWidth=3;g.beginPath();P.forEach((p,i)=>i?g.lineTo(X(p),Y(p)):g.moveTo(X(p),Y(p)));g.stroke();g.strokeStyle='#2ee6d6';g.lineWidth=8;s.waves.forEach(w=>{g.beginPath();for(let i=w.a;i<=w.b;i++)i===w.a?g.moveTo(X(P[i]),Y(P[i])):g.lineTo(X(P[i]),Y(P[i]));g.stroke()});
  g.fillStyle='#2ee6d6';g.font='bold 64px -apple-system,sans-serif';g.fillText(s.spot,70,110);g.fillStyle='#bcd6ea';g.font='36px sans-serif';g.fillText(dstr(s.start),70,160);
  [['WAVES',s.count],['TOP MPH',(s.top*MPH).toFixed(1)],['LONGEST',Math.round(s.longest)+'m'],['TIME',fmtD(s.dur)]].forEach(([l,v],i)=>{const x=70+(i%2)*480,y=900+Math.floor(i/2)*190;g.fillStyle='#fff';g.font='bold 96px sans-serif';g.fillText(v,x,y+80);g.fillStyle='#8fb3cc';g.font='32px sans-serif';g.fillText(l,x,y+125)});
  c.toBlob(b=>shareFile(b,'session.png'))}
// ---------- forecast ----------
const cmp=d=>d==null?'':['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'][Math.round(d/22.5)%16];
async function fj(u,tries=3){for(let i=0;i<tries;i++){const c=new AbortController(),t=setTimeout(()=>c.abort(),9000);try{const r=await fetch(u,{signal:c.signal});clearTimeout(t);if(r.ok)return r.json()}catch(e){clearTimeout(t)}}throw Error('network')}
const RL=['Flat','Poor','Fair','Good','Great','Epic'],RC=['#4a5d70','#e05a5a','#f0a03c','#37c978','#2ee6d6','#b76cff'];
// original heuristic: size from swell height x period, plus wind quality vs. beach facing (default WSW 255°)
function score(ft,per,ws,wd,face=255){if(ft==null)return 0;let sz=Math.min(3.2,ft*(per||8)/11);if(ft<0.7)sz=0;const off=Math.cos(rad((wd-((face+180)%360))));let w=ws<5?1.4:off>0.5?(ws<20?1.6:0.6):off>-0.3?(ws<10?0.4:-0.6):(ws<8?-0.2:-1.6);return Math.max(0,Math.min(5,Math.round(sz+w)))}
const badge=r=>`<span class="pill" style="background:${RC[r]};color:#021">${RL[r]}</span>`;
const arrow=d=>`<span style="display:inline-block;transform:rotate(${d}deg)">↓</span>`;
const mUrl=(la,lo,days=3)=>`https://marine-api.open-meteo.com/v1/marine?latitude=${la}&longitude=${lo}&hourly=wave_height,swell_wave_height,swell_wave_period,swell_wave_direction,sea_surface_temperature&length_unit=imperial&timezone=America%2FLos_Angeles&forecast_days=${days}`;
const wUrl=(la,lo,days=3)=>`https://api.open-meteo.com/v1/forecast?latitude=${la}&longitude=${lo}&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=mph&timezone=America%2FLos_Angeles&forecast_days=${days}`;
const favs=()=>JSON.parse(localStorage.favs||'[]');
async function overview(){const el=$('#ovT tbody');try{const la=spots.map(s=>s[1]).join(','),lo=spots.map(s=>s[2]).join(',');let[m,w]=await Promise.all([fj(mUrl(la,lo,1)),fj(wUrl(la,lo,1))]);if(!Array.isArray(m)){m=[m];w=[w]}
  const F=favs(),now=new Date();el.innerHTML=spots.map((s,i)=>{const H=m[i].hourly,W=w[i].hourly,k=Math.max(0,H.time.findIndex(t=>new Date(t)>now)-1),r=score(H.swell_wave_height[k],H.swell_wave_period[k],W.wind_speed_10m[k],W.wind_direction_10m[k],s[3]);return`<tr class="clk" data-i="${i}"><td data-v="${F.includes(s[0])?0:1}"><span class="star" data-f="${i}">${F.includes(s[0])?'★':'☆'}</span></td><td>${s[0]}</td><td data-v="${r}">${badge(r)}</td><td>${H.wave_height[k]?.toFixed(1)}</td><td>${Math.round(H.swell_wave_period[k])}s</td><td data-v="${W.wind_speed_10m[k]}">${Math.round(W.wind_speed_10m[k])} ${arrow(W.wind_direction_10m[k])}</td></tr>`}).sort((x,y)=>(x.includes('★')?0:1)-(y.includes('★')?0:1)).join('')}catch(e){el.innerHTML='<tr><td>Conditions unavailable — retry later</td></tr>'}}
async function forecast(){const s=spots[+$('#fcSpot').value]||spots[0];$('#fcNow').textContent='Loading…';
  try{const[m,w]=await Promise.all([fj(mUrl(s[1],s[2])),fj(wUrl(s[1],s[2]))]);
    const H=m.hourly,W=w.hourly,now=new Date(),ni=Math.max(0,H.time.findIndex(t=>new Date(t)>now)-1);
    const sc=H.time.map((t,i)=>score(H.swell_wave_height[i],H.swell_wave_period[i],W.wind_speed_10m[i],W.wind_direction_10m[i],s[3]));
    let bi=-1;H.time.forEach((t,i)=>{const h=new Date(t).getHours();if(i>=ni&&h>=6&&h<=18&&(bi<0||sc[i]>sc[bi]))bi=i});
    $('#fcNowCard').innerHTML=[['Now',badge(sc[ni])],['Surf ft',H.wave_height[ni]?.toFixed(1)],['Swell',`${H.swell_wave_height[ni]?.toFixed(1)}ft ${Math.round(H.swell_wave_period[ni])}s`],['Swell dir',cmp(H.swell_wave_direction[ni])+' '+Math.round(H.swell_wave_direction[ni])+'°'],['Wind',`${Math.round(W.wind_speed_10m[ni])} mph ${cmp(W.wind_direction_10m[ni])} ${arrow(W.wind_direction_10m[ni])}`],['Water °F',H.sea_surface_temperature[ni]!=null?Math.round(H.sea_surface_temperature[ni]*9/5+32):'–']].map(([l,v])=>`<div class="st"><div class="v" style="font-size:20px">${v}</div><div class="l">${l}</div></div>`).join('');
    $('#best').innerHTML=bi>=0?`Best time to surf: <b>${new Date(H.time[bi]).toLocaleString([], {weekday:'short',hour:'numeric'})}</b> ${badge(sc[bi])}`:'';
    drawChart(H,sc,ni);
    $('#fcT tbody').innerHTML=H.time.map((t,i)=>i%3||i<ni?'':`<tr><td data-v="${i}">${new Date(t).toLocaleString([], {weekday:'short',hour:'numeric'})}</td><td data-v="${sc[i]}">${badge(sc[i])}</td><td>${H.swell_wave_height[i]?.toFixed(1)}</td><td>${Math.round(H.swell_wave_period[i])}</td><td data-v="${H.swell_wave_direction[i]}">${cmp(H.swell_wave_direction[i])}</td><td data-v="${W.wind_speed_10m[i]}">${Math.round(W.wind_speed_10m[i])} ${arrow(W.wind_direction_10m[i])}</td></tr>`).join('');$('#fcNow').textContent=s[0]+' · Open-Meteo'}catch(e){$('#fcNow').textContent='Forecast unavailable ('+e.message+') — pull to retry'}
  try{const d=new Date(),f=x=>x.toISOString().slice(0,10).replace(/-/g,'');const e=new Date(+d+3*864e5);const t=await fj(`https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&application=swelllog&begin_date=${f(d)}&end_date=${f(e)}&datum=MLLW&station=9410230&time_zone=lst_ldt&units=english&interval=hilo&format=json`);
    $('#tideT tbody').innerHTML=t.predictions.filter(p=>new Date(p.t.replace(' ','T'))>new Date(Date.now()-3*36e5)).map(p=>`<tr><td>${new Date(p.t.replace(' ','T')).toLocaleString([], {weekday:'short',hour:'numeric',minute:'2-digit'})}</td><td>${p.type==='H'?'▲ High':'▼ Low'}</td><td>${(+p.v).toFixed(1)} ft</td></tr>`).join('')}catch(e){$('#tideT tbody').innerHTML='<tr><td>Tides unavailable</td></tr>'}}
function drawChart(H,sc,ni){const c=$('#chart'),W=c.width=c.clientWidth*2,Hh=c.height=320,g=c.getContext('2d'),n=H.time.length,mx=Math.max(3,...H.wave_height.map(v=>v||0)),bw=W/n;
  g.clearRect(0,0,W,Hh);H.time.forEach((t,i)=>{const v=H.wave_height[i]||0,h=v/mx*(Hh-60);g.fillStyle=RC[sc[i]];g.globalAlpha=i<ni?.35:1;g.fillRect(i*bw+1,Hh-30-h,bw-2,h);const d=new Date(t);if(d.getHours()===0||i===0){g.globalAlpha=1;g.fillStyle='#8fb3cc';g.font='22px sans-serif';g.fillText(d.toLocaleDateString([], {weekday:'short'}),i*bw+4,Hh-6);g.fillRect(i*bw,0,1,Hh-30)}});
  g.globalAlpha=1;g.fillStyle='#e6f4ff';g.font='bold 22px sans-serif';g.fillText(mx.toFixed(1)+' ft',6,24);g.fillStyle='#fff';g.fillRect(ni*bw,10,2,Hh-40)}
// conditions snapshot at session time (best effort, cached on session)
async function addConditions(a){try{const d=new Date(a.start),day=d.toLocaleDateString('en-CA'),p={lat:a.pts[0][1],lon:a.pts[0][2]};
  const[m,w,t]=await Promise.all([fj(`https://marine-api.open-meteo.com/v1/marine?latitude=${p.lat}&longitude=${p.lon}&hourly=wave_height,swell_wave_period&length_unit=imperial&timezone=America%2FLos_Angeles&start_date=${day}&end_date=${day}`),fj(`https://archive-api.open-meteo.com/v1/archive?latitude=${p.lat}&longitude=${p.lon}&hourly=wind_speed_10m&wind_speed_unit=mph&timezone=America%2FLos_Angeles&start_date=${day}&end_date=${day}`).catch(()=>fj(`https://api.open-meteo.com/v1/forecast?latitude=${p.lat}&longitude=${p.lon}&hourly=wind_speed_10m&wind_speed_unit=mph&timezone=America%2FLos_Angeles&start_date=${day}&end_date=${day}`)),fj(`https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&application=swelllog&begin_date=${day.replace(/-/g,'')}&end_date=${day.replace(/-/g,'')}&datum=MLLW&station=9410230&time_zone=lst_ldt&units=english&interval=h&format=json`)]);
  const h=d.getHours();a.cond={ft:m.hourly.wave_height[h],per:m.hourly.swell_wave_period[h],wind:w.hourly.wind_speed_10m[h],tide:+t.predictions[h].v};await putS(a)}catch(e){}}
function renderSpots(){$('#fcSpot').innerHTML=spots.map((s,i)=>`<option value="${i}">${s[0]}</option>`).join('');$('#spT tbody').innerHTML=spots.map((s,i)=>`<tr><td>${s[0]}</td><td>${s[1].toFixed(4)}</td><td>${s[2].toFixed(4)}</td><td><button class="btn sec" data-rm="${i}" style="padding:4px 8px">✕</button></td></tr>`).join('')}
// ---------- wiring ----------
function show(t){document.querySelectorAll('section').forEach(s=>s.classList.toggle('on',s.id==='t-'+t));document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('on',b.dataset.t===t));if(t==='fc'&&!$('#fcT tbody').innerHTML){forecast();overview()}if(map)setTimeout(()=>map.invalidateSize(),50)}
document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>show(b.dataset.t));
$('#go').onclick=()=>watch==null?startLive():stopLive();
$('#file').onchange=e=>importFiles([...e.target.files]);
const dz=$('#drop');['dragenter','dragover'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.add('hov')}));['dragleave','drop'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.remove('hov')}));dz.addEventListener('drop',e=>importFiles([...e.dataTransfer.files]));
document.addEventListener('dragover',e=>e.preventDefault());document.addEventListener('drop',e=>{e.preventDefault();if(!dz.contains(e.target))importFiles([...e.dataTransfer.files])});
if('launchQueue'in window)launchQueue.setConsumer(async p=>importFiles(await Promise.all(p.files.map(h=>h.getFile()))));
$('#latest').onclick=e=>{const c=e.target.closest('[data-id]');c&&openS(c.dataset.id)};$('#hdr').onclick=()=>show('log');
$('#logT tbody').onclick=e=>{const r=e.target.closest('tr[data-id]');r&&openS(r.dataset.id)};
$('#fcSpot').onchange=forecast;$('#ovT tbody').onclick=e=>{const f=e.target.dataset.f;if(f!=null){const n=spots[f][0];let F=favs();F=F.includes(n)?F.filter(x=>x!==n):[...F,n];localStorage.favs=JSON.stringify(F);overview();return}const r=e.target.closest('tr[data-i]');if(r){$('#fcSpot').value=r.dataset.i;forecast();$('#fcNow').scrollIntoView({behavior:'smooth'})}};
$('#spT tbody').onclick=e=>{const i=e.target.dataset.rm;if(i!=null&&confirm('Remove '+spots[i][0]+'?')){spots.splice(i,1);saveSpots();renderSpots()}};
$('#nsAdd').onclick=()=>{const n=$('#nsN').value.trim(),a=+$('#nsLa').value,o=+$('#nsLo').value;if(!n||!isFinite(a)||!isFinite(o)||!a)return alert('Name, lat, lon');spots.push([n,a,o]);saveSpots();renderSpots()};
$('#nsHere').onclick=()=>navigator.geolocation.getCurrentPosition(p=>{$('#nsLa').value=p.coords.latitude.toFixed(5);$('#nsLo').value=p.coords.longitude.toFixed(5)});
if(localStorage.liveBackup&&localStorage.liveBackup.length>5){live=JSON.parse(localStorage.liveBackup);const a=analyze(live);if(a&&confirm('Recover unfinished session?')){a.id='s'+a.start;a.src='live (recovered)';putS(a).then(render)}localStorage.removeItem('liveBackup')}
if('serviceWorker'in navigator){navigator.serviceWorker.register('sw.js').then(reg=>{const toast=()=>{$('#toast').classList.add('on')};if(reg.waiting&&navigator.serviceWorker.controller)toast();reg.onupdatefound=()=>{const w=reg.installing;w&&w.addEventListener('statechange',()=>{if(w.state==='installed'&&navigator.serviceWorker.controller)toast()})};document.addEventListener('visibilitychange',()=>{if(!document.hidden)reg.update()});setInterval(()=>reg.update(),30*60e3)});
  $('#toast').onclick=()=>location.reload()}
// one-time sample session (only when the log is empty; never touches user sessions)
async function seedSample(){if(localStorage.sampleSeeded)return;const ex=await allS();if(ex.length){localStorage.sampleSeeded=1;return}
  try{const txt=await fetch('sample_beacons.gpx').then(r=>r.text());const a=analyze(parseXML(txt));if(!a)return;
    a.id='s'+a.start;a.spot='Beacons';a.sample=true;a.src='Sample session – delete anytime';
    a.cond={pills:['Fair','Surf 1–2 ft (thigh–stomach)','Wind 4 kts W, gusts 5','Tide 3.6 ft rising (4.3 ft high 3:24 AM)','Water 72°F','Air 75°F','1mm wetsuit']};
    await putS(a);localStorage.sampleSeeded=1}catch(e){}}
seedSample().then(render);
