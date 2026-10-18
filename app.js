'use strict';
const $=s=>document.querySelector(s),R=6371000,MPH=2.23694;
const DEF_SPOTS=[["Tamarack",33.1494,-117.3487],["Terramar",33.1290,-117.3361],["Ponto",33.0868,-117.3123],["Oceanside Pier",33.1934,-117.3866],["Swami's",33.0346,-117.2945],["Cardiff Reef",33.0136,-117.2829]];
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
async function importFiles(files){const msg=[];for(const f of files){try{let pts;if(/\.fit$/i.test(f.name))pts=parseFIT(await f.arrayBuffer());else pts=parseXML(await f.text());const a=analyze(pts);if(!a)throw Error('no GPS points');a.id='s'+a.start;a.src=f.name;await putS(a);msg.push(`✓ ${f.name}: ${a.count} waves at ${a.spot}`)}catch(e){msg.push(`✗ ${f.name}: ${e.message}`)}}
  $('#impMsg').innerHTML=msg.map(m=>`<div class="mu">${m}</div>`).join('');render();}
// ---------- live tracking ----------
let watch=null,live=[],wl=null,tick=null;
async function startLive(){if(!navigator.geolocation)return alert('No GPS');live=[];try{wl=await navigator.wakeLock?.request('screen')}catch(e){}
  watch=navigator.geolocation.watchPosition(p=>{if(p.coords.accuracy>30)return;live.push({lat:p.coords.latitude,lon:p.coords.longitude,t:p.timestamp});if(live.length===1)$('#spotNow').textContent='Spot: '+nearestSpot(live[0]);liveUpdate()},e=>$('#spotNow').textContent='GPS: '+e.message,{enableHighAccuracy:true,maximumAge:0,timeout:20000});
  tick=setInterval(liveUpdate,1000);$('#go').textContent='End session';localStorage.liveBackup='[]'}
function liveUpdate(){const a=analyze(live.slice());if(!a)return;$('#lw').textContent=a.count;$('#lt').textContent=fmtD(a.dur);$('#ls').textContent=(a.top*MPH).toFixed(1);$('#ld').textContent=(a.total/1609).toFixed(2);if(live.length%20===0)localStorage.liveBackup=JSON.stringify(live)}
async function stopLive(){navigator.geolocation.clearWatch(watch);clearInterval(tick);wl&&wl.release();watch=null;$('#go').textContent='Start session';const a=analyze(live);if(a){a.id='s'+a.start;a.src='live';await putS(a);render();show('log');openS(a.id)}localStorage.removeItem('liveBackup')}
// ---------- render ----------
const fmtD=s=>{s=Math.round(s);const h=Math.floor(s/3600),m=Math.floor(s%3600/60);return h?`${h}:${String(m).padStart(2,'0')}h`:`${m}:${String(s%60).padStart(2,'0')}`};
const dstr=t=>new Date(t).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'});
let S=[];
async function render(){S=(await allS()).sort((a,b)=>b.start-a.start);$('#hdr').textContent=S.length+' sessions';
  $('#logT tbody').innerHTML=S.map(s=>`<tr class="clk" data-id="${s.id}"><td data-v="${s.start}">${dstr(s.start)}</td><td>${s.spot}</td><td>${s.count}</td><td>${(s.top*MPH).toFixed(1)}</td><td>${Math.round(s.longest)}</td><td data-v="${s.dur}">${fmtD(s.dur)}</td></tr>`).join('')||'<tr><td colspan=6 class="mu">No sessions yet — track one or import a file.</td></tr>';
  const mx=(f)=>S.reduce((b,s)=>f(s)>f(b||s)?s:(b||s),null);const pb=[['Most waves',s=>s.count,v=>v],['Top speed',s=>s.top,v=>(v*MPH).toFixed(1)+' mph'],['Longest wave',s=>s.longest,v=>Math.round(v)+' m'],['Longest ride time',s=>s.longestDur||0,v=>Math.round(v)+' s'],['Longest session',s=>s.dur,fmtD],['Most distance',s=>s.total,v=>(v/1609).toFixed(2)+' mi']];
  $('#pb').innerHTML=S.length?pb.map(([l,f,fm])=>{const b=mx(f);return`<div class="st"><div class="v">${fm(f(b))}</div><div class="l">${l}</div><div class="mu">${dstr(b.start)} · ${b.spot}</div></div>`}).join('')+`<div class="st"><div class="v">${S.reduce((a,s)=>a+s.count,0)}</div><div class="l">Career waves</div></div><div class="st"><div class="v">${(S.reduce((a,s)=>a+s.dur,0)/3600).toFixed(1)}</div><div class="l">Hours in water</div></div>`:'<span class="mu">No sessions yet</span>';
  const grp=(k)=>{const g={};S.forEach(s=>{const key=k(s);(g[key]=g[key]||[]).push(s)});return Object.entries(g).map(([k,a])=>`<tr><td>${k}</td><td>${a.length}</td><td>${a.reduce((x,s)=>x+s.count,0)}</td><td>${(a.reduce((x,s)=>x+s.dur,0)/3600).toFixed(1)}</td><td>${(Math.max(...a.map(s=>s.top))*MPH).toFixed(1)}</td></tr>`).join('')};
  $('#monT tbody').innerHTML=grp(s=>new Date(s.start).toISOString().slice(0,7));$('#spotT tbody').innerHTML=grp(s=>s.spot);renderSpots()}
