import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

// ---------- config ----------
const LANE_X = 2.3;
const SPAWN_Z = -150;
const KILL_Z = 8;
const GRAVITY = 22;
const JUMP_V = 7.6;
const START_SPEED = 14;
const SPEED_RAMP = 0.22;
const MAX_SPEED = 34;

const PLAYER = { dir: "assets/cat2/", prefix: "cat2_", frames: 24, h: 1.7, aspect: 286 / 448 };
const CHASER = { dir: "assets/dog2/", prefix: "dog2_", frames: 15, h: 1.5, aspect: 270 / 613 };

const LS_KEY = "nekochase_scores";

const DEATH_MSG = {
  redcandle: "RED CANDLE GOT YOU.",
  hurdle: "FACEPLANTED THE HURDLE.",
  cucumber: "CUCUMBER JUMPSCARE.",
  roomba: "ROOMBA'D INTO OBLIVION.",
};

const POWERUPS = {
  ninelives: { name: "NINE LIVES", color: 0xff9fb8, weight: 4 },
  zoomies:   { name: "ZOOMIES",    color: 0xffd738, weight: 4 },
  frenzy:    { name: "PUMP MODE",  color: 0x16c784, weight: 5 },
  firework:  { name: "FIREWORK",   color: 0xe0402e, weight: 4 },
  cataclysm: { name: "CAT-ACLYSM", color: 0x9d4dff, weight: 1 },
};

const RANKS = [
  ["Wet Paper Paw", 0], ["Litter Rookie", 500], ["Alley Runner", 1500],
  ["Street Legend", 3000], ["Nine-Life Baron", 6000], ["NEKO GOD", 12000],
];
function rankFor(score) {
  let name = RANKS[0][0];
  for (const [n, min] of RANKS) if (score >= min) name = n;
  return name;
}

// obstacle stats: damage dealt, dash-breakable, spawn tier + weight
const OB_CFG = {
  hurdle:    { dmg: 1, breakable: true,  tier: 0, w: 3 },
  cucumber:  { dmg: 1, breakable: true,  tier: 0, w: 2 },
  redcandle: { dmg: 1, breakable: true,  tier: 1, w: 3 },
  roomba:    { dmg: 2, breakable: false, tier: 2, w: 1 },
};
function tierFor(t) { return t < 12 ? 0 : t < 32 ? 1 : t < 60 ? 2 : 3; }
function pickWeighted(entries) {
  let total = 0;
  for (const [, w] of entries) total += w;
  let r = Math.random() * total;
  for (const [k, w] of entries) { r -= w; if (r <= 0) return k; }
  return entries[entries.length - 1][0];
}

// ---------- dom ----------
const canvas = document.getElementById("game");
const ui = {
  menu: document.getElementById("menu"),
  paused: document.getElementById("paused"),
  gameover: document.getElementById("gameover"),
  leaderboard: document.getElementById("leaderboard"),
  pauseBtn: document.getElementById("pauseBtn"),
  hud: document.getElementById("hud"),
  hudDistance: document.getElementById("hudDistance"),
  hudFish: document.getElementById("hudFish"),
  hudCombo: document.getElementById("hudCombo"),
  hudLives: document.getElementById("hudLives"),
  finalRank: document.getElementById("finalRank"),
  fxbar: document.getElementById("fxbar"),
  toast: document.getElementById("toast"),
  name: document.getElementById("landingPlayerName"),
  twitter: document.getElementById("landingPlayerTwitter"),
  deathMsg: document.getElementById("deathMsg"),
  finalDistance: document.getElementById("finalDistance"),
  finalFish: document.getElementById("finalFish"),
  finalScore: document.getElementById("finalScore"),
  newBest: document.getElementById("newBest"),
  scoreList: document.getElementById("scoreList"),
};

// ---------- audio engine (WebAudio synth & background MP3s) ----------
const audio = {
  ctx: null, noise: null, sfxGain: null, musicGain: null,
  track1: null, track2: null, track1Source: null, track2Source: null, currentTrack: 0,

  ensure() {
    if (this.ctx) return true;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.sfxGain = this.ctx.createGain();
      this.sfxGain.gain.value = 0.9;
      this.sfxGain.connect(this.ctx.destination);
      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = 0.30;
      this.musicGain.connect(this.ctx.destination);

      // Create Audio elements
      this.track1 = new Audio("Josef Bel Habib - Play Me Like That Video Game (SPOTISAVER).mp3.mpeg");
      this.track1.loop = true;
      this.track1Source = this.ctx.createMediaElementSource(this.track1);
      this.track1Source.connect(this.musicGain);

      this.track2 = new Audio("Josef Bel Habib - Time to Level Up (SPOTISAVER).mp3.mpeg");
      this.track2.loop = true;
      this.track2Source = this.ctx.createMediaElementSource(this.track2);
      this.track2Source.connect(this.musicGain);

      const buf = this.ctx.createBuffer(1, this.ctx.sampleRate, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      this.noise = buf;
      return true;
    } catch (e) {
      console.error("Audio initialization failed:", e);
      return false;
    }
  },

  tone(freq, dur, { type = "sine", vol = 0.05, to = 0, at = 0 } = {}) {
    if (!this.ensure()) return;
    const t0 = this.ctx.currentTime + at;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (to) o.frequency.exponentialRampToValueAtTime(Math.max(30, to), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(this.sfxGain);
    o.start(t0); o.stop(t0 + dur + 0.02);
  },

  hiss(dur, { vol = 0.08, from = 3000, to = 400, at = 0 } = {}) {
    if (!this.ensure()) return;
    const t0 = this.ctx.currentTime + at;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise; src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.setValueAtTime(from, t0);
    f.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(this.sfxGain);
    src.start(t0); src.stop(t0 + dur + 0.02);
  },

  jump() {
    this.tone(240, 0.16, { type: "sine", vol: 0.06, to: 560 });
    this.tone(240, 0.16, { type: "triangle", vol: 0.03, to: 560 });
  },
  swish() { this.hiss(0.12, { vol: 0.03, from: 900, to: 2600 }); },
  candle() {
    this.tone(988, 0.07, { type: "triangle", vol: 0.07 });
    this.tone(1319, 0.11, { type: "triangle", vol: 0.07, at: 0.06 });
  },
  powerup() {
    this.tone(523, 0.09, { type: "triangle", vol: 0.07 });
    this.tone(659, 0.09, { type: "triangle", vol: 0.07, at: 0.08 });
    this.tone(784, 0.16, { type: "triangle", vol: 0.08, at: 0.16 });
  },
  rocket() {
    this.tone(180, 0.35, { type: "sawtooth", vol: 0.04, to: 900 });
    this.hiss(0.35, { vol: 0.05, from: 1200, to: 4500 });
  },
  boom() {
    this.tone(90, 0.5, { type: "sine", vol: 0.12, to: 40 });
    this.hiss(0.5, { vol: 0.12, from: 4000, to: 200 });
  },
  die() {
    this.tone(420, 0.7, { type: "square", vol: 0.05, to: 90 });
    this.hiss(0.6, { vol: 0.06, from: 2000, to: 150 });
  },

  startMusic() {
    if (!this.ensure()) return;
    this.currentTrack = 1;
    this.track1.volume = 1;
    this.track2.volume = 0;
    this.track1.currentTime = 0;
    this.track2.currentTime = 0;
    
    // Play both tracks on user gesture to prevent browser blocking on auto-fade
    this.track1.play().catch(e => console.log("Play track1 failed:", e));
    this.track2.play().catch(e => console.log("Play track2 failed:", e));
  },

  fadeToTrack2() {
    if (this.currentTrack !== 1) return;
    this.currentTrack = 2;
    if (!this.track2) return;

    let duration = 2500; // 2.5 seconds fade
    let intervalTime = 50;
    let steps = duration / intervalTime;
    let step = 0;
    const interval = setInterval(() => {
      step++;
      let t = step / steps;
      if (this.track1) this.track1.volume = 1 - t;
      if (this.track2) this.track2.volume = t;
      if (step >= steps) {
        clearInterval(interval);
        if (this.track1) {
          this.track1.pause();
          this.track1.volume = 0;
        }
        if (this.track2) {
          this.track2.volume = 1;
        }
      }
    }, intervalTime);
  },

  stopMusic() {
    this.currentTrack = 0;
    if (this.track1) {
      this.track1.pause();
      this.track1.volume = 1;
    }
    if (this.track2) {
      this.track2.pause();
      this.track2.volume = 0;
    }
  },

  suspend() {
    if (this.ctx) this.ctx.suspend();
    if (this.currentTrack === 1 && this.track1) this.track1.pause();
    if (this.currentTrack === 2 && this.track2) this.track2.pause();
  },
  resume() {
    if (this.ctx) this.ctx.resume();
    if (this.currentTrack === 1 && this.track1) this.track1.play().catch(e => {});
    if (this.currentTrack === 2 && this.track2) this.track2.play().catch(e => {});
  },
};

// ---------- renderer / composer ----------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xc4e0f4, 60, 220);

const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 400);
camera.position.set(0, 2.8, 6.2);
camera.lookAt(0, 1.1, -12);

