import * as THREE from 'three';
import Lenis from 'lenis';

import { vertexShader, fragmentShader } from './shaders.js';

// ---------------------------------------------------------------------------
// CONFIG — single source of truth for the spiral's look and motion.
// ---------------------------------------------------------------------------

const CONFIG = {
  totalImages: 10,
  tilesPerRevolution: 15,
  revolutions: 5,
  startRadius: 5,
  endRadius: 3.5,
  tileHeightRatio: 1.1,
  tileSegments: 24,
  spiralGap: 0.35,
  tileOverlap: 0.005,
  cameraZ: 12,
  cameraSmoothing: 0.075,
  baseRotationSpeed: 0.001,
  scrollRotationMultiplier: 0.0035,
  rotationDecay: 0.9,
  scrollMultiplier: 1.25,
  cameraYMultiplier: 0.2,
  parallaxStrength: 0.1,
  spiralOffsetY: -2.0,
};

const heroSection = document.querySelector('.hero');

const state = {
  isMobile: window.innerWidth < 768,
  width: heroSection.clientWidth,
  height: heroSection.clientHeight,
  scrollProgress: 0,
  scrollVelocity: 0,
  spinVelocity: 0,
  targetCameraY: 0,
  currentCameraY: 0,
  mouseX: 0,
  mouseY: 0,
  targetTiltX: 0,
  targetTiltZ: 0,
  currentTiltX: 0,
  currentTiltZ: 0,
};

// ---------------------------------------------------------------------------
// Lenis smooth scrolling — wired before WebGL so the page feels smooth from
// the first interaction even while textures stream in.
// ---------------------------------------------------------------------------

const lenis = new Lenis({
  duration: 1.2,
  smoothWheel: true,
  smoothTouch: false,
  easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
});

lenis.on('scroll', ({ scroll, limit, velocity }) => {
  const max = Math.max(limit, 1);
  state.scrollProgress = Math.min(scroll / max, 1);
  state.scrollVelocity = velocity;
  state.spinVelocity +=
    velocity * CONFIG.scrollRotationMultiplier * CONFIG.scrollMultiplier;
});

function onMouseMove(event) {
  if (state.isMobile) return;
  state.mouseX = (event.clientX / window.innerWidth) * 2 - 1;
  state.mouseY = (event.clientY / window.innerHeight) * 2 - 1;
  state.targetTiltX = state.mouseY * CONFIG.parallaxStrength;
  state.targetTiltZ = state.mouseX * CONFIG.parallaxStrength * -0.5;
}
window.addEventListener('mousemove', onMouseMove);

function lenisRaf(time) {
  lenis.raf(time);
  requestAnimationFrame(lenisRaf);
}
requestAnimationFrame(lenisRaf);

// ---------------------------------------------------------------------------
// Scroll reveals — slow, cinematic fade-up for every `.reveal-text` block
// below the hero. Each element gets its own ScrollTrigger so the reveals
// stagger naturally with how the user scrolls, not on a fixed clock.
//
// Project is vanilla JS, but we still wrap in `gsap.context()` so all
// triggers can be reverted as a group when Vite hot-reloads this module —
// otherwise duplicates would pile up on every save.
// ---------------------------------------------------------------------------

// Reveals are driven by a native IntersectionObserver instead of GSAP
// ScrollTrigger. This is far more robust on a page with a sticky hero and a
// tall WebGL canvas (where ScrollTrigger could mis-position a trigger and
// leave a block stuck at opacity 0 — the bug this replaces).
//
// Crucially, content is VISIBLE BY DEFAULT (see `.reveal-text` in CSS). The
// hidden → reveal animation is only enabled once we add `.reveals` to <html>,
// so if this script ever fails to run, nothing is left invisible.
document.documentElement.classList.add('reveals');

function reveal(el) {
  el.classList.add('is-in');
}

const revealObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        reveal(entry.target);
        revealObserver.unobserve(entry.target);
      }
    });
  },
  { root: null, rootMargin: '0px 0px -8% 0px', threshold: 0.01 }
);

function observeReveals() {
  document.querySelectorAll('.reveal-text:not(.is-in)').forEach((el) =>
    revealObserver.observe(el)
  );
}

