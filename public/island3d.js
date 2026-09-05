// 🌊 The office, as a resort over the water.
//
// A Maldivian lagoon drawn with three.js: a boardwalk on stilts across
// turquoise water, one bungalow off it per project with the project's table
// on its deck, a café deck at the end of the boardwalk and a spur of villas
// for the orchestrators. Nothing stands on land. One character per open
// session. A session mid-turn sits at its project's table hammering a
// laptop; one waiting on an answer stands at the café with its question over
// its head; one with nothing to do is at the café too, on a stool or with a
// coffee at the rail, until its next turn starts and it walks back to work.
//
// The orchestrators are the bosses: each one lives in a villa at the end of
// the spur, facing the boardwalk, and every time one of its workers starts a
// turn a line of light flies from the villa's deck to the worker's chair.
// That is the point of the place: reading who tells whom what to do, from
// across the water.
//
// developer.js owns what the resort is made of (the projects, the crowd,
// what each session is doing and the line its bubble says) and hands it over
// in `island.layout(...)`; this module owns how it looks and moves. Nothing
// here talks to the server. It is still `island` to its caller and in its
// file name: the sand went, the contract did not.
//
// Rendered at the display's full resolution with multisampling, soft shadows
// and a bloom pass: the reader asked for the best picture the GPU can draw,
// so this is the one view that assumes a real one. A tab left in the
// background stops drawing altogether, which is where the cost is contained.

import * as THREE from 'three';
import { GLTFLoader } from '/vendor/three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from '/vendor/three/addons/libs/meshopt_decoder.module.js';
import { Water } from '/vendor/three/addons/objects/Water.js';
import { RoundedBoxGeometry } from '/vendor/three/addons/geometries/RoundedBoxGeometry.js';
import { EffectComposer } from '/vendor/three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from '/vendor/three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '/vendor/three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '/vendor/three/addons/postprocessing/OutputPass.js';

// ---- the plan ----------------------------------------------------------
//
// Plan units are metres: a character is a little under two of them tall.
// `x` runs along the boardwalk, `z` towards the reader; the sea is at y = 0
// and every plank is DECK_Y above it. The bungalows hang off the boardwalk
// on piers, alternating sides so the row stays short; the café deck closes
// the boardwalk on the right, and the villas' spur leaves its left end and
// runs out towards the reader.
const PITCH = 7; // one project's stretch of boardwalk; a side's neighbours are two of these apart
const WALK_W = 2.4; // the boardwalk's width, and every pier's
const PIER_END = 4.5; // from the boardwalk's centre line to a bungalow's deck
const DECK_W = 9; // a bungalow's deck, along the boardwalk
const DECK_D = 10; // and away from it
const PIER_U = 2.6; // where along a deck's edge its pier lands: clear of the cabin
const CAFE_W = 18;
const CAFE_D = 16;
const CAFE_GAP = 2; // between the last bungalow's pitch and the café deck
const JETTY_LEN = 26;
const JETTY_GAP = 12; // the spur's distance from the first bungalow's pitch
const DECK_Y = 1.0; // where feet stand: the top of the planks
const WALK = 2.6; // metres a second, a stroll in the heat
const SEAT_DROP = 0.42; // how far a seated character sinks to a chair

// The purchased resort kit is one large scene, but these named objects are
// independent meshes. One copy of each becomes a reusable project bungalow;
// if the file is absent or malformed, palafito() keeps drawing its original
// procedural version below. The deck scale turns its 12 × 28 m footprint
// (including the access pier) into a 9 × 21 m project plot.
const KIT_URL = '/assets/overwater_resort_hut.glb';
const KIT_DECK_SCALE = 0.75;
const KIT_DECK_D = 21.25;
const KIT_ANCHOR_Z = 11.6; // puts the built-in pier's end at the boardwalk edge
const KIT_TABLE = { x: 2.1, z: -1.8 };
const KIT_RAIL_SCALE = 0.75;
const KIT_RAIL_WIDTH = 0.981;
const KIT_RAIL_PITCH = 0.925;
const KIT_WALK_WIDTH = 2.973;
const KIT_PLANK_PITCH = 0.582;

const CAFE_ASSETS = {
  chair: '/assets/resort/cafe/furniture/gallinera_chair_2k_web.glb',
  table: '/assets/resort/cafe/furniture/gallinera_table_2k_web.glb',
  lounge: '/assets/resort/cafe/furniture/outdoor_table_chair_set_01_2k_web.glb',
  stool: '/assets/resort/cafe/stools/bar_chair_round_01_2k_web.glb',
  lantern: '/assets/resort/cafe/lanterns/wooden_lantern_01_2k_web.glb',
  plants: '/assets/resort/cafe/plants/pachira_aquatica_01_lod1_1k_web.glb',
};
// ---- the palette --------------------------------------------------------
//
// The one place the dark theme does not reach, same as the city before it: a
// lagoon has teak and thatch and none of those are theme tokens. The three
// session colours are the sidebar's, so the two views never disagree on what
// a session is doing.
const C = {
  shallows: 0x5fd9d4,
  lagoon: 0x0f8ea3,
  teak: 0xa8794a,
  teakDark: 0x7a5533,
  thatch: 0xb89a5a,
  wall: 0xf4efe4,
  linen: 0xfaf6ee,
  cushion: 0x2f5f7f,
  glass: 0x24485e,
  busy: 0xd97757,
  lit: 0x7fbf7f,
  wait: 0xe0af68,
  crew: 0xb35c3e,
  boss: 0xf3f0ea,
  order: 0xffb070,
  lamp: 0xffd9a0,
};
// A wardrobe: what a session's character is born wearing, picked by hash so
// the same session always looks the same. The shirt is not here — that is
// the mood colour, and it changes with the work.
const SKINS = [0xf6d3b6, 0xe8b48f, 0xc98e63, 0x9e6b45, 0x6f4a30];
const HAIRS = [0x2b1b12, 0x5a3a22, 0xd9a441, 0xb0412e, 0x1a1a1a, 0xe5d3a8, 0x6d3fa0];
const PANTS = [0x2c3e6b, 0x3b3b3b, 0x6b4a2e, 0x2f5f4f, 0x7a2f3f, 0xe9e2d0];

// The hour, as light. `el` is the sun's elevation in degrees (below the
// horizon at night, when the lamps carry the scene), `exposure` the tone
// mapping's, `top`/`horizon` the sky's gradient, and the rest the fill.
const PHASES = {
  night: {
    el: -12,
    az: 200,
    exposure: 0.55,
    sky: 0x1a2440,
    ground: 0x0a0c14,
    fill: 0.35,
    lamps: 1,
    top: 0x060a18,
    horizon: 0x101a30,
  },
  dawn: {
    el: 4,
    az: 100,
    exposure: 0.7,
    sky: 0xffc9a0,
    ground: 0x3a2e28,
    fill: 0.5,
    lamps: 0.5,
    top: 0x5a78b8,
    horizon: 0xffc9a0,
  },
  morning: {
    el: 35,
    az: 120,
    exposure: 0.85,
    sky: 0xbfe0ff,
    ground: 0x6a5a48,
    fill: 0.7,
    lamps: 0,
    top: 0x3f86d8,
    horizon: 0xdff0ff,
  },
  afternoon: {
    el: 55,
    az: 210,
    exposure: 0.9,
    sky: 0xb8dcff,
    ground: 0x6a5a48,
    fill: 0.7,
    lamps: 0,
    top: 0x3a7fd0,
    horizon: 0xd8ecff,
  },
  evening: {
    el: 12,
    az: 265,
    exposure: 0.8,
    sky: 0xffb080,
    ground: 0x3a2e28,
    fill: 0.55,
    lamps: 0.4,
    top: 0x4a6aa8,
    horizon: 0xffb080,
  },
  dusk: {
    el: 0.5,
    az: 280,
    exposure: 0.65,
    sky: 0x8a6aa0,
    ground: 0x1c1826,
    fill: 0.45,
    lamps: 0.9,
    top: 0x2a2a58,
    horizon: 0xc07a70,
  },
};

// Deterministic "random" off a string, so a session's hair does not change
// colour every time the poll re-lays the island.
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const lerp = (a, b, k) => a + (b - a) * k;

// One material per colour, shared: an island is a few thousand meshes in
// thirty colours, and three.js sorts draw calls by material.
const materials = new Map();
function mat(color, extra) {
  if (extra) return new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0, ...extra });
  let m = materials.get(color);
  if (!m) materials.set(color, (m = new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0 })));
  return m;
}
const unitBox = new THREE.BoxGeometry(1, 1, 1);
const roundBoxes = new Map();
function roundBox(w, h, d, r) {
  const key = `${w},${h},${d},${r}`;
  let g = roundBoxes.get(key);
  if (!g) roundBoxes.set(key, (g = new RoundedBoxGeometry(w, h, d, 3, r)));
  return g;
}
function box(w, h, d, color, x = 0, y = 0, z = 0, opts = {}) {
  const m = new THREE.Mesh(opts.round ? roundBox(w, h, d, opts.round) : unitBox, opts.material || mat(color));
  if (!opts.round) m.scale.set(w, h, d);
  m.position.set(x, y, z);
  m.castShadow = opts.shadow !== false;
  m.receiveShadow = true;
  return m;
}
function cyl(rt, rb, h, color, x = 0, y = 0, z = 0, seg = 16, opts = {}) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), opts.material || mat(color));
  m.position.set(x, y, z);
  m.castShadow = opts.shadow !== false;
  m.receiveShadow = true;
  return m;
}

// ---- the character ------------------------------------------------------
//
// Low-poly and rounded rather than blocky: a sphere for a head, capsules for
// the limbs, a rounded box for the torso. Built at the origin facing +z,
// one unit of scale per full-size person. Same rig as the old city's, so the
// walking, typing and sitting animation carried over untouched.
const CAP = (r, h) => new THREE.CapsuleGeometry(r, h, 3, 10);
const HEAD_R = 0.42;
function buildFigure(seed, shirt, scale = 1, opts = {}) {
  const g = new THREE.Group();
  const skin = SKINS[seed % SKINS.length];
  const hair = HAIRS[(seed >> 3) % HAIRS.length];
  const pants = opts.uniform ? 0xf4f1ea : PANTS[(seed >> 6) % PANTS.length];
  const style = (seed >> 9) % 4;
  const shirtMat = mat(shirt, { emissive: shirt, emissiveIntensity: 0.08, roughness: 0.75 });
  const skinMat = mat(skin, { roughness: 0.6 });
  const pantsMat = mat(pants);
  const hairMat = mat(hair, { roughness: 0.9 });

  const legL = new THREE.Group();
  const legR = new THREE.Group();
  for (const [leg, side] of [
    [legL, -1],
    [legR, 1],
  ]) {
    leg.position.set(side * 0.17, 0.82, 0);
    const shin = new THREE.Mesh(CAP(0.13, 0.5), pantsMat);
    shin.position.y = -0.4;
    shin.castShadow = true;
    const shoe = box(0.26, 0.14, 0.38, 0x3a3230, 0, -0.76, 0.06, { round: 0.05 });
    leg.add(shin, shoe);
  }
  const body = new THREE.Mesh(roundBox(0.7, 0.8, 0.42, 0.16), shirtMat);
  body.position.y = 1.22;
  body.castShadow = true;
  const armL = new THREE.Group();
  const armR = new THREE.Group();
  for (const [arm, side] of [
    [armL, -1],
    [armR, 1],
  ]) {
    arm.position.set(side * 0.46, 1.55, 0);
    const sleeve = new THREE.Mesh(CAP(0.11, 0.42), shirtMat);
    sleeve.position.y = -0.3;
    sleeve.castShadow = true;
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 8), skinMat);
    hand.position.y = -0.62;
    arm.add(sleeve, hand);
  }
  const head = new THREE.Group();
  head.position.y = 1.66;
  const face = new THREE.Mesh(new THREE.SphereGeometry(HEAD_R, 18, 14), skinMat);
  face.position.y = HEAD_R;
  face.castShadow = true;
  const eyeMat = mat(0x1a1a1a, { roughness: 0.3 });
  const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), eyeMat);
  const eyeR = eyeL.clone();
  eyeL.position.set(-0.15, HEAD_R + 0.05, HEAD_R * 0.9);
  eyeR.position.set(0.15, HEAD_R + 0.05, HEAD_R * 0.9);
  head.add(face, eyeL, eyeR);
  if (opts.uniform) {
    // The captain's cap: a white crown with a dark peak, and no hair to see.
    head.add(cyl(HEAD_R * 0.95, HEAD_R * 0.9, 0.22, 0xf8f6f0, 0, HEAD_R * 1.75, 0, 20));
    head.add(box(0.5, 0.05, 0.36, 0x1d2a3a, 0, HEAD_R * 1.66, HEAD_R * 0.7, { round: 0.02 }));
    head.add(box(0.14, 0.1, 0.02, 0xd8b45a, 0, HEAD_R * 1.8, HEAD_R * 0.9));
  } else {
    // Four hairdos: a short crop, a quiff, a bob, and a bun.
    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(HEAD_R + 0.04, 18, 14, 0, Math.PI * 2, 0, Math.PI * 0.55),
      hairMat,
    );
    cap.position.y = HEAD_R;
    head.add(cap);
    if (style === 1) head.add(box(0.36, 0.22, 0.3, hair, 0.08, HEAD_R * 2.05, 0.12, { round: 0.08 }));
    if (style === 2) head.add(box(0.8, 0.5, 0.5, hair, 0, HEAD_R * 0.95, -0.2, { round: 0.18 }));
    if (style === 3) {
      const bun = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), hairMat);
      bun.position.set(0, HEAD_R * 1.9, -0.28);
      head.add(bun);
    }
  }
  g.add(legL, legR, body, armL, armR, head);
  g.scale.setScalar(scale);
  return { group: g, parts: { legL, legR, body, armL, armR, head, shirtMat } };
}