const composer = new EffectComposer(renderer);
composer.setSize(window.innerWidth, window.innerHeight);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.5, 0.4, 0.85);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// bloom auto-disables on slow renderers (e.g. software WebGL) after a few frames
let bloomOn = !new URLSearchParams(location.search).has("nobloom");
let perfAccum = 0, perfFrames = 0, perfSettled = false;
function trackPerf(dt) {
  if (perfSettled) return;
  perfFrames++;
  if (perfFrames <= 10) return;          // skip warm-up/compile frames
  perfAccum += dt;
  if (perfFrames >= 70) {
    const avg = perfAccum / (perfFrames - 10);
    if (avg > 0.07 && bloomOn) {
      bloomOn = false;
      console.warn(`nekochase: avg frame ${(avg * 1000) | 0}ms — bloom disabled`);
    }
    perfSettled = true;
  }
}

scene.add(new THREE.AmbientLight(0xffffff, 0.95));
const sunLight = new THREE.DirectionalLight(0xfff2cc, 1.0);
sunLight.position.set(8, 14, 4);
scene.add(sunLight);
const greenLight = new THREE.PointLight(0x2ee08a, 0, 14);
greenLight.position.set(0, 2, 0);
scene.add(greenLight);

// sky gradient
{
  const c = document.createElement("canvas");
  c.width = 2; c.height = 512;
  const g = c.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, "#2f7fd6");
  grad.addColorStop(0.55, "#8ec4ef");
  grad.addColorStop(0.82, "#cfe7f8");
  grad.addColorStop(1, "#f2e9d8");
  g.fillStyle = grad;
  g.fillRect(0, 0, 2, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  scene.background = tex;
}

function canvasTexture(w, h, drawFn) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  drawFn(c.getContext("2d"), w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function billboard(tex, w, h) {
  return new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.08, side: THREE.DoubleSide, fog: true })
  );
}

// ---------- ground ----------
const GROUND_TILE = 25;
const groundTex = canvasTexture(2048, 2048, (g) => {
  // layered grass
  g.fillStyle = "#4b9a3e"; g.fillRect(0, 0, 2048, 2048);
  g.fillStyle = "#55a946"; g.fillRect(0, 0, 2048, 1024);
  for (let i = 0; i < 260; i++) {
    const x = Math.random() * 2048, y = Math.random() * 2048, r = 30 + Math.random() * 120;
    g.fillStyle = Math.random() < 0.5 ? "rgba(60,130,50,.12)" : "rgba(120,190,95,.10)";
    g.beginPath(); g.ellipse(x, y, r, r * 0.6, Math.random() * 3, 0, 6.29); g.fill();
  }
  for (let i = 0; i < 4200; i++) {
    const x = Math.random() * 2048, y = Math.random() * 2048;
    g.strokeStyle = Math.random() < 0.5 ? "rgba(25,80,20,.28)" : "rgba(150,220,120,.22)";
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + (Math.random() - 0.5) * 6, y - 6 - Math.random() * 8); g.stroke();
  }
  // wildflowers on the lawn (outside the path)
  for (let i = 0; i < 160; i++) {
    let x = Math.random() * 2048;
    if (x > 740 && x < 1308) continue;
    const y = Math.random() * 2048;
    g.fillStyle = ["#ff8fb8", "#fff", "#ffd738", "#8fb8ff"][i % 4];
    g.beginPath(); g.arc(x, y, 6, 0, 6.29); g.fill();
    g.fillStyle = "rgba(255,220,80,.9)";
    g.beginPath(); g.arc(x, y, 2.4, 0, 6.29); g.fill();
  }
  // gravel path
  const grad = g.createLinearGradient(1024 - 156, 0, 1024 + 156, 0);
  grad.addColorStop(0, "#c9b487");
  grad.addColorStop(0.5, "#dcc99b");
  grad.addColorStop(1, "#c9b487");
  g.fillStyle = grad;
  g.fillRect(1024 - 156, 0, 312, 2048);
  for (let i = 0; i < 1600; i++) {
    const x = 1024 - 150 + Math.random() * 300, y = Math.random() * 2048;
    g.fillStyle = ["rgba(110,92,64,.25)", "rgba(255,255,255,.22)", "rgba(160,140,100,.3)"][i % 3];
    g.beginPath(); g.arc(x, y, 1.6 + Math.random() * 3.4, 0, 6.29); g.fill();
  }
  // center wear
  g.fillStyle = "rgba(120,100,70,.10)";
  for (const cx of [1024 - 96, 1024, 1024 + 96]) g.fillRect(cx - 26, 0, 52, 2048);
  g.strokeStyle = "rgba(255,255,255,.9)";
  g.lineWidth = 10;
  for (const x of [1024 - 156, 1024 + 156]) {
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 2048); g.stroke();
  }
  g.strokeStyle = "rgba(255,255,255,.5)";
  g.setLineDash([88, 88]);
  g.lineWidth = 8;
  for (const x of [1024 - 48, 1024 + 48]) {
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 2048); g.stroke();
  }
});
groundTex.wrapS = THREE.RepeatWrapping;
groundTex.wrapT = THREE.RepeatWrapping;
groundTex.repeat.set(1, 400 / GROUND_TILE);
groundTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(50, 400),
  new THREE.MeshBasicMaterial({ map: groundTex, fog: true })
);
ground.rotation.x = -Math.PI / 2;
ground.position.set(0, 0, -170);
scene.add(ground);

// ---------- skyline ----------
const houseTex = canvasTexture(1024, 400, (g) => {
  const cx = 512, base = 380;
  g.fillStyle = "#f6f4ee"; g.fillRect(cx - 400, base - 210, 800, 210);
  g.fillStyle = "#e3e0d6"; g.fillRect(cx - 400, base - 210, 800, 22);
  g.fillStyle = "#f6f4ee"; g.fillRect(cx - 350, base - 238, 700, 28);
  g.fillStyle = "#efece2";
  g.beginPath();
  g.moveTo(cx - 140, base - 210); g.lineTo(cx, base - 272); g.lineTo(cx + 140, base - 210);
  g.closePath(); g.fill();
  g.fillStyle = "#fff";
  for (let i = -2; i <= 2; i++) g.fillRect(cx + i * 54 - 9, base - 204, 18, 204);
  g.fillStyle = "#8a93a8";
  for (let i = 0; i < 6; i++) {
    for (const side of [-1, 1]) {
      const x = cx + side * (180 + i * 36);
      g.fillRect(x, base - 166, 24, 44);
      g.fillRect(x, base - 92, 24, 44);
    }
  }
  g.fillStyle = "#39424f"; g.fillRect(cx - 22, base - 84, 44, 84);
  g.strokeStyle = "#888"; g.lineWidth = 5;
  g.beginPath(); g.moveTo(cx, base - 272); g.lineTo(cx, base - 356); g.stroke();
  g.fillStyle = "#c22"; g.fillRect(cx, base - 356, 62, 34);
  g.fillStyle = "#fff"; g.fillRect(cx, base - 345, 62, 8);
  g.fillStyle = "#224"; g.fillRect(cx, base - 356, 26, 19);
});
const house = billboard(houseTex, 46, 18);
house.position.set(0, 9.2, -200);
scene.add(house);

// distant treeline wall (house rises above it)
{
  const wall = new THREE.Mesh(
    new THREE.BoxGeometry(360, 4.5, 3),
    new THREE.MeshLambertMaterial({ color: 0x2a5c26 })
  );
  wall.position.set(0, 2.2, -186);
  scene.add(wall);
}

// Washington Monument
{
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.9, 1.5, 26, 4),
    new THREE.MeshLambertMaterial({ color: 0xf2efe6 })
  );
  shaft.rotation.y = Math.PI / 4;
  shaft.position.set(-34, 13, -195);
  const tip = new THREE.Mesh(
    new THREE.ConeGeometry(1.0, 3, 4),
    new THREE.MeshLambertMaterial({ color: 0xe8e4d6 })
  );
  tip.rotation.y = Math.PI / 4;
  tip.position.set(-34, 27.5, -195);
  scene.add(shaft); scene.add(tip);
}