// Pure class-based failsafe (no GSAP) — guarantees that anything inside or
// near the viewport is revealed even if IntersectionObserver callbacks are
// delayed or a trigger is mis-measured. Runs on scroll, on Lenis scroll, on
// resize and after load.
function revealInView() {
  const vh = window.innerHeight;
  document.querySelectorAll('.reveal-text:not(.is-in)').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.top < vh * 0.95 && r.bottom > 0) reveal(el);
  });
}

observeReveals();
revealInView();

lenis.on('scroll', revealInView);
window.addEventListener('scroll', revealInView, { passive: true });
window.addEventListener('resize', revealInView);
window.addEventListener('load', () => {
  observeReveals();
  revealInView();
  setTimeout(revealInView, 300);
  setTimeout(revealInView, 1000);
});

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    revealObserver.disconnect();
  });
}

// ---------------------------------------------------------------------------
// Three.js — deferred until after the headline has painted so it doesn't
// compete with LCP.
// ---------------------------------------------------------------------------

let scene;
let camera;
let renderer;
let spiral;
let clock;

const totalTiles = CONFIG.tilesPerRevolution * CONFIG.revolutions;
const angleStep = (Math.PI * 2) / CONFIG.tilesPerRevolution;

const textureLoader = new THREE.TextureLoader();

function loadTexture(url) {
  return new Promise((resolve) => {
    textureLoader.load(
      url,
      (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        if (renderer) {
          texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
        }
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;
        resolve(texture);
      },
      undefined,
      () => {
        const fallback = new THREE.DataTexture(
          new Uint8Array([22, 22, 24, 255]),
          1,
          1,
          THREE.RGBAFormat
        );
        fallback.needsUpdate = true;
        resolve(fallback);
      }
    );
  });
}

const textureUrls = Array.from(
  { length: CONFIG.totalImages },
  (_, i) => `/images/img${i + 1}.webp`
);

// ---------------------------------------------------------------------------
// Curved tile geometry — a strip of a cylinder wall, not a flat plane.
// Each tile follows a sin/cos curve so the spiral reads as one continuous
// surface rather than a series of facets.
// ---------------------------------------------------------------------------

function createCurvedTileGeometry(radius, arcAngle, tileHeight, segments) {
  const geometry = new THREE.BufferGeometry();

  const positions = [];
  const uvs = [];
  const indices = [];

  const halfArc = arcAngle / 2;
  const halfHeight = tileHeight / 2;

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const theta = -halfArc + arcAngle * t;
    const x = Math.sin(theta) * radius;
    const z = Math.cos(theta) * radius;

    positions.push(x, halfHeight, z);
    positions.push(x, -halfHeight, z);

    uvs.push(t, 1);
    uvs.push(t, 0);
  }

  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;

    indices.push(a, b, c);
    indices.push(b, d, c);
  }

  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(positions, 3)
  );
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  return geometry;
}

function buildSpiral(textures) {
  const arcAngle = angleStep + CONFIG.tileOverlap;
  // Anchor tile height to the chord length at the start radius so each
  // tile reads as proportional even as the radius tapers down the helix.
  const chord = 2 * CONFIG.startRadius * Math.sin(angleStep / 2);
  const tileHeight = chord * CONFIG.tileHeightRatio;

  const totalHeight = (totalTiles - 1) * CONFIG.spiralGap;
  const startY = totalHeight / 2;

  for (let i = 0; i < totalTiles; i++) {
    const progress = totalTiles === 1 ? 0 : i / (totalTiles - 1);
    const radius =
      CONFIG.startRadius + (CONFIG.endRadius - CONFIG.startRadius) * progress;

    const geometry = createCurvedTileGeometry(
      radius,
      arcAngle,
      tileHeight,
      CONFIG.tileSegments
    );

    const texture = textures[i % textures.length];

    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uMap: { value: texture },
        uCameraPosition: { value: camera.position },
      },
      side: THREE.DoubleSide,
      transparent: true,
    });

    const tile = new THREE.Mesh(geometry, material);
    tile.position.y = startY - i * CONFIG.spiralGap;
    tile.rotation.y = i * angleStep;
    spiral.add(tile);
  }
}

