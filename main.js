import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js';
import { feature as topoFeature } from 'https://cdn.jsdelivr.net/npm/topojson-client@3/+esm';
import * as d3geo from 'https://cdn.jsdelivr.net/npm/d3-geo@3/+esm';

const FILE_URL = './india_subdivisions.topo.json';
const CSV_URL  = '/RainfallDataClean.csv';

const MONTHS   = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
const YEAR_COL = "YEAR";

const app = document.getElementById('app') || document.body;
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setClearColor(0x0b0b0b, 1);
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
app.appendChild(renderer.domElement);

const scene    = new THREE.Scene();
let camera;                            // Orthographic, created in onResize()
const mapGroup = new THREE.Group();    // your outlines + labels
scene.add(mapGroup);

// NEW: root for all ferns (drawn above map)
const fernsRoot = new THREE.Group();
fernsRoot.position.z = 1;              // labels use depthTest=false; z=1 keeps order clear
scene.add(fernsRoot);

// DATA STATE
let geojson = null;
let currentProjection = null;          // keep the projection we used last rebuild
let anchors = new Map();               // subdivision -> THREE.Vector3 (screen/world coords)

// Rain data state
let dataBySubdivision = new Map();     // name -> [{YEAR, JAN..DEC}, sorted]
let subdivisionList   = [];            // stable order
let yearList          = [];            // sorted union of all years

let fernMeshes = [];                   // THREE.Points per subdivision
let monthIndex = 0, yearIndex = 0;
let tickMs = 1200;
let lastTime = 0;

// Normalize subdivision names so CSV <-> topo keys match.
const norm = s => (s ?? "")
  .toLowerCase()
  .replace(/\s+/g, " ")        // collapse spaces
  .replace(/[^\w& ]/g, "")     // drop punctuation except &
  .trim();

const NAME_ALIASES = {
  [norm("Andaman & Nicobar Islands")]: norm("1"),
  [norm("Arunachal Pradesh")]: norm("2"),
  [norm("Assam & Meghalaya")]: norm("3"),
  [norm("Naga Mani Mizo Tripura")]: norm("4"),
  [norm("Sub Himalayan West Bengal & Sikkim")]: norm("5"),
  [norm("Gangetic West Bengal")]: norm("6"),
  [norm("Orissa")]: norm("7"),
  [norm("Jharkhand")]: norm("8"),
  [norm("Bihar")]: norm("9"),
  [norm("East Uttar Pradesh")]: norm("10"),
  [norm("West Uttar Pradesh")]: norm("11"),
  [norm("Uttarakhand")]: norm("12"),
  [norm("Haryana Delhi & Chandigarh")]: norm("13"),
  [norm("Punjab")]: norm("14"),
  [norm("Himachal Pradesh")]: norm("15"),
  [norm("Jammu & Kashmir")]: norm("16"),
  [norm("West Rajasthan")]: norm("17"),
  [norm("East Rajasthan")]: norm("18"),
  [norm("West Madhya Pradesh")]: norm("19"),
  [norm("East Madhya Pradesh")]: norm("20"),
  [norm("Gujarat Region")]: norm("21"),
  [norm("Saurashtra & Kutch")]: norm("22"),
  [norm("Konkan & Goa")]: norm("23"),
  [norm("Madhya Maharashtra")]: norm("24"),
  [norm("Matathwada")]: norm("25"),
  [norm("Vidarbha")]: norm("26"),
  [norm("Chhattisgarh")]: norm("27"),
  [norm("Coastal Andhra Pradesh")]: norm("28"),
  [norm("Telangana")]: norm("29"),
  [norm("Rayalseema")]: norm("30"),
  [norm("Tamil Nadu")]: norm("31"),
  [norm("Coastal Karnataka")]: norm("32"),
  [norm("North Interior Karnataka")]: norm("33"),
  [norm("South Interior Karnataka")]: norm("34"),
  [norm("Kerala")]: norm("35"),
  [norm("Lakshadweep")]: norm("36")
};

const ANCHOR_OVERRIDES = {
  
};

// Build a normalized override map once
const overrideMap = new Map(
  Object.entries(ANCHOR_OVERRIDES).map(([k, v]) => [norm(k), v])
);

// Per-subdivision (normalized key) scale overrides
const scaleBySubdivision = new Map();
const DEFAULT_SCALE = 0.25;