// hot-air balloon
const balloon = new THREE.Group();
{
  const env = new THREE.Mesh(
    new THREE.SphereGeometry(2.6, 18, 14),
    new THREE.MeshLambertMaterial({ color: 0xe0402e })
  );
  env.scale.y = 1.15;
  const stripe = new THREE.Mesh(
    new THREE.SphereGeometry(2.62, 18, 14, 0, Math.PI * 2, 1.1, 0.5),
    new THREE.MeshLambertMaterial({ color: 0xffffff })
  );
  stripe.scale.y = 1.15;
  const basket = new THREE.Mesh(
    new THREE.BoxGeometry(1.1, 0.8, 1.1),
    new THREE.MeshLambertMaterial({ color: 0x7a5230 })
  );
  basket.position.y = -3.9;
  balloon.add(env); balloon.add(stripe); balloon.add(basket);
  balloon.position.set(22, 20, -150);
  scene.add(balloon);
}

// birds
const birdTex = canvasTexture(64, 32, (g) => {
  g.strokeStyle = "#2a2a35"; g.lineWidth = 4; g.lineCap = "round";
  g.beginPath(); g.moveTo(6, 22); g.quadraticCurveTo(18, 8, 32, 20); g.quadraticCurveTo(46, 8, 58, 22); g.stroke();
});
const birds = [];
for (let i = 0; i < 5; i++) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: birdTex, transparent: true, fog: false }));
  sp.scale.set(2.2, 1.1, 1);
  sp.position.set(-80 + Math.random() * 160, 16 + Math.random() * 12, -160);
  scene.add(sp);
  birds.push({ sp, v: 2 + Math.random() * 2.5, bob: Math.random() * 6 });
}

// ---------- 3D roadside ----------
const scenery = [];
function addScenery(mesh, span) { scene.add(mesh); scenery.push({ mesh, span }); }

function makeTree3D() {
  const grp = new THREE.Group();
  const trunkH = 1.2 + Math.random() * 0.6;
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.1, 0.18, trunkH, 7),
    new THREE.MeshLambertMaterial({ color: 0x6b4a2b })
  );
  trunk.position.y = trunkH / 2;
  grp.add(trunk);
  if (Math.random() < 0.35) {
    // pine
    const c = new THREE.Color(0x1f6b34).offsetHSL(0, 0, (Math.random() - 0.5) * 0.08);
    const mat = new THREE.MeshLambertMaterial({ color: c });
    for (let i = 0; i < 3; i++) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(1.15 - i * 0.3, 1.2, 9), mat);
      cone.position.y = trunkH + 0.4 + i * 0.75;
      grp.add(cone);
    }
  } else {
    // deciduous: clustered spheres
    const c = new THREE.Color(0x2f7a2e).offsetHSL((Math.random() - 0.5) * 0.03, 0, (Math.random() - 0.5) * 0.1);
    const mat = new THREE.MeshLambertMaterial({ color: c });
    const blobs = [
      [0, trunkH + 0.9, 0, 1.0],
      [-0.6, trunkH + 0.6, 0.15, 0.7],
      [0.55, trunkH + 0.65, -0.1, 0.72],
      [0.05, trunkH + 1.5, 0.05, 0.65],
    ];
    for (const [x, y, z, r] of blobs) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), mat);
      s.position.set(x, y, z);
      grp.add(s);
    }
  }
  const s = 0.85 + Math.random() * 0.6;
  grp.scale.set(s, s, s);
  return grp;
}

function makeHedge3D() {
  const grp = new THREE.Group();
  const c = new THREE.Color(0x2f6e2a).offsetHSL(0, 0, (Math.random() - 0.5) * 0.06);
  const mat = new THREE.MeshLambertMaterial({ color: c });
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.9, 1.05, 1.0), mat);
  body.position.y = 0.52;
  grp.add(body);
  const top = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.35, 0.8), new THREE.MeshLambertMaterial({ color: c.clone().offsetHSL(0, 0, 0.05) }));
  top.position.y = 1.2;
  grp.add(top);
  return grp;
}

for (let i = 0; i < 14; i++) {
  for (const side of [-1, 1]) {
    const hedge = makeHedge3D();
    hedge.position.set(side * 6.6, 0, -i * 14 - Math.random() * 4);
    addScenery(hedge, 14 * 14);
  }
}
for (let i = 0; i < 9; i++) {
  for (const side of [-1, 1]) {
    const tree = makeTree3D();
    tree.position.set(side * (9.5 + Math.random() * 3.5), 0, -i * 22 - Math.random() * 8);
    addScenery(tree, 9 * 22);
  }
}
// rolling hills far out
for (let i = 0; i < 6; i++) {
  for (const side of [-1, 1]) {
    const hill = new THREE.Mesh(
      new THREE.SphereGeometry(7 + Math.random() * 5, 14, 10),
      new THREE.MeshLambertMaterial({ color: new THREE.Color(0x478f3a).offsetHSL(0, 0, (Math.random() - 0.5) * 0.05) })
    );
    hill.scale.set(1.6, 0.28 + Math.random() * 0.12, 1.1);
    hill.position.set(side * (18 + Math.random() * 7), 0, -i * 40 - Math.random() * 12);
    addScenery(hill, 6 * 40);
  }
}
// flower patches
const flowerTex = canvasTexture(256, 96, (g) => {
  for (let i = 0; i < 26; i++) {
    const x = 10 + Math.random() * 236, y = 40 + Math.random() * 46;
    g.strokeStyle = "#2f7a2a"; g.lineWidth = 3;
    g.beginPath(); g.moveTo(x, y + 14); g.lineTo(x, y); g.stroke();
    g.fillStyle = ["#ff5f8f", "#fff", "#ffd738", "#ff8a2a", "#8fb8ff"][i % 5];
    for (let p = 0; p < 5; p++) {
      const a = (p / 5) * 6.29;
      g.beginPath(); g.arc(x + Math.cos(a) * 5, y + Math.sin(a) * 5, 4, 0, 6.29); g.fill();
    }
    g.fillStyle = "#ffdf60";
    g.beginPath(); g.arc(x, y, 3.4, 0, 6.29); g.fill();
  }
});
for (let i = 0; i < 10; i++) {
  for (const side of [-1, 1]) {
    const patch = billboard(flowerTex, 2.6, 1.0);
    patch.position.set(side * (5.2 + Math.random() * 0.4), 0.5, -i * 19 - 6 - Math.random() * 5);
    addScenery(patch, 10 * 19);
  }
}
// white picket fence
{
  const fenceMat = new THREE.MeshLambertMaterial({ color: 0xefebe0 });
  for (let i = 0; i < 34; i++) {
    for (const side of [-1, 1]) {
      const seg = new THREE.Group();
      const rail = new THREE.Mesh(new THREE.BoxGeometry(3.9, 0.09, 0.06), fenceMat);
      rail.position.y = 0.62;
      seg.add(rail);
      const rail2 = rail.clone();
      rail2.position.y = 0.34;
      seg.add(rail2);
      for (let p = 0; p < 4; p++) {
        const picket = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.85, 0.06), fenceMat);
        picket.position.set(-1.47 + p * 0.98, 0.42, 0);
        seg.add(picket);
      }
      seg.position.set(side * 4.55, 0, -i * 4 + 4);
      addScenery(seg, 34 * 4);
    }
  }
}
// lampposts with flags
{
  const poleMat = new THREE.MeshLambertMaterial({ color: 0x2e3340 });
  const flagTex = canvasTexture(64, 40, (g) => {
    g.fillStyle = "#c22"; g.fillRect(0, 0, 64, 40);
    g.fillStyle = "#fff";
    for (let s = 0; s < 3; s++) g.fillRect(0, 6 + s * 12, 64, 5);
    g.fillStyle = "#224"; g.fillRect(0, 0, 26, 20);
  });
  for (let i = 0; i < 6; i++) {
    for (const side of [-1, 1]) {
      const lamp = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 3.4, 8), poleMat);
      pole.position.y = 1.7;
      lamp.add(pole);
      const head = new THREE.Mesh(
        new THREE.SphereGeometry(0.22, 10, 8),
        new THREE.MeshStandardMaterial({ color: 0xfff2b0, emissive: 0xffe9a0, emissiveIntensity: 0.7 })
      );
      head.position.y = 3.45;
      lamp.add(head);
      const flag = new THREE.Mesh(
        new THREE.PlaneGeometry(0.65, 0.4),
        new THREE.MeshBasicMaterial({ map: flagTex, side: THREE.DoubleSide, fog: true })
      );
      flag.position.set(0.38, 3.0, 0);
      lamp.add(flag);
      lamp.position.set(side * 5.6, 0, -i * 28 - 8);
      addScenery(lamp, 6 * 28);
    }
  }
}