function onResize() {
  state.isMobile = window.innerWidth < 768;
  state.width = heroSection.clientWidth;
  state.height = heroSection.clientHeight;

  if (!camera || !renderer) return;

  camera.aspect = state.width / state.height;
  camera.position.z = CONFIG.cameraZ + (state.isMobile ? 3 : 0);
  camera.updateProjectionMatrix();

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(state.width, state.height);

  if (state.isMobile) {
    state.targetTiltX = 0;
    state.targetTiltZ = 0;
  }
}
window.addEventListener('resize', onResize);

function tick() {
  if (renderer && camera && scene && spiral && clock) {
    clock.getDelta();

    spiral.rotation.y += CONFIG.baseRotationSpeed + state.spinVelocity;
    state.spinVelocity *= CONFIG.rotationDecay;

    if (!state.isMobile) {
      state.currentTiltX +=
        (state.targetTiltX - state.currentTiltX) * CONFIG.cameraSmoothing;
      state.currentTiltZ +=
        (state.targetTiltZ - state.currentTiltZ) * CONFIG.cameraSmoothing;
      spiral.rotation.x = state.currentTiltX;
      spiral.rotation.z = state.currentTiltZ;
    }

    state.targetCameraY =
      -state.scrollProgress * CONFIG.cameraYMultiplier * 10;
    state.currentCameraY +=
      (state.targetCameraY - state.currentCameraY) * CONFIG.cameraSmoothing;
    camera.position.y = state.currentCameraY;
    camera.lookAt(0, state.currentCameraY * 0.4, 0);

    renderer.render(scene, camera);
  }
  requestAnimationFrame(tick);
}

function initThreeJs() {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(
    45,
    state.width / state.height,
    0.1,
    100
  );
  camera.position.set(0, 0, CONFIG.cameraZ + (state.isMobile ? 3 : 0));

  renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(state.width, state.height);
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.classList.add('hero__canvas');
  heroSection.appendChild(renderer.domElement);

  spiral = new THREE.Group();
  spiral.position.y = CONFIG.spiralOffsetY;
  scene.add(spiral);

  clock = new THREE.Clock();

  requestAnimationFrame(tick);

  Promise.all(textureUrls.map(loadTexture)).then((textures) => {
    buildSpiral(textures);
    renderer.domElement.classList.add('is-ready');
  });
}

// Kick the WebGL spiral off as soon as the first frame has painted. The
// textures are small WebP files now, so there's no need to defer far into
// idle time — a short idle window keeps it off the critical paint without
// the old multi-second wait.
if ('requestIdleCallback' in window) {
  requestIdleCallback(initThreeJs, { timeout: 300 });
} else {
  requestAnimationFrame(() => requestAnimationFrame(initThreeJs));
}

// ---------------------------------------------------------------------------
// Contact form — no backend required. On submit we compose a pre-filled email
// to info@sadeofset.com.tr and hand it off to the visitor's mail client.
// ---------------------------------------------------------------------------

const contactForm = document.getElementById('contactForm');
if (contactForm) {
  contactForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!contactForm.checkValidity()) {
      contactForm.reportValidity();
      return;
    }

    const value = (name) => (contactForm.elements[name]?.value || '').trim();
    const tr = document.documentElement.lang === 'tr';
    const L = tr
      ? { subj: 'Web sitesi iletişim', name: 'Ad Soyad', email: 'E-posta', phone: 'Telefon', company: 'Firma', message: 'Mesaj' }
      : { subj: 'Website contact', name: 'Name', email: 'Email', phone: 'Phone', company: 'Company', message: 'Message' };

    const subject = `${L.subj} — ${value('name') || value('email')}`;
    const body = [
      `${L.name}: ${value('name')}`,
      `${L.email}: ${value('email')}`,
      `${L.phone}: ${value('phone')}`,
      `${L.company}: ${value('company')}`,
      '',
      `${L.message}:`,
      value('message'),
    ].join('\n');

    window.location.href = `mailto:info@sadeofset.com.tr?subject=${encodeURIComponent(
      subject
    )}&body=${encodeURIComponent(body)}`;
  });
}