let map=null,rep=null;
function openS(id){const s=S.find(x=>x.id===id);if(!s)return;const P=s.pts.map(p=>[p[1],p[2]]);
  $('#detail').innerHTML=`<div class="card"><h3>${s.spot} · ${dstr(s.start)}</h3><div class="mu">${new Date(s.start).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})} · source: ${s.src}</div>
  <div class="grid" style="margin-top:8px">${[['Waves',s.count],['Top speed',(s.top*MPH).toFixed(1)+' mph'],['Longest wave',Math.round(s.longest)+' m'],['Time in water',fmtD(s.dur)],['Wave distance',(s.waveDist/1609).toFixed(2)+' mi'],['Paddle distance',(s.paddle/1609).toFixed(2)+' mi']].map(([l,v])=>`<div class="st"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('')}</div>
  <div id="map" class="map"></div><button class="btn sec" id="replay">▶ Replay</button> <button class="btn sec" id="shImg">Share image</button> <button class="btn sec" id="shGpx">Export GPX</button> <button class="btn sec" id="del">Delete</button>
  <h3 style="margin-top:12px">Wave by wave</h3><table id="wvT"><thead><tr><th>#</th><th>Time</th><th>Dist m</th><th>Secs</th><th>Top mph</th></tr></thead><tbody>${s.waves.map((w,i)=>`<tr class="clk" data-w="${i}"><td>${i+1}</td><td data-v="${w.t}">${new Date(w.t).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}</td><td>${Math.round(w.dist)}</td><td>${Math.round(w.dur)}</td><td>${(w.top*MPH).toFixed(1)}</td></tr>`).join('')}</tbody></table></div>`;
  if(map)map.remove();map=L.map('map',{zoomControl:false});L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'}).addTo(map);
  L.polyline(P,{color:'#6c8aa6',weight:2,opacity:.7}).addTo(map);const wl=s.waves.map((w,i)=>L.polyline(P.slice(w.a,w.b+1),{color:'#2ee6d6',weight:5}).bindTooltip('Wave '+(i+1)).addTo(map));map.fitBounds(P,{padding:[20,20]});
  $('#wvT tbody').onclick=e=>{const r=e.target.closest('tr');if(!r)return;const l=wl[r.dataset.w];map.fitBounds(l.getBounds(),{padding:[40,40]});l.setStyle({color:'#ffd23f'});setTimeout(()=>l.setStyle({color:'#2ee6d6'}),1500)};
  $('#replay').onclick=()=>{clearInterval(rep);const m=L.circleMarker(P[0],{radius:7,color:'#fff',fillColor:'#ff5d73',fillOpacity:1}).addTo(map);let i=0;const step=Math.max(1,Math.floor(P.length/400));rep=setInterval(()=>{i+=step;if(i>=P.length){clearInterval(rep);setTimeout(()=>m.remove(),800);return}m.setLatLng(P[i])},25)};
  $('#shGpx').onclick=()=>shareFile(new Blob([toGPX(s)],{type:'application/gpx+xml'}),`session-${new Date(s.start).toISOString().slice(0,10)}.gpx`);
  $('#shImg').onclick=()=>shareImg(s);$('#del').onclick=async()=>{if(confirm('Delete session?')){await delS(s.id);$('#detail').innerHTML='';render()}};
  $('#detail').scrollIntoView({behavior:'smooth'})}
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
async function forecast(){const s=spots[+$('#fcSpot').value]||spots[0];$('#fcNow').textContent='Loading…';
  try{const[m,w]=await Promise.all([fetch(`https://marine-api.open-meteo.com/v1/marine?latitude=${s[1]}&longitude=${s[2]}&hourly=wave_height,swell_wave_height,swell_wave_period,swell_wave_direction,sea_surface_temperature&length_unit=imperial&timezone=America%2FLos_Angeles&forecast_days=3`).then(r=>r.json()),
    fetch(`https://api.open-meteo.com/v1/forecast?latitude=${s[1]}&longitude=${s[2]}&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=mph&timezone=America%2FLos_Angeles&forecast_days=3`).then(r=>r.json())]);
    const H=m.hourly,W=w.hourly,now=new Date(),ni=Math.max(0,H.time.findIndex(t=>new Date(t)>now)-1);
    $('#fcNowCard').innerHTML=[['Surf ft',H.wave_height[ni]?.toFixed(1)],['Swell',`${H.swell_wave_height[ni]?.toFixed(1)}ft ${Math.round(H.swell_wave_period[ni])}s`],['Swell dir',cmp(H.swell_wave_direction[ni])+' '+Math.round(H.swell_wave_direction[ni])+'°'],['Wind',`${Math.round(W.wind_speed_10m[ni])} mph ${cmp(W.wind_direction_10m[ni])}`],['Water °F',H.sea_surface_temperature[ni]!=null?Math.round(H.sea_surface_temperature[ni]*9/5+32):'–']].map(([l,v])=>`<div class="st"><div class="v" style="font-size:20px">${v}</div><div class="l">${l}</div></div>`).join('');
    $('#fcT tbody').innerHTML=H.time.map((t,i)=>i%3||i<ni?'':`<tr><td data-v="${i}">${new Date(t).toLocaleString([], {weekday:'short',hour:'numeric'})}</td><td>${H.swell_wave_height[i]?.toFixed(1)}</td><td>${Math.round(H.swell_wave_period[i])}</td><td data-v="${H.swell_wave_direction[i]}">${cmp(H.swell_wave_direction[i])}</td><td>${Math.round(W.wind_speed_10m[i])}</td><td data-v="${W.wind_direction_10m[i]}">${cmp(W.wind_direction_10m[i])}</td></tr>`).join('');$('#fcNow').textContent=s[0]+' · Open-Meteo'}catch(e){$('#fcNow').textContent='Forecast unavailable: '+e.message}
  try{const d=new Date(),f=x=>x.toISOString().slice(0,10).replace(/-/g,'');const e=new Date(+d+3*864e5);const t=await fetch(`https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&application=swelllog&begin_date=${f(d)}&end_date=${f(e)}&datum=MLLW&station=9410230&time_zone=lst_ldt&units=english&interval=hilo&format=json`).then(r=>r.json());
    $('#tideT tbody').innerHTML=t.predictions.map(p=>`<tr><td>${new Date(p.t.replace(' ','T')).toLocaleString([], {weekday:'short',hour:'numeric',minute:'2-digit'})}</td><td>${p.type==='H'?'High':'Low'}</td><td>${(+p.v).toFixed(1)} ft</td></tr>`).join('')}catch(e){$('#tideT tbody').innerHTML='<tr><td>Tides unavailable</td></tr>'}}