// clouds + sun
const cloudTex = canvasTexture(256, 128, (g) => {
  g.fillStyle = "rgba(255,255,255,.95)";
  g.beginPath(); g.ellipse(128, 70, 92, 34, 0, 0, 6.29); g.fill();
  g.beginPath(); g.ellipse(84, 52, 48, 26, 0, 0, 6.29); g.fill();
  g.beginPath(); g.ellipse(174, 56, 44, 24, 0, 0, 6.29); g.fill();
});
const clouds = [];
for (let i = 0; i < 8; i++) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: cloudTex, transparent: true, fog: false, opacity: 0.9 }));
  sp.scale.set(18 + Math.random() * 14, 7 + Math.random() * 4, 1);
  sp.position.set(-90 + Math.random() * 180, 24 + Math.random() * 16, -190);
  scene.add(sp);
  clouds.push({ sp, v: 0.6 + Math.random() * 0.9 });
}
{
  const sunTex = canvasTexture(128, 128, (g) => {
    const grad = g.createRadialGradient(64, 64, 6, 64, 64, 62);
    grad.addColorStop(0, "rgba(255,250,220,1)");
    grad.addColorStop(0.4, "rgba(255,244,180,.9)");
    grad.addColorStop(1, "rgba(255,240,160,0)");
    g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  });
  const sun = new THREE.Sprite(new THREE.SpriteMaterial({ map: sunTex, transparent: true, fog: false }));
  sun.scale.set(34, 34, 1);
  sun.position.set(60, 44, -195);
  scene.add(sun);
}

// drifting pollen motes
const motes = [];
{
  const moteTex = canvasTexture(32, 32, (g) => {
    const grad = g.createRadialGradient(16, 16, 1, 16, 16, 15);
    grad.addColorStop(0, "rgba(255,255,230,.9)");
    grad.addColorStop(1, "rgba(255,255,230,0)");
    g.fillStyle = grad; g.fillRect(0, 0, 32, 32);
  });
  for (let i = 0; i < 26; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: moteTex, transparent: true, opacity: 0.5, fog: false }));
    sp.scale.set(0.12, 0.12, 1);
    sp.position.set((Math.random() - 0.5) * 22, 0.4 + Math.random() * 4, -Math.random() * 45);
    scene.add(sp);
    motes.push({ sp, sway: Math.random() * 6.28 });
  }
}

// ---------- sprite characters ----------
const loader = new THREE.TextureLoader();
function loadFrames(cfg) {
  const frames = [];
  for (let i = 0; i < cfg.frames; i++) {
    const t = loader.load(`${cfg.dir}${cfg.prefix}${String(i).padStart(2, "0")}.png`);
    t.colorSpace = THREE.SRGBColorSpace;
    frames.push(t);
  }
  return frames;
}
const catFrames = loadFrames(PLAYER);
const dogFrames = loadFrames(CHASER);

const shadowTex = canvasTexture(128, 128, (g) => {
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 60);
  grad.addColorStop(0, "rgba(10,40,8,.4)");
  grad.addColorStop(1, "rgba(10,40,8,0)");
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
});
function makeShadow(size) {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size * 0.55),
    new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, fog: true })
  );
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.02;
  return m;
}

const player = {
  lane: 0, laneX: 0, elev: 0, vy: 0, onGround: true, wasGrounded: true, frame: 0, ft: 0,
  shield: false, zoomies: 0, frenzy: 0, invuln: 0, trailT: 0,
  mesh: billboard(catFrames[0], PLAYER.h * PLAYER.aspect, PLAYER.h),
  shadow: makeShadow(1.5),
  bubble: null,
};
player.mesh.position.set(0, PLAYER.h / 2, 0);
scene.add(player.mesh);
scene.add(player.shadow);
{
  player.bubble = new THREE.Mesh(
    new THREE.SphereGeometry(1.15, 20, 16),
    new THREE.MeshStandardMaterial({
      color: 0xbfe8ff, transparent: true, opacity: 0.22,
      emissive: 0x9fd8ff, emissiveIntensity: 0.9,
      roughness: 0.1, metalness: 0.1, depthWrite: false,
    })
  );
  player.bubble.visible = false;
  scene.add(player.bubble);
}

const chaser = {
  laneX: 0, frame: 0, ft: 0,
  mesh: billboard(dogFrames[0], CHASER.h * CHASER.aspect, CHASER.h),
  shadow: makeShadow(1.6),
};
chaser.mesh.position.set(0, CHASER.h / 2, 3.1);
chaser.shadow.position.set(0, 0.02, 3.1);
scene.add(chaser.mesh);
scene.add(chaser.shadow);

// ---------- world objects ----------
let objs = [];
let projectiles = [];
let particles = [];
let trails = [];

const speedLines = [];
{
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 });
  const geo = new THREE.BoxGeometry(0.035, 0.035, 2.8);
  for (let i = 0; i < 26; i++) {
    const m = new THREE.Mesh(geo, mat);
    m.visible = false;
    scene.add(m);
    speedLines.push({ mesh: m, active: false });
  }
}

function disposeObj(o) {
  scene.remove(o.mesh);
  if (o.shadow) scene.remove(o.shadow);
}

const greenCandleMat = new THREE.MeshStandardMaterial({ color: 0x16c784, emissive: 0x16c784, emissiveIntensity: 1.15, roughness: 0.35 });
const redCandleMat = new THREE.MeshStandardMaterial({ color: 0xe0402e, emissive: 0xe0402e, emissiveIntensity: 0.7, roughness: 0.35 });
const wickMat = new THREE.MeshBasicMaterial({ color: 0x222226 });

function candleMesh(mat, w, h) {
  const grp = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), mat);
  grp.add(body);
  const wickTop = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, h * 0.42, 6), wickMat);
  wickTop.position.y = h * 0.7;
  grp.add(wickTop);
  const wickBot = wickTop.clone();
  wickBot.position.y = -h * 0.7;
  grp.add(wickBot);
  return grp;
}

function makeGreenCandle(lane, z, elev) {
  const mesh = candleMesh(greenCandleMat, 0.3, 0.6);
  scene.add(mesh);
  return { kind: "candle", lane, elev, z, spin: Math.random() * 6.28, mesh };
}
function makeRedCandle(lane) {
  const mesh = candleMesh(redCandleMat, 0.6, 1.0);
  const shadow = makeShadow(1.4);
  scene.add(mesh); scene.add(shadow);
  return { kind: "redcandle", lane, elev: 0, z: SPAWN_Z, mesh, shadow };
}
function makeHurdle(lane) {
  const grp = new THREE.Group();
  const postMat = new THREE.MeshLambertMaterial({ color: 0xf5f5f5 });
  for (const px of [-0.8, 0.8]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.78, 0.1), postMat);
    post.position.set(px, 0.39, 0);
    grp.add(post);
  }
  const bar = new THREE.Mesh(
    new THREE.BoxGeometry(1.76, 0.16, 0.1),
    new THREE.MeshStandardMaterial({ color: 0xe0402e, emissive: 0xe0402e, emissiveIntensity: 0.3 })
  );
  bar.position.y = 0.7;
  grp.add(bar);
  const bar2 = new THREE.Mesh(new THREE.BoxGeometry(1.76, 0.1, 0.08), postMat);
  bar2.position.y = 0.38;
  grp.add(bar2);
  const shadow = makeShadow(1.9);
  scene.add(grp); scene.add(shadow);
  return { kind: "hurdle", lane, elev: 0, z: SPAWN_Z, mesh: grp, shadow };
}
function makeCucumber(lane) {
  const mesh = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.24, 1.5, 6, 12),
    new THREE.MeshStandardMaterial({ color: 0x2e8b2e, roughness: 0.6 })
  );
  mesh.rotation.z = Math.PI / 2;
  mesh.rotation.y = 0.35;
  const shadow = makeShadow(1.6);
  scene.add(mesh); scene.add(shadow);
  return { kind: "cucumber", lane, elev: 0, z: SPAWN_Z, mesh, shadow };
}
function makeRoomba(lane) {
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.62, 0.66, 0.24, 24),
    new THREE.MeshStandardMaterial({ color: 0x2a2a30, roughness: 0.4, metalness: 0.3 })
  );
  const btn = new THREE.Mesh(
    new THREE.CylinderGeometry(0.12, 0.12, 0.06, 12),
    new THREE.MeshStandardMaterial({ color: 0xe0402e, emissive: 0xe0402e, emissiveIntensity: 0.8 })
  );
  btn.position.y = 0.15;
  body.add(btn);
  const shadow = makeShadow(1.5);
  scene.add(body); scene.add(shadow);
  return { kind: "roomba", lane, laneX: lane, elev: 0, z: SPAWN_Z, shiftT: 1 + Math.random(), mesh: body, shadow };
}