// The resort mascot: a small rounded dog assembled from the same inexpensive
// primitives as the people. It only wags and looks around, so adding it does
// not bring another model or animation download into the office.
function buildDog() {
  const g = new THREE.Group();
  const coat = mat(0xb96f3f, { roughness: 0.9 });
  const cream = mat(0xf0d2a5, { roughness: 0.9 });
  const dark = mat(0x2a1d18, { roughness: 0.75 });
  const collar = mat(0x2b9fc4, { emissive: 0x2b9fc4, emissiveIntensity: 0.08, roughness: 0.55 });

  const body = new THREE.Mesh(roundBox(1.18, 0.62, 0.58, 0.24), coat);
  body.position.y = 0.67;
  body.castShadow = true;
  const chest = new THREE.Mesh(new THREE.SphereGeometry(0.3, 14, 10), cream);
  chest.scale.set(0.75, 1, 0.45);
  chest.position.set(0, 0.7, 0.28);

  const head = new THREE.Group();
  head.position.set(0, 0.98, 0.48);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.37, 16, 12), coat);
  skull.castShadow = true;
  const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.23, 14, 10), cream);
  muzzle.scale.set(1, 0.72, 1.15);
  muzzle.position.set(0, -0.08, 0.28);
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.085, 10, 8), dark);
  nose.scale.z = 0.7;
  nose.position.set(0, -0.04, 0.5);
  const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.047, 8, 6), dark);
  const eyeR = eyeL.clone();
  eyeL.position.set(-0.14, 0.08, 0.33);
  eyeR.position.set(0.14, 0.08, 0.33);
  const earGeometry = new THREE.ConeGeometry(0.16, 0.42, 8);
  for (const side of [-1, 1]) {
    const ear = new THREE.Mesh(earGeometry, dark);
    ear.position.set(side * 0.27, 0.13, 0.02);
    ear.rotation.z = side * 0.38;
    ear.castShadow = true;
    head.add(ear);
  }
  const collarBand = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.035, 7, 20), collar);
  collarBand.rotation.x = Math.PI / 2;
  collarBand.position.set(0, -0.24, -0.08);
  head.add(skull, muzzle, nose, eyeL, eyeR, collarBand);

  const legs = [];
  for (const [x, z] of [
    [-0.38, -0.2],
    [0.38, -0.2],
    [-0.38, 0.28],
    [0.38, 0.28],
  ]) {
    const leg = new THREE.Mesh(CAP(0.105, 0.28), coat);
    leg.position.set(x, 0.29, z);
    leg.castShadow = true;
    legs.push(leg);
  }

  const tail = new THREE.Group();
  tail.position.set(0, 0.82, -0.52);
  const tailMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, 0.5, 3, 9), coat);
  tailMesh.position.y = 0.25;
  tailMesh.rotation.x = -0.75;
  tailMesh.castShadow = true;
  tail.add(tailMesh);

  g.add(body, chest, head, ...legs, tail);
  g.scale.setScalar(0.82);
  return { group: g, body, head, tail };
}

// A laptop for the busy: a lid and a base, on the table in front of them.
function buildLaptop() {
  const g = new THREE.Group();
  g.add(box(0.62, 0.03, 0.4, 0x4a4c52, 0, 0, 0, { round: 0.01 }));
  const lid = box(0.62, 0.42, 0.03, 0x4a4c52, 0, 0.22, -0.2, { round: 0.01 });
  lid.rotation.x = -0.25;
  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(0.54, 0.34),
    new THREE.MeshBasicMaterial({ color: 0xbfe6ff }),
  );
  screen.position.set(0, 0.23, -0.175);
  screen.rotation.x = -0.25;
  g.add(lid, screen);
  return g;
}

// A coffee for the café: a small cup a character holds in a hand.
function buildCup() {
  const g = new THREE.Group();
  g.add(cyl(0.09, 0.07, 0.16, 0xf8f6f0, 0, 0.08, 0, 12));
  g.add(cyl(0.075, 0.075, 0.01, 0x4a2c1a, 0, 0.165, 0, 12, { shadow: false }));
  return g;
}

// The megaphone the bosses give orders through.
function buildMegaphone() {
  const g = new THREE.Group();
  const cone = cyl(0.2, 0.07, 0.42, 0xe04a3a, 0, 0, 0, 14);
  cone.rotation.x = Math.PI / 2;
  const grip = cyl(0.04, 0.04, 0.2, 0x333333, 0, -0.12, -0.15, 8);
  g.add(cone, grip);
  return g;
}

// ---- the textures, painted --------------------------------------------
//
// The deck uses Poly Haven's CC0 Wood Floor Deck material from the café asset
// pack. The packed ARM map supplies its roughness; the thatch and water's
// ripples remain small generated, tileable textures.

let plankTexture = null;
let plankNormalTexture = null;
let plankRoughnessTexture = null;
const WOOD_TEXTURE_ROOT = '/assets/resort/cafe/materials/wood_floor_deck/wood_floor_deck_';
function woodTexture(suffix, color = false) {
  const texture = new THREE.TextureLoader().load(`${WOOD_TEXTURE_ROOT}${suffix}_2k.webp`);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  if (color) texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
function planks() {
  return plankTexture || (plankTexture = woodTexture('diff', true));
}
function plankNormals() {
  return plankNormalTexture || (plankNormalTexture = woodTexture('nor_gl'));
}
function plankRoughness() {
  return plankRoughnessTexture || (plankRoughnessTexture = woodTexture('arm'));
}
function plankMaterial(maps = {}) {
  return new THREE.MeshStandardMaterial({
    map: maps.map || planks(),
    normalMap: maps.normalMap || plankNormals(),
    roughnessMap: maps.roughnessMap || plankRoughness(),
    normalScale: new THREE.Vector2(0.45, 0.45),
    roughness: 0.9,
    metalness: 0,
  });
}

let gltfPlankMaps = null;
function gltfPlankMaterial() {
  if (!gltfPlankMaps) {
    const forGltf = (source) => {
      const texture = source.clone();
      // glTF UVs already use the GPU texture origin. TextureLoader defaults
      // to the opposite convention, so maps assigned after GLTFLoader has
      // parsed a model must opt out of Three.js' vertical image flip.
      texture.flipY = false;
      texture.needsUpdate = true;
      return texture;
    };
    gltfPlankMaps = {
      map: forGltf(planks()),
      normalMap: forGltf(plankNormals()),
      roughnessMap: forGltf(plankRoughness()),
    };
  }
  return plankMaterial(gltfPlankMaps);
}

let darkRoofMaterial = null;
function roofMaterial() {
  return (
    darkRoofMaterial ||
    (darkRoofMaterial = new THREE.MeshStandardMaterial({
      color: 0x343b3c,
      roughness: 0.82,
      side: THREE.DoubleSide,
    }))
  );
}

let thatchTexture = null;
function thatch() {
  if (thatchTexture) return thatchTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#b08f52';
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 1800; i++) {
    ctx.strokeStyle = `hsl(${36 + Math.random() * 10} ${40 + Math.random() * 20}% ${30 + Math.random() * 30}%)`;
    ctx.lineWidth = 1 + Math.random();
    const x = Math.random() * 256;
    const y = Math.random() * 256;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (Math.random() - 0.5) * 4, y + 8 + Math.random() * 14);
    ctx.stroke();
  }
  thatchTexture = new THREE.CanvasTexture(c);
  thatchTexture.wrapS = thatchTexture.wrapT = THREE.RepeatWrapping;
  thatchTexture.colorSpace = THREE.SRGBColorSpace;
  thatchTexture.anisotropy = 8;
  return thatchTexture;
}

// A tileable normal map of ripples: a sum of sines over the tile, and its
// gradient packed into a colour. The water addon wants one and the three.js
// package on npm ships none.
function waterNormals() {
  const N = 384;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(N, N);
  const waves = [];
  for (let i = 0; i < 14; i++) {
    const kx = Math.round(rand(-10, 10)) || 1;
    const ky = Math.round(rand(-10, 10)) || 2;
    waves.push({ kx, ky, ph: rand(0, Math.PI * 2), amp: 1 / (1 + Math.hypot(kx, ky) * 0.7) });
  }
  const h = (x, y) => {
    let s = 0;
    for (const w of waves) s += Math.sin(((w.kx * x + w.ky * y) / N) * Math.PI * 2 + w.ph) * w.amp;
    return s;
  };
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = (h(x + 1, y) - h(x - 1, y)) * 2.8;
      const dy = (h(x, y + 1) - h(x, y - 1)) * 2.8;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * N + x) * 4;
      img.data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      img.data[i + 2] = (1 / len) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// The speech bubbles are DOM now (see the overlay); the one sprite left is
// the glow a busy laptop throws and the pulse an order carries, and both are
// a plain additive quad.
let glowTexture = null;
function glow() {
  if (!glowTexture) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    glowTexture = new THREE.CanvasTexture(c);
  }
  return glowTexture;
}

// ---- the island ---------------------------------------------------------

/**
 * Build the island into `host`, an element the canvas fills.
 * `on.session(id)` and `on.project(repo)` are what a click on a character or
 * a table does; `on.tip(id)` renders a hovered character's text. `on.asset()`
 * asks the caller to lay the scene out again when the optional resort kit has
 * finished loading.
 */