function renderSpots(){$('#fcSpot').innerHTML=spots.map((s,i)=>`<option value="${i}">${s[0]}</option>`).join('');$('#spT tbody').innerHTML=spots.map((s,i)=>`<tr><td>${s[0]}</td><td>${s[1].toFixed(4)}</td><td>${s[2].toFixed(4)}</td><td><button class="btn sec" data-rm="${i}" style="padding:4px 8px">✕</button></td></tr>`).join('')}
// ---------- wiring ----------
function show(t){document.querySelectorAll('section').forEach(s=>s.classList.toggle('on',s.id==='t-'+t));document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('on',b.dataset.t===t));if(t==='fc'&&!$('#fcT tbody').innerHTML)forecast();if(map)setTimeout(()=>map.invalidateSize(),50)}
document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>show(b.dataset.t));
$('#go').onclick=()=>watch==null?startLive():stopLive();
$('#file').onchange=e=>importFiles([...e.target.files]);
const dz=$('#drop');['dragenter','dragover'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.add('hov')}));['dragleave','drop'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.remove('hov')}));dz.addEventListener('drop',e=>importFiles([...e.dataTransfer.files]));
document.addEventListener('dragover',e=>e.preventDefault());document.addEventListener('drop',e=>{e.preventDefault();if(!dz.contains(e.target))importFiles([...e.dataTransfer.files])});
if('launchQueue'in window)launchQueue.setConsumer(async p=>importFiles(await Promise.all(p.files.map(h=>h.getFile()))));
$('#logT tbody').onclick=e=>{const r=e.target.closest('tr[data-id]');r&&openS(r.dataset.id)};
$('#fcSpot').onchange=forecast;
$('#spT tbody').onclick=e=>{const i=e.target.dataset.rm;if(i!=null&&confirm('Remove '+spots[i][0]+'?')){spots.splice(i,1);saveSpots();renderSpots()}};
$('#nsAdd').onclick=()=>{const n=$('#nsN').value.trim(),a=+$('#nsLa').value,o=+$('#nsLo').value;if(!n||!isFinite(a)||!isFinite(o)||!a)return alert('Name, lat, lon');spots.push([n,a,o]);saveSpots();renderSpots()};
$('#nsHere').onclick=()=>navigator.geolocation.getCurrentPosition(p=>{$('#nsLa').value=p.coords.latitude.toFixed(5);$('#nsLo').value=p.coords.longitude.toFixed(5)});
if(localStorage.liveBackup&&localStorage.liveBackup.length>5){live=JSON.parse(localStorage.liveBackup);const a=analyze(live);if(a&&confirm('Recover unfinished session?')){a.id='s'+a.start;a.src='live (recovered)';putS(a).then(render)}localStorage.removeItem('liveBackup')}
if('serviceWorker'in navigator)navigator.serviceWorker.register('sw.js');
render();