// distinct power-up models
function heartGeo() {
  const s = new THREE.Shape();
  s.moveTo(0, 0.3);
  s.bezierCurveTo(0, 0.52, -0.32, 0.52, -0.32, 0.28);
  s.bezierCurveTo(-0.32, 0.06, -0.04, -0.02, 0, -0.3);
  s.bezierCurveTo(0.04, -0.02, 0.32, 0.06, 0.32, 0.28);
  s.bezierCurveTo(0.32, 0.52, 0, 0.52, 0, 0.3);
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.16, bevelEnabled: true, bevelSize: 0.03, bevelThickness: 0.03, bevelSegments: 2 });
  g.center();
  return g;
}
function boltGeo() {
  const s = new THREE.Shape();
  s.moveTo(-0.06, 0.5); s.lineTo(0.2, 0.5); s.lineTo(0.04, 0.14);
  s.lineTo(0.24, 0.14); s.lineTo(-0.14, -0.5); s.lineTo(-0.01, -0.04);
  s.lineTo(-0.22, -0.04); s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.12, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.02, bevelSegments: 1 });
  g.center();
  return g;
}
function powerupMesh(type) {
  const c = POWERUPS[type].color;
  const mat = new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 1.25, roughness: 0.25, metalness: 0.2 });
  if (type === "ninelives") return new THREE.Mesh(heartGeo(), mat);
  if (type === "zoomies") return new THREE.Mesh(boltGeo(), mat);
  if (type === "frenzy") {
    const grp = new THREE.Group();
    const hs = [0.34, 0.56, 0.8];
    hs.forEach((h, i) => {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.17, h, 0.17), mat);
      bar.position.set(-0.24 + i * 0.24, h / 2 - 0.36, 0);
      grp.add(bar);
    });
    return grp;
  }
  if (type === "cataclysm") return new THREE.Mesh(new THREE.IcosahedronGeometry(0.42, 0), mat);
  return makeRocketMesh(false);
}
function makePowerup(lane) {
  const type = pickWeighted(Object.entries(POWERUPS).map(([k, v]) => [k, v.weight]));
  const mesh = powerupMesh(type);
  const shadow = makeShadow(1.1);
  scene.add(mesh); scene.add(shadow);
  return { kind: "powerup", type, lane, elev: 1.0, z: SPAWN_Z, spin: 0, mesh, shadow };
}
function makeRocketMesh(pointDown = true) {
  const grp = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.14, 0.14, 0.6, 10),
    new THREE.MeshStandardMaterial({ color: 0xe0402e, emissive: 0xe0402e, emissiveIntensity: 0.5 })
  );
  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.14, 0.3, 10),
    new THREE.MeshStandardMaterial({ color: 0xffffff })
  );
  nose.position.y = 0.45;
  grp.add(body); grp.add(nose);
  if (pointDown) grp.rotation.x = -Math.PI / 2;
  scene.add(grp);
  return grp;
}

const particleColors = [0xff4444, 0xffffff, 0x4466ff, 0xffd738];
function burst(pos, big, colors = particleColors) {
  const n = big ? 36 : 22;
  for (let i = 0; i < n; i++) {
    const mat = new THREE.SpriteMaterial({ color: colors[i % colors.length], transparent: true, fog: false });
    const sp = new THREE.Sprite(mat);
    sp.scale.set(0.22, 0.22, 1);
    sp.position.copy(pos);
    scene.add(sp);
    const a = Math.random() * 6.28, b = Math.random() * 3.14;
    const spd = (big ? 7 : 4.5) * (0.5 + Math.random() * 0.6);
    particles.push({
      sp,
      vx: Math.cos(a) * Math.sin(b) * spd,
      vy: Math.cos(b) * spd + 2,
      vz: Math.sin(a) * Math.sin(b) * spd,
      life: 0.9 + Math.random() * 0.4, t: 0, grav: 9,
    });
  }
}
function puff(pos, color, n, spread, life) {
  for (let i = 0; i < n; i++) {
    const mat = new THREE.SpriteMaterial({ color, transparent: true, fog: false });
    const sp = new THREE.Sprite(mat);
    sp.scale.set(0.16, 0.16, 1);
    sp.position.copy(pos);
    scene.add(sp);
    particles.push({
      sp,
      vx: (Math.random() - 0.5) * spread,
      vy: 0.8 + Math.random() * 1.4,
      vz: (Math.random() - 0.5) * spread + 0.8,
      life, t: 0, grav: 4,
    });
  }
}

// ---------- game state ----------
let state = "menu";
let last = 0, speed = 0, elapsed = 0, distance = 0;
let candleCount = 0, scorePoints = 0, combo = 0, comboT = 0;
let hp = 3, dashT = 0, shake = 0, nextMilestone = 500;
let spawnT = { wave: 0, powerup: 0 };
let playerInfo = { name: "", twitter: "", wallet: "" };
let lastFxHtml = "";

function clearWorld() {
  for (const o of objs) disposeObj(o);
  for (const p of projectiles) scene.remove(p.mesh);
  for (const p of particles) scene.remove(p.sp);
  for (const t of trails) { scene.remove(t.mesh); t.mesh.material.dispose(); }
  for (const l of speedLines) { l.active = false; l.mesh.visible = false; }
  objs = []; projectiles = []; particles = []; trails = [];
}

function reset() {
  clearWorld();
  speed = START_SPEED; elapsed = 0; distance = 0;
  candleCount = 0; scorePoints = 0; combo = 0; comboT = 0;
  hp = 3; dashT = 0; shake = 0; nextMilestone = 500;
  player.lane = 0; player.laneX = 0; player.elev = 0; player.vy = 0; player.onGround = true; player.wasGrounded = true;
  player.shield = false; player.zoomies = 0; player.frenzy = 0; player.invuln = 0; player.trailT = 0;
  player.mesh.visible = true;
  player.shadow.visible = true;
  player.bubble.visible = false;
  chaser.laneX = 0;
  chaser.mesh.visible = true;
  chaser.shadow.visible = true;
  greenLight.intensity = 0;
  camera.fov = 58;
  camera.updateProjectionMatrix();
  spawnT = { wave: 1.2, powerup: 7 };
  updateHud();
}

function setState(next) {
  state = next;
  ui.pauseBtn.classList.toggle("hidden", next !== "playing");
  ui.hud.classList.toggle("hidden", next !== "playing" && next !== "paused");
}

function score() { return Math.round(distance) + scorePoints; }
function comboMult() { return Math.min(5, 1 + Math.floor(combo / 8)); }

function updateHud() {
  ui.hudDistance.textContent = Math.round(distance) + "m";
  ui.hudFish.textContent = "🟩 " + candleCount;
  ui.hudLives.textContent = "❤".repeat(Math.max(0, hp)) + "🖤".repeat(Math.max(0, 3 - hp));
  const mult = comboMult();
  if (mult > 1 && state === "playing") {
    ui.hudCombo.textContent = "x" + mult;
    ui.hudCombo.classList.remove("hidden");
  } else {
    ui.hudCombo.classList.add("hidden");
  }
  const parts = [];
  if (player.shield) parts.push(`<div class="fxpill nine">NINE LIVES ♥</div>`);
  if (player.zoomies > 0) parts.push(`<div class="fxpill zoom">ZOOMIES ${Math.ceil(player.zoomies)}s</div>`);
  if (player.frenzy > 0) parts.push(`<div class="fxpill pump">PUMP MODE ${Math.ceil(player.frenzy)}s</div>`);
  const html = parts.join("");
  if (html !== lastFxHtml) { ui.fxbar.innerHTML = html; lastFxHtml = html; }
}

function toast(text) {
  ui.toast.textContent = text;
  ui.toast.classList.add("hidden");
  void ui.toast.offsetWidth;
  ui.toast.classList.remove("hidden");
}

// ---------- input ----------
function jump() {
  if (state !== "playing") return;
  if (player.onGround) {
    player.vy = JUMP_V;
    player.onGround = false;
    audio.jump();
  }
}
function move(dir) {
  if (state !== "playing") return;
  const next = Math.max(-1, Math.min(1, player.lane + dir));
  if (next !== player.lane) {
    player.lane = next;
    audio.swish();
  }
}
function togglePause() {
  if (state === "playing") {
    setState("paused");
    audio.suspend();
    ui.paused.classList.remove("hidden");
    ui.pauseBtn.classList.remove("hidden");
  } else if (state === "paused") {
    ui.paused.classList.add("hidden");
    audio.resume();
    setState("playing");
  }
}
window.addEventListener("keydown", (e) => {
  if (state === "playing") {
    if (e.code === "Space" || e.code === "ArrowUp" || e.code === "KeyW") { e.preventDefault(); jump(); return; }
    if (e.code === "ArrowLeft" || e.code === "KeyA") { e.preventDefault(); move(-1); return; }
    if (e.code === "ArrowRight" || e.code === "KeyD") { e.preventDefault(); move(1); return; }
    if (e.code === "ArrowDown" || e.code === "KeyS" || e.code === "ShiftLeft") { e.preventDefault(); dash(); return; }
  }
  if ((e.code === "KeyP" || e.code === "Escape") && (state === "playing" || state === "paused")) {
    e.preventDefault();
    togglePause();
  }
});
let touchStart = null;
canvas.addEventListener("pointerdown", (e) => { touchStart = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener("pointerup", (e) => {
  if (!touchStart) return;
  const dx = e.clientX - touchStart.x, dy = e.clientY - touchStart.y;
  touchStart = null;
  if (Math.abs(dx) > 35 && Math.abs(dx) > Math.abs(dy)) move(dx > 0 ? 1 : -1);
  else if (dy > 35) dash();
  else jump();
});
ui.pauseBtn.addEventListener("click", togglePause);

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  bloom.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);


// ---------- leaderboard ----------
const KVDB_URL = "https://kvdb.io/NekoRound1_8D3sJ2mK9aPqXy2w/leaderboard";

async function getScores() {
  try {
    const res = await fetch(KVDB_URL);
    if (!res.ok) {
      if (res.status === 404) return [];
      throw new Error("HTTP " + res.status);
    }
    const data = await res.json();
    return data || [];
  } catch (e) {
    console.warn("Using offline scores fallback:", e);
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || []; }
    catch (err) { return []; }
  }
}