// Build reverse alias: topoKey -> csvKey (both normalized)
const REVERSE_ALIASES = Object.fromEntries(
  Object.entries(NAME_ALIASES).map(([csvKey, topoKey]) => [topoKey, csvKey])
);

// -------------- LOADERS --------------
async function loadBoundaries(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('Failed to load ' + url + ' (' + resp.status + ')');
  const data = await resp.json();
  if (data.type === 'Topology') {
    const objName = Object.keys(data.objects)[0];
    return topoFeature(data, data.objects[objName]);
  }
  if (data.type === 'FeatureCollection') return data;
  throw new Error('Unrecognized data type: ' + data.type);
}

async function loadCSVRows(url) {
  const text = await (await fetch(url)).text();
  // tiny CSV parser (no external dep): split lines + headers
  const lines = text.split(/\r?\n/).filter(Boolean);
  const headers = lines[0].split(',').map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = splitCSVLine(lines[i]);
    if (parts.length !== headers.length) continue;
    const obj = {};
    for (let j = 0; j < headers.length; j++) obj[headers[j]] = parts[j];
    rows.push(obj);
  }
  return rows;
}
// handles simple CSV (no embedded quotes/commas). Replace with Papa if needed.
function splitCSVLine(line) { return line.split(',').map(v => v.trim()); }

// -------------- MAP BUILD --------------
function buildOutlineGeometry(geo, projection, width, height) {
  const verts = [];
  function project(lonlat) {
    const [x, y] = projection(lonlat);
    return { x: x - width / 2, y: -y + height / 2 };
  }
  function addRing(ring) {
    if (!ring || ring.length < 2) return;
    const first = project(ring[0]);
    let prev = first;
    for (let i = 1; i < ring.length; i++) {
      const p = project(ring[i]);
      verts.push(prev.x, prev.y, 0, p.x, p.y, 0);
      prev = p;
    }
    verts.push(prev.x, prev.y, 0, first.x, first.y, 0); // close
  }
  for (const f of geo.features) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === 'Polygon') {
      for (const ring of g.coordinates) addRing(ring);
    } else if (g.type === 'MultiPolygon') {
      for (const poly of g.coordinates) for (const ring of poly) addRing(ring);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(verts), 3));
  return geometry;
}

function makeOutlineMesh(geometry) {
  const material = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 });
  return new THREE.LineSegments(geometry, material);
}

function getName(props = {}) {
  return (
    props.SUBDIVISION ||
    props['SUB-DIV']   ||
    props.MET_SUBDIV   ||
    props.DIVISION     ||
    props.NAME_1       ||
    props.NAME         ||
    props.name         ||
    props.subdivisio   ||   
    ''
  );
}

function makeLabelSprites(geo, projection, width, height) {
  const labels = new THREE.Group();
  const path = d3geo.geoPath(projection);
  for (const f of geo.features) {
    const name = getName(f.properties);
    if (!name) continue;
    const [cx, cy] = path.centroid(f);
    const pos = new THREE.Vector3(cx - width / 2, -cy + height / 2, 0);
    const sprite = makeTextSprite(name);
    sprite.position.copy(pos);
    labels.add(sprite);
  }
  return labels;
}