export function createIsland(host, on) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;
  renderer.domElement.className = 'office-canvas';
  host.appendChild(renderer.domElement);

  // The DOM riding on the canvas: landmark labels, a bubble over every
  // character saying what it is doing, and the hover tip.
  const overlay = document.createElement('div');
  overlay.className = 'office-overlay';
  host.appendChild(overlay);
  const tip = document.createElement('div');
  tip.className = 'office-tip hidden';
  overlay.appendChild(tip);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 30000); // far enough for the sky
  const hemi = new THREE.HemisphereLight(0xbfe0ff, 0x6a5a48, 0.7);
  const sun = new THREE.DirectionalLight(0xfff2dc, 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 2;
  scene.add(hemi, sun, sun.target);

  // The sky, and the light it throws on everything: a gradient dome, three
  // colours and a sun, drawn huge round the island and baked small to an
  // environment map whenever the hour changes. That bake is what makes a
  // white wall go peach at dusk without a single material knowing the time.
  // A gradient rather than the sky addon's scattering because the bake has
  // to be safe to filter — a NaN anywhere in it is a black island and,
  // through the bloom, a black frame — and the scattering shader is not, at
  // every sun height, on every GPU. Three colours cannot produce one.
  const domeMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      top: { value: new THREE.Color(0x4d8fd6) },
      horizon: { value: new THREE.Color(0xdfeeff) },
      ground: { value: new THREE.Color(0x6a5a48) },
      sunDir: { value: new THREE.Vector3(0, 1, 0) },
      sunColor: { value: new THREE.Color(0xfff0d0) },
    },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 ground; uniform vec3 sunDir; uniform vec3 sunColor; varying vec3 vDir;
      void main(){
        float y = clamp(vDir.y, -1.0, 1.0);
        vec3 c = y >= 0.0 ? mix(horizon, top, pow(y, 0.6)) : mix(horizon, ground, min(1.0, -y * 3.0));
        float s = max(0.0, dot(normalize(vDir), normalize(sunDir)));
        c += sunColor * (pow(s, 400.0) * 6.0 + pow(s, 12.0) * 0.35);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(6000, 48, 24), domeMat);
  sky.frustumCulled = false;
  scene.add(sky);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const domeScene = new THREE.Scene();
  domeScene.add(new THREE.Mesh(new THREE.SphereGeometry(40, 32, 16), domeMat));
  let envTarget = null;
  const sunDir = new THREE.Vector3();
  function bakeSky(el, az, tint) {
    const phi = THREE.MathUtils.degToRad(90 - Math.max(el, -2));
    const theta = THREE.MathUtils.degToRad(az);
    sunDir.setFromSphericalCoords(1, phi, theta);
    const d = domeMat.uniforms;
    d.top.value.set(tint.top);
    d.horizon.value.set(tint.horizon);
    d.ground.value.set(tint.ground);
    d.sunDir.value.copy(sunDir);
    d.sunColor.value.set(el > 0 ? (el < 15 ? 0xffb070 : 0xfff0d0) : 0x000000);
    if (envTarget) envTarget.dispose();
    envTarget = pmrem.fromScene(domeScene, 0.04);
    scene.environment = envTarget.texture;
    if (water) water.material.uniforms.sunDirection.value.copy(sunDir).normalize();
  }

  // The lagoon: the water addon's mirror, tinted turquoise, with layered
  // directional ripples. The translucent sandbank below adds moving caustics
  // near the stilts, where real shallow water is at its liveliest.
  let water = null;
  function buildWater() {
    water = new Water(new THREE.PlaneGeometry(3000, 3000), {
      textureWidth: 1024,
      textureHeight: 1024,
      waterNormals: waterNormals(),
      sunDirection: new THREE.Vector3(0, 1, 0),
      sunColor: 0xffffff,
      waterColor: C.lagoon,
      distortionScale: 3.1,
      fog: false,
    });
    water.rotation.x = -Math.PI / 2;
    water.material.uniforms.size.value = 4.4;
    scene.add(water);
  }
  buildWater();

  // A small procedural soundscape keeps the feature self-contained: filtered
  // noise rises and falls like nearby surf, with a quieter airy band behind
  // it. The AudioContext is created only from the sound button's click so the
  // browser's autoplay policy is always respected.
  let beachAudio = null;
  let beachSoundWanted = false;
  let beachPauseTimer = null;
  function ensureBeachAudio() {
    if (beachAudio) return true;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return false;
    const context = new AudioContext();
    const seconds = 9;
    const buffer = context.createBuffer(1, context.sampleRate * seconds, context.sampleRate);
    const data = buffer.getChannelData(0);
    let brown = 0;
    for (let i = 0; i < data.length; i++) {
      brown = Math.max(-1, Math.min(1, brown * 0.985 + (Math.random() * 2 - 1) * 0.12));
      data[i] = brown;
    }

    const master = context.createGain();
    master.gain.value = 0.0001;
    master.connect(context.destination);

    const surf = context.createBufferSource();
    const surfFilter = context.createBiquadFilter();
    const surfGain = context.createGain();
    surf.buffer = buffer;
    surf.loop = true;
    surfFilter.type = 'lowpass';
    surfFilter.frequency.value = 780;
    surfFilter.Q.value = 0.55;
    surfGain.gain.value = 0.075;
    surf.connect(surfFilter).connect(surfGain).connect(master);

    const swell = context.createOscillator();
    const swellDepth = context.createGain();
    swell.type = 'sine';
    swell.frequency.value = 0.085;
    swellDepth.gain.value = 0.048;
    swell.connect(swellDepth).connect(surfGain.gain);

    const breeze = context.createBufferSource();
    const breezeFilter = context.createBiquadFilter();
    const breezeGain = context.createGain();
    breeze.buffer = buffer;
    breeze.loop = true;
    breeze.playbackRate.value = 0.83;
    breezeFilter.type = 'bandpass';
    breezeFilter.frequency.value = 1650;
    breezeFilter.Q.value = 0.32;
    breezeGain.gain.value = 0.012;
    breeze.connect(breezeFilter).connect(breezeGain).connect(master);

    surf.start();
    breeze.start();
    swell.start();
    beachAudio = { context, master, sources: [surf, breeze, swell] };
    return true;
  }

  function wakeBeachAudio() {
    if (!beachAudio || !beachSoundWanted || !running) return;
    clearTimeout(beachPauseTimer);
    beachPauseTimer = null;
    beachAudio.context
      .resume()
      .then(() => {
        if (!beachSoundWanted || !running) return;
        const now = beachAudio.context.currentTime;
        beachAudio.master.gain.cancelScheduledValues(now);
        beachAudio.master.gain.setTargetAtTime(0.42, now, 0.18);
      })
      .catch(() => {});
  }

  function quietBeachAudio() {
    if (!beachAudio) return;
    clearTimeout(beachPauseTimer);
    const now = beachAudio.context.currentTime;
    beachAudio.master.gain.cancelScheduledValues(now);
    beachAudio.master.gain.setTargetAtTime(0.0001, now, 0.08);
    beachPauseTimer = setTimeout(() => {
      if (beachAudio && (!running || !beachSoundWanted)) beachAudio.context.suspend().catch(() => {});
    }, 450);
  }

  // What is standing: rebuilt whole when the project list changes, kept
  // otherwise. The characters live outside it and persist across layouts,
  // which is what lets them walk.
  let island = null; // { group, homes: Map(repo -> bungalow), cafe, villas, plates, bounds }
  const chars = new Map(); // session id -> character
  const seats = []; // every sittable spot at the café: { x, z, facing, taken, kind }
  const rails = []; // places to stand with a coffee: { x, z, facing }
  let pickables = [];
  let phase = null;
  let light = { ...PHASES.afternoon };
  const lampMats = []; // emissive materials that come on at night
  const nightLights = []; // the point lights under the lamps, off by day
  const orders = []; // lines of light in flight: { mesh, pulse, curve, life, age }
  let dog = null; // the café's resident mascot, rebuilt with the island
  let kit = null; // the four extracted GLB prototypes, once its local load finishes
  let cafeKit = null; // optimized Poly Haven furniture and plants
  let disposed = false;

  // Rebuild the kit's flat author colours with this scene's palette. The GLB
  // has UVs but no image textures, so the same painted teak and thatch used by
  // the fallback geometry can go straight onto its meshes.
  const kitMaterials = new Map();
  function kitMaterial(source) {
    const name = source.name || '';
    let material = kitMaterials.get(name);
    if (material) return material;
    if (name === 'Wood_Brown') {
      material = gltfPlankMaterial();
    } else if (name === 'House_Roof') {
      // The kit's broad round roof becomes visually noisy with straw fibres;
      // its original dark silhouette is calmer against the detailed deck.
      material = roofMaterial();
    } else if (name === 'House_Wall' || name === 'Swimming_Pool_White') {
      material = new THREE.MeshStandardMaterial({ color: C.wall, roughness: 0.82 });
    } else if (name === 'House_Window_Glass') {
      material = new THREE.MeshStandardMaterial({
        color: C.glass,
        metalness: 0.15,
        roughness: 0.12,
        transparent: true,
        opacity: 0.72,
        depthWrite: false,
      });
    } else if (name === 'Swimming_Pool_Cyan') {
      material = new THREE.MeshStandardMaterial({ color: C.shallows, roughness: 0.35 });
    } else if (name === 'Swimming_Pool_Water_Blue') {
      material = new THREE.MeshStandardMaterial({
        color: C.lagoon,
        roughness: 0.08,
        transparent: true,
        opacity: 0.78,
        depthWrite: false,
      });
    } else if (name === 'Beach_Chair_Black') {
      material = new THREE.MeshStandardMaterial({ color: C.teakDark, roughness: 0.8 });
    } else if (name === 'Beach_Chair_Gold') {
      material = gltfPlankMaterial();
    } else if (name === 'Beach_Chair_White') {
      material = new THREE.MeshStandardMaterial({ color: C.linen, roughness: 0.9 });
    } else {
      material = source.clone();
    }
    material.name = name;
    kitMaterials.set(name, material);
    return material;
  }

  // GLTFLoader removes dots from node names so animation paths remain valid:
  // e.g. `Ground.015` in the file becomes `Ground015` here. Reset the
  // resort-wide transforms, leaving a small prototype centred on its own
  // geometry and sharing the source buffers between every project copy.
  function prepareKit(root) {
    // The source asset merged each bungalow's floor, stilts, stairs and rails
    // into one mesh. Ground015's front-right bay is a clean repeating piece,
    // so retain only its triangles above the floor and make that exact rail
    // geometry available to the rest of the resort.
    const extractPart = (source, accepts, offset) => {
      const sourceMesh = source?.isMesh ? source : source?.getObjectByProperty('isMesh', true);
      if (!sourceMesh?.geometry) return null;
      const flat = sourceMesh.geometry.index
        ? sourceMesh.geometry.toNonIndexed()
        : sourceMesh.geometry.clone();
      const positions = flat.getAttribute('position');
      const kept = [];
      for (let i = 0; i < positions.count; i += 3) {
        const triangle = [];
        for (let v = i; v < i + 3; v++) {
          triangle.push([positions.getX(v), positions.getY(v), positions.getZ(v)]);
        }
        if (accepts(triangle)) kept.push(i, i + 1, i + 2);
      }
      if (!kept.length) {
        flat.dispose();
        return null;
      }
      const geometry = new THREE.BufferGeometry();
      for (const [name, attribute] of Object.entries(flat.attributes)) {
        const values = [];
        const read = [attribute.getX, attribute.getY, attribute.getZ, attribute.getW];
        for (const vertex of kept) {
          for (let component = 0; component < attribute.itemSize; component++) {
            values.push(read[component].call(attribute, vertex));
          }
        }
        geometry.setAttribute(name, new THREE.Float32BufferAttribute(values, attribute.itemSize));
      }
      flat.dispose();
      geometry.translate(...offset);
      geometry.computeBoundingSphere();
      const part = new THREE.Mesh(geometry, gltfPlankMaterial());
      part.castShadow = true;
      part.receiveShadow = true;
      return part;
    };

    const ground = root.getObjectByName('Ground015');
    const rail = extractPart(
      ground,
      (triangle) =>
        triangle.some(([, y]) => y > 0.2) &&
        triangle.every(([x, , z]) => x >= 1.3 && x <= 2.31 && z >= 7.15 && z <= 7.28),
      [-1.8065, 0, -7.2175],
    );
    const walkway = extractPart(
      ground,
      (triangle) => triangle.every(([x, y, z]) => Math.abs(x) <= 1.51 && y <= 0.13 && z >= 7.29 && z <= 7.84),
      [0, 0, -7.562],
    );

    const take = (name) => {
      const source = root.getObjectByName(name);
      if (!source) return null;
      const part = source.clone(true);
      part.position.set(0, 0, 0);
      part.quaternion.identity();
      part.scale.set(1, 1, 1);
      part.traverse((o) => {
        if (!o.isMesh) return;
        o.material = Array.isArray(o.material)
          ? o.material.map((m) => kitMaterial(m))
          : kitMaterial(o.material);
        o.castShadow = true;
        o.receiveShadow = true;
      });
      return part;
    };
    const parts = {
      deck: take('Ground015'),
      hut: take('Small_House014'),
      pool: take('Swimming_Pool015'),
      lounger: take('Swimming_Chair062'),
      rail,
      walkway,
    };
    return Object.values(parts).every(Boolean) ? parts : null;
  }

  const kitPart = (name) => kit[name].clone(true);

  function cafePart(name, scale = 1) {
    const part = cafeKit[name].clone(true);
    part.scale.setScalar(scale);
    part.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
    });
    return part;
  }

  const el = (cls, parent) => {
    const e = document.createElement('div');
    e.className = cls;
    parent.appendChild(e);
    return e;
  };

  // ---- building the resort ----

  function buildIsland(projects, counts) {
    if (island) scene.remove(island.group);
    seats.length = 0;
    rails.length = 0;
    lampMats.length = 0;
    nightLights.length = 0;
    overlay.querySelectorAll('.office-plate').forEach((p) => p.remove());
    pickables = [];

    const group = new THREE.Group();
    const homes = new Map();
    const plates = [];
    const n = projects.length;
    const usingKit = !!kit;
    const x0 = -(n * PITCH) / 2; // where the first bungalow's pitch starts
    const jettyX = x0 - JETTY_GAP; // the villas' spur, off the boardwalk's left end
    const cafeX = x0 + n * PITCH + CAFE_GAP + CAFE_W / 2;
    const walkX0 = jettyX - WALK_W / 2; // the boardwalk's two ends
    const walkX1 = cafeX - CAFE_W / 2;

    // ---- the bungalows: one per project, either side of the boardwalk ----
    //
    // Even projects hang off the far side, odd ones off the near, so two
    // neighbours never share a side and the row is half as long as the decks
    // are wide. Each is the same deck, cabin at the back and table out front,
    // the cabin always on the side away from the reader so it never hides
    // who is at the table; only the pier knows which side of the boardwalk
    // it is on.
    const gaps = { near: [jettyX], far: [] }; // where something meets the boardwalk, and its rail stops
    projects.forEach((p, i) => {
      const near = i % 2 === 1;
      const pierV = near ? -1 : 1;
      const xc = x0 + i * PITCH + PITCH / 2;
      const zc = (near ? 1 : -1) * (usingKit ? KIT_ANCHOR_Z : PIER_END + DECK_D / 2);
      const pierX = usingKit ? xc : xc + PIER_U;
      gaps[near ? 'near' : 'far'].push(pierX);
      const b = palafito(pierV);
      b.position.set(xc, 0, zc);
      group.add(b);
      // The table, on the open front of the deck, in world coordinates so a
      // click on it can be found.
      const x = xc + (usingKit ? pierV * KIT_TABLE.x : 0);
      const z = zc + (usingKit ? pierV * KIT_TABLE.z : 2);
      const y = DECK_Y;
      const t = table(i);
      t.position.set(x, y, z);
      t.userData.pick = { kind: 'project', repo: p.repo, top: 3.2 };
      pickables.push(t);
      group.add(t);
      // Four chairs: two with their backs to the cabin facing the reader,
      // one each side.
      const chairs = [
        { dx: -0.9, dz: -1.35, facing: 0 },
        { dx: 0.9, dz: -1.35, facing: 0 },
        { dx: -1.9, dz: 0, facing: Math.PI / 2 },
        { dx: 1.9, dz: 0, facing: -Math.PI / 2 },
      ].map((c) => {
        const ch = chair();
        ch.position.set(x + c.dx, y, z + c.dz);
        ch.rotation.y = c.facing;
        group.add(ch);
        return { x: x + c.dx, z: z + c.dz, facing: c.facing, taken: null, kind: 'work', y };
      });
      // The way off the deck: the pier's deck end (past the cabin's front on
      // the near side, where the pier lands beside it), then the boardwalk.
      const dock = usingKit
        ? [
            { x: pierX, z: zc + pierV * (KIT_ANCHOR_Z - WALK_W / 2) },
            { x: pierX, z: 0 },
          ]
        : [
            { x: pierX, z: near ? zc - 0.5 : zc + DECK_D / 2 - 0.5 },
            { x: pierX, z: 0 },
          ];
      const holds = (q) =>
        Math.abs(q.x - xc) <= DECK_W / 2 + 0.3 &&
        Math.abs(q.z - zc) <= (usingKit ? KIT_DECK_D : DECK_D) / 2 + 0.3;
      homes.set(p.repo, { x, z, y, chairs, dock, holds });
    });

    // ---- the boardwalk: the spine everything hangs off ----
    const walk = new THREE.Group();
    walk.add(board(walkX1 - walkX0, WALK_W, (walkX0 + walkX1) / 2, 0));
    for (let x = walkX0 + 1.3; x < walkX1; x += 2.6) for (const dz of [-1, 1]) post(walk, x, dz);
    railAlong(walk, 'x', -WALK_W / 2, walkX0, walkX1, gaps.far);
    railAlong(walk, 'x', WALK_W / 2, walkX0, walkX1, gaps.near);
    rail(walk, walkX0, -WALK_W / 2, walkX0, WALK_W / 2);
    group.add(walk);

    // ---- the café: the widest deck, at the boardwalk's end, hut at its back ----
    const cafe = {
      x: cafeX,
      z: 0,
      y: DECK_Y,
      hutZ: -3.5,
      dock: [{ x: walkX1 + 0.2, z: 0 }],
      holds: (q) => Math.abs(q.x - cafeX) <= CAFE_W / 2 + 0.3 && Math.abs(q.z) <= CAFE_D / 2 + 0.3,
    };
    const cd = cafeDeck();
    cd.position.set(cafe.x, 0, cafe.z);
    group.add(cd);
    const hut = cafeHut();
    hut.position.set(cafe.x, cafe.y, cafe.hutZ);
    group.add(hut);
    // Stools along the bar's front, facing it; and the rail spots either side.
    for (const dx of [-2.1, -0.7, 0.7, 2.1]) {
      const st = stool();
      st.position.set(cafe.x + dx, cafe.y, cafe.hutZ + 1.6);
      group.add(st);
      seats.push({
        x: cafe.x + dx,
        z: cafe.hutZ + 1.6,
        facing: Math.PI,
        taken: null,
        kind: 'stool',
        y: cafe.y,
      });
    }
    // Two tables outside the café for the ones waiting on a coffee.
    for (const dx of [-4.6, 4.6]) {
      const ct = cafeTable();
      const tz = cafe.hutZ + 3.6;
      ct.position.set(cafe.x + dx, cafe.y, tz);
      group.add(ct);
      for (const [ddx, ddz, facing] of [
        [-0.85, 0, Math.PI / 2],
        [0.85, 0, -Math.PI / 2],
        [0, -0.85, 0],
      ]) {
        const ch = cafeChair();
        ch.position.set(cafe.x + dx + ddx, cafe.y, tz + ddz);
        ch.rotation.y = facing;
        group.add(ch);
        seats.push({ x: cafe.x + dx + ddx, z: tz + ddz, facing, taken: null, kind: 'chair', y: cafe.y });
      }
    }
    // A furnished lounge and tropical greenery fill the quiet rear corners;
    // they are decorative so the café's routes and sittable spots stay clear.
    if (cafeKit) {
      for (const [dx, turn] of [
        [-6.7, Math.PI / 2],
        [6.7, -Math.PI / 2],
      ]) {
        const lounge = cafePart('lounge', 1.25);
        lounge.position.set(cafe.x + dx, cafe.y, cafe.hutZ + 6.2);
        lounge.rotation.y = turn;
        group.add(lounge);
      }
      const plants = cafePart('plants', 1.15);
      plants.position.set(cafe.x - 1.3, cafe.y, cafe.hutZ - 3.4);
      group.add(plants);
      for (const [dx, dz] of [
        [-7.9, -6.8],
        [7.9, -6.8],
        [-7.9, 6.8],
        [7.9, 6.8],
      ]) {
        const lantern = cafePart('lantern', 1.35);
        lantern.position.set(cafe.x + dx, cafe.y + 0.05, cafe.z + dz);
        group.add(lantern);
      }
    }
    // The deck's front rail, looking out over the lagoon towards the reader.
    for (let k = 0; k < 6; k++) {
      rails.push({
        x: cafe.x - 3 + k * 1.2,
        z: cafe.z + 6 + (k % 2) * 0.8,
        facing: rand(-0.6, 0.6),
      });
    }
    const cafePlate = el('office-plate office-plate-park', overlay);
    cafePlate.textContent = '☕ Café';
    plates.push({ node: cafePlate, x: cafe.x, y: cafe.y + 5.6, z: cafe.hutZ });

    // Moka keeps watch by the café's open edge, far enough from the tables
    // and walking routes that a busy resort never has people clipping through.
    dog = buildDog();
    dog.group.position.set(cafe.x + 5.9, cafe.y, cafe.z + 4.7);
    dog.group.rotation.y = -0.55;
    dog.baseY = cafe.y;
    group.add(dog.group);

    // ---- the spur and the villas ----
    //
    // The spur leaves the boardwalk's left end and runs out towards the
    // reader. A villa either side every few metres, and the big one at the
    // end, every deck facing the boardwalk: that is where the bosses stand.
    // There are always at least two, so a resort without an orchestrator
    // still has somewhere for one to move in.
    const jetty = new THREE.Group();
    const jz0 = WALK_W / 2; // where the spur's planks leave the boardwalk's edge
    jetty.add(board(WALK_W, JETTY_LEN, jettyX, jz0 + JETTY_LEN / 2));
    for (let z = jz0 + 1; z < jz0 + JETTY_LEN; z += 2.6)
      for (const dx of [-1, 1]) post(jetty, jettyX + dx, z);
    const villas = [];
    const nBoss = Math.max(2, counts.get('__bosses__')?.length || 0);
    // The main villa at the end, its floor starting where the spur stops,
    // then one either side working back.
    const villaSpots = [{ x: jettyX, z: jz0 + JETTY_LEN + 6.7, big: true, side: 0 }];
    for (let i = 1; i < nBoss; i++) {
      const side = i % 2 ? 1 : -1;
      const z = jz0 + JETTY_LEN - 4 - Math.floor((i - 1) / 2) * 9;
      villaSpots.push({ x: jettyX + side * 7, z, big: false, side });
    }
    const spurGaps = { [-1]: [], [1]: [] }; // where a villa's walkway leaves the spur, per side
    villaSpots.forEach((v, i) => {
      const b = bungalow(v.big, -v.side);
      b.position.set(v.x, 0, v.z);
      jetty.add(b);
      // A walkway from the spur onto the villa's deck, for the small ones;
      // the big one is walked straight into.
      if (!v.big) {
        const wz = v.z - 3.45;
        jetty.add(board(3, 1.6, jettyX + v.side * 2.7, wz));
        spurGaps[v.side].push(wz);
      }
      // Where a boss stands: the deck's front edge, facing the boardwalk and
      // the bungalows off to its right.
      const f = v.big ? { x: v.x + 2.2, z: v.z - 5.6 } : { x: v.x + 1.4, z: v.z - 4.2 };
      villas.push({ ...v, stand: { x: f.x, z: f.z, y: DECK_Y, facing: Math.PI - 0.55 } });
      if (i === 0) {
        const plate = el('office-plate office-plate-park', overlay);
        plate.textContent = '⚓ Villa';
        plates.push({ node: plate, x: v.x, y: 7.2, z: v.z });
      }
    });
    for (const side of [-1, 1]) {
      railAlong(jetty, 'z', jettyX + (side * WALK_W) / 2, jz0, jz0 + JETTY_LEN, spurGaps[side], 1.6);
    }
    group.add(jetty);

    const bounds = {
      minX: walkX0 - 2,
      maxX: cafeX + CAFE_W / 2 + 2,
      minZ: -(usingKit ? KIT_ANCHOR_Z + KIT_DECK_D / 2 : PIER_END + DECK_D) - 2,
      maxZ: jz0 + JETTY_LEN + 11,
    };

    // The sandbank: a soft turquoise patch floating just over the water under
    // the whole resort, brightest in the middle and gone a way out, so the
    // lagoon reads shallow where the stilts go in and deep beyond.
    const shallow = new THREE.Mesh(
      new THREE.CircleGeometry(1, 96),
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: { color: { value: new THREE.Color(C.shallows) }, time: { value: 0 } },
        vertexShader: `varying float vR; varying vec2 vP; void main(){ vR = length(position.xy); vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `uniform vec3 color; uniform float time; varying float vR; varying vec2 vP;
          void main(){
            float edge = (1.0 - clamp(vR, 0.0, 1.0));
            float a = edge * edge * 0.42;
            float c1 = sin(vP.x * 48.0 + vP.y * 31.0 + time * 0.9);
            float c2 = sin(vP.x * -37.0 + vP.y * 43.0 - time * 0.7);
            float caustic = pow(max(0.0, c1 + c2 - 1.0), 2.0);
            vec3 tint = mix(color, vec3(0.78, 0.98, 1.0), caustic * 0.32);
            gl_FragColor = vec4(tint, a + caustic * edge * 0.055);
          }`,
      }),
    );
    shallow.rotation.x = -Math.PI / 2;
    shallow.scale.set((bounds.maxX - bounds.minX) * 0.8, (bounds.maxZ - bounds.minZ) * 0.8, 1);
    shallow.position.set((bounds.minX + bounds.maxX) / 2, 0.03, (bounds.minZ + bounds.maxZ) / 2);
    shallow.renderOrder = 1;
    group.add(shallow);

    // The characters outlive the rebuild. One on a seat keeps it if the seat
    // is still where it was; otherwise it is sent to find another.
    for (const c of chars.values()) {
      const seat = c.seat;
      c.seat = null;
      if (!seat) continue;
      const again = seats.find((q) => Math.hypot(q.x - seat.x, q.z - seat.z) < 0.01 && q.kind === seat.kind);
      if (again) {
        again.taken = c.id;
        c.seat = again;
      } else c.act = null;
      for (const h of homes.values()) {
        const ch = h.chairs.find((q) => Math.hypot(q.x - seat.x, q.z - seat.z) < 0.01);
        if (ch) {
          ch.taken = c.id;
          c.seat = ch;
        }
      }
    }
    scene.add(group);
    island = { group, homes, cafe, villas, plates, bounds, shallow };
    const reach = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) * 0.7;
    Object.assign(sun.shadow.camera, {
      left: -reach,
      right: reach,
      top: reach,
      bottom: -reach,
      near: 1,
      far: 400,
    });
    sun.shadow.camera.updateProjectionMatrix();
    sun.target.position.set((bounds.minX + bounds.maxX) / 2, 0, (bounds.minZ + bounds.maxZ) / 2);
    fit(true);
  }

  // ---- the planks ----
  //
  // Every deck is one box with the plank texture on it, the boards laid
  // across its longer side the way a jetty's are. The texture is cloned per
  // shape of board so its repeat fits: a hundred-metre boardwalk and a pier
  // cannot share one.
  const plankTexes = new Map();
  function board(w, d, x, z) {
    if (kit?.walkway && Math.min(w, d) <= 3.1) return kitWalkway(w, d, x, z);
    const key = `${w.toFixed(1)},${d.toFixed(1)}`;
    let maps = plankTexes.get(key);
    if (!maps) {
      const fitted = (source) => {
        const texture = source.clone();
        texture.center.set(0.5, 0.5);
        const runsAlongX = w >= d;
        texture.rotation = runsAlongX ? Math.PI / 2 : 0;
        // Rotating the image also rotates its repeat axes. Swap them here so
        // a long x-axis boardwalk repeats along its length, not dozens of
        // times across its narrow width (which looked like a flat red strip).
        texture.repeat.set(runsAlongX ? d / 1.8 : w / 1.8, runsAlongX ? w / 1.8 : d / 1.8);
        texture.needsUpdate = true;
        return texture;
      };
      maps = {
        map: fitted(planks()),
        normalMap: fitted(plankNormals()),
        roughnessMap: fitted(plankRoughness()),
      };
      plankTexes.set(key, maps);
    }
    return box(w, 0.18, d, C.teak, x, DECK_Y - 0.09, z, {
      material: plankMaterial(maps),
    });
  }

  // Tile the real crosswise plank extracted from the GLB's access path. One
  // InstancedMesh keeps even the long central boardwalk to a single draw call,
  // while retaining the narrow authored gaps instead of stretching a texture
  // over a solid box.
  function kitWalkway(w, d, x, z) {
    const alongX = w >= d;
    const length = Math.max(w, d);
    const width = Math.min(w, d);
    const count = Math.max(1, Math.round(length / (KIT_PLANK_PITCH * KIT_DECK_SCALE)));
    const pitch = length / count;
    const plank = kit.walkway;
    const floor = new THREE.InstancedMesh(plank.geometry, plank.material, count);
    const transform = new THREE.Object3D();
    for (let i = 0; i < count; i++) {
      transform.position.set(0, 0, -length / 2 + (i + 0.5) * pitch);
      transform.scale.set(width / KIT_WALK_WIDTH, KIT_DECK_SCALE, pitch / KIT_PLANK_PITCH);
      transform.updateMatrix();
      floor.setMatrixAt(i, transform.matrix);
    }
    floor.instanceMatrix.needsUpdate = true;
    floor.castShadow = true;
    floor.receiveShadow = true;
    const path = new THREE.Group();
    path.add(floor);
    path.position.set(x, DECK_Y - 0.063 * KIT_DECK_SCALE, z);
    if (alongX) path.rotation.y = Math.PI / 2;
    return path;
  }

  // A stilt: a post driven into the lagoon, up into the underside of the planks.
  function post(g, x, z) {
    g.add(cyl(0.13, 0.16, 3.4, C.teakDark, x, DECK_Y - 1.75, z, 8));
  }

  // A rail from one point to another at deck height: posts a stride apart
  // and a bar along the top.
  function rail(g, x1, z1, x2, z2) {
    const len = Math.hypot(x2 - x1, z2 - z1);
    if (len < 0.5) return;
    if (kit?.rail) {
      const segment = new THREE.Group();
      const bays = Math.max(1, Math.round(len / (KIT_RAIL_PITCH * KIT_RAIL_SCALE)));
      const bayWidth = len / bays;
      for (let i = 0; i < bays; i++) {
        const bay = kitPart('rail');
        bay.scale.set(bayWidth / KIT_RAIL_WIDTH, KIT_RAIL_SCALE, KIT_RAIL_SCALE);
        bay.position.x = -len / 2 + (i + 0.5) * bayWidth;
        segment.add(bay);
      }
      segment.position.set((x1 + x2) / 2, DECK_Y - 0.063 * KIT_RAIL_SCALE, (z1 + z2) / 2);
      segment.rotation.y = Math.atan2(z1 - z2, x2 - x1);
      g.add(segment);
      return;
    }
    const a = Math.atan2(x2 - x1, z2 - z1);
    for (let s = 0.15; s <= len; s += 1.2) {
      g.add(cyl(0.04, 0.04, 1, C.teakDark, x1 + Math.sin(a) * s, DECK_Y + 0.5, z1 + Math.cos(a) * s, 6));
    }
    const bar = box(0.06, 0.06, len, C.teakDark, (x1 + x2) / 2, DECK_Y + 1, (z1 + z2) / 2, { shadow: false });
    bar.rotation.y = a;
    g.add(bar);
  }

  // A rail down one side of a walkway, broken wherever something meets it.
  // `axis` is the walkway's direction; `at` is the rail's position across it,
  // `from`..`to` its run, and `openings` the centres of the gaps, each
  // `width` wide.
  function railAlong(g, axis, at, from, to, openings, width = WALK_W) {
    const seg = (a, b) => {
      if (b - a < 0.5) return;
      if (axis === 'x') rail(g, a, at, b, at);
      else rail(g, at, a, at, b);
    };
    let s = from;
    for (const o of [...openings].sort((p, q) => p - q)) {
      seg(s, o - width / 2 - 0.15);
      s = Math.max(s, o + width / 2 + 0.15);
    }
    seg(s, to);
  }

  // A bungalow for a project: a deck on stilts, a cabin at its back, rails
  // round it, and the pier to the boardwalk leaving the deck's front edge
  // (`pierV` = 1, for the far side of the boardwalk) or its back (-1, the
  // near side, where the pier lands beside the cabin). The table is not
  // here: it is placed by buildIsland, in world coordinates.
  function palafito(pierV) {
    if (kit) return kitPalafito(pierV);
    const g = new THREE.Group();
    const hw = DECK_W / 2;
    const hd = DECK_D / 2;
    g.add(board(DECK_W, DECK_D, 0, 0));
    for (const u of [-hw + 0.4, 0, hw - 0.4]) for (const v of [-hd + 0.4, 0, hd - 0.4]) post(g, u, v);
    const pierLen = PIER_END - WALK_W / 2;
    const edge = pierV * hd;
    g.add(board(WALK_W, pierLen, PIER_U, edge + (pierV * pierLen) / 2));
    for (const du of [-0.9, 0.9]) post(g, PIER_U + du, edge + pierV * (pierLen - 0.5));
    for (const du of [-WALK_W / 2, WALK_W / 2]) {
      rail(g, PIER_U + du, edge, PIER_U + du, edge + pierV * pierLen);
    }
    rail(g, -hw, -hd, -hw, hd);
    rail(g, hw, -hd, hw, hd);
    rail(g, -hw, -edge, hw, -edge);
    rail(g, -hw, edge, PIER_U - WALK_W / 2, edge);
    rail(g, PIER_U + WALK_W / 2, edge, hw, edge);
    const cab = cabin(5, 3.6);
    cab.position.set(-2, DECK_Y, -hd + 1.8);
    g.add(cab);
    // A lantern on the front corner post. No light under it: one point
    // light per table is already a lot of shader for the lagoon.
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), lampMat(3));
    lamp.position.set(hw - 0.3, DECK_Y + 1.6, hd - 0.3);
    g.add(lamp, cyl(0.04, 0.04, 1.5, C.teakDark, hw - 0.3, DECK_Y + 0.75, hd - 0.3, 6));
    return g;
  }

  // The GLB version of a project's bungalow. Its authored deck already owns
  // the stilts, rails and long access pier, so only the four useful objects
  // are composed here. Their offsets are measured from the common floor in
  // the source file; keeping that plane at local y=0 makes DECK_Y remain the
  // single walking height for both this version and the fallback above.
  function kitPalafito(pierV) {
    const g = new THREE.Group();

    const deck = kitPart('deck');
    deck.scale.setScalar(KIT_DECK_SCALE);
    deck.position.y = DECK_Y - 0.063 * KIT_DECK_SCALE;
    g.add(deck);

    // The smaller six-metre house leaves the right side of the deck open for
    // the project's table while retaining the kit's curved walls and roof.
    const hut = kitPart('hut');
    const hutScale = { x: 0.78, y: 0.88, z: 0.82 };
    hut.scale.set(hutScale.x, hutScale.y, hutScale.z);
    hut.rotation.y = Math.PI;
    hut.position.set(-2.15, DECK_Y + 1.603 * hutScale.y, -1.15);
    g.add(hut);

    const pool = kitPart('pool');
    // Preserve the pool's authored relationship to the deck: its source
    // centre is 1.324 m left and 9.944 m behind the deck origin.
    const poolScale = KIT_DECK_SCALE;
    pool.scale.setScalar(poolScale);
    pool.position.set(-1.324 * KIT_DECK_SCALE, DECK_Y - 0.918 * poolScale, -9.944 * KIT_DECK_SCALE);
    g.add(pool);

    for (const [x, turn] of [
      [-1.8, -0.08],
      [1.8, 0.08],
    ]) {
      const lounger = kitPart('lounger');
      const loungerScale = 0.65;
      lounger.scale.setScalar(loungerScale);
      lounger.position.set(x, DECK_Y + 0.212 * loungerScale, -4.65);
      lounger.rotation.y = turn;
      g.add(lounger);
    }

    // The source pier points towards +z. Mirror the whole plot on the near
    // side so both copies meet the boardwalk rather than pointing at sea.
    if (pierV < 0) g.rotation.y = Math.PI;
    return g;
  }

  // A cabin: white walls, a strip of glass down each side, a door and a
  // window on the front and a pyramid of thatch. Built with its floor at the
  // origin and its front towards +z.
  function cabin(w, d) {
    const g = new THREE.Group();
    const h = 2.9;
    g.add(box(w, h, d, C.wall, 0, h / 2, 0, { round: 0.06 }));
    const glassMat = mat(C.glass, { metalness: 0.9, roughness: 0.15 });
    for (const side of [-1, 1]) {
      g.add(
        box(0.08, 1.0, d - 1.2, C.glass, side * (w / 2 + 0.02), 1.7, 0, {
          material: glassMat,
          shadow: false,
        }),
      );
    }
    g.add(box(1.0, 2.1, 0.1, C.teakDark, w / 2 - 1.1, 1.05, d / 2 + 0.05, { shadow: false }));
    g.add(
      box(1.4, 1.0, 0.08, C.glass, -w / 2 + 1.4, 1.7, d / 2 + 0.02, { material: glassMat, shadow: false }),
    );
    const roof = new THREE.Mesh(
      new THREE.ConeGeometry(Math.max(w, d) * 0.85, 2.2, 4, 1, true),
      roofMaterial(),
    );
    roof.rotation.y = Math.PI / 4;
    roof.scale.set(w / Math.max(w, d), 1, d / Math.max(w, d));
    roof.position.y = h + 1.1;
    roof.castShadow = true;
    g.add(roof);
    return g;
  }

  // The café's deck: the boardwalk runs straight onto it through a gap in
  // its rail, and the hut, stools and tables are set on it by buildIsland.
  function cafeDeck() {
    const g = new THREE.Group();
    const hw = CAFE_W / 2;
    const hd = CAFE_D / 2;
    g.add(board(CAFE_W, CAFE_D, 0, 0));
    for (let u = -hw + 0.4; u <= hw - 0.3; u += (CAFE_W - 0.8) / 4) {
      for (let v = -hd + 0.4; v <= hd - 0.3; v += (CAFE_D - 0.8) / 4) post(g, u, v);
    }
    rail(g, -hw, -hd, hw, -hd);
    rail(g, -hw, hd, hw, hd);
    rail(g, hw, -hd, hw, hd);
    rail(g, -hw, -hd, -hw, -WALK_W / 2 - 0.15);
    rail(g, -hw, WALK_W / 2 + 0.15, -hw, hd);
    return g;
  }

  // ---- the furniture ----

  function table(i) {
    const g = new THREE.Group();
    const top = cyl(1.25, 1.25, 0.08, C.linen, 0, 0.78, 0, 24, {
      material: mat(0xf7f2e8, { roughness: 0.6 }),
    });
    g.add(
      top,
      cyl(0.08, 0.1, 0.78, C.teakDark, 0, 0.39, 0, 8),
      cyl(0.5, 0.55, 0.06, C.teakDark, 0, 0.03, 0, 12),
    );
    // No parasol: the cabin behind it is the shade, and a cone over the
    // table would hide whoever sits at it from the reader's height. The lamp
    // stands on the table.
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), lampMat(i));
    lamp.position.y = 0.98;
    g.add(lamp, nightLight(0, 1.4, 0, 14, 9));
    return g;
  }

  function chair() {
    const g = new THREE.Group();
    g.add(box(0.62, 0.08, 0.62, C.teak, 0, 0.62, 0, { round: 0.03 }));
    g.add(box(0.62, 0.7, 0.08, C.teak, 0, 0.98, -0.28, { round: 0.03 }));
    for (const [dx, dz] of [
      [-0.26, -0.26],
      [0.26, -0.26],
      [-0.26, 0.26],
      [0.26, 0.26],
    ]) {
      g.add(cyl(0.03, 0.03, 0.6, C.teakDark, dx, 0.3, dz, 6));
    }
    return g;
  }

  function stool() {
    if (cafeKit) return cafePart('stool');
    const g = new THREE.Group();
    g.add(cyl(0.24, 0.24, 0.06, C.cushion, 0, 0.78, 0, 12));
    g.add(cyl(0.04, 0.04, 0.78, C.teakDark, 0, 0.39, 0, 6));
    g.add(cyl(0.2, 0.22, 0.04, C.teakDark, 0, 0.02, 0, 10));
    return g;
  }

  function cafeTable() {
    if (cafeKit) return cafePart('table', 1.5);
    const g = new THREE.Group();
    g.add(cyl(0.7, 0.7, 0.06, C.teak, 0, 0.8, 0, 16));
    g.add(cyl(0.05, 0.05, 0.8, C.teakDark, 0, 0.4, 0, 6));
    g.add(cyl(0.35, 0.4, 0.05, C.teakDark, 0, 0.025, 0, 10));
    return g;
  }

  function cafeChair() {
    if (cafeKit) return cafePart('chair');
    return chair();
  }

  function cafeHut() {
    const g = new THREE.Group();
    const floor = box(8, 0.2, 5, C.teak, 0, 0.1, 0, {
      material: plankMaterial(),
    });
    g.add(floor);
    // The bar: a counter across the front with the barista's back wall.
    g.add(box(6.4, 1.1, 0.7, C.teakDark, 0, 0.75, 0.9, { round: 0.04 }));
    g.add(box(6.6, 0.08, 0.9, C.teak, 0, 1.32, 0.9, { round: 0.02 }));
    g.add(box(7.4, 3.2, 0.3, C.wall, 0, 1.8, -2.2));
    for (const dx of [-2.2, 0, 2.2]) {
      g.add(box(1.6, 0.06, 0.3, C.teak, dx, 2.2, -2.0));
      g.add(box(1.6, 0.06, 0.3, C.teak, dx, 1.6, -2.0));
      for (let b = 0; b < 4; b++) {
        const shade = [0x4d8b4a, 0xc9a24a, 0x8a3b3b, 0x3b6a8a][(b + Math.round(dx)) & 3];
        g.add(cyl(0.07, 0.07, 0.36, shade, dx - 0.5 + b * 0.33, 2.42, -2.0, 8));
      }
    }
    // The coffee machine on the counter, and the cups.
    g.add(
      box(0.8, 0.6, 0.5, 0x2b2b30, 1.8, 1.66, 0.7, {
        round: 0.04,
        material: mat(0x2b2b30, { metalness: 0.6, roughness: 0.35 }),
      }),
    );
    for (let k = 0; k < 5; k++) g.add(cyl(0.08, 0.06, 0.12, 0xf8f6f0, -2.2 + k * 0.22, 1.42, 0.7, 10));
    // Posts and the thatched roof over it all.
    for (const [dx, dz] of [
      [-3.7, -2.2],
      [3.7, -2.2],
      [-3.7, 2.2],
      [3.7, 2.2],
    ]) {
      g.add(cyl(0.12, 0.14, 3.8, C.teakDark, dx, 1.9, dz, 8));
    }
    const roof = new THREE.Mesh(
      new THREE.ConeGeometry(6.4, 2.6, 4, 1, true),
      new THREE.MeshStandardMaterial({ map: thatch(), roughness: 1, side: THREE.DoubleSide }),
    );
    roof.rotation.y = Math.PI / 4;
    roof.scale.set(1.3, 1, 0.9);
    roof.position.y = 5.0;
    roof.castShadow = true;
    g.add(roof);
    // String lights along the eaves: the café's light at night.
    for (let k = 0; k < 9; k++) {
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 6), lampMat(k));
      bulb.position.set(-4 + k, 3.55 + Math.sin(k * 1.3) * 0.12, 2.6);
      g.add(bulb);
    }
    g.add(nightLight(0, 3.2, 2.4, 40, 16), nightLight(0, 2.6, -1, 18, 9));
    // A sign, so the plate is not the only thing saying so.
    g.add(box(1.6, 0.5, 0.06, 0x2a2622, 0, 3.0, 2.35));
    return g;
  }

  // A villa on stilts: a square room with a pyramid of thatch, a deck out
  // front over the water facing the boardwalk, and a lamp on the rail. The
  // big one is entered from the spur through a gate in its front rail, the
  // small ones by a walkway onto the deck's `open` side (-1 or 1 in x).
  function bungalow(big, open = 0) {
    const g = new THREE.Group();
    const w = big ? 7 : 5;
    const d = big ? 6 : 4.5;
    const deckD = big ? 3.4 : 2.4;
    const plankMat = plankMaterial();
    // Stilts.
    for (let x = -w / 2; x <= w / 2; x += w / 2) {
      for (let z = -d / 2 - deckD; z <= d / 2; z += (d + deckD) / 2) {
        g.add(cyl(0.14, 0.17, 3, C.teakDark, x, -0.4, z, 8));
      }
    }
    const floor = box(w + 0.6, 0.2, d + deckD + 0.6, C.teak, 0, 0.9, -deckD / 2, { material: plankMat });
    g.add(floor);
    // Walls, with a window strip and a door towards the deck.
    g.add(box(w, 2.9, d, C.wall, 0, 2.45, 0, { round: 0.06 }));
    g.add(
      box(w - 1, 1.1, 0.08, C.glass, 0, 2.6, d / 2 + 0.02, {
        material: mat(C.glass, { metalness: 0.9, roughness: 0.15 }),
        shadow: false,
      }),
    );
    for (const side of [-1, 1]) {
      g.add(
        box(0.08, 1.1, d - 1.2, C.glass, side * (w / 2 + 0.02), 2.6, 0, {
          material: mat(C.glass, { metalness: 0.9, roughness: 0.15 }),
          shadow: false,
        }),
      );
    }
    g.add(box(1.1, 2.1, 0.1, C.teakDark, -w / 2 + 1.2, 2.05, -d / 2 - 0.05, { shadow: false }));
    // The thatch.
    const roof = new THREE.Mesh(
      new THREE.ConeGeometry(Math.max(w, d) * 0.85, big ? 2.8 : 2.2, 4, 1, true),
      roofMaterial(),
    );
    roof.rotation.y = Math.PI / 4;
    roof.scale.set(w / Math.max(w, d), 1, d / Math.max(w, d));
    roof.position.y = 3.9 + (big ? 1.4 : 1.1);
    roof.castShadow = true;
    g.add(roof);
    // The deck's rail, and a lamp on the corner post.
    const dz = -d / 2 - deckD;
    for (const x of [-w / 2 - 0.2, w / 2 + 0.2]) {
      if (Math.sign(x) === open) continue;
      for (let z = dz + 0.3; z < -d / 2; z += 1.2) g.add(cyl(0.04, 0.04, 1, C.teakDark, x, 1.5, z, 6));
      g.add(box(0.06, 0.06, deckD, C.teakDark, x, 2.0, -d / 2 - deckD / 2, { shadow: false }));
    }
    for (let x = -w / 2 + 0.2; x < w / 2; x += 1.2) {
      if (big && Math.abs(x) < 1.3) continue;
      g.add(cyl(0.04, 0.04, 1, C.teakDark, x, 1.5, dz + 0.1, 6));
    }
    if (big) {
      const half = (w + 0.5) / 2 - 1.3;
      for (const side of [-1, 1]) {
        g.add(box(half, 0.06, 0.06, C.teakDark, side * (1.3 + half / 2), 2.0, dz + 0.1, { shadow: false }));
      }
    } else g.add(box(w + 0.5, 0.06, 0.06, C.teakDark, 0, 2.0, dz + 0.1, { shadow: false }));
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 8), lampMat(big ? 0 : 1));
    lamp.position.set(-w / 2 - 0.2, 2.2, dz + 0.1);
    g.add(lamp, nightLight(0, 2.6, dz + 1.2, big ? 30 : 16, 12));
    if (big) {
      // The captain's chair and a telescope on the big deck.
      const ch = chair();
      ch.position.set(-1.6, 1.0, dz + 1.4);
      ch.rotation.y = Math.PI;
      g.add(ch);
      const tele = cyl(0.06, 0.09, 0.9, 0x2b2b30, 2.6, 2.1, dz + 0.9, 10, {
        material: mat(0x2b2b30, { metalness: 0.7, roughness: 0.3 }),
      });
      tele.rotation.set(-0.5, 0.6, 0);
      g.add(tele, cyl(0.03, 0.03, 1.2, C.teakDark, 2.6, 1.6, dz + 0.9, 6));
    }
    return g;
  }

  // A pool of warm light under a lamp, for the dark. No shadows: a dozen of
  // them across the resort is fine, a dozen shadow maps is not.
  function nightLight(x, y, z, full, reach) {
    const l = new THREE.PointLight(C.lamp, 0, reach, 1.6);
    l.position.set(x, y, z);
    l.userData.full = full;
    nightLights.push(l);
    return l;
  }

  // A lamp's material: warm, and lit only after dark (stepLight drives it).
  function lampMat(i) {
    const m = mat(C.lamp, { emissive: C.lamp, emissiveIntensity: 0, roughness: 0.4 });
    m.userData.flicker = (i * 7) % 5;
    lampMats.push(m);
    return m;
  }

  // ---- the camera ----
  //
  // Perspective, orbiting a point over the water. The default view is from
  // the south-east, up and back enough that the bungalows, the café and the
  // villas all fit; the reader's drag orbits it and the wheel moves in.
  const orbit = { yaw: 0.35, pitch: 0.45, dist: 60 };
  const target = new THREE.Vector3(0, 1, 0);
  const goal = { yaw: orbit.yaw, pitch: orbit.pitch, dist: orbit.dist, target: target.clone() }; // eased toward
  let composer = null;
  let bloom = null;

  function fit(reset = false) {
    const w = host.clientWidth || 1;
    const hgt = host.clientHeight || 1;
    camera.aspect = w / hgt;
    camera.updateProjectionMatrix();
    renderer.setSize(w, hgt, false);
    renderer.domElement.style.width = `${w}px`;
    renderer.domElement.style.height = `${hgt}px`;
    if (!composer) {
      const rt = new THREE.WebGLRenderTarget(w, hgt, { samples: 4, type: THREE.HalfFloatType });
      composer = new EffectComposer(renderer, rt);
      composer.addPass(new RenderPass(scene, camera));
      // The threshold sits above the daylight sky, which is HDR-bright all
      // over: below it the bloom would fog the whole frame white. Only the
      // sun, the glints and the lamps at night get past it.
      bloom = new UnrealBloomPass(new THREE.Vector2(w, hgt), 0.2, 0.55, 1.9);
      composer.addPass(bloom);
      composer.addPass(new OutputPass());
    }
    composer.setSize(w, hgt);
    composer.setPixelRatio(renderer.getPixelRatio());
    if (reset && island) {
      const b = island.bounds;
      goal.target.set((b.minX + b.maxX) / 2, 1.5, (b.minZ + b.maxZ) / 2 - 2);
      goal.yaw = 0.35;
      goal.pitch = 0.45;
      goal.dist = fitDistance(goal, b);
    }
    placeCamera();
  }

  // How far back the camera has to stand, from this angle, for the whole
  // resort to be on screen with a little sea round it. The bounds' corners
  // are projected and the distance scaled until the widest of them sits
  // just inside the frame; a few rounds of that settle it.
  const probe = new THREE.PerspectiveCamera();
  function fitDistance(view, b) {
    probe.fov = camera.fov;
    probe.aspect = camera.aspect;
    probe.updateProjectionMatrix();
    let dist = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
    const corners = [];
    for (const x of [b.minX, b.maxX]) {
      for (const z of [b.minZ, b.maxZ]) for (const y of [0, 8]) corners.push(new THREE.Vector3(x, y, z));
    }
    const v = new THREE.Vector3();
    for (let round = 0; round < 4; round++) {
      probe.position.set(
        view.target.x + Math.sin(view.yaw) * Math.cos(view.pitch) * dist,
        view.target.y + Math.sin(view.pitch) * dist,
        view.target.z + Math.cos(view.yaw) * Math.cos(view.pitch) * dist,
      );
      probe.lookAt(view.target);
      probe.updateMatrixWorld();
      let worst = 0;
      for (const c of corners) {
        v.copy(c).project(probe);
        worst = Math.max(worst, Math.abs(v.x), Math.abs(v.y));
      }
      dist *= worst * 1.03;
    }
    return dist;
  }

  function placeCamera() {
    const cx = target.x + Math.sin(orbit.yaw) * Math.cos(orbit.pitch) * orbit.dist;
    const cz = target.z + Math.cos(orbit.yaw) * Math.cos(orbit.pitch) * orbit.dist;
    const cy = target.y + Math.sin(orbit.pitch) * orbit.dist;
    camera.position.set(cx, Math.max(cy, 1.2), cz);
    camera.lookAt(target);
  }

  function stepCamera(dt) {
    const k = Math.min(1, dt * 5);
    orbit.yaw += (goal.yaw - orbit.yaw) * k;
    orbit.pitch += (goal.pitch - orbit.pitch) * k;
    orbit.dist += (goal.dist - orbit.dist) * k;
    target.lerp(goal.target, k);
    placeCamera();
  }

  // A world point to a place on the overlay, in CSS pixels.
  const projected = new THREE.Vector3();
  function toScreen(x, y, z) {
    projected.set(x, y, z).project(camera);
    return {
      left: ((projected.x + 1) / 2) * host.clientWidth,
      top: ((1 - projected.y) / 2) * host.clientHeight,
      on: projected.z < 1 && Math.abs(projected.x) < 1.2 && Math.abs(projected.y) < 1.2,
    };
  }

  // ---- the characters ----
  //
  // Each one is a little state machine. `route` is where it is walking, as
  // waypoints; `act` is what it is doing when it gets there.
  function spawn(s) {
    const seed = hash(s.id);
    const boss = !!s.orchestrator;
    const { group, parts } = buildFigure(seed, boss ? C.boss : C[s.mood], 1, { uniform: boss });
    group.userData.pick = { kind: 'session', id: s.id, top: 2.4 };
    const at = boss ? { x: island.villas[0].stand.x, z: island.villas[0].stand.z } : cafeSpot();
    group.position.set(at.x, DECK_Y, at.z);
    const bubbleNode = el('office-bubble hidden', overlay);
    const c = {
      id: s.id,
      seed,
      boss,
      mood: s.mood,
      group,
      parts,
      x: at.x,
      z: at.z,
      y: 0,
      facing: 0,
      route: [],
      act: null,
      home: null,
      stride: Math.random() * 6,
      laptop: null,
      cup: null,
      megaphone: null,
      shout: 0, // seconds left with the megaphone up
      crew: [],
      seat: null,
      bubble: { node: bubbleNode, text: '', tone: '' },
      glow: null,
    };
    scene.add(group);
    pickables.push(group);
    chars.set(s.id, c);
    return c;
  }

  function dress(c, mood) {
    if (c.mood === mood) return;
    c.mood = mood;
    if (c.boss) return; // a boss wears the uniform whatever the hour
    c.parts.shirtMat.color.set(C[mood]);
    c.parts.shirtMat.emissive.set(C[mood]);
  }

  function cafeSpot() {
    const k = island.cafe;
    return { x: k.x + rand(-5, 5), z: k.z + rand(4, 7) };
  }

  function leaveSeat(c) {
    if (c.seat) c.seat.taken = null;
    c.seat = null;
  }

  // The way off the deck a spot is on: the waypoints from it to the
  // boardwalk (a bungalow's pier end and junction, or the café deck's
  // mouth), or nothing for a spot on the boardwalk itself.
  function dockOf(p) {
    for (const h of island.homes.values()) if (h.holds(p)) return h.dock;
    return island.cafe.holds(p) ? island.cafe.dock : null;
  }

  // Send a character somewhere. Along the planks: off its own deck by the
  // pier, along the boardwalk, and up the pier of where it is going, with one
  // waypoint round the café's bar if the last stretch would go through it.
  // Nobody walks on water; a character caught mid-pier by a change of plan
  // goes back to the boardwalk first.
  function sendTo(c, to, act) {
    leaveSeat(c);
    const k = island.cafe;
    const from = { x: c.x, z: c.z };
    const a = dockOf(from);
    const b = dockOf(to);
    const pts = [];
    if (a !== b) {
      if (a) pts.push(...a);
      else if (Math.abs(from.z) > WALK_W / 2) pts.push({ x: from.x, z: 0 });
      if (b) pts.push(...[...b].reverse());
    }
    const last = pts.length ? pts[pts.length - 1] : from;
    const inHut = (p) => Math.abs(p.x - k.x) < 4.2 && p.z > k.hutZ - 2.6 && p.z < k.hutZ + 1.4;
    const mid = { x: (last.x + to.x) / 2, z: (last.z + to.z) / 2 };
    if (inHut(mid) || inHut(last) || inHut(to)) pts.push({ x: k.x - 4.8, z: k.hutZ + 2.6 });
    pts.push(to);
    c.route = pts;
    c.act = act;
    c.y = DECK_Y;
  }

  // What to do next at the café: a stool at the bar, a chair outside, or a
  // coffee standing at the rail looking at the water.
  function cafePlan(c) {
    const r = Math.random();
    const free = seats.filter((s) => !s.taken);
    if (free.length && r < 0.65) {
      const s = pick(free);
      s.taken = c.id;
      sendTo(c, { x: s.x, z: s.z }, { kind: 'sit', until: rand(12, 30), facing: s.facing, seat: s });
      c.seat = s;
      return;
    }
    const rail = pick(rails);
    sendTo(
      c,
      { x: rail.x + rand(-0.3, 0.3), z: rail.z },
      { kind: 'stand', until: rand(6, 14), facing: rail.facing },
    );
  }

  // The order: a line of light from a boss's deck to a worker's chair, with a
  // pulse running along it. Fired when a worker starts a turn, and drawn for
  // a couple of seconds.
  function fireOrder(boss, worker) {
    const a = new THREE.Vector3(boss.x, boss.y + 1.9, boss.z);
    const b = new THREE.Vector3(worker.x, worker.y + 1.6, worker.z);
    const mid = a.clone().lerp(b, 0.5);
    mid.y += Math.max(4, a.distanceTo(b) * 0.22);
    const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
    const mesh = new THREE.Mesh(
      new THREE.TubeGeometry(curve, 48, 0.06, 6, false),
      new THREE.MeshBasicMaterial({ color: C.order, transparent: true, opacity: 0.9 }),
    );
    const pulse = new THREE.Mesh(
      new THREE.SphereGeometry(0.26, 12, 10),
      new THREE.MeshBasicMaterial({ color: 0xfff1d0 }),
    );
    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glow(),
        color: C.order,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    halo.scale.set(1.6, 1.6, 1);
    pulse.add(halo);
    scene.add(mesh, pulse);
    orders.push({ mesh, pulse, curve, life: 2.4, age: 0 });
    boss.shout = 2.2;
    boss.facing = Math.atan2(b.x - a.x, b.z - a.z);
  }

  function stepOrders(dt) {
    for (let i = orders.length - 1; i >= 0; i--) {
      const o = orders[i];
      o.age += dt;
      const t = Math.min(1, o.age / 1.1);
      o.curve.getPoint(t, o.pulse.position);
      o.mesh.material.opacity = o.age < 1.1 ? 0.9 : Math.max(0, 0.9 * (1 - (o.age - 1.1) / (o.life - 1.1)));
      o.pulse.visible = o.age < 1.2;
      if (o.age >= o.life) {
        scene.remove(o.mesh, o.pulse);
        o.mesh.geometry.dispose();
        orders.splice(i, 1);
      }
    }
  }

  // Move every character a frame on.
  function stepChars(dt, t) {
    for (const c of chars.values()) {
      const p = c.parts;
      let swing = 0;
      if (c.route.length) {
        const to = c.route[0];
        const dx = to.x - c.x;
        const dz = to.z - c.z;
        const dist = Math.hypot(dx, dz);
        const step = WALK * dt;
        if (dist <= step + 0.05) {
          c.x = to.x;
          c.z = to.z;
          c.route.shift();
          if (!c.route.length) arrive(c);
        } else {
          c.x += (dx / dist) * step;
          c.z += (dz / dist) * step;
          c.facing = Math.atan2(dx, dz);
          c.stride += dt * 9;
          swing = Math.sin(c.stride) * 0.65;
        }
        c.y = c.boss ? c.y : DECK_Y;
      }
      const act = c.act;
      let bob = 0;
      let armF = 0;
      let sit = 0;
      let raise = 0; // the megaphone arm
      if (act && !c.route.length) {
        if (act.until != null) {
          act.until -= dt;
          if (act.until <= 0 && !c.home && !c.boss) cafePlan(c);
        }
        if (act.kind === 'type') {
          armF = 1.25;
          sit = 1;
          bob = Math.sin(t * 34 + c.seed) * 0.012;
        } else if (act.kind === 'wait') {
          bob = Math.sin(t * 3 + c.seed) * 0.05;
          p.head.rotation.z = Math.sin(t * 2) * 0.08;
        } else if (act.kind === 'sit') {
          sit = 1;
          armF = act.seat?.kind === 'stool' ? 0.9 : 0.5;
        } else if (act.kind === 'command') {
          bob = Math.sin(t * 2 + c.seed) * 0.02;
          raise = 1;
        } else {
          bob = Math.sin(t * 1.6 + c.seed) * 0.02;
        }
      }
      if (act?.kind !== 'wait') p.head.rotation.z = 0;
      if (c.shout > 0) {
        c.shout -= dt;
        raise = 1;
        bob = Math.sin(t * 18) * 0.02;
      }
      p.legL.rotation.x = sit ? -1.45 : swing;
      p.legR.rotation.x = sit ? -1.45 : -swing;
      p.armL.rotation.x = sit ? -armF : -swing * 0.8 - armF;
      p.armR.rotation.x = raise ? -2.6 : sit ? -armF : swing * 0.8 - armF;
      p.armR.rotation.z = raise ? 0.35 : 0;
      if (sit && act.facing != null) c.facing = act.facing;
      if (act?.kind === 'stand' && act.facing != null) c.facing = act.facing;
      // On a chair the hips drop to its seat; on the planks, nearly to the deck.
      c.group.position.set(c.x, c.y + bob - sit * (c.seat?.kind === 'overflow' ? 0.72 : SEAT_DROP), c.z);
      c.group.rotation.y = c.facing;
      if (c.laptop) c.laptop.visible = act?.kind === 'type';
      if (c.glow) c.glow.visible = act?.kind === 'type';
      if (c.cup) {
        c.cup.visible =
          !!act && (act.kind === 'sit' || act.kind === 'stand' || act.kind === 'wait') && !c.boss;
      }
      if (c.megaphone) c.megaphone.visible = raise > 0;
      // The crew stand beside their session, a step apart.
      c.crew.forEach((k, i) => {
        const side = i % 2 ? 1 : -1;
        const back = 0.9 + Math.floor(i / 2) * 0.7;
        const tx = c.x - Math.sin(c.facing) * back + Math.cos(c.facing) * side * 0.8;
        const tz = c.z - Math.cos(c.facing) * back - Math.sin(c.facing) * side * 0.8;
        k.x += (tx - k.x) * Math.min(1, dt * 4);
        k.z += (tz - k.z) * Math.min(1, dt * 4);
        const moving = Math.hypot(tx - k.x, tz - k.z) > 0.1;
        k.stride += moving ? dt * 12 : 0;
        const ks = moving ? Math.sin(k.stride) * 0.7 : 0;
        k.parts.legL.rotation.x = ks;
        k.parts.legR.rotation.x = -ks;
        k.parts.armL.rotation.x = -ks * 0.8;
        k.parts.armR.rotation.x = ks * 0.8;
        k.group.position.set(k.x, c.boss ? c.y : DECK_Y, k.z);
        k.group.rotation.y = moving ? Math.atan2(tx - k.x, tz - k.z) : c.facing;
      });
    }
  }

  function arrive(c) {
    const act = c.act;
    if (!act) return;
    if (act.kind === 'type' || act.kind === 'sit' || act.kind === 'stand' || act.kind === 'command') {
      if (act.facing != null) c.facing = act.facing;
    }
    if (act.kind === 'wait') c.facing = act.facing ?? Math.PI;
    if (act.kind === 'type' && act.fromBoss) {
      const boss = chars.get(act.fromBoss);
      if (boss && !boss.route.length) fireOrder(boss, c);
      act.fromBoss = null;
    }
  }

  function stepDog(t) {
    if (!dog) return;
    dog.tail.rotation.y = Math.sin(t * 7.5) * 0.72;
    dog.head.rotation.y = Math.sin(t * 0.85) * 0.2;
    dog.head.rotation.z = Math.sin(t * 1.3) * 0.025;
    dog.body.rotation.z = Math.sin(t * 1.8) * 0.012;
    dog.group.position.y = dog.baseY + Math.sin(t * 1.8) * 0.012;
  }

  // ---- the light ----
  let bakedFor = null;
  function stepLight(dt, t) {
    if (!phase) return;
    const k = Math.min(1, dt * 0.8);
    const tgt = PHASES[phase] || PHASES.afternoon;
    if (bakedFor !== phase) {
      bakedFor = phase;
      bakeSky(tgt.el, tgt.az, tgt);
    }
    light.exposure = lerp(light.exposure, tgt.exposure, k);
    light.fill = lerp(light.fill, tgt.fill, k);
    light.lamps = lerp(light.lamps ?? 0, tgt.lamps, k);
    renderer.toneMappingExposure = light.exposure;
    hemi.color.lerp(new THREE.Color(tgt.sky), k);
    hemi.groundColor.lerp(new THREE.Color(tgt.ground), k);
    hemi.intensity = light.fill;
    // The sun is where the sky says it is; under the horizon it goes out and
    // the moon (the same lamp, bluer and dim) takes over.
    const up = Math.max(0, Math.sin(THREE.MathUtils.degToRad(tgt.el)));
    sun.intensity = lerp(sun.intensity, tgt.el > 0 ? 2.2 + up * 1.5 : 0.7, k);
    sun.color.lerp(new THREE.Color(tgt.el > 0 ? (tgt.el < 15 ? 0xffb070 : 0xfff2dc) : 0x8090d0), k);
    if (island) {
      const b = island.bounds;
      const cx = (b.minX + b.maxX) / 2;
      const cz = (b.minZ + b.maxZ) / 2;
      const dir = tgt.el > 0 ? sunDir : new THREE.Vector3(-0.4, 0.7, 0.3).normalize();
      sun.position.set(cx + dir.x * 120, Math.max(30, dir.y * 120), cz + dir.z * 120);
    }
    for (const m of lampMats) {
      m.emissiveIntensity = light.lamps * (4.5 + Math.sin(t * 7 + m.userData.flicker) * 0.3);
    }
    for (const l of nightLights) l.intensity = light.lamps * l.userData.full;
    if (water) {
      water.material.uniforms.time.value = t * 0.6;
      water.material.uniforms.sunColor.value.copy(sun.color);
    }
    if (island?.shallow) island.shallow.material.uniforms.time.value = t;
    if (bloom) bloom.strength = 0.15 + light.lamps * 0.35;
  }

  // ---- the overlay ----
  function placeOverlay() {
    if (!island) return;
    for (const p of island.plates) {
      const at = toScreen(p.x, p.y, p.z);
      p.node.style.left = `${Math.round(at.left)}px`;
      p.node.style.top = `${Math.round(at.top)}px`;
      p.node.classList.toggle('hidden', !at.on);
    }
    for (const c of chars.values()) {
      const node = c.bubble.node;
      if (!c.bubble.text) {
        node.classList.add('hidden');
        continue;
      }
      const at = toScreen(c.x, c.y + 2.35, c.z);
      node.style.left = `${Math.round(at.left)}px`;
      node.style.top = `${Math.round(at.top)}px`;
      node.classList.toggle('hidden', !at.on);
    }
    if (hover && tipFor) {
      const o = tipFor.obj;
      const at = toScreen(o.position.x, o.position.y + tipFor.top, o.position.z);
      tip.style.left = `${Math.round(at.left)}px`;
      tip.style.top = `${Math.round(at.top)}px`;
    }
  }

  function setBubble(c, text, tone) {
    if (c.bubble.text === text && c.bubble.tone === tone) return;
    c.bubble.text = text;
    c.bubble.tone = tone;
    c.bubble.node.textContent = text;
    c.bubble.node.className = `office-bubble ${tone || ''}${text ? '' : ' hidden'}`;
  }

  // ---- pointer ----
  //
  // Hover names, click opens, drag orbits, wheel moves in. A click is a
  // press and release that did not travel, so an orbit never opens what it
  // started on.
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let hover = null;
  let tipFor = null;
  let drag = null;

  function pickAt(clientX, clientY) {
    const r = renderer.domElement.getBoundingClientRect();
    pointer.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(pickables, true);
    for (const h of hits) {
      let o = h.object;
      while (o && !o.userData.pick) o = o.parent;
      if (o) return o;
    }
    return null;
  }

  function setHover(o) {
    const p = o?.userData.pick || null;
    if (p === hover) return;
    hover = p;
    renderer.domElement.style.cursor = p ? 'pointer' : drag ? 'grabbing' : 'grab';
    const text = p?.kind === 'session' ? on.tip(p.id) : null;
    if (!text) {
      tip.classList.add('hidden');
      tipFor = null;
      return;
    }
    tip.textContent = text;
    tip.classList.remove('hidden');
    tipFor = { obj: o, top: p.top + 0.9 };
  }

  const canvas = renderer.domElement;
  canvas.style.cursor = 'grab';
  canvas.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, moved: false };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (drag && e.buttons) {
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (Math.hypot(dx, dy) > 4) drag.moved = true;
      if (drag.moved) {
        goal.yaw -= dx * 0.006;
        goal.pitch = Math.min(1.35, Math.max(0.12, goal.pitch + dy * 0.005));
        drag.x = e.clientX;
        drag.y = e.clientY;
        canvas.style.cursor = 'grabbing';
      }
      return;
    }
    setHover(pickAt(e.clientX, e.clientY));
  });
  canvas.addEventListener('pointerup', (e) => {
    const was = drag;
    drag = null;
    if (was && !was.moved) {
      const o = pickAt(e.clientX, e.clientY);
      const p = o?.userData.pick;
      if (p?.kind === 'session') on.session(p.id);
      if (p?.kind === 'project') on.project(p.repo);
    }
    setHover(pickAt(e.clientX, e.clientY));
    canvas.style.cursor = hover ? 'pointer' : 'grab';
  });
  canvas.addEventListener('pointerleave', () => setHover(null));
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      goal.dist = Math.min(220, Math.max(8, goal.dist * Math.exp(e.deltaY * 0.0012)));
    },
    { passive: false },
  );
  // ---- the loop ----
  let running = false;
  let raf = 0;
  let last = 0;
  // Everything that moves, one step on. Apart from the frame, a test page
  // runs it to fast-forward a scene it can only afford to draw once.
  function simulate(dt, t) {
    stepLight(dt, t);
    stepCamera(dt);
    stepChars(dt, t);
    stepDog(t);
    stepOrders(dt);
  }
  function frame(now) {
    raf = 0;
    if (!running) return;
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;
    simulate(dt, now / 1000);
    if (island) {
      composer.render();
      placeOverlay();
    }
    raf = requestAnimationFrame(frame);
  }
  const onVisible = () => {
    if (document.hidden) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    } else if (running && !raf) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  };
  document.addEventListener('visibilitychange', onVisible);

  // Sub-agents: smaller figures standing beside their session.
  function syncCrew(c, s) {
    const want = (s.crew || []).length;
    while (c.crew.length < want) {
      const k = buildFigure(hash(`${s.id}/${c.crew.length}`), C.crew, 0.6);
      k.group.position.set(c.x, c.y, c.z);
      scene.add(k.group);
      c.crew.push({ group: k.group, parts: k.parts, x: c.x, z: c.z, stride: 0 });
    }
    while (c.crew.length > want) scene.remove(c.crew.pop().group);
  }

  // ---- the API ----
  let lastKey = '';
  const gltfLoader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  gltfLoader.load(
    KIT_URL,
    (gltf) => {
      if (disposed) return;
      kit = prepareKit(gltf.scene);
      if (!kit) return;
      lastKey = '';
      on.asset?.();
    },
    undefined,
    () => {}, // the procedural palafitos are the deliberate missing-file fallback
  );

  Promise.all(
    Object.entries(CAFE_ASSETS).map(
      ([name, url]) =>
        new Promise((resolve, reject) => {
          gltfLoader.load(url, (gltf) => resolve([name, gltf.scene]), undefined, reject);
        }),
    ),
  )
    .then((assets) => {
      if (disposed) return;
      cafeKit = Object.fromEntries(assets);
      lastKey = '';
      on.asset?.();
    })
    .catch(() => {}); // the procedural café is the deliberate load-error fallback

  return {
    /**
     * Lay the resort out for what is true now.
     * @param {{ projects: {repo:string,label?:string}[], crowd: {id:string,repo:string,mood:string,status:string,crew:string[],orchestrator?:boolean,parentId?:string|null,note?:string}[], phase: string }} state
     * `mood` is `busy` | `lit` | `wait`; `status` decides who is at a table
     * and who is at the café; `note` is the line in the bubble over its head.
     */
    layout({ projects, crowd, phase: hour }) {
      phase = hour;
      const counts = new Map();
      const bosses = crowd.filter((s) => s.orchestrator);
      counts.set('__bosses__', bosses);
      for (const s of crowd) {
        if (s.orchestrator) continue;
        if (!counts.has(s.repo)) counts.set(s.repo, []);
        counts.get(s.repo).push(s);
      }
      // The resort only changes when a project comes or goes, or the number
      // of villas has to: those are the cheap things to compare, and a
      // rebuild is what would make a walking character's world jump.
      const key = JSON.stringify([projects.map((p) => p.repo), [...counts].map(([r, ss]) => [r, ss.length])]);
      if (key !== lastKey) {
        lastKey = key;
        const kept = [...chars.values()].map((c) => c.group);
        buildIsland(projects, counts);
        pickables.push(...kept);
        for (const c of chars.values()) if (!c.boss) c.y = DECK_Y;
      }
      const seen = new Set();
      const bossIds = new Set(bosses.map((b) => b.id));
      // The bosses first, so a worker arriving at its chair can find the
      // deck its order is fired from.
      bosses.forEach((s, i) => {
        seen.add(s.id);
        const c = chars.get(s.id) || spawn(s);
        const villa = island.villas[Math.min(i, island.villas.length - 1)];
        const spot = villa.stand;
        const kind = s.mood === 'wait' ? 'wait' : s.status === 'running' ? 'command' : 'stand';
        if (c.home?.x !== spot.x || c.home?.z !== spot.z || c.act?.kind !== kind) {
          c.home = spot;
          c.y = spot.y;
          c.route = [{ x: spot.x, z: spot.z }];
          c.act = { kind, facing: spot.facing };
          if (Math.hypot(c.x - spot.x, c.z - spot.z) < 0.05) {
            c.route = [];
            arrive(c);
          }
        }
        if (!c.megaphone) {
          c.megaphone = buildMegaphone();
          c.megaphone.rotation.x = -0.4;
          c.megaphone.position.set(0, -0.62, 0.22);
          c.parts.armR.add(c.megaphone);
        }
        setBubble(c, s.note || '', s.mood);
        syncCrew(c, s);
      });
      crowd.forEach((s) => {
        if (s.orchestrator) return;
        seen.add(s.id);
        const c = chars.get(s.id) || spawn(s);
        dress(c, s.mood);
        // Who is at work: a running turn sits at its project's table. A
        // question waiting on the reader, and everybody with nothing to do,
        // is at the café.
        const home = island.homes.get(s.repo);
        const working = s.status === 'running' && s.mood !== 'wait' && home;
        if (working) {
          let chair = home.chairs.find((q) => q.taken === s.id) || home.chairs.find((q) => !q.taken);
          if (!chair) {
            // A full table: the rest sit along the deck's rail beside it,
            // laptop on their knees, facing the table. The spot is kept once
            // taken so a re-layout does not shuffle them.
            if (c.seat?.kind === 'overflow' && c.seat.repo === s.repo) chair = c.seat;
            else {
              const n = [...chars.values()].filter(
                (o) => o.seat?.kind === 'overflow' && o.seat.repo === s.repo,
              ).length;
              chair = {
                x: home.x + 3.6,
                z: home.z + 2.2 - (n % 5) * 1.1,
                facing: -Math.PI / 2,
                kind: 'overflow',
                repo: s.repo,
                y: home.y,
              };
            }
          }
          if (c.seat !== chair || c.act?.kind !== 'type') {
            leaveSeat(c);
            chair.taken = s.id;
            const fromBoss = s.parentId && bossIds.has(s.parentId) ? s.parentId : null;
            sendTo(c, { x: chair.x, z: chair.z }, { kind: 'type', facing: chair.facing, fromBoss });
            c.seat = chair;
            c.home = chair;
            if (Math.hypot(c.x - chair.x, c.z - chair.z) < 0.05) {
              c.route = [];
              arrive(c);
            }
          }
        } else if (s.mood === 'wait') {
          // Standing at the café deck's front, facing the lagoon and, off to
          // the left, the villas.
          if (c.act?.kind !== 'wait') {
            c.home = null;
            const k = island.cafe;
            const i = [...chars.values()].filter((o) => o.act?.kind === 'wait').length;
            sendTo(
              c,
              { x: k.x - 4 + (i % 6) * 1.4, z: k.z + 4.8 + Math.floor(i / 6) },
              { kind: 'wait', facing: -0.6 },
            );
          }
        } else if (c.home || !c.act || c.act.kind === 'wait' || c.act.kind === 'type') {
          c.home = null;
          cafePlan(c);
        }
        // Props: the laptop and its glow for the typing, the cup for the rest.
        if (!c.laptop) {
          c.laptop = buildLaptop();
          c.laptop.position.set(0, 0.88, 0.62);
          c.group.add(c.laptop);
          c.glow = new THREE.Sprite(
            new THREE.SpriteMaterial({
              map: glow(),
              color: 0x9fd0ff,
              transparent: true,
              opacity: 0.35,
              blending: THREE.AdditiveBlending,
              depthWrite: false,
            }),
          );
          c.glow.scale.set(1.4, 1.0, 1);
          c.glow.position.set(0, 1.2, 0.55);
          c.group.add(c.glow);
          c.laptop.visible = c.glow.visible = false;
        }
        if (!c.cup) {
          c.cup = buildCup();
          c.cup.position.set(0, -0.72, 0.08);
          c.parts.armL.add(c.cup);
          c.cup.visible = false;
        }
        setBubble(c, s.note || '', s.mood);
        syncCrew(c, s);
      });
      for (const [id, c] of chars) {
        if (seen.has(id)) continue;
        leaveSeat(c);
        scene.remove(c.group);
        c.crew.forEach((k) => scene.remove(k.group));
        c.bubble.node.remove();
        pickables = pickables.filter((o) => o !== c.group);
        chars.delete(id);
      }
      if (!running) {
        stepLight(1, performance.now() / 1000);
        composer.render();
        placeOverlay();
      }
    },
    resize() {
      fit();
    },
    /** Swing the camera to the bosses' villa, the bungalows, the café, or back out to the whole resort. */
    focus(where) {
      if (!island) return;
      if (where === 'villa') {
        const v = island.villas[0];
        goal.target.set(v.x + 1, 2.5, v.z - 2);
        goal.dist = 22;
        goal.yaw = 1.9;
        goal.pitch = 0.32;
      } else if (where === 'beach') {
        const xs = [...island.homes.values()].map((h) => h.x);
        goal.target.set(xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : 0, 1.5, 0);
        goal.dist = Math.max(24, (xs.length ? Math.max(...xs) - Math.min(...xs) : 10) * 1.1 + 16);
        goal.yaw = 0.25;
        goal.pitch = 0.4;
      } else if (where === 'cafe') {
        goal.target.set(island.cafe.x, 1.8, island.cafe.z + 2);
        goal.dist = 20;
        goal.yaw = 0.5;
        goal.pitch = 0.35;
      } else fit(true);
    },
    start() {
      if (running) return;
      running = true;
      last = performance.now();
      wakeBeachAudio();
      if (!document.hidden) raf = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      quietBeachAudio();
    },
    /** Enable or mute the optional beach ambience. Must be called from a user gesture the first time. */
    sound(enabled) {
      beachSoundWanted = !!enabled;
      if (beachSoundWanted && !ensureBeachAudio()) return false;
      if (beachSoundWanted) wakeBeachAudio();
      else quietBeachAudio();
      return true;
    },
    /** The scene's innards, for a test page to fast-forward and draw once. */
    debug() {
      return { renderer, scene, camera, composer, goal, step: simulate, overlay: placeOverlay };
    },
    dispose() {
      disposed = true;
      this.stop();
      document.removeEventListener('visibilitychange', onVisible);
      pmrem.dispose();
      composer?.dispose();
      renderer.dispose();
      clearTimeout(beachPauseTimer);
      beachAudio?.sources.forEach((source) => source.stop());
      beachAudio?.context.close();
      renderer.domElement.remove();
      overlay.remove();
    },
  };
}