async function saveScore(entry) {
  let scores = [];
  try {
    const res = await fetch(KVDB_URL);
    if (res.ok) {
      scores = await res.json() || [];
    }
  } catch (e) {
    console.warn("Could not fetch current scores for merge, using local fallback:", e);
    try { scores = JSON.parse(localStorage.getItem(LS_KEY)) || []; } catch (err) {}
  }

  // Deduplicate: If this wallet already exists, keep only the highest score
  if (entry.wallet) {
    const idx = scores.findIndex(s => s.wallet === entry.wallet);
    if (idx !== -1) {
      if (entry.score > scores[idx].score) {
        scores.splice(idx, 1);
        scores.push(entry);
      }
    } else {
      scores.push(entry);
    }
  } else {
    scores.push(entry);
  }

  scores.sort((a, b) => b.score - a.score);
  const trimmed = scores.slice(0, 15);

  try { localStorage.setItem(LS_KEY, JSON.stringify(trimmed)); } catch (e) {}

  try {
    await fetch(KVDB_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(trimmed)
    });
  } catch (e) {
    console.error("Failed to upload score to global database:", e);
  }
}

async function renderScores() {
  const scores = await getScores();
  
  // Render in-game leaderboard overlay
  if (ui.scoreList) {
    ui.scoreList.innerHTML = "";
    if (!scores.length) {
      ui.scoreList.innerHTML = `<li class="empty">No scores yet — be the first!</li>`;
    } else {
      for (const s of scores) {
        const li = document.createElement("li");
        const who = document.createElement("span");
        who.className = "who"; who.textContent = " " + s.name;
        const pts = document.createElement("span");
        pts.className = "pts"; pts.textContent = s.score + " pts";
        li.appendChild(who);
        if (s.twitter) {
          const tw = document.createElement("span");
          tw.className = "tw"; tw.textContent = " @" + s.twitter.replace(/^@/, "");
          li.appendChild(tw);
        }
        li.appendChild(pts);
        ui.scoreList.appendChild(li);
      }
    }
  }

  // Render landing page leaderboard section
  const landingLb = document.getElementById("landingScoreList");
  if (landingLb) {
    landingLb.innerHTML = "";
    if (!scores.length) {
      landingLb.innerHTML = `<li class="py-3 text-center text-[#7f8ccc]">No scores yet — be the first!</li>`;
    } else {
      scores.forEach((s, idx) => {
        const li = document.createElement("li");
        li.className = "py-3 flex justify-between items-center";
        
        const leftDiv = document.createElement("div");
        leftDiv.className = "flex flex-wrap items-center gap-x-2 gap-y-1 max-w-[70%] md:max-w-[80%]";
        
        const rankSpan = document.createElement("span");
        rankSpan.className = "font-comic text-2xl text-[#6B9AC4] w-8";
        rankSpan.textContent = (idx + 1) + ".";
        
        const nameSpan = document.createElement("span");
        nameSpan.className = "font-marker text-[#4A3B32]";
        nameSpan.textContent = s.name;
        
        leftDiv.appendChild(rankSpan);
        leftDiv.appendChild(nameSpan);

        // Add Wallet Address next to name if connected
        if (s.wallet) {
          const wSpan = document.createElement("span");
          wSpan.className = "text-[#4A3B32] text-xs font-mono bg-[#FFFDF7] px-2 py-0.5 border-2 border-[#4A3B32] rounded ml-1";
          wSpan.textContent = s.wallet.slice(0, 4) + "..." + s.wallet.slice(-4);
          leftDiv.appendChild(wSpan);
        }
        
        if (s.twitter) {
          const twSpan = document.createElement("span");
          twSpan.className = "text-[#6B9AC4] text-sm font-mono ml-2";
          twSpan.textContent = "@" + s.twitter.replace(/^@/, "");
          leftDiv.appendChild(twSpan);
        }

        // Highlight Top 5 for Manual Airdrop Prize eligibility
        if (idx < 5) {
          const badgeSpan = document.createElement("span");
          badgeSpan.className = "text-xs font-mono text-[#4A3B32] bg-[#FFD738] border border-[#4A3B32] px-2 py-0.5 rounded ml-2 uppercase font-bold animate-pulse";
          badgeSpan.textContent = "🎁 Airdrop qualified";
          leftDiv.appendChild(badgeSpan);
        }
        
        const scoreSpan = document.createElement("span");
        scoreSpan.className = "font-comic text-2xl text-[#E57373] text-stroke";
        scoreSpan.textContent = s.score + " pts";
        
        li.appendChild(leftDiv);
        li.appendChild(scoreSpan);
        landingLb.appendChild(li);
      });
    }
  }
}

// ---------- ui wiring ----------
const startGame = () => {
  playerInfo.name = (ui.name ? ui.name.value.trim() : "") || "Anonymous Cat";
  playerInfo.twitter = ui.twitter ? ui.twitter.value.trim() : "";
  playerInfo.wallet = window.walletPublicKey || "";
  
  // Transition to game screen
  document.body.classList.remove("landing-active");
  const landingPage = document.getElementById("landing-page");
  if (landingPage) landingPage.classList.add("hidden");
  
  const stage = document.querySelector(".stage");
  if (stage) stage.classList.remove("hidden");
  
  reset();
  setState("playing");
  audio.resume();
  audio.startMusic();
};

document.querySelectorAll(".play-game-btn").forEach(btn => {
  btn.addEventListener("click", startGame);
});

document.getElementById("retryBtn").addEventListener("click", () => {
  ui.gameover.classList.add("hidden");
  reset();
  setState("playing");
  audio.startMusic();
});

const showMainMenu = () => {
  ui.gameover.classList.add("hidden");
  ui.paused.classList.add("hidden");
  
  // Transition to landing page
  document.body.classList.add("landing-active");
  const landingPage = document.getElementById("landing-page");
  if (landingPage) landingPage.classList.remove("hidden");
  
  const stage = document.querySelector(".stage");
  if (stage) stage.classList.add("hidden");
  
  audio.resume();
  audio.stopMusic();
  setState("menu");
  
  // Refresh landing page scores
  renderScores();
};

document.getElementById("menuBtn").addEventListener("click", showMainMenu);
document.getElementById("quitBtn").addEventListener("click", showMainMenu);
document.getElementById("resumeBtn").addEventListener("click", togglePause);

const leaderboardBtn = document.getElementById("leaderboardBtn");
if (leaderboardBtn) {
  leaderboardBtn.addEventListener("click", () => {
    renderScores();
    ui.menu.classList.add("hidden");
    ui.leaderboard.classList.remove("hidden");
  });
}

const closeLbBtn = document.getElementById("closeLbBtn");
if (closeLbBtn) {
  closeLbBtn.addEventListener("click", () => {
    ui.leaderboard.classList.add("hidden");
    ui.menu.classList.remove("hidden");
  });
}

// ---------- spawning ----------
const LANES = [-1, 0, 1];
function spawnWave() {
  const roll = Math.random();
  if (roll < 0.55) {
    const lane = LANES[Math.floor(Math.random() * 3)];
    const elev = Math.random() < 0.3 ? 1.15 : 0.45;
    const n = 5 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) objs.push(makeGreenCandle(lane, SPAWN_Z - i * 2.4, elev));
  } else {
    const tier = tierFor(elapsed);
    const count = tier >= 3 ? 2 : tier >= 1 && Math.random() < 0.45 ? 2 : 1;
    const lanes = [...LANES].sort(() => Math.random() - 0.5).slice(0, count);
    const pool = Object.entries(OB_CFG).filter(([, c]) => c.tier <= tier).map(([k, c]) => [k, c.w]);
    const makers = { hurdle: makeHurdle, cucumber: makeCucumber, redcandle: makeRedCandle, roomba: makeRoomba };
    for (const lane of lanes) objs.push(makers[pickWeighted(pool)](lane));
  }
}
function spawn(dt) {
  spawnT.wave -= dt; spawnT.powerup -= dt;
  if (spawnT.wave <= 0) {
    spawnWave();
    const base = 26 / speed;
    spawnT.wave = base + Math.random() * base;
  }
  if (spawnT.powerup <= 0) {
    objs.push(makePowerup(LANES[Math.floor(Math.random() * 3)]));
    spawnT.powerup = 8 + Math.random() * 6;
  }
}