function makeTextSprite(text, { fontSize = 14, pad = 4 } = {}) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2); // keep it sane

  // First pass: measure at CSS pixels
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = `${fontSize}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
  const wCss = Math.ceil(measure.measureText(text).width) + pad * 2;
  const hCss = fontSize + pad * 2 + 2;

  // Real canvas at DPR resolution
  const canvas = document.createElement('canvas');
  canvas.width  = Math.max(1, Math.floor(wCss * dpr));
  canvas.height = Math.max(1, Math.floor(hCss * dpr));

  const ctx = canvas.getContext('2d');
  // draw in CSS pixel space by scaling the context
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = measure.font;
  ctx.textBaseline = 'top';

  // background
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, 0, wCss, hCss);

  // text
  ctx.fillStyle = '#e9eef6';
  ctx.fillText(text, pad, pad);

  // texture
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;      // or THREE.NearestFilter for ultra-crisp pixels
  tex.generateMipmaps = false;             // avoid mipmap blurring
  tex.needsUpdate = true;

  const mat = new THREE.SpriteMaterial({
    map: tex,
    depthTest: false,
    depthWrite: false,
    transparent: true
  });

  const spr = new THREE.Sprite(mat);
  // scale in CSS pixels (undo the DPR upscaling)
  spr.scale.set(wCss, hCss, 1);
  return spr;
}

function chooseProjection(geo, w, h) {
  const [[minX, minY], [maxX, maxY]] = d3geo.geoBounds(geo);
  const isLonLat = isFinite(minX) && isFinite(minY) &&
                   Math.abs(minX) <= 180 && Math.abs(maxX) <= 180 &&
                   Math.abs(minY) <= 90  && Math.abs(maxY) <= 90;
  if (isLonLat) {
    const proj = d3geo.geoMercator();
    proj.fitSize([w, h], geo);
    return proj;
  } else {
    const proj = d3geo.geoIdentity().reflectY(true);
    proj.fitSize([w, h], geo);
    return proj;
  }
}

function rebuildMap() {
  if (!geojson) return;
  const { innerWidth: w, innerHeight: h } = window;

  currentProjection = chooseProjection(geojson, w, h);

  const outlineGeom = buildOutlineGeometry(geojson, currentProjection, w, h);
  const outlineMesh = makeOutlineMesh(outlineGeom);
  const labels      = makeLabelSprites(geojson, currentProjection, w, h);

  mapGroup.clear();
  mapGroup.add(outlineMesh);
  mapGroup.add(labels);

  // (Re)build anchors whenever map/projection changes
  rebuildAnchorsFromMap(w, h);
  // If ferns already exist, snap them to updated anchors
  applyAnchorsToFerns();
}

// -------------- ANCHORS FROM MAP --------------
function rebuildAnchorsFromMap(w, h) {
  anchors.clear();

  // Rebuild overrideMap each time (safe)
  const overrideMap = new Map(
    Object.entries(ANCHOR_OVERRIDES).map(([k, v]) => [norm(k), v])
  );

  const path = d3geo.geoPath(currentProjection);
  for (const f of geojson.features) {
    const rawName = getName(f.properties);
    if (!rawName) continue;

    // Topo-normalized key
    let topoKey = norm(rawName);

    // If you alias topo->canonical, apply here (rarely needed)
    if (NAME_ALIASES[topoKey]) topoKey = NAME_ALIASES[topoKey];

    const [cx, cy] = path.centroid(f);
    const pos = new THREE.Vector3(cx - w/2, -cy + h/2, 0);

    // 🔑 Try override by TOPO key, then by CSV key via reverse alias
    const csvKey = REVERSE_ALIASES[topoKey]; // e.g. norm("andaman & nicobar islands")
    const ov = overrideMap.get(topoKey) || (csvKey ? overrideMap.get(csvKey) : undefined);

    if (ov) {
      pos.set(ov.x, ov.y, 0);
      if (ov.scale != null) scaleBySubdivision.set(topoKey, ov.scale);
    }

    anchors.set(topoKey, pos);
  }
}

function anchorFor(name) {
  const key = NAME_ALIASES[norm(name)] ?? norm(name);
  return anchors.get(key) || new THREE.Vector3(0, 0, 0);
}

// -------------- FERNS --------------
function chooseStyle(value) {
  if (!Number.isFinite(value)) return ["#555555", 5000];
  if (value <= 50)   return ["#a56c34", 1000];
  if (value <= 100)  return ["#96ad2f", 2500];
  if (value <= 200)  return ["#3ba84d", 5000];
  if (value <= 300)  return ["#1f6e2c", 6000];
  return ["#325c49", 7500];
}

const IFS = [
  [0.00,  0.00,  0.00,  0.16, 0.00,  0.00, 0.01],
  [0.85,  0.04, -0.04,  0.85, 0.00,  1.60, 0.85],
  [0.20, -0.26,  0.23,  0.22, 0.00,  1.60, 0.07],
  [-0.15, 0.28,  0.26,  0.24, 0.00,  0.44, 0.07]
];

function buildFernGeometryForValue(value) {
  const [hex, numPoints] = chooseStyle(value);
  const color = new THREE.Color(hex);
  const positions = new Float32Array(numPoints * 3);
  const colors    = new Float32Array(numPoints * 3);

  let x = 0, y = 0;
  const SCALE = 34;      // tuned for your ortho/pixel world
  const Y_OFF = -40;

  for (let i = 0; i < numPoints; i++) {
    const r = Math.random();
    let a, b, c, d, e, f;
    if (r < IFS[0][6]) [a, b, c, d, e, f] = IFS[0];
    else if (r < 0.86) [a, b, c, d, e, f] = IFS[1];
    else if (r < 0.93) [a, b, c, d, e, f] = IFS[2];
    else               [a, b, c, d, e, f] = IFS[3];

    const nx = a * x + b * y + e;
    const ny = c * x + d * y + f;
    x = nx; y = ny;

    const base = i * 3;
    positions[base + 0] = x * SCALE;
    positions[base + 1] = y * SCALE + Y_OFF;
    positions[base + 2] = 0;

    colors[base + 0] = color.r;
    colors[base + 1] = color.g;
    colors[base + 2] = color.b;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
  return geometry;
}

function createFernMesh(initialValue, pos, scale = 0.18) {
  const geom = buildFernGeometryForValue(initialValue);
  const mat  = new THREE.PointsMaterial({ vertexColors: true, size: 0.05 });
  const pts  = new THREE.Points(geom, mat);
  pts.position.copy(pos);
  pts.scale.setScalar(scale);
  return pts;
}

function setFernValue(mesh, value) {
  const old = mesh.geometry;
  mesh.geometry = buildFernGeometryForValue(value);
  old.dispose();
}

// Build data + ferns once CSV is ready
function ingestRainRows(rows) {
  const tmp = new Map();
  for (const row of rows) {
    const sub = row["SUBDIVISION"];
    if (!sub) continue;
    if (!tmp.has(sub)) tmp.set(sub, []);
    tmp.get(sub).push(row);
  }
  dataBySubdivision = new Map();
  for (const [sub, arr] of tmp.entries()) {
    arr.sort((a, b) => Number(a[YEAR_COL]) - Number(b[YEAR_COL]));
    dataBySubdivision.set(sub, arr);
  }
  subdivisionList = Array.from(dataBySubdivision.keys()).sort();

  const yearSet = new Set();
  for (const arr of dataBySubdivision.values()) {
    for (const r of arr) {
      const y = Number(r[YEAR_COL]);
      if (Number.isFinite(y)) yearSet.add(y);
    }
  }
  yearList = Array.from(yearSet).sort((a, b) => a - b);

  buildYearSelect();
  buildTimeline();

  buildAllFerns();       // create meshes (uses anchors if map built)
  updateAllFerns();      // set initial month/year values
}

function valueFor(subdivision, y, m) {
  const arr = dataBySubdivision.get(subdivision);
  if (!arr || arr.length === 0) return NaN;
  let row = arr.find(r => Number(r[YEAR_COL]) === y);
  if (!row) {
    // fallback: nearest previous year, else first
    for (let i = arr.length - 1; i >= 0; i--) {
      const ry = Number(arr[i][YEAR_COL]);
      if (ry <= y) { row = arr[i]; break; }
    }
    if (!row) row = arr[0];
  }
  return Number(row[m]);
}

function buildAllFerns() {
  // Clear any existing meshes
  while (fernsRoot.children.length) {
    const c = fernsRoot.children.pop();
    c.geometry?.dispose();
    c.material?.dispose();
  }
  fernMeshes = [];

  let missing = 0;

  for (let i = 0; i < subdivisionList.length; i++) {
    const sub = subdivisionList[i];

    // CSV name -> normalized topo key (Option A uses topo-space anchors)
    const topoKey = NAME_ALIASES[norm(sub)] ?? norm(sub);

    // Current time slice
    const y = yearList[yearIndex] ?? Number(dataBySubdivision.get(sub)?.[0]?.[YEAR_COL]);
    const m = MONTHS[monthIndex];
    const v = valueFor(sub, y, m);

    // Position & scale from anchors/overrides
    const anchor = anchors.get(topoKey);
    const pos    = anchor ? anchor.clone() : new THREE.Vector3(0, 0, 0);
    const sc     = (scaleBySubdivision.get(topoKey) ?? DEFAULT_SCALE);

    if (!anchor) missing++;

    // Build the fern
    const mesh = createFernMesh(v, pos, sc);
    mesh.userData.subdivision = sub;      // original CSV label (nice for UI)
    mesh.userData.key = topoKey;          // normalized topo key (for lookups)
    fernsRoot.add(mesh);
    fernMeshes.push(mesh);
  }

  if (missing) {
    console.warn(`[buildAllFerns] ${missing} ferns missing anchors (likely name mismatch).`);
  }
}

function applyAnchorsToFerns() {
  if (!fernMeshes.length) return;
  for (const mesh of fernMeshes) {
    const key = mesh.userData.key;
    const pos = anchors.get(key);
    if (pos) mesh.position.copy(pos);

    const sc = scaleBySubdivision.get(key);
    if (sc != null) mesh.scale.setScalar(sc);
  }
}

function updateAllFerns() {
  if (!fernMeshes.length) return;
  const y = yearList[yearIndex];
  const m = MONTHS[monthIndex];
  for (let i = 0; i < fernMeshes.length; i++) {
    const sub = subdivisionList[i];
    const mesh = fernMeshes[i];
    const v = valueFor(sub, y, m);
    setFernValue(mesh, v);
  }
}

// -------------- TIME STEPPER --------------
function step(now) {
  if (now - lastTime >= tickMs && yearList.length) {
    lastTime = now;
    monthIndex = (monthIndex + 1) % MONTHS.length;  // keep looping months only
    // DO NOT change yearIndex here
    updateAllFerns();
    updateTimelineIndicator();
  }
}

// -------------- RESIZE / CAMERA --------------
function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);

  const left = -w / 2, right = w / 2, top = h / 2, bottom = -h / 2;
  if (!camera) {
    camera = new THREE.OrthographicCamera(left, right, top, bottom, -1000, 1000);
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
  } else {
    camera.left = left; camera.right = right; camera.top = top; camera.bottom = bottom;
    camera.updateProjectionMatrix();
  }

  rebuildMap();          // also rebuild anchors
  renderer.render(scene, camera);
  updateTimelineIndicator();

}

//-------------TIMELINE AND YEAR SELECT--------------
// --- UI: Year select ---
function buildYearSelect() {
  const sel = document.getElementById('yearSelect');
  if (!sel) return;

  // clear and fill
  sel.innerHTML = '';
  yearList.forEach(y => {
    const opt = document.createElement('option');
    opt.value = String(y);
    opt.textContent = y;
    sel.appendChild(opt);
  });

  // default to last (most recent) year
  yearIndex = Math.max(0, yearList.length - 1);
  sel.value = String(yearList[yearIndex]);

  // on change: update the chosen year (months keep looping)
  sel.addEventListener('change', () => {
    const v = Number(sel.value);
    const idx = yearList.indexOf(v);
    if (idx !== -1) {
      yearIndex = idx;
      updateAllFerns();
      // keep the month where it is; just reflect it on the timeline
      updateTimelineIndicator();
    }
  });
}

// --- UI: Timeline ---
function buildTimeline() {
  const bar    = document.getElementById('timelineBar');
  const labels = document.getElementById('timelineLabels');
  if (!bar || !labels) return;

  // Build 12 segments
  bar.innerHTML = '';
  labels.innerHTML = '';
  MONTHS.forEach((m, i) => {
    const seg = document.createElement('div');
    seg.className = 'timeline-segment';
    seg.style.borderRight = i < MONTHS.length - 1 ? '1px solid rgba(255,255,255,0.25)' : 'none';
    seg.style.background = 'rgba(255,255,255,0.08)';
    seg.style.cursor = 'pointer';
    seg.addEventListener('click', () => {
      monthIndex = i;
      updateAllFerns();
      updateTimelineIndicator();
    });
    bar.appendChild(seg);

    const lab = document.createElement('div');
    lab.textContent = m;
    labels.appendChild(lab);
  });

  updateTimelineIndicator();
}

function updateTimelineIndicator() {
  const container = document.getElementById('timelineContainer');
  const indicator = document.getElementById('timelineIndicator');
  if (!container || !indicator) return;

  const w = container.clientWidth;
  const step = w / MONTHS.length;
  // center the indicator in the active month segment
  const x = step * monthIndex + step / 2;
  indicator.style.left = `${Math.round(x)}px`;
}


// -------------- MAIN --------------
(async function init() {
  try {
    geojson = await loadBoundaries(FILE_URL);
  } catch (err) {
    console.error(err);
    const hud = document.getElementById('hud');
    hud.innerHTML = 'Failed to load <code>' + FILE_URL + '</code>. Make sure a dev server is running and the file exists.';
    return;
  }
  // Load rainfall in parallel
  try {
    const rows = await loadCSVRows(CSV_URL);
    ingestRainRows(rows);
  } catch (e) {
    console.error('CSV load error:', e);
  }

  window.addEventListener('resize', onResize);
  onResize(); // builds map + anchors (and snaps ferns if already present)
  animate();
})();

function animate(now = 0) {
  requestAnimationFrame(animate);
  step(now);
  renderer.render(scene, camera);
}
