import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js';
import { feature as topoFeature } from 'https://cdn.jsdelivr.net/npm/topojson-client@3/+esm';
import * as d3geo from 'https://cdn.jsdelivr.net/npm/d3-geo@3/+esm';

const FILE_URL = '/public/india_subdivisions.topo.json'; // Use .json for either TopoJSON or GeoJSON

const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
let camera; // Orthographic camera, created in onResize()
const mapGroup = new THREE.Group();
scene.add(mapGroup);

let geojson = null; // FeatureCollection

// Auto-detect TopoJSON vs GeoJSON and return a GeoJSON FeatureCollection
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
    props['SUB-DIV'] ||
    props.MET_SUBDIV ||
    props.DIVISION ||
    props.NAME_1 ||
    props.NAME ||
    props.name ||
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

function makeTextSprite(text) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const fontSize = 16;
  ctx.font = `${fontSize}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
  const pad = 4;
  const metrics = ctx.measureText(text);
  canvas.width = Math.ceil(metrics.width) + pad * 2;
  canvas.height = fontSize + pad * 2 + 2;
  const ctx2 = canvas.getContext('2d');
  ctx2.font = ctx.font;
  ctx2.fillStyle = 'rgba(0,0,0,0.55)';
  ctx2.fillRect(0, 0, canvas.width, canvas.height);
  ctx2.fillStyle = '#e9eef6';
  ctx2.textBaseline = 'top';
  ctx2.fillText(text, pad, pad);


  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true });
  const spr = new THREE.Sprite(mat);
  const scale = 0.8;
  spr.scale.set(canvas.width * scale, canvas.height * scale, 1);
  return spr;
}

function chooseProjection(geo, w, h) {
  // Try to detect lon/lat vs planar coordinates
  const [[minX, minY], [maxX, maxY]] = d3geo.geoBounds(geo);
  const isLonLat =
    isFinite(minX) && isFinite(minY) &&
    Math.abs(minX) <= 180 && Math.abs(maxX) <= 180 &&
    Math.abs(minY) <= 90 && Math.abs(maxY) <= 90;

  if (isLonLat) {
    const proj = d3geo.geoMercator();
    proj.fitSize([w, h], geo);
    return proj;
  } else {
    // Your data is likely in meters (e.g., UTM) or another planar CRS.
    // Use an identity projection that treats coords as planar and fits them to the viewport.
    const proj = d3geo.geoIdentity().reflectY(true); // .reflectY(true) if you see an upside-down map
    proj.fitSize([w, h], geo);
    return proj;
  }
}

function rebuildMap() {
  if (!geojson) return;
  const { innerWidth: w, innerHeight: h } = window;
  const projection = chooseProjection(geojson, w, h);

  const outlineGeom = buildOutlineGeometry(geojson, projection, w, h);
  const outlineMesh = makeOutlineMesh(outlineGeom);
  const labels = makeLabelSprites(geojson, projection, w, h);

  mapGroup.clear();
  mapGroup.add(outlineMesh);
  mapGroup.add(labels);
}

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

  rebuildMap();
  renderer.render(scene, camera);
}

(async function init() {
  try {
    geojson = await loadBoundaries(FILE_URL);
  } catch (err) {
    console.error(err);
    const hud = document.getElementById('hud');
    hud.innerHTML = 'Failed to load <code>' + FILE_URL + '</code>. Make sure a dev server is running and the file exists.';
    return;
  }
  window.addEventListener('resize', onResize);
  onResize();
})();