// ---------- collisions & effects ----------
function laneOf(o) { return o.laneX !== undefined ? o.laneX : o.lane; }
const OBSTACLES = new Set(["redcandle", "hurdle", "cucumber", "roomba"]);
const CLEAR_HEIGHT = { redcandle: 0.72, hurdle: 0.55, cucumber: 0.5, roomba: 0.38 };

function destroyObstacle(o, i) {
  burst(o.mesh.position.clone(), true);
  disposeObj(o);
  objs.splice(i, 1);
  scorePoints += 25;
  audio.boom();
}

function hitObstacle(o, i) {
  if (player.invuln > 0) return;
  if (player.zoomies > 0) { destroyObstacle(o, i); return; }
  if (dashT > 0 && OB_CFG[o.kind].breakable) {
    destroyObstacle(o, i);
    combo++; comboT = 2.2;
    scorePoints += 120;
    shake = Math.max(shake, 0.2);
    return;
  }
  if (player.shield) {
    player.shield = false;
    player.invuln = 1.2;
    destroyObstacle(o, i);
    toast("NINE LIVES SAVED YOU!");
    return;
  }
  hp -= OB_CFG[o.kind].dmg;
  shake = Math.max(shake, 0.5);
  flashHit();
  audio.boom();
  if (hp <= 0) { gameOver(o.kind); return; }
  player.invuln = 1.4;
  combo = 0;
  destroyObstacle(o, i);
}

function flashHit() {
  const f = document.getElementById("flash");
  f.classList.add("hidden");
  void f.offsetWidth;
  f.classList.remove("hidden");   // animation restarts, fades itself to 0
}

function dash() {
  if (state !== "playing" || dashT > 0) return;
  dashT = 0.45;
  shake = Math.max(shake, 0.12);
  audio.swish();
  for (let i = 0; i < 4; i++) spawnSpeedLine();
}

function applyPowerup(type) {
  audio.powerup();
  toast(POWERUPS[type].name);
  burst(player.mesh.position.clone(), false, [POWERUPS[type].color, 0xffffff]);
  if (type === "ninelives") player.shield = true;
  else if (type === "zoomies") player.zoomies = 5;
  else if (type === "frenzy") player.frenzy = 8;
  else if (type === "cataclysm") {
    for (let i = objs.length - 1; i >= 0; i--) {
      if (OBSTACLES.has(objs[i].kind)) destroyObstacle(objs[i], i);
    }
    player.zoomies = Math.max(player.zoomies, 5);
    shake = Math.max(shake, 0.6);
  }
  else if (type === "firework") {
    const rocket = makeRocketMesh(true);
    rocket.position.set(player.lane * LANE_X, 1.0, 0);
    projectiles.push({ mesh: rocket, lane: player.lane });
    audio.rocket();
  }
}

function spawnSpeedLine() {
  const slot = speedLines.find((l) => !l.active);
  if (!slot) return;
  slot.active = true;
  slot.mesh.visible = true;
  const side = Math.random() < 0.5 ? -1 : 1;
  slot.mesh.position.set(side * (1.5 + Math.random() * 4), 0.3 + Math.random() * 3.2, -40);
}

// ---------- update ----------
function update(dt) {
  elapsed += dt;
  const zoomBoost = player.zoomies > 0 ? 1.3 : 1;
  speed = Math.min(MAX_SPEED, START_SPEED + elapsed * SPEED_RAMP) * zoomBoost;
  distance += speed * dt;

  if (speed > 17 && audio.currentTrack === 1) {
    audio.fadeToTrack2();
  }

  dashT = Math.max(0, dashT - dt);
  shake = Math.max(0, shake - dt * 1.6);
  if (distance >= nextMilestone) {
    toast(nextMilestone + "m ⚡");
    audio.powerup();
    nextMilestone += 500;
  }
  player.zoomies = Math.max(0, player.zoomies - dt);
  player.frenzy = Math.max(0, player.frenzy - dt);
  player.invuln = Math.max(0, player.invuln - dt);
  comboT -= dt;
  if (comboT <= 0) combo = 0;

  groundTex.offset.y += speed * dt / GROUND_TILE;

  // player
  player.laneX += (player.lane - player.laneX) * Math.min(1, dt * 12);
  if (!player.onGround) {
    player.vy -= GRAVITY * dt;
    player.elev += player.vy * dt;
    if (player.elev <= 0) { player.elev = 0; player.vy = 0; player.onGround = true; }
  }
  player.ft += dt;
  const pfr = player.onGround ? 1 / 14 : 1 / 8;
  while (player.ft > pfr) { player.ft -= pfr; player.frame = (player.frame + 1) % PLAYER.frames; }
  player.mesh.material.map = catFrames[player.frame];
  const px = player.laneX * LANE_X;
  player.mesh.position.set(px, PLAYER.h / 2 + player.elev, 0);
  player.mesh.rotation.z = (player.lane - player.laneX) * -0.18;
  player.shadow.position.set(px, 0.02, 0);
  const sh = Math.max(0.4, 1 - player.elev / 2.2);
  player.shadow.scale.set(sh, sh, 1);
  player.mesh.material.opacity = player.zoomies > 0 ? (Math.sin(elapsed * 30) > 0 ? 1 : 0.55) :
                                 player.invuln > 0 ? 0.6 : 1;
  player.mesh.material.transparent = true;

  // landing dust
  if (player.onGround && !player.wasGrounded) {
    puff(new THREE.Vector3(px, 0.12, 0.3), 0xcbb894, 8, 2.2, 0.45);
  }
  player.wasGrounded = player.onGround;

  // shield bubble
  player.bubble.visible = player.shield;
  if (player.shield) {
    player.bubble.position.set(px, PLAYER.h / 2 + player.elev, 0);
    player.bubble.scale.setScalar(1 + Math.sin(elapsed * 5) * 0.04);
  }

  // zoomies afterimages
  if (player.zoomies > 0) {
    player.trailT -= dt;
    if (player.trailT <= 0) {
      player.trailT = 0.055;
      const ghost = new THREE.Mesh(
        player.mesh.geometry,
        new THREE.MeshBasicMaterial({ map: catFrames[player.frame], transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide })
      );
      ghost.position.copy(player.mesh.position);
      ghost.rotation.copy(player.mesh.rotation);
      scene.add(ghost);
      trails.push({ mesh: ghost, t: 0, life: 0.32 });
    }
  }
  for (let i = trails.length - 1; i >= 0; i--) {
    const t = trails[i];
    t.t += dt;
    t.mesh.position.z += speed * dt * 0.6;
    t.mesh.material.opacity = 0.35 * (1 - t.t / t.life);
    if (t.t > t.life) {
      scene.remove(t.mesh);
      t.mesh.material.dispose();
      trails.splice(i, 1);
    }
  }

  // speed lines
  if (player.zoomies > 0 && Math.random() < dt * 40) spawnSpeedLine();
  else if (speed > 27 && Math.random() < dt * 10) spawnSpeedLine();
  for (const l of speedLines) {
    if (!l.active) continue;
    l.mesh.position.z += speed * 2.6 * dt;
    if (l.mesh.position.z > 8) { l.active = false; l.mesh.visible = false; }
  }

  // pump mode glow + rain
  greenLight.intensity += ((player.frenzy > 0 ? 3.2 : 0) - greenLight.intensity) * Math.min(1, dt * 6);
  greenLight.position.set(px, 2, 0);
  if (player.frenzy > 0 && Math.random() < dt * 30) {
    const mat = new THREE.SpriteMaterial({ color: 0x35e0a1, transparent: true, fog: false });
    const sp = new THREE.Sprite(mat);
    sp.scale.set(0.12, 0.3, 1);
    sp.position.set((Math.random() - 0.5) * 10, 4.5 + Math.random() * 1.5, -Math.random() * 22 + 2);
    scene.add(sp);
    particles.push({ sp, vx: 0, vy: -2.5, vz: speed * 0.4, life: 1.1, t: 0, grav: 6 });
  }

  // the chasing dog
  chaser.laneX += (player.laneX - chaser.laneX) * Math.min(1, dt * 5);
  chaser.ft += dt;
  while (chaser.ft > 1 / 16) { chaser.ft -= 1 / 16; chaser.frame = (chaser.frame + 1) % CHASER.frames; }
  chaser.mesh.material.map = dogFrames[chaser.frame];
  const cxp = chaser.laneX * LANE_X;
  const lunge = 3.1 - Math.sin(elapsed * 1.4) * 0.35;
  chaser.mesh.position.set(cxp, CHASER.h / 2 + Math.abs(Math.sin(elapsed * 7)) * 0.12, lunge);
  chaser.shadow.position.set(cxp, 0.02, lunge);

  // scenery recycle
  for (const s of scenery) {
    s.mesh.position.z += speed * dt;
    if (s.mesh.position.z > 8) s.mesh.position.z -= s.span;
  }
  for (const c of clouds) {
    c.sp.position.x += c.v * dt;
    if (c.sp.position.x > 110) c.sp.position.x = -110;
  }
  for (const b of birds) {
    b.bob += dt * 3;
    b.sp.position.x += b.v * dt;
    b.sp.position.y += Math.sin(b.bob) * dt * 1.5;
    if (b.sp.position.x > 100) b.sp.position.x = -100;
  }
  for (const m of motes) {
    m.sway += dt;
    m.sp.position.z += speed * dt * 0.25;
    m.sp.position.x += Math.sin(m.sway) * dt * 0.4;
    m.sp.position.y += Math.cos(m.sway * 0.7) * dt * 0.2;
    if (m.sp.position.z > 6) {
      m.sp.position.z = -45;
      m.sp.position.x = (Math.random() - 0.5) * 22;
      m.sp.position.y = 0.4 + Math.random() * 4;
    }
  }
  balloon.position.y = 20 + Math.sin(elapsed * 0.5) * 1.2;
  balloon.position.x = 22 + Math.sin(elapsed * 0.18) * 4;

  spawn(dt);

  // objects
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i];
    o.z += speed * dt;

    if (o.kind === "candle") {
      o.spin += dt * 2.2;
      if (player.frenzy > 0 && o.z > -14) o.lane += (player.lane - o.lane) * Math.min(1, dt * 5);
    } else if (o.kind === "roomba") {
      o.shiftT -= dt;
      if (o.shiftT <= 0 && o.z < -18) {   // no point-blank lane swaps — stay dodgeable
        o.lane = Math.max(-1, Math.min(1, o.lane + (Math.random() < 0.5 ? -1 : 1)));
        o.shiftT = 1.1 + Math.random() * 0.9;
      }
      o.laneX += (o.lane - o.laneX) * Math.min(1, dt * 6);
      o.mesh.rotation.y += dt * 3;
    } else if (o.kind === "powerup") {
      o.spin += dt;
      o.mesh.rotation.y = o.spin * 2.4;
      o.elev = 1.0 + Math.sin(o.spin * 3) * 0.15;
    }

    const lx = laneOf(o) * LANE_X;
    let y;
    if (o.kind === "candle") {
      y = o.elev + 0.35 + Math.sin(o.spin * 1.6) * 0.06;
      o.mesh.rotation.y = o.spin;
    } else if (o.kind === "powerup") y = o.elev;
    else if (o.kind === "redcandle") y = 0.52;
    else if (o.kind === "hurdle") y = 0;
    else if (o.kind === "cucumber") y = 0.26;
    else y = 0.13;
    o.mesh.position.set(lx, y, o.z);
    if (o.shadow) o.shadow.position.set(lx, 0.02, o.z);

    if (o.z > KILL_Z) { disposeObj(o); objs.splice(i, 1); continue; }

    const laneClose = Math.abs(laneOf(o) - player.laneX) < 0.5;
    if (o.z > -0.9 && o.z < 0.9 && laneClose) {
      if (o.kind === "candle") {
        if (Math.abs(player.elev + 0.55 - (o.elev + 0.35)) < 0.95) {
          burst(o.mesh.position.clone(), false, [0x16c784, 0xffffff]);
          disposeObj(o); objs.splice(i, 1);
          combo++; comboT = 2.2;
          const gain = (player.frenzy > 0 ? 2 : 1);
          candleCount += gain;
          scorePoints += 10 * gain * comboMult();
          audio.candle();
        }
      } else if (o.kind === "powerup") {
        disposeObj(o); objs.splice(i, 1);
        applyPowerup(o.type);
      } else if (OBSTACLES.has(o.kind)) {
        if (player.elev < CLEAR_HEIGHT[o.kind]) hitObstacle(o, i);
      }
      if (state === "gameover") return;
    }
  }

  // fired rockets
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    p.mesh.position.z -= (26 + speed) * dt;
    let hit = false;
    for (let j = objs.length - 1; j >= 0; j--) {
      const o = objs[j];
      if (OBSTACLES.has(o.kind) &&
          Math.abs(laneOf(o) - p.lane) < 0.5 &&
          Math.abs(o.z - p.mesh.position.z) < 1.4) {
        destroyObstacle(o, j);
        hit = true;
        break;
      }
    }
    if (hit || p.mesh.position.z < SPAWN_Z) {
      scene.remove(p.mesh);
      projectiles.splice(i, 1);
    }
  }

  // particles
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.t += dt;
    if (p.t > p.life) { scene.remove(p.sp); particles.splice(i, 1); continue; }
    p.sp.position.x += p.vx * dt;
    p.sp.position.y += p.vy * dt;
    p.sp.position.z += p.vz * dt;
    p.vy -= (p.grav || 9) * dt;
    p.sp.material.opacity = 1 - p.t / p.life;
  }

  // speed-reactive camera
  const targetFov = 58 + Math.min(9, (speed - START_SPEED) * 0.45) + (player.zoomies > 0 ? 7 : 0);
  camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 4);
  camera.updateProjectionMatrix();
  camera.position.x += (player.laneX * 0.8 - camera.position.x) * Math.min(1, dt * 5);
  camera.position.y = 2.8 + Math.sin(elapsed * 2.2) * 0.04;
  if (player.zoomies > 0) {
    camera.position.x += (Math.random() - 0.5) * 0.05;
    camera.position.y += (Math.random() - 0.5) * 0.04;
  }
  if (shake > 0) {
    camera.position.x += (Math.random() - 0.5) * shake * 0.3;
    camera.position.y += (Math.random() - 0.5) * shake * 0.25;
  }
  // dash lean
  player.mesh.rotation.x = dashT > 0 ? -0.28 : 0;

  updateHud();
}

async function gameOver(kind) {
  setState("gameover");
  audio.die();
  audio.stopMusic();
  burst(player.mesh.position.clone(), true);
  player.mesh.visible = false;
  player.shadow.visible = false;
  player.bubble.visible = false;
  greenLight.intensity = 0;
  const finalScore = score();
  ui.deathMsg.textContent = DEATH_MSG[kind] || "WIPED OUT.";
  ui.finalDistance.textContent = Math.round(distance) + "m";
  ui.finalFish.textContent = candleCount;
  ui.finalScore.textContent = finalScore;
  ui.finalRank.textContent = rankFor(finalScore);
  
  const scoresList = await getScores();
  const best = scoresList[0];
  ui.newBest.classList.toggle("hidden", !(finalScore > 0 && (!best || finalScore > best.score)));
  
  await saveScore({ name: playerInfo.name, twitter: playerInfo.twitter, wallet: playerInfo.wallet, score: finalScore });
  await renderScores();
  setTimeout(() => ui.gameover.classList.remove("hidden"), 600);
}

// ---------- main loop ----------
function frame(t) {
  const rawDt = (t - last) / 1000;
  const dt = Math.min(0.05, rawDt);
  last = t;
  trackPerf(rawDt);
  if (state === "playing") {
    update(dt);
  } else if (state !== "paused") {
    elapsed += dt * 0.3;
    for (const c of clouds) {
      c.sp.position.x += c.v * dt * 0.5;
      if (c.sp.position.x > 110) c.sp.position.x = -110;
    }
  }
  if (bloomOn) composer.render();
  else renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

reset();
renderScores().catch(console.error);
requestAnimationFrame((t) => { last = t; requestAnimationFrame(frame); });

// Auto-refresh global scores list every 30 seconds when not playing
setInterval(() => {
  if (state !== "playing") {
    renderScores().catch(console.error);
  }
}, 30000);

// debug handle for automated checks
window.__neko = {
  snapshot: () => ({
    state, speed: +speed.toFixed(1), distance: Math.round(distance),
    candleCount, score: score(), combo, objects: objs.length,
    kinds: objs.reduce((m, o) => ((m[o.kind] = (m[o.kind] || 0) + 1), m), {}),
    playerLane: player.lane, elev: +player.elev.toFixed(2),
    shield: player.shield, zoomies: +player.zoomies.toFixed(1), frenzy: +player.frenzy.toFixed(1),
    fov: +camera.fov.toFixed(1), trails: trails.length,
    lines: speedLines.filter((l) => l.active).length,
    bloom: bloomOn,
  }),
  jump, move,
  give: (type) => applyPowerup(type),
  objects: () => objs.map((o) => ({ kind: o.kind, lane: laneOf(o), z: +o.z.toFixed(1), elev: o.elev })),
  setLane: (l) => { player.lane = Math.max(-1, Math.min(1, Math.round(l))); },
};
