/* Spectrum Auto — shop diorama.
   A row of industrial bays with unit #3 open and stocked, a shoulder road with parked
   cars, Sean pulling one onto the apron to work on it, and a full day/night cycle.
   Registers <shop-diorama>. three.js resolves through the import map in the host page. */
(function () {
  'use strict';

  const CYCLE = 220;   // seconds — one customer car's whole visit: drop-off, wait in the stall, bay, reveal, pick-up
  const SEAN_H = 110;  // two cars run the same story half a cycle apart, so Sean's own loop is half
  const DAY   = 150;   // seconds — one full day/night rotation

  class ShopDiorama extends HTMLElement {
    connectedCallback() {
      this._dead = false;
      this.style.cssText = 'display:block;width:100%;height:100%';
      if (this._started) { if (this._resume) this._resume(); return; }
      this._started = true;
      this.boot();
    }

    /* Embedded mode (attribute `embedded`): the scene is a page's hero. It plays on its own
       but ignores the pointer — no orbit, zoom, peek or click-to-follow — so the wheel
       scrolls the page. setExplore(true) hands it the pointer; setExplore(false) gives it
       back and eases out of any close-up. The standalone page never sets the attribute. */
    setExplore(on) {
      const m = this._mode; if (!m) return;
      m.explore = !!on;
      if (this._controls) this._controls.enabled = !m.embedded || m.explore;
      if (!on && this._peekExit) this._peekExit();
    }

    disconnectedCallback() {
      // The host re-parents this element on re-render, so treat detach as a pause:
      // stop the loop but keep the scene, and resume when re-attached.
      this._dead = true;
      if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
      this._looping = false;
      if (this._overlayTimer) { clearInterval(this._overlayTimer); this._overlayTimer = 0; }
      if (this._io) { this._io.disconnect(); this._io = null; }
      if (this._onVis) { document.removeEventListener('visibilitychange', this._onVis); this._onVis = null; }
    }

    async boot() {
      let THREE, OrbitControls;
      try {
        THREE = await import('three');
        ({ OrbitControls } = await import('three/addons/controls/OrbitControls.js'));
      } catch (e) {
        const msg = document.createElement('div');
        msg.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
          "font-family:'JetBrains Mono',ui-monospace,monospace;font-size:11px;letter-spacing:0.16em;" +
          'text-transform:uppercase;color:#6B675F;text-align:center;padding:24px';
        msg.textContent = '3D scene could not load';
        this.appendChild(msg);
        return;
      }
      if (this._dead) return;

      const C = {
        // One tone for all paved ground — lot, apron, drive, pads. Three near-identical
        // greys read as patchy resurfacing, worst in the rain. Only the road is darker.
        ground:  0x726F7B, apron: 0x726F7B, road: 0x4A4954, stripe: 0xC9BC9E,
        // Poured service pads read as concrete, so they sit at or just above the
        // surrounding ground — never below the asphalt beside them.
        pad:     0x726F7B,
        wall:    0x8A8478, wallAlt: 0x7A7268, roof: 0x726B61, door: 0x8A8278,
        trim:    0xC9A227, bayGlow: 0xE8B23A,
        floorIn: 0x6E6558, benchTop: 0x4E463C,
        skin:    0xC08F68, shirt: 0x5E7284, jeans: 0x46525F, boots: 0x1E1C1A,
        tire:    0x141314, glass: 0x1F2A32, card: 0x8A6E4A,
      };
      const CAR_PAINT = [0x6E4B3A, 0x3E4A52, 0x574E3D, 0x7A2E22, 0x45514B];

      /* ---------- renderer / camera ---------- */
      /* preserveDrawingBuffer stays ON — captures and PNG export read the canvas back.
         Measured live (M4 Pro, Chrome 154): the flag makes no difference to frame pacing.
         The slow presentation seen in the embedded preview (100–400 ms per frame while GPU
         draw time, timed with gl.finish(), was ~1 ms) reproduces with an empty scene and
         even with renderer.render skipped entirely, so it belongs to the host compositor,
         not this scene. */
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
      // Pixel ratio is set in resize(): capped by a total device-pixel budget, not a fixed 2.
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.25;
      renderer.domElement.style.cssText = 'display:block;width:100%;height:100%';
      this.appendChild(renderer.domElement);
      this._renderer = renderer;

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x0C0C0D);
      scene.fog = new THREE.Fog(0x171519, 70, 190);

      // Wide enough that the row runs from the neighbours' side lot (x -46) to the exit
      // drive (x 24) across the default view. The bay stays the centre of attention — the
      // orbit target sits just west of it so both ends of the street fit.
      const VIEW = 13.5;
      const camera = new THREE.OrthographicCamera(-VIEW, VIEW, VIEW, -VIEW, 0.1, 400);
      camera.position.set(20, 22, 26);

      const controls = new OrbitControls(camera, renderer.domElement);
      controls.target.set(8, 1.2, 0.2);
      controls.enableDamping = true;
      controls.dampingFactor = 0.07;
      controls.enablePan = false;
      const MODE = this._mode = { embedded: this.hasAttribute('embedded'), explore: false };
      const live = () => !MODE.embedded || MODE.explore;
      controls.enabled = live();
      this._controls = controls;
      controls.minPolarAngle = 0.22;
      controls.maxPolarAngle = 1.02;
      controls.minZoom = 0.7;
      controls.maxZoom = 2.6;
      // The bay opening faces +z, so the camera must stay in the arc that sees into it.
      // Wide enough to swing round to the back of the car during the reveal — the subs are
      // in the boot, and the old arc could only ever see the nose. Still bounded so the
      // camera can't end up behind the building looking at unbuilt back faces.
      // Swing biased east: the further round the camera sits toward the exit drive, the
      // more of the neighbours' side lot (x -46) clears the left edge of the frame.
      const AZ_BASE = 0.30, AZ_SWING = 0.52;
      controls.minAzimuthAngle = -0.95;
      controls.maxAzimuthAngle = AZ_BASE + AZ_SWING + 0.25;
      controls.autoRotate = false;
      let drifting = true;
      renderer.domElement.addEventListener('pointerdown', () => { drifting = false; });

      /* ---------- the peek ----------
         One more notch past the zoom limit: the camera leaves the orbit and settles on a
         fixed view straight into the bay — low, from the door, looking at the car on the
         lift and the bench behind it. Any wheel-out returns to the regular orbit where it
         left off. OrbitControls stays alive but ignored while peeking, so its state is
         exactly as the user left it. */
      const PEEK = { on: false, k: 0, armed: 0 };
      // From the door line, just above car-roof height, so the car stopped at the door and
      // the reveal spot (both out on the apron at z > 2) stay behind the camera.
      // Two levels. The first stands at the door looking down the lift; the second steps
      // inside past the car and looks across at the break nook in the back-left corner.
      // One level: at the door, at eye height, aimed past the car's right flank toward the
      // back-left corner so the couch and TV are in frame along with the car on the lift.
      const PEEK_VIEWS = [
        // Square on: centred on the door (x = OPEN_X 9), looking straight down the bay to the
        // back wall, a little above car-roof height so the lift car doesn't fill the frame.
        // Kept just inside the door line so a car stopped on the apron stays behind it.
        // Starts square to the door, just outside it. Dragging looks around (see PEEK_LOOK):
        // the camera swings on a short arm about a point in the middle of the bay, so you
        // can peer past the car to either side and tilt up or down.
        { pos: new THREE.Vector3(9.0, 3.1, 1.8), tgt: new THREE.Vector3(9.0, 1.3, -8.0), zoom: 4.0 },
      ];
      let PEEK_LVL = 0;
      /* Close-up targets. Each is a pivot the camera swings round on an arm, a base
         heading, and drag limits that keep the frame clean (bay: doorway stays in frame,
         bottom above ground, top under the roof deck). The bay is entered by scrolling
         past max zoom; the cat tower by clicking it. Scroll out to leave either. */
      const PEEK_CFG = {
        bay:   { pivot: new THREE.Vector3(9.0, 1.3, -8.0), arm: 10, zoom: 4.0, yaw0: 0, pitch0: 0.26, yawLim: 0.4, pMin: 0.22, pMax: 0.38 },
        // Behind the row, looking back at the tower from the field side (the rear wall
        // fills the background). Close in: you can see who's on which shelf.
        tower: { pivot: new THREE.Vector3(11.6, 0.95, -16.4), arm: 6, zoom: 8.5, yaw0: Math.PI, pitch0: 0.32, yawLim: 0.9, pMin: 0.18, pMax: 0.62 },
        // Action cam: rides with a cat. Pivot tracks the cat every frame; drag spins all
        // the way round. The near plane is pushed out to just short of the cat, so walls,
        // roofs and cars between the lens and the cat are cut away instead of blocking it.
        cat:   { pivot: new THREE.Vector3(), arm: 6, zoom: 9, yaw0: 0, pitch0: 0.45, yawLim: Infinity, pMin: 0.15, pMax: 1.05, follow: true },
      };
      let followCat = null;
      const catScreenHit = (e) => {
        if (typeof cats === 'undefined') return null;
        const r = renderer.domElement.getBoundingClientRect();
        let best = null, bd = 26;
        cats.forEach(c => {
          tmpVec.copy(c.g.position); tmpVec.y += 0.3; tmpVec.project(camera);
          const sx = (tmpVec.x + 1) / 2 * r.width + r.left, sy = (1 - tmpVec.y) / 2 * r.height + r.top;
          const dd = Math.hypot(sx - e.clientX, sy - e.clientY);
          if (dd < bd && tmpVec.z < 1) { bd = dd; best = c; }
        });
        return best;
      };
      let peekCfg = PEEK_CFG.bay;
      const PEEK_PIVOT = new THREE.Vector3().copy(peekCfg.pivot);
      let PEEK_ARM = peekCfg.arm;
      const PEEK_LOOK = { yaw: 0, pitch: 0.26, drag: null, down: null };
      let catTowerObj = null;   // set when the tower is built
      const peekRay = new THREE.Raycaster(), peekNdc = new THREE.Vector2();
      const hitTower = (e) => {
        if (!catTowerObj) return false;
        const r = renderer.domElement.getBoundingClientRect();
        peekNdc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
        peekRay.setFromCamera(peekNdc, camera);
        return peekRay.intersectObject(catTowerObj, true).length > 0;
      };
      renderer.domElement.addEventListener('pointerdown', (e) => {
        PEEK_LOOK.down = [e.clientX, e.clientY];
        if (PEEK.on) PEEK_LOOK.drag = [e.clientX, e.clientY, PEEK_LOOK.yaw, PEEK_LOOK.pitch];
      });
      window.addEventListener('pointerup', (e) => {
        PEEK_LOOK.drag = null;
        const d = PEEK_LOOK.down; PEEK_LOOK.down = null;
        // A click (not a drag) on the tower opens its close-up.
        if (d && live() && !PEEK.on && Math.hypot(e.clientX - d[0], e.clientY - d[1]) < 5 && e.target === renderer.domElement) {
          const c = catScreenHit(e);
          if (c) enterPeek('cat', c);
          else if (hitTower(e)) enterPeek('tower');
        }
      });
      renderer.domElement.addEventListener('pointermove', (e) => {
        const d = PEEK_LOOK.drag;
        if (!d || !PEEK.on) {
          if (!PEEK.on && !PEEK_LOOK.down) renderer.domElement.style.cursor = live() && (catScreenHit(e) || hitTower(e)) ? 'pointer' : '';
          return;
        }
        const c = peekCfg;
        PEEK_LOOK.yaw = Math.max(-c.yawLim, Math.min(c.yawLim, d[2] - (e.clientX - d[0]) * 0.004));
        PEEK_LOOK.pitch = Math.max(c.pMin, Math.min(c.pMax, d[3] + (e.clientY - d[1]) * 0.003));
      });
      function enterPeek(which, cat) {
        peekCfg = PEEK_CFG[which];
        followCat = cat || null;
        if (followCat) {
          // Start from wherever the camera already is, so the swoop in reads as one move.
          peekCfg.pivot.copy(followCat.g.position); peekCfg.pivot.y += 0.3;
          peekCfg.yaw0 = Math.atan2(camera.position.x - peekCfg.pivot.x, camera.position.z - peekCfg.pivot.z);
        }
        PEEK.on = true; PEEK.armed = 0; drifting = false; setPeekLevel(0);
        PEEK_PIVOT.copy(peekCfg.pivot); PEEK_ARM = peekCfg.arm; PEEK_ZOOM = peekCfg.zoom;
        PEEK_LOOK.yaw = 0; PEEK_LOOK.pitch = peekCfg.pitch0;
        peekFrom.pos.copy(camera.position); peekFrom.tgt.copy(controls.target); peekFrom.zoom = camera.zoom;
        controls.enabled = false;
        renderer.domElement.style.cursor = '';
      }
      const BASE_NEAR = camera.near;
      let peekHud = null;
      const fadeHud = (on) => {
        if (!peekHud) { const c = document.querySelector('[data-diorama-clock]'); peekHud = c && c.parentElement && c.parentElement.parentElement; if (peekHud) peekHud.style.transition = 'opacity 400ms ease'; }
        if (peekHud) peekHud.style.opacity = on ? '0' : '';
        const brand = document.querySelector('[data-diorama-brand]');
        if (brand) { brand.style.transition = 'opacity 400ms ease'; brand.style.opacity = on ? '0' : ''; }
      };
      const PEEK_POS = PEEK_VIEWS[0].pos.clone(), PEEK_TGT = PEEK_VIEWS[0].tgt.clone();
      let PEEK_ZOOM = PEEK_VIEWS[0].zoom;
      const setPeekLevel = (n) => { PEEK_LVL = n; PEEK_POS.copy(PEEK_VIEWS[n].pos); PEEK_TGT.copy(PEEK_VIEWS[n].tgt); PEEK_ZOOM = PEEK_VIEWS[n].zoom; };
      const peekFrom = { pos: new THREE.Vector3(), tgt: new THREE.Vector3(), zoom: 1 };
      const peekStage = { pos: new THREE.Vector3(), tgt: new THREE.Vector3() };
      this._peekExit = () => { if (PEEK.on) { PEEK.on = false; PEEK.armed = 0; PEEK.hush = true; controls.enableZoom = false; } };
      renderer.domElement.addEventListener('wheel', (e) => {
        PEEK.lastWheel = performance.now();
        if (!live()) return;
        // While the scene has the pointer it owns the wheel outright. OrbitControls only
        // claims it when it's zooming, so in a close-up (controls off) or the quiet period
        // after one, the page underneath used to scroll — and on the home page that
        // scrolled you out of Explore and away from the scene.
        e.preventDefault();
        if (e.deltaY < 0) {
          // Zooming in. At the limit already? One more notch — but wait for the controls'
          // damping to actually reach the limit, otherwise the first scroll that lands
          // there also trips the peek.
          if (!PEEK.on && camera.zoom >= controls.maxZoom - 0.02) {
            PEEK.armed += 1;
            if (PEEK.armed >= 2) {
              enterPeek('bay');
            }
          } else if (PEEK.on && PEEK_LVL < PEEK_VIEWS.length - 1 && PEEK.k > 0.95) {
            // Already peeking and settled: the next notch steps further in.
            PEEK.armed += 1;
            if (PEEK.armed >= 2) { PEEK.armed = 0; PEEK.stage = { from: PEEK_LVL, t: 0 }; setPeekLevel(PEEK_LVL + 1); }
          }
        } else if (e.deltaY > 0) {
          PEEK.armed = 0;
          if (PEEK.on) {
            // Step back a level first; out of the peek altogether only from level 0.
            if (PEEK_LVL > 0 && PEEK.k > 0.95) { PEEK.stage = { from: PEEK_LVL, t: 0 }; setPeekLevel(PEEK_LVL - 1); }
            else { PEEK.on = false; PEEK.hush = true; controls.enableZoom = false; }
          }
        }
      }, { passive: false });

      /* ---------- lights (values driven by the day cycle) ---------- */
      const hemi = new THREE.HemisphereLight(0x4A5A72, 0x1E1B16, 1.35);
      scene.add(hemi);

      const sun = new THREE.DirectionalLight(0xB4C6DE, 1.45);
      sun.castShadow = true;
      sun.shadow.mapSize.set(1024, 1024);
      const sc = sun.shadow.camera;
      sc.left = -44; sc.right = 44; sc.top = 44; sc.bottom = -44; sc.near = 1; sc.far = 140;
      sun.shadow.bias = -0.0006;
      // Large flat receivers (ground, grass, pads) are almost coplanar, so a depth bias
      // alone leaves acne crawling across them as the sun swings. Offsetting the sample
      // along the surface normal is what actually kills it.
      sun.shadow.normalBias = 0.06;
      scene.add(sun);

      const lamps = [];   // artificial lights that come up at dusk
      const glows = [];   // emissive planes that come up at dusk
      const addLamp = (light, base, floor) => { lamps.push({ light, base, floor: floor || 0 }); scene.add(light); return light; };
      const addGlow = (mesh, base, floor) => { glows.push({ mesh, base, floor: floor || 0 }); return mesh; };

      /* ---------- material + mesh helpers ----------
         Geometry and material are both cached by their parameters. Without this the scene
         allocates a fresh BoxGeometry per prop (500+ unique buffers for ~30 real shapes),
         which is the single biggest source of draw calls and GPU memory here. */
      const mats = new Map();
      const geos = new Map();
      const mat = (color, opts) => {
        const key = color + ':' + JSON.stringify(opts || {});
        if (!mats.has(key)) {
          mats.set(key, new THREE.MeshStandardMaterial(Object.assign({
            color, flatShading: true, roughness: 0.82, metalness: 0.05
          }, opts || {})));
        }
        return mats.get(key);
      };
      const boxGeo = (w, h, d) => {
        const key = 'b' + w + ',' + h + ',' + d;
        if (!geos.has(key)) geos.set(key, new THREE.BoxGeometry(w, h, d));
        return geos.get(key);
      };
      const cylGeo = (rt, rb, h, seg) => {
        const key = 'c' + rt + ',' + rb + ',' + h + ',' + seg;
        if (!geos.has(key)) geos.set(key, new THREE.CylinderGeometry(rt, rb, h, seg));
        return geos.get(key);
      };
      const planeGeo = (w, h) => {
        const key = 'p' + w + ',' + h;
        if (!geos.has(key)) geos.set(key, new THREE.PlaneGeometry(w, h));
        return geos.get(key);
      };
      const coneGeo = (r, h, seg) => {
        const key = 'n' + r.toFixed(2) + ',' + h.toFixed(2) + ',' + seg;
        if (!geos.has(key)) geos.set(key, new THREE.ConeGeometry(r, h, seg));
        return geos.get(key);
      };
      const circGeo = (r) => {
        const key = 'c' + r.toFixed(2);
        if (!geos.has(key)) geos.set(key, new THREE.CircleGeometry(r, 10));
        return geos.get(key);
      };
      const icoGeo = (r) => {
        const key = 'i' + r.toFixed(2);
        if (!geos.has(key)) geos.set(key, new THREE.IcosahedronGeometry(r, 0));
        return geos.get(key);
      };
      const box = (w, h, d, color, opts) => {
        const m = new THREE.Mesh(boxGeo(w, h, d), mat(color, opts));
        m.castShadow = true; m.receiveShadow = true;
        return m;
      };
      const cyl = (rt, rb, h, seg, color, opts) => {
        const m = new THREE.Mesh(cylGeo(rt, rb, h, seg), mat(color, opts));
        m.castShadow = true; m.receiveShadow = true;
        return m;
      };
      const at = (m, x, y, z) => { m.position.set(x, y, z); return m; };

      /* Static scenery is drawn one mesh at a time even though nothing about it ever
         moves: 44 trees, 14 poles and 29 lane markings alone were ~215 of ~300 draw calls
         a frame, in BOTH the shadow pass and the colour pass. This bakes a group down to
         one mesh per material — same pixels, a fraction of the CPU submitting them. */
      function bakeStatic(root, opts) {
        root.updateMatrixWorld(true);
        const buckets = new Map();
        const skip = (opts && opts.skip) || (() => false);
        const loose = [];
        root.traverse(o => {
          if (!o.isMesh) return;
          if (skip(o)) { loose.push(o); return; }
          const k = o.material.uuid;
          if (!buckets.has(k)) buckets.set(k, { mat: o.material, geos: [], cast: false });
          const b = buckets.get(k);
          const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
          g.applyMatrix4(o.matrixWorld);
          b.geos.push(g);
          b.cast = b.cast || o.castShadow;
        });
        const out = new THREE.Group();
        buckets.forEach(({ mat: m, geos, cast }) => {
          let n = 0;
          geos.forEach(g => { n += g.attributes.position.count; });
          const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
          let off = 0;
          geos.forEach(g => {
            pos.set(g.attributes.position.array, off * 3);
            if (g.attributes.normal) nor.set(g.attributes.normal.array, off * 3);
            off += g.attributes.position.count;
            g.dispose();
          });
          const bg = new THREE.BufferGeometry();
          bg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
          bg.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
          const mesh = new THREE.Mesh(bg, m);
          mesh.castShadow = cast; mesh.receiveShadow = true;
          out.add(mesh);
        });
        loose.forEach(o => out.add(o));
        return out;
      }
      const slab = (w, d, color, y) => {
        const m = new THREE.Mesh(planeGeo(w, d), mat(color, { roughness: 0.95 }));
        m.rotation.x = -Math.PI / 2;
        m.position.y = y || 0;
        m.receiveShadow = true;
        return m;
      };

      /* ---------- ground, apron, road ---------- */
      scene.add(slab(260, 260, C.ground, 0));
      const apron = slab(30, 12, C.apron, 0.02); apron.position.set(6, 0.02, 1.6); scene.add(apron);
      /* ---------- the neighbours' side lot ----------
         West of the west block (its end wall is x -35.5): a pad from the kerb back to the
         block's rear line, a lane down its outer edge off the road, and stalls nosed to the
         end wall. The parts store's customers park here and walk round the corner. */
      const sideLot = slab(11, 19.5, C.pad, 0.03); sideLot.position.set(-41, 0.03, -1.75); scene.add(sideLot);
      [-10.4, -7.2, -4.0, -0.8].forEach(sz => {
        const line = slab(4.8, 0.14, C.stripe, 0.045); line.position.set(-38.2, 0.045, sz); scene.add(line);
      });
      /* The carriageway sits 5 m further out than it did (centre z 17.4, kerbs at 13.2 and
         21.6). Between it and the frontages is a grass verge with a kerb along the road
         edge, broken only at three driveways: Spectrum's entrance (x 1.5–8.5), Spectrum's
         exit (x 17.5–23.5, the old exit drive) and the neighbours' side-lot entrance
         (x -45 to -39). Every car route turns in and out through one of those. */
      const ROAD_Z = 17.4, KERB_N = 13.2;
      const DRIVEWAYS = [[-45, -39], [1.5, 8.5], [17.5, 23.5]];
      const road = slab(220, 8.4, C.road, 0.03); road.position.set(0, 0.03, ROAD_Z); scene.add(road);
      {
        const verge = new THREE.Group();
        const cuts = [[-110, -45], [-39, 1.5], [8.5, 17.5], [23.5, 110]];
        cuts.forEach(([x0, x1]) => {
          const w = x1 - x0, cx = (x0 + x1) / 2;
          // Grass from the frontage line (z 8.0) to the kerb, and a kerb face along the road.
          const g = slab(w, KERB_N - 8.0, 0x3B4A2F, 0.06); g.position.set(cx, 0.06, (8.0 + KERB_N) / 2); g.receiveShadow = true; verge.add(g);
          verge.add(at(box(w, 0.16, 0.24, 0x8A857C), cx, 0.08, KERB_N - 0.12));
        });
        // Driveway aprons: paved, with dropped kerb returns either side.
        DRIVEWAYS.forEach(([x0, x1]) => {
          const d = slab(x1 - x0, KERB_N - 7.4, C.apron, 0.024); d.position.set((x0 + x1) / 2, 0.024, (7.4 + KERB_N) / 2); verge.add(d);
          [x0, x1].forEach(x => verge.add(at(box(0.24, 0.16, KERB_N - 8.0, 0x8A857C), x, 0.08, (8.0 + KERB_N) / 2)));
        });
        scene.add(bakeStatic(verge));
      }
      /* ---------- across the road ----------
         Everything here is the strip nearest the camera, so it stays LOW: a footway along
         the far kerb (the far street lights stand on it), a grass verge, a knee-high hedge
         broken by runs of post-and-rail, and open field beyond. Opposite the shop, a bus
         stop. Nothing taller than the shelter roof, so the diorama is never blocked. */
      const KERB_S = 21.6;
      {
        const far = new THREE.Group();
        far.add(at(box(220, 0.14, 0.24, 0x8A857C), 0, 0.07, KERB_S + 0.12));              // kerb
        const fw = slab(220, 2.0, 0x7A7684, 0.05); fw.position.set(0, 0.05, KERB_S + 1.24); far.add(fw);   // footway
        const fv = slab(220, 3.4, 0x3B4A2F, 0.055); fv.position.set(0, 0.055, KERB_S + 3.94); far.add(fv); // verge
        const field = slab(240, 40, 0x41502F, 0.052); field.position.set(0, 0.052, KERB_S + 25.6); far.add(field);
        // Hedge in runs, with post-and-rail filling the gaps. Varied lengths so it doesn't
        // read as a repeated tile.
        const HEDGE_Z = KERB_S + 5.6;
        let x = -110, k = 0;
        const runs = [14, 9, 18, 6, 12, 16, 8, 20, 10];
        while (x < 110) {
          const len = runs[k % runs.length]; k++;
          if (k % 3 === 0) {
            for (let px = x; px <= x + len; px += 2.4) far.add(at(box(0.1, 0.95, 0.1, 0x5A4A38), px, 0.47, HEDGE_Z));
            [0.42, 0.78].forEach(ry => far.add(at(box(len, 0.07, 0.05, 0x6B5A44), x + len / 2, ry, HEDGE_Z)));
          } else {
            const hh = 0.8 + ((k * 37) % 5) * 0.06;
            far.add(at(box(len, hh, 0.9, k % 2 ? 0x34452A : 0x2E3F26, { roughness: 1 }), x + len / 2, hh / 2, HEDGE_Z));
          }
          x += len;
        }
        // Bus stop opposite the shop: open-fronted shelter with a glazed back toward the
        // field, a bench, and a flag pole at the kerb.
        const BX = 2.2, BZ = KERB_S + 1.6;
        const glass = new THREE.MeshStandardMaterial({ color: 0xBFD3DF, transparent: true, opacity: 0.18, roughness: 0.1, depthWrite: false, side: THREE.DoubleSide });
        const back = new THREE.Mesh(boxGeo(3.0, 1.9, 0.04), glass); at(back, BX, 1.15, BZ + 0.7); back.castShadow = false; far.add(back);
        [-1, 1].forEach(sd => {
          const side = new THREE.Mesh(boxGeo(0.04, 1.9, 1.3), glass); at(side, BX + sd * 1.5, 1.15, BZ + 0.1); side.castShadow = false; far.add(side);
          far.add(at(box(0.07, 2.25, 0.07, 0x2A2825), BX + sd * 1.5, 1.12, BZ + 0.7));
          far.add(at(box(0.07, 2.25, 0.07, 0x2A2825), BX + sd * 1.5, 1.12, BZ - 0.5));
        });
        far.add(at(box(3.2, 0.08, 1.5, 0x2A2825), BX, 2.28, BZ + 0.1));                      // roof
        far.add(at(box(2.2, 0.06, 0.38, 0x6B5A44), BX, 0.46, BZ + 0.45));                    // bench
        far.add(at(box(2.2, 0.06, 0.06, 0x2A2825), BX, 0.24, BZ + 0.45));
        far.add(at(cyl(0.04, 0.04, 2.6, 8, 0x2A2825), BX - 2.3, 1.3, KERB_S + 0.5));         // flag pole
        far.add(at(box(0.5, 0.36, 0.04, 0x20324A), BX - 2.3, 2.45, KERB_S + 0.5));          // stop sign
        scene.add(bakeStatic(far));
        // Shelter strip light: comes up at dusk with the street lights.
        const strip = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.08),
          new THREE.MeshBasicMaterial({ color: 0xF2F0E6, transparent: true, opacity: 0 }));
        strip.rotation.x = Math.PI / 2; at(strip, BX, 2.23, BZ + 0.1); strip.castShadow = false;
        addGlow(strip, 0.9); scene.add(strip);
        addLamp(at(new THREE.PointLight(0xF2EEDD, 6, 5, 2), BX, 2.0, BZ), 6);
      }
      const BUS_SEAT = [2.2, KERB_S + 2.0];
      /* ---------- holidays ----------
         Major US holidays, each with its own dressing, chosen from today's date in
         Papillion (America/Chicago) or pinned from the shop console. Only the active set
         is built; switching disposes the old one. No lights are created at switch time —
         two holiday lamps exist from boot and are just recoloured/re-placed — so a switch
         never changes the shader light count. Every animated bit (bulbs, lantern faces,
         fireworks) is one instanced mesh or one shared material, updated per frame.

           newyear      Dec 31 – Jan 1      gold/silver eave lights, fireworks at night
           valentines   Feb 7 – 14          red/pink heart lights
           stpatricks   Mar 14 – 17         green/gold lights, shamrocks on the fascia
           easter       Easter −7 … +1      pastel bunting, eggs hidden in the grass
           memorial     last Mon of May −2  flags along the verge, patriotic bunting
           july4        Jun 30 – Jul 5      flags, bunting, fireworks at night
           labor        first Mon of Sep −2 flags along the verge
           halloween    Oct 1 – 31          jack-o'-lanterns, hay, skeleton, webs, graves
           veterans     Nov 10 – 11         flags along the verge
           thanksgiving Nov 12 – 4th Thu    hay, pumpkins, corn stalks, leaf wreath
           christmas    day after Thanksgiving – Dec 30   lit tree, presents, wreath, eave lights */
      const HOLIDAY_LABEL = {
        newyear: "New Year's", valentines: "Valentine's Day", stpatricks: "St. Patrick's Day",
        easter: 'Easter', memorial: 'Memorial Day', july4: 'Independence Day', labor: 'Labor Day',
        halloween: 'Halloween', veterans: 'Veterans Day', thanksgiving: 'Thanksgiving', christmas: 'Christmas',
      };
      function chicagoDate() {
        const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: 'numeric', day: 'numeric' })
          .formatToParts(new Date()).reduce((o, x) => (o[x.type] = +x.value, o), {});
        return { y: p.year, m: p.month, d: p.day };
      }
      const dayNum = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / 864e5);
      const nthDow = (y, m, dow, n) => { const f = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(); return 1 + ((dow - f + 7) % 7) + (n - 1) * 7; };
      const lastDow = (y, m, dow) => { const last = new Date(Date.UTC(y, m, 0)); return last.getUTCDate() - ((last.getUTCDay() - dow + 7) % 7); };
      function easterDay(y) {   // Anonymous Gregorian algorithm
        const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
        const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
        const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
        const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
        return dayNum(y, month, day);
      }
      function holidayFor({ y, m, d }) {
        const n = dayNum(y, m, d), inR = (a, b) => n >= a && n <= b;
        if ((m === 12 && d === 31) || (m === 1 && d === 1)) return 'newyear';
        if (m === 2 && d >= 7 && d <= 14) return 'valentines';
        if (m === 3 && d >= 14 && d <= 17) return 'stpatricks';
        const E = easterDay(y); if (inR(E - 7, E + 1)) return 'easter';
        const mem = dayNum(y, 5, lastDow(y, 5, 1)); if (inR(mem - 2, mem)) return 'memorial';
        if ((m === 6 && d === 30) || (m === 7 && d <= 5)) return 'july4';
        const lab = dayNum(y, 9, nthDow(y, 9, 1, 1)); if (inR(lab - 2, lab)) return 'labor';
        if (m === 10) return 'halloween';
        if (m === 11 && (d === 10 || d === 11)) return 'veterans';
        const tg = dayNum(y, 11, nthDow(y, 11, 4, 4));
        if (m === 11 && n >= dayNum(y, 11, 12) && n <= tg) return 'thanksgiving';
        if (inR(tg + 1, dayNum(y, 12, 30))) return 'christmas';
        return null;
      }
      // The two holiday lamps, made at boot so the light count never changes.
      const holLampA = addLamp(at(new THREE.PointLight(0xFFFFFF, 0, 7, 2), 9, 0.6, 0.4), 0);
      const holRecA = lamps[lamps.length - 1];
      const holLampB = addLamp(at(new THREE.PointLight(0xFFFFFF, 0, 6, 2), 2.8, 1.6, 0.2), 0);
      const holRecB = lamps[lamps.length - 1];
      const canvasTex = (w, h, draw) => { const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h); const t = new THREE.CanvasTexture(c); t.anisotropy = 4; return t; };
      const flagTex = canvasTex(96, 52, (g, w, h) => {
        for (let i = 0; i < 13; i++) { g.fillStyle = i % 2 ? '#F2F0EA' : '#B22234'; g.fillRect(0, i * h / 13, w, h / 13 + 1); }
        g.fillStyle = '#3C3B6E'; g.fillRect(0, 0, w * 0.42, h * 7 / 13);
        g.fillStyle = '#F2F0EA'; for (let r = 0; r < 5; r++) for (let c = 0; c < 6; c++) g.fillRect(3 + c * 6.4, 3 + r * 5.2, 1.6, 1.6);
      });
      const webTex = canvasTex(128, 128, (g) => {
        g.strokeStyle = 'rgba(235,235,235,0.85)'; g.lineWidth = 1.2;
        for (let a = 0; a <= 6; a++) { const t = a / 6 * Math.PI / 2; g.beginPath(); g.moveTo(0, 0); g.lineTo(Math.cos(t) * 128, Math.sin(t) * 128); g.stroke(); }
        for (let r = 18; r < 128; r += 18) { g.beginPath(); for (let a = 0; a <= 6; a++) { const t = a / 6 * Math.PI / 2, rr = r - (a % 2) * 4; a ? g.lineTo(Math.cos(t) * rr, Math.sin(t) * rr) : g.moveTo(Math.cos(t) * rr, Math.sin(t) * rr); } g.stroke(); }
      });
      const shamTex = canvasTex(64, 64, (g) => {
        g.fillStyle = '#2E8B3E';
        [[32, 18], [19, 34], [45, 34]].forEach(([x, y]) => { g.beginPath(); g.arc(x, y, 12, 0, Math.PI * 2); g.fill(); });
        g.fillRect(30, 34, 4, 26);
      });
      const tmpCol = new THREE.Color(), tmpObj = new THREE.Object3D();
      let holKey = null, holPinned = undefined, holGroup = null, holAnim = [];

      // Bulbs on a cord along the eave of the whole row, scalloped between hooks.
      function eaveBulbs(G, palette, shape) {
        const pts = [];
        for (let x = -13.0; x <= 13.2; x += 2.2) for (let k = 0; k < 4; k++) {
          const u = k / 4, bx = x + u * 2.2; if (bx > 13.3) break;
          pts.push([bx, 4.86 - Math.sin(u * Math.PI) * 0.28, -1.62]);
        }
        const geo = shape === 'heart' ? boxGeo(0.12, 0.12, 0.05) : new THREE.SphereGeometry(0.07, 8, 6);
        const m = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ toneMapped: false }), pts.length);
        pts.forEach(([x, y, z], i) => { tmpObj.position.set(x, y, z); tmpObj.rotation.set(0, 0, shape === 'heart' ? Math.PI / 4 : 0); tmpObj.updateMatrix(); m.setMatrixAt(i, tmpObj.matrix); m.setColorAt(i, tmpCol.setHex(palette[i % palette.length])); });
        m.castShadow = m.receiveShadow = false; G.add(m);
        const cord = box(26.4, 0.02, 0.02, 0x1A1A1A); cord.castShadow = false; at(cord, 0.1, 4.72, -1.62); G.add(cord);
        const base = pts.map((_, i) => palette[i % palette.length]);
        holAnim.push((T, lamp) => {
          for (let i = 0; i < pts.length; i++) {
            const tw = 0.75 + 0.25 * Math.sin(T * 2.3 + i * 1.7);
            tmpCol.setHex(base[i]).multiplyScalar(0.3 + lamp * 0.9 * tw);
            m.setColorAt(i, tmpCol);
          }
          m.instanceColor.needsUpdate = true;
        });
      }
      // Triangle pennants hung off the same line.
      function bunting(G, palette) {
        const n = 60, geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.16, 0, 0, 0.16, 0, 0, 0, -0.34, 0], 3));
        geo.computeVertexNormals();
        const m = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.9 }), n);
        for (let i = 0; i < n; i++) {
          const x = -13 + i * (26.3 / (n - 1)), u = ((x + 13) % 4.4) / 4.4;
          tmpObj.position.set(x, 4.62 - Math.sin(u * Math.PI) * 0.4, -1.58); tmpObj.rotation.set(0, 0, 0); tmpObj.updateMatrix();
          m.setMatrixAt(i, tmpObj.matrix); m.setColorAt(i, tmpCol.setHex(palette[i % palette.length]));
        }
        m.castShadow = false; G.add(m);
      }
      function flagsOnVerge(G) {
        const fm = new THREE.MeshStandardMaterial({ map: flagTex, side: THREE.DoubleSide, roughness: 0.8 });
        const flags = [];
        for (let x = -40; x <= 40; x += 6) {
          if ([[-45, -39], [1.5, 8.5], [17.5, 23.5]].some(([a, b]) => x > a - 1 && x < b + 1)) continue;
          G.add(at(cyl(0.025, 0.025, 1.6, 6, 0xC9C4BA), x, 0.85, 8.6));
          const f = new THREE.Mesh(new THREE.PlaneGeometry(0.72, 0.4, 6, 1), fm); f.castShadow = false;
          at(f, x + 0.37, 1.42, 8.6); G.add(f); flags.push(f);
        }
        holAnim.push((T) => flags.forEach((f, i) => { f.rotation.y = Math.sin(T * 2.2 + i) * 0.25; }));
      }
      // Fireworks over the trees behind the row: three bursts recycling, additive points.
      function fireworks(G) {
        const B = 3, P = 90, N = B * P;
        const pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
        geo.setAttribute('color', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
        const pts = new THREE.Points(geo, new THREE.PointsMaterial({ size: 4 * renderer.getPixelRatio(), sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
        pts.frustumCulled = false; G.add(pts);
        const HUES = [0xFF4A4A, 0xF2F0EA, 0x5A7BFF, 0xFFD24A, 0x7BFF9A, 0xFF7AE0];
        const bursts = Array.from({ length: B }, (_, b) => ({ t: -b * 1.1, life: 2.4, o: [0, 0, 0], c: new THREE.Color(), v: new Float32Array(P * 3) }));
        const reset = (br) => {
          br.t = -(0.4 + Math.random() * 1.6); br.o = [-22 + Math.random() * 52, 15 + Math.random() * 9, -34 - Math.random() * 8];
          br.c.setHex(HUES[Math.floor(Math.random() * HUES.length)]);
          for (let i = 0; i < P; i++) {
            const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1), sp = 5 + Math.random() * 1.5;
            br.v[i * 3] = Math.sin(ph) * Math.cos(th) * sp; br.v[i * 3 + 1] = Math.cos(ph) * sp; br.v[i * 3 + 2] = Math.sin(ph) * Math.sin(th) * sp;
          }
        };
        bursts.forEach(reset);
        holAnim.push((T, lamp, dt) => {
          pts.visible = lamp > 0.5;
          if (!pts.visible) return;
          bursts.forEach((br, b) => {
            br.t += dt; if (br.t > br.life) reset(br);
            const t = Math.max(0, br.t), on = br.t > 0, fade = on ? Math.pow(1 - t / br.life, 1.6) : 0;
            for (let i = 0; i < P; i++) {
              const k = (b * P + i) * 3;
              pos[k] = br.o[0] + br.v[i * 3] * t; pos[k + 1] = br.o[1] + br.v[i * 3 + 1] * t - 2.2 * t * t; pos[k + 2] = br.o[2] + br.v[i * 3 + 2] * t;
              col[k] = br.c.r * fade; col[k + 1] = br.c.g * fade; col[k + 2] = br.c.b * fade;
            }
          });
          geo.attributes.position.needsUpdate = true; geo.attributes.color.needsUpdate = true;
        });
      }
      function pumpkin(G, x, z, s, carved, faceMat, y) {
        const p = new THREE.Mesh(new THREE.SphereGeometry(0.28 * s, 10, 8), mat(0xD9701E, { roughness: 0.7 }));
        p.scale.y = 0.78; at(p, x, (y || 0) + 0.22 * s, z); p.castShadow = true; G.add(p);
        G.add(at(cyl(0.03 * s, 0.04 * s, 0.1 * s, 6, 0x4A5A2A), x, (y || 0) + 0.46 * s, z));
        if (!carved) return;
        // Face toward the street (+z): two eyes and a grin.
        [[-0.09, 0.27, 0.07, 0.06], [0.09, 0.27, 0.07, 0.06], [0, 0.15, 0.2, 0.05]].forEach(([fx, fy, fw, fh]) => {
          const f = new THREE.Mesh(new THREE.PlaneGeometry(fw * s, fh * s), faceMat);
          at(f, x + fx * s, (y || 0) + fy * s, z + 0.275 * s); f.castShadow = false; G.add(f);
        });
      }
      const hay = (G, x, z, y) => { const b = box(1.1, 0.5, 0.6, 0xC9A24A, { roughness: 1 }); at(b, x, (y || 0) + 0.25, z); G.add(b); return b; };
      /* ---------- yard-prop kit for the holidays ----------
         Lawn in front of Sean's bay is x 8.5–17.5, z 8–13.2 (Christmas tree at 11.2, 10.6);
         the west verge x -39…1.5 (Halloween's graveyard is x -17…0). Glowing props scale
         with the lamp level, so they read lit after dark and painted by day. */
      const glowMat = (c) => new THREE.MeshBasicMaterial({ color: c, toneMapped: false });
      const glowProps = [];
      const glowing = (m, c) => { glowProps.push({ m, c }); return m; };
      const heartShape = (() => { const h = new THREE.Shape(); h.moveTo(0, -0.5); h.bezierCurveTo(-0.1, -0.35, -0.6, -0.1, -0.6, 0.18); h.bezierCurveTo(-0.6, 0.45, -0.3, 0.6, 0, 0.35); h.bezierCurveTo(0.3, 0.6, 0.6, 0.45, 0.6, 0.18); h.bezierCurveTo(0.6, -0.1, 0.1, -0.35, 0, -0.5); return h; })();
      const starShape = (() => { const h = new THREE.Shape(); for (let i = 0; i < 10; i++) { const r = i % 2 ? 0.22 : 0.5, a = Math.PI / 2 + i * Math.PI / 5; i ? h.lineTo(Math.cos(a) * r, Math.sin(a) * r) : h.moveTo(Math.cos(a) * r, Math.sin(a) * r); } h.closePath(); return h; })();
      const flatGeo = (shape, d) => new THREE.ExtrudeGeometry(shape, { depth: d || 0.06, bevelEnabled: false, curveSegments: 8 });
      // A yard sign on two stakes: shape cut-out, lit.
      function yardShape(G, shape, x, z, size, color, y, ry) {
        const m = new THREE.Mesh(flatGeo(shape), glowMat(color)); m.scale.setScalar(size); m.castShadow = false;
        at(m, x, (y || 0.5) + size * 0.5, z); m.rotation.y = ry || 0; G.add(glowing(m, color));
        [-0.25, 0.25].forEach(dx => G.add(at(box(0.03, (y || 0.5) + 0.1, 0.03, 0x3A3632), x + dx * size, ((y || 0.5) + 0.1) / 2, z - 0.02)));
        return m;
      }
      // A bunch of balloons on strings, bobbing.
      function balloons(G, x, z, palette, n) {
        const items = [];
        for (let i = 0; i < n; i++) {
          const b = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 10), mat(palette[i % palette.length], { roughness: 0.35, metalness: 0.2 }));
          b.scale.y = 1.18; b.castShadow = false;
          const ox = (i - (n - 1) / 2) * 0.3, oy = 2.0 + (i % 3) * 0.3;
          at(b, x + ox, oy, z + (i % 2) * 0.2); G.add(b);
          const str = box(0.008, oy - 0.2, 0.008, 0xE8E4DC); at(str, x + ox * 0.5, (oy - 0.2) / 2, z + (i % 2) * 0.1); str.castShadow = false; G.add(str);
          items.push({ b, y0: oy, ph: i * 1.3 });
        }
        G.add(at(box(0.16, 0.14, 0.16, 0x5A4A3C), x, 0.07, z));          // the weight
        holAnim.push((T) => items.forEach(o => { o.b.position.y = o.y0 + Math.sin(T * 1.4 + o.ph) * 0.06; o.b.rotation.z = Math.sin(T * 0.9 + o.ph) * 0.08; }));
      }
      // Flag on a tall pole, gently waving.
      function bigFlag(G, x, z, halfStaff) {
        G.add(at(cyl(0.05, 0.06, 5.2, 8, 0xC8C4BC, { metalness: 0.6, roughness: 0.4 }), x, 2.6, z));
        G.add(at(new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), mat(0xD9B44A, { metalness: 0.7 })), x, 5.25, z));
        const f = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 1.0, 8, 1), new THREE.MeshStandardMaterial({ map: flagTex, side: THREE.DoubleSide, roughness: 0.8 }));
        f.position.set(x + 1.0, halfStaff ? 2.9 : 4.6, z); f.castShadow = true; G.add(f);
        const p = f.geometry.attributes.position, x0 = Float32Array.from({ length: p.count }, (_, i) => p.getX(i));
        holAnim.push((T) => { for (let i = 0; i < p.count; i++) p.setZ(i, Math.sin(T * 3 + x0[i] * 3) * 0.08 * (x0[i] + 0.95)); p.needsUpdate = true; });
      }
      // Text banner on the fascia above Sean's opening.
      function fasciaBanner(G, text, bg, fg) {
        const t = canvasTex(512, 72, (g, w, h) => { g.fillStyle = bg; g.fillRect(0, 0, w, h); g.fillStyle = fg; let fs = 44; do { g.font = '700 ' + fs + 'px Newsreader, Georgia, serif'; fs -= 2; } while (g.measureText(text).width > w - 36 && fs > 18); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, w / 2, h / 2 + 2); });
        const m = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 0.6), new THREE.MeshBasicMaterial({ map: t, toneMapped: false, side: THREE.DoubleSide })); m.castShadow = false;
        // Hung just under the eave line and proud of the lintel, so the roof overhang and
        // the bunting above it don't cover the lettering.
        at(m, 9, 3.78, -1.62); G.add(glowing(m, 0xFFFFFF));
        [-2.0, 2.0].forEach(dx => { const cord = box(0.012, 0.42, 0.012, 0x2A2622); cord.castShadow = false; at(cord, 9 + dx, 4.29, -1.64); G.add(cord); });
      }
      function wreath(G, x, y, z, ring, bow) {
        const w = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.13, 8, 20), mat(ring, { roughness: 0.9 })); at(w, x, y, z); G.add(w);
        if (bow) G.add(at(box(0.22, 0.16, 0.08, bow), x, y - 0.38, z + 0.08));
      }

      function buildHoliday(key) {
        const G = new THREE.Group(); holAnim = []; glowProps.length = 0;
        holAnim.push((T, lamp) => glowProps.forEach(o => o.m.material.color.setHex(o.c).multiplyScalar(0.55 + lamp * 0.55)));
        let A = null, Bc = null, aBase = 0, bBase = 0;
        holLampA.position.set(9, 0.6, 0.4); holLampB.position.set(2.8, 1.6, 0.2);
        switch (key) {
          case 'halloween': {
            const faceMat = new THREE.MeshBasicMaterial({ color: 0x2A1A08, toneMapped: false });
            holAnim.push((T, lamp) => { const fl = 0.75 + 0.25 * Math.sin(T * 17) * Math.sin(T * 7.3); faceMat.color.setHex(0x2A1A08).lerp(tmpCol.setHex(0xFFB040), lamp * fl); });
            hay(G, 2.0, -1.25); hay(G, 3.2, -1.25); hay(G, 2.6, -1.25, 0.5);
            pumpkin(G, 4.45, -1.45, 1.1, true, faceMat); pumpkin(G, 3.8, -1.0, 0.8, true, faceMat);
            pumpkin(G, 1.6, -1.25, 0.9, true, faceMat, 0.5); pumpkin(G, 13.8, -1.3, 0.9, false);
            pumpkin(G, -26.0, -1.55, 0.9, true, faceMat); pumpkin(G, -32.2, -1.55, 1.0, true, faceMat);
            // Skeleton slumped on the top bale.
            const bone = 0xE6E1D3, sk = new THREE.Group();
            sk.add(at(box(0.22, 0.24, 0.22, bone), 0, 1.38, 0));             // skull
            [-0.05, 0.05].forEach(ex => { const e = box(0.05, 0.05, 0.02, 0x111111); e.castShadow = false; sk.add(at(e, ex, 1.4, 0.115)); });
            sk.add(at(box(0.08, 0.5, 0.06, bone), 0, 1.0, 0));                // spine
            for (let r = 0; r < 4; r++) sk.add(at(box(0.32 - r * 0.03, 0.03, 0.18, bone), 0, 1.14 - r * 0.09, 0));
            [-1, 1].forEach(sd => { const a = box(0.05, 0.42, 0.05, bone); a.rotation.z = sd * 0.35; sk.add(at(a, sd * 0.2, 0.98, 0.05)); const l = box(0.06, 0.06, 0.48, bone); sk.add(at(l, sd * 0.09, 0.78, 0.26)); const sh = box(0.05, 0.42, 0.05, bone); sk.add(at(sh, sd * 0.09, 0.57, 0.5)); });
            sk.position.set(2.6, 0.27, -1.2); sk.rotation.z = 0.12; G.add(sk);
            // Webs across the top corners of the bay door.
            const wm = new THREE.MeshBasicMaterial({ map: webTex, transparent: true, depthWrite: false, side: THREE.DoubleSide });
            [[5.2, 1], [12.8, -1]].forEach(([wx, sd]) => { const w = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 1.0), wm); w.scale.x = sd; at(w, wx + sd * 0.5 - sd * 0.5 + (sd > 0 ? 0.45 : -0.45), 3.55, -1.96); w.castShadow = false; G.add(w); });
            // A little graveyard on the verge west of the entrance.
            // Two staggered rows, mixed shapes (rounded, cross, slab), each leaning a little.
            [[-13.4, 10.0, 0.1, 0], [-11.8, 11.5, -0.12, 1], [-10.2, 9.8, 0.06, 2], [-8.7, 11.3, 0.18, 0],
             [-7.2, 10.2, 0.1, 1], [-5.6, 11.4, -0.15, 0], [-3.8, 10.0, 0.05, 2], [-2.0, 11.6, -0.2, 0],
             [-15.0, 11.2, -0.08, 2], [-16.6, 9.9, 0.14, 1], [-0.5, 10.1, 0.12, 1], [-9.5, 12.4, -0.05, 2]].forEach(([gx, gz, ry, kind]) => {
              const g = new THREE.Group(); g.position.set(gx, 0, gz); g.rotation.set(-0.08, ry, ry * 0.4);
              const stone = 0x8C8A86;
              if (kind === 0) {
                g.add(at(box(0.6, 0.8, 0.14, stone, { roughness: 1 }), 0, 0.4, 0));
                const top = cyl(0.3, 0.3, 0.14, 12, stone); top.rotation.x = Math.PI / 2; at(top, 0, 0.8, 0); g.add(top);
              } else if (kind === 1) {
                g.add(at(box(0.16, 1.1, 0.14, 0x7E7C78, { roughness: 1 }), 0, 0.55, 0));
                g.add(at(box(0.62, 0.16, 0.14, 0x7E7C78, { roughness: 1 }), 0, 0.78, 0));
              } else {
                g.add(at(box(0.8, 0.55, 0.16, 0x9A9792, { roughness: 1 }), 0, 0.275, 0));
              }
              g.add(at(box(0.7, 0.04, 0.9, 0x4A3E30, { roughness: 1 }), 0, 0.07, 0.5));   // the turned earth
              G.add(g);
            });
            eaveBulbs(G, [0xFF7A1A, 0x9B4AFF, 0xFF7A1A, 0x6AFF4A]);
            // The big-box-store giant: a skeleton hauling itself out of the lawn in front of
            // the bay, buried to the hips, both hands planted on the turf, elbows out as it
            // pushes up, head thrown back. Limbs are built point-to-point (boneBetween), so
            // every joint meets where it should whatever the pose.
            { const bone = mat(0xE6DFCC, { roughness: 0.85 }), dark = mat(0x16110C, { roughness: 1 }), dirt = mat(0x3A2A1E, { roughness: 1 });
              const sk = new THREE.Group(); sk.position.set(12.4, 0, 10.4); sk.rotation.y = -0.18; sk.scale.setScalar(1.5);
              const Y = new THREE.Vector3(0, 1, 0), V = (x, y, z) => new THREE.Vector3(x, y, z);
              const boneBetween = (p, q, r, parent) => {
                const d = q.clone().sub(p), L = d.length();
                const m = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.85, r, L, 7), bone);
                m.position.copy(p).addScaledVector(d, 0.5); m.quaternion.setFromUnitVectors(Y, d.normalize()); m.castShadow = true;
                (parent || sk).add(m);
              };
              const knob = (p, r, parent) => { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), bone); m.position.copy(p); m.castShadow = true; (parent || sk).add(m); };

              // Dirt: a churned mound round the waist, clods of turf flung out, piles under the hands.
              const mound = new THREE.Mesh(new THREE.SphereGeometry(0.75, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), dirt);
              mound.scale.set(1.15, 0.32, 0.95); mound.receiveShadow = true; sk.add(mound);
              [[0.85, 0.35, 0.5], [-0.8, 0.5, -0.4], [0.3, -0.75, 0.9], [-0.45, -0.6, 0.2], [0.95, -0.25, 1.2], [-1.05, 0.15, 0.7]].forEach(([cx, cz, r]) => {
                const cl = new THREE.Mesh(boxGeo(0.2, 0.08, 0.18), mat(0x3E5A2E, { roughness: 1 })); cl.rotation.set(r, cx * 2, 0.5); at(cl, cx, 0.05, cz); sk.add(cl);
                sk.add(at(box(0.16, 0.06, 0.14, 0x2E2218), cx * 0.8, 0.03, cz * 0.8));
              });

              // Torso: leans toward the road as it heaves itself up.
              const up = new THREE.Group(); up.position.set(0, -0.05, -0.05); up.rotation.set(0.3, 0, 0.06); sk.add(up);
              // Spine: one continuous column tucked against the back of the ribs, ridged with
              // vertebrae, running down into the dirt — no loose blocks hanging below the cage.
              boneBetween(V(0, 0.0, -0.17), V(0, 1.3, -0.17), 0.04, up);
              for (let i = 0; i < 9; i++) { const v = cyl(0.055, 0.055, 0.035, 8, 0xDCD4C0); at(v, 0, 0.3 + i * 0.12, -0.17); up.add(v); }
              // Seven pairs of ribs, each an arc from the spine round the side, sloping down toward the front.
              [0.22, 0.27, 0.3, 0.32, 0.33, 0.32, 0.29].forEach((r, i) => {
                const y = 1.12 - i * 0.095;
                [-1, 1].forEach(sd => {
                  const g = new THREE.TorusGeometry(r, 0.022, 5, 14, Math.PI - 0.5);
                  g.rotateZ(sd > 0 ? -Math.PI / 2 + 0.5 : Math.PI / 2); g.rotateX(-Math.PI / 2);
                  const rib = new THREE.Mesh(g, bone); rib.scale.set(1, 1, 0.72); rib.rotation.x = 0.32;
                  rib.position.set(0, y, 0.0); rib.castShadow = true; up.add(rib);
                });
              });
              const stern = box(0.07, 0.36, 0.035, 0xE6DFCC); stern.rotation.x = 0.12; at(stern, 0, 0.92, 0.22); up.add(stern);
              // Shoulder girdle. Each shoulder joint sits on the top outer corner of the cage,
              // held by a collarbone running forward to the top of the breastbone and a
              // shoulder blade lying flat on the upper back ribs, its spine ending at the joint.
              const shL = V(-0.3, 1.14, -0.05), shR = V(0.3, 1.14, -0.05);
              [-1, 1].forEach(sd => {
                const sh = sd < 0 ? shL : shR;
                boneBetween(V(sd * 0.03, 1.1, 0.21), V(sd * 0.27, 1.16, -0.02), 0.022, up);   // clavicle
                knob(sh, 0.055, up);
                // Scapula: a thin triangle against the back of ribs 2–5.
                const tri = new THREE.Shape(); tri.moveTo(0, 0); tri.lineTo(-sd * 0.15, -0.05); tri.lineTo(-sd * 0.05, -0.3); tri.closePath();
                const sg = new THREE.ExtrudeGeometry(tri, { depth: 0.018, bevelEnabled: false });
                const sc = new THREE.Mesh(sg, bone); sc.castShadow = true;
                sc.position.set(sd * 0.27, 1.12, -0.2); sc.rotation.set(-0.3, -sd * 0.55, 0); up.add(sc);
                boneBetween(V(sd * 0.12, 1.07, -0.24), V(sd * 0.29, 1.15, -0.09), 0.016, up);  // spine of the scapula up to the joint
              });

              // Neck and skull, tipped back to look up out of the hole.
              for (let i = 0; i < 3; i++) up.add(at(box(0.07, 0.06, 0.07, 0xE6DFCC), 0, 1.3 + i * 0.07, -0.16));
              const head = new THREE.Group(); head.position.set(0, 1.6, -0.08); head.rotation.x = -0.45; up.add(head);
              const cran = new THREE.Mesh(new THREE.SphereGeometry(0.2, 18, 14), bone); cran.scale.set(0.86, 0.92, 1.08); cran.position.set(0, 0.06, -0.02); cran.castShadow = true; head.add(cran);
              // Face plate: brow, cheekbones, maxilla — flatter than the dome, so it reads as a face.
              head.add(at(box(0.3, 0.05, 0.08, 0xE6DFCC), 0, 0.07, 0.15));                    // brow ridge
              [-1, 1].forEach(sd => { const ck = box(0.08, 0.05, 0.1, 0xE6DFCC); ck.rotation.y = sd * 0.4; at(ck, sd * 0.12, -0.04, 0.12); head.add(ck); });
              head.add(at(box(0.15, 0.08, 0.1, 0xE6DFCC), 0, -0.09, 0.14));                   // upper jaw
              // Big dark sockets and the nasal hole, set into the face.
              [-0.068, 0.068].forEach(ex => {
                const so = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 8), dark); so.scale.set(1, 0.9, 0.5); at(so, ex, 0.0, 0.17); head.add(so);
                const eye = new THREE.Mesh(new THREE.SphereGeometry(0.022, 6, 5), glowMat(0xFF3A1A)); eye.castShadow = false; at(eye, ex, 0.0, 0.185); head.add(glowing(eye, 0xFF3A1A));
              });
              const nose = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.06, 3), dark); nose.rotation.set(Math.PI, 0, 0); at(nose, 0, -0.05, 0.19); head.add(nose);
              for (let i = 0; i < 6; i++) head.add(at(box(0.018, 0.03, 0.02, 0xF2EEE2), -0.05 + i * 0.02, -0.14, 0.18));   // upper teeth
              // The jaw hangs open in a scream, hinged under the ears.
              const jaw = new THREE.Group(); jaw.position.set(0, -0.11, 0.02); jaw.rotation.x = 0.55; head.add(jaw);
              jaw.add(at(box(0.15, 0.04, 0.16, 0xE6DFCC), 0, -0.05, 0.08));
              [-1, 1].forEach(sd => jaw.add(at(box(0.03, 0.09, 0.05, 0xE6DFCC), sd * 0.08, -0.01, 0.0)));
              for (let i = 0; i < 6; i++) jaw.add(at(box(0.018, 0.03, 0.02, 0xF2EEE2), -0.05 + i * 0.02, -0.02, 0.15));

              // Arms: shoulders read back out of the leaning torso, hands planted on the
              // turf ahead and to the side, elbows bowed out and up as it pushes.
              up.updateMatrix();
              [[-1, shL], [1, shR]].forEach(([sd, sh0]) => {
                const sh = sh0.clone().applyMatrix4(up.matrix);
                const hand = V(sd * 0.78, 0.04, 0.62);
                const elbow = sh.clone().lerp(hand, 0.45).add(V(sd * 0.3, 0.16, -0.1));
                boneBetween(sh, elbow, 0.04);                                                    // humerus
                knob(elbow, 0.05);
                boneBetween(elbow, V(hand.x - sd * 0.02, hand.y + 0.04, hand.z - 0.04), 0.03);   // radius
                boneBetween(elbow.clone().add(V(0, 0, 0.03)), V(hand.x + sd * 0.02, hand.y + 0.04, hand.z - 0.06), 0.025);   // ulna
                const palm = box(0.13, 0.03, 0.12, 0xE6DFCC); palm.rotation.y = -sd * 0.25; at(palm, hand.x, hand.y, hand.z); sk.add(palm);
                // Fingers clawed into the dirt: up over the knuckle, then down into the turf.
                for (let f = 0; f < 4; f++) {
                  const ox = (f - 1.5) * 0.035, base = V(hand.x + ox, hand.y + 0.01, hand.z + 0.06);
                  const kn = V(base.x + ox * 0.4 - sd * 0.01, base.y + 0.05, base.z + 0.08), tip = V(kn.x + ox * 0.3, 0.0, kn.z + 0.08);
                  boneBetween(base, kn, 0.013); boneBetween(kn, tip, 0.011);
                }
                boneBetween(V(hand.x - sd * 0.07, hand.y, hand.z), V(hand.x - sd * 0.15, 0.01, hand.z + 0.08), 0.013);   // thumb
                const pile = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), dirt); pile.scale.y = 0.35; at(pile, hand.x, 0, hand.z + 0.05); sk.add(pile);
              });
              G.add(sk); }
            // No coloured lamps: low point lights threw bright purple/orange pools on the
            // ground that read as stray reflections. The lanterns and bulbs glow on their own.
            A = 0x8A3AFF; aBase = 0; Bc = 0xFF8A2A; bBase = 0;
            break;
          }
          case 'christmas': {
            const T0 = new THREE.Group();
            T0.add(at(cyl(0.12, 0.14, 0.5, 8, 0x4A3628), 0, 0.25, 0));
            [[1.05, 1.4, 0.95], [0.82, 1.2, 1.7], [0.56, 1.0, 2.35]].forEach(([r, h, y]) => { const c = new THREE.Mesh(new THREE.ConeGeometry(r, h, 12), mat(0x1F4A2A, { roughness: 0.9 })); c.castShadow = true; at(c, 0, y, 0); T0.add(c); });
            const star = new THREE.Mesh(new THREE.OctahedronGeometry(0.16), new THREE.MeshBasicMaterial({ color: 0xFFE07A, toneMapped: false })); at(star, 0, 2.95, 0); star.castShadow = false; T0.add(star);
            // Bulbs wound round the cones.
            const NB = 54, bulbs = new THREE.InstancedMesh(new THREE.SphereGeometry(0.055, 6, 5), new THREE.MeshBasicMaterial({ toneMapped: false }), NB);
            const pal = [0xFF3A3A, 0x3AFF6A, 0x4A7BFF, 0xFFD24A, 0xFF7AE0], base = [];
            for (let i = 0; i < NB; i++) { const u = i / NB, y = 0.5 + u * 2.3, r = 1.0 * (1 - u * 0.86) + 0.04, a = u * Math.PI * 11; tmpObj.position.set(Math.cos(a) * r, y, Math.sin(a) * r); tmpObj.rotation.set(0, 0, 0); tmpObj.updateMatrix(); bulbs.setMatrixAt(i, tmpObj.matrix); base.push(pal[i % pal.length]); bulbs.setColorAt(i, tmpCol.setHex(base[i])); }
            bulbs.castShadow = false; T0.add(bulbs);
            holAnim.push((T, lamp) => { for (let i = 0; i < NB; i++) { const tw = 0.6 + 0.4 * Math.sin(T * 1.9 + i * 2.1); bulbs.setColorAt(i, tmpCol.setHex(base[i]).multiplyScalar(0.3 + lamp * tw)); } bulbs.instanceColor.needsUpdate = true; star.material.color.setHex(0xFFE07A).multiplyScalar(0.5 + lamp * 0.6); });
            // On the lawn straight in front of Sean's bay (grass x 8.5–17.5), clear of the
            // door and the apron, with the presents ringed round the road-facing side.
            const TX = 11.2, TZ = 10.6;
            T0.position.set(TX, 0, TZ); G.add(T0);
            [[-0.95, 0.7, 0xE0283A, 0.62, 0xFFD24A], [0.2, 1.05, 0x2E8AD9, 0.5, 0xF2F0EA], [1.05, 0.55, 0xF2C230, 0.56, 0xC8283A],
             [-0.35, 1.35, 0x2FAE5A, 0.38, 0xF2F0EA], [0.75, 1.3, 0xC85AD9, 0.4, 0xFFD24A], [-1.2, -0.2, 0xF2F0EA, 0.46, 0xE0283A],
             [1.25, -0.35, 0xE0283A, 0.34, 0xF2F0EA]].forEach(([dx, dz, c, sz, rib]) => {
              const px = TX + dx, pz = TZ + dz, ry = (dx * 7) % 1;
              const pg = new THREE.Group(); pg.position.set(px, 0, pz); pg.rotation.y = ry;
              pg.add(at(box(sz, sz * 0.82, sz, c, { roughness: 0.55 }), 0, sz * 0.41, 0));
              pg.add(at(box(sz + 0.02, sz * 0.84, 0.07, rib), 0, sz * 0.41, 0));
              pg.add(at(box(0.07, sz * 0.84, sz + 0.02, rib), 0, sz * 0.41, 0));
              const bow = box(0.2, 0.1, 0.2, rib); bow.rotation.y = 0.785; at(bow, 0, sz * 0.82 + 0.05, 0); pg.add(bow);
              G.add(pg);
            });
            wreath(G, 9, 4.55, -1.9, 0x1F4A2A, 0xB22234);
            eaveBulbs(G, [0xFF3A3A, 0x3AFF6A, 0x4A7BFF, 0xFFD24A]);
            // Santa's sleigh and two reindeer on the roof, between the skylights.
            { const SY = 5.375, sl = new THREE.Group(); sl.position.set(3.6, SY, -3.6);
              sl.add(at(box(1.3, 0.5, 0.8, 0xB22234, { roughness: 0.5 }), 0, 0.45, 0));
              sl.add(at(box(0.3, 0.75, 0.8, 0xB22234, { roughness: 0.5 }), -0.55, 0.6, 0));
              [-0.36, 0.36].forEach(rz => sl.add(at(box(1.7, 0.06, 0.06, 0xD9B44A, { metalness: 0.6 }), 0.1, 0.12, rz)));
              const santa = new THREE.Group(); santa.position.set(-0.05, 0.7, 0);
              santa.add(at(box(0.44, 0.5, 0.46, 0xC8283A), 0, 0.2, 0));
              santa.add(at(box(0.3, 0.28, 0.3, 0xF0C8A8), 0, 0.6, 0));
              santa.add(at(box(0.32, 0.2, 0.32, 0xF2F0EA), 0.03, 0.48, 0));                // beard
              const hat = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.32, 8), mat(0xC8283A)); at(hat, 0, 0.9, 0); hat.rotation.z = -0.3; santa.add(hat);
              santa.add(at(new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 5), mat(0xF2F0EA)), 0.08, 1.05, 0));
              sl.add(santa);
              sl.add(at(box(0.5, 0.42, 0.42, 0x6A4A2A), -0.3, 0.92, 0));                     // sack of toys
              G.add(sl);
              const deer = (x, ph) => {
                const d = new THREE.Group(); d.position.set(x, SY, -3.6);
                d.add(at(box(0.8, 0.36, 0.3, 0x7A5432), 0, 0.62, 0));
                [[-0.28, 0.12], [0.28, 0.12], [-0.28, -0.12], [0.28, -0.12]].forEach(([lx, lz]) => d.add(at(box(0.07, 0.45, 0.07, 0x5A3E26), lx, 0.22, lz)));
                d.add(at(box(0.12, 0.32, 0.14, 0x7A5432), 0.4, 0.88, 0));
                const head = box(0.28, 0.18, 0.18, 0x7A5432); at(head, 0.52, 1.06, 0); d.add(head);
                [-0.06, 0.06].forEach(az => { const an = box(0.04, 0.28, 0.04, 0xC9A27A); an.rotation.z = -0.4; at(an, 0.42, 1.28, az); d.add(an); });
                G.add(d); return { d, ph };
              };
              const herd = [deer(5.1, 0), deer(6.3, 1.6)];
              const nose = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 5), glowMat(0xFF2A2A)); nose.castShadow = false; at(nose, 6.3 + 0.67, SY + 1.06, -3.6); G.add(glowing(nose, 0xFF2A2A));
              [5.1, 6.3].forEach(x => G.add(at(box(0.9, 0.03, 0.03, 0xD9B44A), x - 0.75, SY + 0.7, -3.6)));   // harness
              holAnim.push((T) => herd.forEach(o => { o.d.position.y = SY + Math.max(0, Math.sin(T * 2.2 + o.ph)) * 0.05; }));
            }
            // Lawn: two light-up wire reindeer, a snowman and candy canes along the kerb.
            const wire = (x, z, ry, sc) => {
              const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = ry; g.scale.setScalar(sc);
              const wm2 = glowMat(0xF2F0EA);
              [[0.9, 0.06, 0.06, 0, 0.75, 0], [0.06, 0.6, 0.06, -0.38, 0.38, 0.12], [0.06, 0.6, 0.06, 0.38, 0.38, 0.12], [0.06, 0.6, 0.06, -0.38, 0.38, -0.12], [0.06, 0.6, 0.06, 0.38, 0.38, -0.12], [0.06, 0.45, 0.06, 0.48, 1.0, 0], [0.32, 0.06, 0.06, 0.6, 1.2, 0]]
                .forEach(([w, h, d, px, py, pz]) => { const m = new THREE.Mesh(boxGeo(w, h, d), wm2); m.castShadow = false; at(m, px, py, pz); g.add(m); });
              [-0.08, 0.08].forEach(az => { const an = new THREE.Mesh(boxGeo(0.04, 0.32, 0.04), wm2); an.rotation.z = -0.5; at(an, 0.5, 1.42, az); g.add(an); });
              glowProps.push({ m: { material: wm2 }, c: 0xF2F0EA });
              G.add(g);
            };
            wire(14.6, 10.2, -0.3, 1.25); wire(16.0, 11.2, 0.2, 1.0);
            { const sm = mat(0xF4F4F6, { roughness: 0.9 }), x = 9.3, z = 11.6;
              [[0.42, 0.4], [0.32, 0.98], [0.23, 1.44]].forEach(([r, y]) => { const b = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 10), sm); b.castShadow = true; at(b, x, y, z); G.add(b); });
              G.add(at(box(0.36, 0.06, 0.36, 0x1A1A1E), x, 1.66, z)); G.add(at(box(0.24, 0.24, 0.24, 0x1A1A1E), x, 1.81, z));
              const carrot = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.2, 6), mat(0xE87A2A)); carrot.rotation.x = Math.PI / 2; at(carrot, x, 1.44, z + 0.31); G.add(carrot);
              G.add(at(box(0.5, 0.08, 0.5, 0xB22234), x, 1.2, z));                        // scarf
              [-1, 1].forEach(sd => { const arm = box(0.5, 0.03, 0.03, 0x4A3628); arm.rotation.z = sd * 0.5; at(arm, x + sd * 0.48, 1.08, z); G.add(arm); }); }
            [9.0, 10.6, 12.2, 13.8, 15.4, 17.0].forEach(x => {
              const cc = new THREE.Group(); cc.position.set(x, 0, 12.7);
              for (let k = 0; k < 6; k++) cc.add(at(box(0.07, 0.14, 0.07, k % 2 ? 0xF2F0EA : 0xD62A3A), 0, 0.07 + k * 0.14, 0));
              const hook = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.035, 6, 10, Math.PI), mat(0xD62A3A)); at(hook, -0.1, 0.84, 0); cc.add(hook);
              G.add(cc);
            });
            A = 0xFFD9A0; aBase = 6; Bc = 0xFFC88A; bBase = 9;
            holLampB.position.set(11.2, 1.8, 11.8);   // lights the tree and presents from the road side
            break;
          }
          case 'thanksgiving': {
            hay(G, 2.0, -1.25); hay(G, 3.2, -1.25);
            pumpkin(G, 2.0, -1.25, 0.9, false, null, 0.5); pumpkin(G, 3.3, -1.25, 0.7, false, null, 0.5); pumpkin(G, 4.4, -1.4, 1.1, false); pumpkin(G, 13.8, -1.3, 0.8, false);
            [[1.2, -1.5], [4.9, -1.6]].forEach(([cx, cz]) => { for (let k = 0; k < 7; k++) { const st = box(0.05, 1.7, 0.05, 0xB8964A); st.rotation.set((k - 3) * 0.05, 0, (k - 3) * 0.07); at(st, cx + (k - 3) * 0.04, 0.85, cz); G.add(st); } G.add(at(box(0.22, 0.06, 0.22, 0x7A3A1A), cx, 0.7, cz)); });
            wreath(G, 9, 4.55, -1.9, 0xB8601E, 0x7A3A1A);
            A = 0xFFB070; aBase = 5;
            break;
          }
          case 'valentines': {
            eaveBulbs(G, [0xFF2A5A, 0xFF8AB0, 0xFFF0F4], 'heart');
            bunting(G, [0xFF2A5A, 0xFFB0C8, 0xF2F0EA, 0xC8283A]);
            // Balloons at the bay door and a pink-and-red wreath.
            balloons(G, 4.6, -0.9, [0xFF2A5A, 0xFFB0C8, 0xF2F0EA], 5);
            balloons(G, 13.4, -0.9, [0xFF2A5A, 0xFFB0C8, 0xC8283A], 4);
            wreath(G, 9, 4.55, -1.9, 0xFF8AB0, 0xC8283A);
            fasciaBanner(G, 'Love your ride', '#C8283A', '#FFE8EE');
            A = 0xFF5A8A; aBase = 7; Bc = 0xFF6A9A; bBase = 7;
            holLampB.position.set(13.6, 1.6, 12.0);
            break;
          }
          case 'stpatricks': {
            eaveBulbs(G, [0x2EC24A, 0xFFD24A, 0x2EC24A, 0xF2F0EA]);
            const sm = new THREE.MeshBasicMaterial({ map: shamTex, transparent: true });
            [-10, -6, -2, 2, 6, 12].forEach(x => { const s2 = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.6), sm); at(s2, x, 4.25, -1.95); s2.castShadow = false; G.add(s2); });
            bunting(G, [0x2EC24A, 0xF2F0EA, 0xFFA23A, 0x1E8A3A]);
            // A rainbow arching over the lawn into a pot of gold, and shamrock stakes.
            { const cols = [0xE0283A, 0xFF8A2A, 0xFFD24A, 0x3AC24A, 0x2E8AD9, 0x7A4AD9];
              cols.forEach((c, i) => { const r = 2.2 - i * 0.16; const a2 = new THREE.Mesh(new THREE.TorusGeometry(r, 0.08, 6, 28, Math.PI), glowMat(c)); a2.castShadow = false; at(a2, 13.2, 0, 10.8); G.add(glowing(a2, c)); });
              const pot = cyl(0.42, 0.32, 0.5, 14, 0x1A1A1E, { metalness: 0.4, roughness: 0.4 }); at(pot, 15.4, 0.25, 10.8); G.add(pot);
              G.add(at(box(0.9, 0.05, 0.12, 0x1A1A1E), 15.4, 0.5, 10.8));
              const gold = new THREE.Mesh(new THREE.SphereGeometry(0.4, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat(0xE8B23A, { metalness: 0.9, roughness: 0.25 }));
              at(gold, 15.4, 0.48, 10.8); G.add(gold);
              [[15.0, 11.3], [15.9, 11.2], [15.7, 10.3]].forEach(([cx, cz]) => { const coin = cyl(0.09, 0.09, 0.02, 10, 0xE8B23A, { metalness: 0.9 }); coin.rotation.x = 0.4; at(coin, cx, 0.03, cz); G.add(coin); }); }
            { const shamCut = new THREE.Shape(); [[0, 0.24], [-0.21, -0.04], [0.21, -0.04]].forEach(([cx, cy]) => shamCut.absarc(cx, cy, 0.17, 0, Math.PI * 2, false));
              [9.4, 10.8, 16.8, -2.5, -6.5, -10.5].forEach((x, i) => yardShape(G, shamCut, x, 12.5, 1.1, i % 2 ? 0x3AC24A : 0x1E8A3A, 0.2)); }
            fasciaBanner(G, 'Lucky to have you', '#1E8A3A', '#FFE8A8');
            A = 0x3AFF6A; aBase = 6; Bc = 0xFFD24A; bBase = 6;
            holLampB.position.set(13.6, 1.4, 12.2);
            break;
          }
          case 'easter': {
            bunting(G, [0xF7B8D0, 0xB8E0F7, 0xF7EBA8, 0xC8F0C0, 0xD8C0F0]);
            const eggs = new THREE.InstancedMesh(new THREE.SphereGeometry(0.09, 8, 6), new THREE.MeshStandardMaterial({ roughness: 0.6 }), 26);
            const ep = [0xF7B8D0, 0xB8E0F7, 0xF7EBA8, 0xC8F0C0, 0xD8C0F0];
            // Verge eggs sit only on the grass runs between driveways (x -45…-39, 1.5…8.5,
            // 17.5…23.5 are paved), with a metre's margin either side.
            const VX = [-36.5, -31.2, -26.8, -21.5, -16.4, -12.0, -7.6, -3.1, 10.2, 12.6, 15.4, 26.0, 30.8, 35.2];
            for (let i = 0; i < 26; i++) { const onVerge = i < 14; const x = onVerge ? VX[i] : -24 + (i - 14) * 4.0; const z = onVerge ? 9 + (i * 37 % 30) / 10 : -22 - ((i * 53) % 40) / 10; tmpObj.position.set(x + (onVerge ? 0 : ((i * 17) % 10) / 10), 0.12, z); tmpObj.rotation.set(0.3, i, 0); tmpObj.scale.set(1, 1.3, 1); tmpObj.updateMatrix(); eggs.setMatrixAt(i, tmpObj.matrix); eggs.setColorAt(i, tmpCol.setHex(ep[i % ep.length])); }
            tmpObj.scale.set(1, 1, 1); G.add(eggs);
            // A big bunny on the lawn, a basket of eggs, and tulips along the kerb.
            { const wm3 = mat(0xF4F2EE, { roughness: 0.9 }), x = 13.8, z = 10.8;
              const body = new THREE.Mesh(new THREE.SphereGeometry(0.55, 14, 10), wm3); body.scale.set(1, 1.15, 0.9); at(body, x, 0.6, z); G.add(body);
              const head = new THREE.Mesh(new THREE.SphereGeometry(0.34, 14, 10), wm3); at(head, x, 1.4, z + 0.08); G.add(head);
              [-0.13, 0.13].forEach(ex => { const ear = box(0.12, 0.6, 0.06, 0xF4F2EE); ear.rotation.z = ex * 1.2; at(ear, x + ex, 1.95, z); G.add(ear); G.add(at(box(0.06, 0.44, 0.02, 0xF7B8D0), x + ex * 1.04, 1.95, z + 0.035)); });
              [-0.11, 0.11].forEach(ex => G.add(at(box(0.06, 0.06, 0.02, 0x2A2A2E), x + ex, 1.46, z + 0.41)));
              G.add(at(box(0.07, 0.05, 0.03, 0xF7B8D0), x, 1.36, z + 0.42));
              G.add(at(new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), wm3), x, 0.4, z - 0.52));       // tail
              [-0.3, 0.3].forEach(fx => G.add(at(box(0.24, 0.12, 0.42, 0xF4F2EE), x + fx, 0.06, z + 0.35)));
              const bow = box(0.28, 0.12, 0.08, 0xB8E0F7); at(bow, x, 1.12, z + 0.32); G.add(bow); }
            { const bx = 11.6, bz = 11.4;
              G.add(at(cyl(0.38, 0.3, 0.32, 14, 0xB88A4A, { roughness: 1 }), bx, 0.16, bz));
              const handle = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.03, 6, 14, Math.PI), mat(0xB88A4A)); at(handle, bx, 0.32, bz); G.add(handle);
              G.add(at(cyl(0.34, 0.34, 0.04, 14, 0x9ADA7A), bx, 0.33, bz));
              [[0xF7B8D0, -0.12, 0], [0xB8E0F7, 0.1, 0.08], [0xF7EBA8, 0.02, -0.12], [0xD8C0F0, 0.16, -0.08], [0xC8F0C0, -0.14, 0.12]].forEach(([c, ex, ez]) => { const e = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), mat(c, { roughness: 0.5 })); e.scale.y = 1.3; at(e, bx + ex, 0.42, bz + ez); G.add(e); }); }
            [9.0, 9.5, 10.0, 15.6, 16.1, 16.6, 17.1].forEach((x, i) => {
              const tc = [0xE0283A, 0xF7EBA8, 0xF7B8D0, 0xD8C0F0][i % 4];
              G.add(at(box(0.03, 0.36, 0.03, 0x3A7A3A), x, 0.18, 12.6));
              const bloom = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.05, 0.16, 6), mat(tc, { roughness: 0.6 })); at(bloom, x, 0.42, 12.6); G.add(bloom);
            });
            balloons(G, 4.6, -0.9, [0xF7B8D0, 0xB8E0F7, 0xF7EBA8], 4);
            Bc = 0xFFF0D8; bBase = 5; holLampB.position.set(13.6, 1.6, 12.0);
            break;
          }
          case 'memorial': {
            /* A day of mourning, not a celebration: no bunting, lawn flags, lit stars or
               coloured lights. One flag at half-staff, a plain evergreen wreath on the door,
               a laurel wreath on a stand at the foot of the flagpole, and a quiet banner. */
            bigFlag(G, 13.0, 11.2, true);
            { const x = 13.0, z = 11.9;
              [-0.28, 0.28].forEach(dx => { const leg = box(0.03, 1.0, 0.03, 0x2A2622); leg.rotation.z = dx * 0.4; at(leg, x + dx, 0.48, z); G.add(leg); });
              const ring = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.11, 8, 20), mat(0x2E4A2A, { roughness: 1 }));
              at(ring, x, 1.05, z); G.add(ring);
              const sash = box(0.12, 0.5, 0.02, 0x8A2A2E); at(sash, x, 0.72, z + 0.06); G.add(sash); }
            // A low plaque on two posts beside the wreath stand, facing the road.
            { const t = canvasTex(512, 160, (g, w, h) => {
                g.fillStyle = '#2A2A30'; g.fillRect(0, 0, w, h);
                g.strokeStyle = '#8C8A86'; g.lineWidth = 4; g.strokeRect(10, 10, w - 20, h - 20);
                g.fillStyle = '#E8E4DC'; g.textAlign = 'center'; g.textBaseline = 'middle';
                g.font = '600 46px Newsreader, Georgia, serif'; g.fillText('In memory of', w / 2, 56);
                g.font = '600 46px Newsreader, Georgia, serif'; g.fillText('those who served', w / 2, 108); });
              const p = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.5), new THREE.MeshBasicMaterial({ map: t, toneMapped: false }));
              at(p, 14.9, 0.72, 11.95); p.castShadow = false; G.add(glowing(p, 0xFFFFFF));
              G.add(at(box(1.66, 0.56, 0.05, 0x1E1E22), 14.9, 0.72, 11.92));
              [-0.6, 0.6].forEach(dx => G.add(at(box(0.05, 0.5, 0.05, 0x2A2622), 14.9 + dx, 0.22, 11.9))); }
            break;
          }
          case 'labor': case 'veterans': {
            flagsOnVerge(G); bunting(G, [0xB22234, 0xF2F0EA, 0x3C3B6E]);
            bigFlag(G, 13.0, 11.2);
            // A star wreath on the door and a row of lit stars along the kerb.
            wreath(G, 9, 4.55, -1.9, 0x3C3B6E, 0xB22234);
            [9.6, 11.4, 15.6, 17.0].forEach((x, i) => yardShape(G, starShape, x, 12.5, 0.8, i % 2 ? 0xF2F0EA : 0xB22234, 0.2));
            fasciaBanner(G, key === 'labor' ? 'Thank you, workers' : 'Thank you, veterans', '#3C3B6E', '#F2F0EA');
            Bc = 0xF2F0EA; bBase = 5; holLampB.position.set(13.2, 1.6, 12.4);
            break;
          }
          case 'july4': {
            flagsOnVerge(G); bunting(G, [0xB22234, 0xF2F0EA, 0x3C3B6E]); fireworks(G);
            eaveBulbs(G, [0xB22234, 0xF2F0EA, 0x3C3B6E, 0xF2F0EA]);
            bigFlag(G, 13.0, 11.2);
            yardShape(G, starShape, 15.8, 10.6, 1.6, 0xF2F0EA, 0.3);
            [9.4, 10.8, -2.5, -6.5, -10.5].forEach((x, i) => yardShape(G, starShape, x, 12.5, 0.75, [0xB22234, 0xF2F0EA, 0x3C3B6E][i % 3], 0.2));
            balloons(G, 4.6, -0.9, [0xB22234, 0xF2F0EA, 0x3C3B6E], 5);
            balloons(G, 13.4, -0.9, [0x3C3B6E, 0xF2F0EA, 0xB22234], 4);
            fasciaBanner(G, 'Happy 4th of July', '#B22234', '#F2F0EA');
            A = 0xF2F0EA; aBase = 4; Bc = 0xF2F0EA; bBase = 5; holLampB.position.set(14.4, 1.6, 12.2);
            break;
          }
          case 'newyear': {
            eaveBulbs(G, [0xFFD24A, 0xE8E8F0, 0xFFD24A, 0xFFF4C8]); fireworks(G);
            bunting(G, [0xFFD24A, 0x1A1A1E, 0xE8E8F0, 0xD9B44A]);
            const yr = new Date().getMonth() === 11 ? new Date().getFullYear() + 1 : new Date().getFullYear();
            fasciaBanner(G, 'Happy New Year ' + yr, '#1A1A1E', '#FFD24A');
            balloons(G, 4.6, -0.9, [0xFFD24A, 0xE8E8F0, 0x1A1A1E], 6);
            balloons(G, 13.4, -0.9, [0xE8E8F0, 0xFFD24A, 0x1A1A1E], 5);
            // The year in lit numerals on the lawn, and a disco ball turning over the door.
            { const t = canvasTex(256, 96, (g, w, h) => { g.clearRect(0, 0, w, h); g.fillStyle = '#FFD24A'; g.font = '700 84px Newsreader, Georgia, serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(yr), w / 2, h / 2 + 4); });
              const sgn = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 1.2), new THREE.MeshBasicMaterial({ map: t, transparent: true, toneMapped: false, side: THREE.DoubleSide }));
              at(sgn, 13.2, 1.15, 10.8); sgn.castShadow = false; G.add(glowing(sgn, 0xFFFFFF));
              [11.8, 14.6].forEach(px => G.add(at(box(0.04, 0.6, 0.04, 0x3A3632), px, 0.3, 10.78))); }
            { const ball = new THREE.Mesh(new THREE.IcosahedronGeometry(0.3, 1), new THREE.MeshStandardMaterial({ color: 0xE8E8F0, metalness: 1, roughness: 0.15, flatShading: true }));
              at(ball, 9, 3.7, -1.2); G.add(ball); G.add(at(box(0.01, 0.5, 0.01, 0xC8C4BC), 9, 4.15, -1.2));
              holAnim.push((T) => { ball.rotation.y = T * 0.8; }); }
            A = 0xFFE0A0; aBase = 6; Bc = 0xFFD24A; bBase = 6; holLampB.position.set(13.2, 1.6, 12.0);
            break;
          }
        }
        if (A != null) holLampA.color.setHex(A); holRecA.base = aBase;
        if (Bc != null) holLampB.color.setHex(Bc); holRecB.base = bBase;
        return G;
      }
      function disposeGroup(g) {
        g.traverse(o => { if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose(); });
      }
      let holCheck = -1;
      function stepHoliday(T, dt) {
        if (T - holCheck > 30 || holCheck < 0) {   // re-read the date every 30 s
          holCheck = T;
          const want = holPinned !== undefined ? holPinned : holidayFor(chicagoDate());
          if (want !== holKey) {
            if (holGroup) { scene.remove(holGroup); disposeGroup(holGroup); holGroup = null; }
            holAnim = []; holRecA.base = 0; holRecB.base = 0;
            holKey = want;
            if (want) { holGroup = buildHoliday(want); scene.add(holGroup); }
          }
        }
        if (!holGroup) return;
        const lamp = dayState.lamp;
        for (let i = 0; i < holAnim.length; i++) holAnim[i](T, lamp, dt);
      }

      // Exit drive at the east end of the apron, joining the carriageway just west of the
      // roadside sign. This is the way out of the lot — nothing reverses into the road.
      const drive = slab(6, 11, C.apron, 0.021); drive.position.set(20.5, 0.021, 2.4); scene.add(drive);
      const laneMarks = new THREE.Group();
      for (let x = -100; x < 100; x += 7) {
        const s = slab(3.4, 0.22, C.stripe, 0.05); s.position.set(x, 0.05, ROAD_Z); laneMarks.add(s);
      }
      scene.add(bakeStatic(laneMarks));
      const edgeLine = slab(220, 0.16, 0x4A443A, 0.05); edgeLine.position.set(0, 0.05, KERB_N + 0.1); scene.add(edgeLine);

      /* ---------- the building ---------- */
      const building = new THREE.Group();
      const OPEN_X = 9;                     // unit #3, the open one
      const ROOM = { x0: 5.0, x1: 13.0, z0: -15.0, z1: -2.0, h: 4.2 };
      // A car parks nose-in down the middle of the bay, so this lane is kept clear of
      // everything on the floor: the fitout lives against the two side walls and the back.
      const LANE = { x0: 7.8, x1: 10.2 };

      // Units 1–2: a solid block. Unit 3 is a hollow room, so it's built separately.
      const leftBlock = box(18.1, 5.0, 13, C.wall);
      at(leftBlock, -4.05, 2.5, -8.5); building.add(leftBlock);
      const leftRoof = box(18.7, 0.45, 13.8, C.roof);
      at(leftRoof, -4.05, 5.15, -8.5); building.add(leftRoof);

      [-8, 0].forEach((ux, i) => {
        const door = box(5.0, 3.7, 0.22, C.door); at(door, ux, 1.85, -2.12); building.add(door);
        for (let k = 0; k < 6; k++) {
          const rib = box(5.0, 0.06, 0.28, 0x3E3A35);
          at(rib, ux, 0.55 + k * 0.6, -2.06); rib.castShadow = false; building.add(rib);
        }
        const jL = box(0.42, 3.9, 0.5, C.wallAlt); at(jL, ux - 2.7, 1.95, -1.95); building.add(jL);
        const jR = box(0.42, 3.9, 0.5, C.wallAlt); at(jR, ux + 2.7, 1.95, -1.95); building.add(jR);
        const lin = box(5.8, 0.5, 0.5, C.wallAlt); at(lin, ux, 4.15, -1.95); building.add(lin);
      });

      // Service doors, centred on the solid piers between the bay openings, each one
      // belonging to the bay on its right. The unit placard mounts on the bay's jamb
      // pillar, which sits proud of the wall — same treatment on every unit.
      const SERVICE_DOORS = [
        { x: -12.0,  plateX: -10.70, plateZ: -1.66, plateW: 0.38, brass: false }, // serves bay -8
        { x: -4.0,   plateX: -2.70,  plateZ: -1.66, plateW: 0.38, brass: false }, // serves bay 0
        { x: 3.96,   plateX: 5.30,   plateZ: -1.85, plateW: 0.50, brass: true },  // serves unit 3
      ];
      SERVICE_DOORS.forEach(({ x, plateX, plateZ, plateW, brass }) => {
        const pdoor = box(0.9, 2.1, 0.16, C.wallAlt); at(pdoor, x, 1.05, -1.98); building.add(pdoor);
        const plate = brass
          ? box(plateW, 0.36, 0.06, C.trim, { emissive: 0x3A2E08, roughness: 0.4, metalness: 0.5 })
          : box(plateW, 0.3, 0.06, 0x55504A);
        at(plate, plateX, 1.85, plateZ); building.add(plate);
      });

      // Unit 3: hollow shell so the interior is actually visible through the opening.
      const roomW = ROOM.x1 - ROOM.x0, roomD = ROOM.z1 - ROOM.z0, roomCz = (ROOM.z0 + ROOM.z1) / 2;
      const inFloor = slab(roomW, roomD, C.floorIn, 0.04);
      inFloor.position.set(OPEN_X, 0.04, roomCz); building.add(inFloor);
      const backW = box(roomW, ROOM.h, 0.3, C.wallAlt); at(backW, OPEN_X, ROOM.h / 2, ROOM.z0 + 0.15); building.add(backW);
      const wallL = box(0.3, ROOM.h, roomD, C.wallAlt); at(wallL, ROOM.x0 + 0.15, ROOM.h / 2, roomCz); building.add(wallL);
      const wallR = box(0.3, ROOM.h, roomD, C.wallAlt); at(wallR, ROOM.x1 - 0.15, ROOM.h / 2, roomCz); building.add(wallR);
      const ceil = box(roomW, 0.3, roomD, 0x38342E); at(ceil, OPEN_X, ROOM.h + 0.15, roomCz); building.add(ceil);
      const unitRoof = box(8.0, 0.45, 13.8, C.roof); at(unitRoof, 9.3, 5.15, -8.5); building.add(unitRoof);
      const rightEnd = box(0.4, 5.0, 13, C.wall); at(rightEnd, ROOM.x1 + 0.2, 2.5, -8.5); building.add(rightEnd);

      // Front facade around the open bay
      const lintel3 = box(roomW, 0.95, 0.42, C.wallAlt); at(lintel3, OPEN_X, ROOM.h + 0.62, -2.1); building.add(lintel3);
      const j3L = box(0.6, ROOM.h, 0.42, C.wallAlt); at(j3L, ROOM.x0 + 0.3, ROOM.h / 2, -2.1); building.add(j3L);
      const j3R = box(0.6, ROOM.h, 0.42, C.wallAlt); at(j3R, ROOM.x1 - 0.3, ROOM.h / 2, -2.1); building.add(j3R);
      // Rolled-up door slats above the opening
      const rolled = cyl(0.44, 0.44, roomW - 1.2, 12, C.door);
      rolled.rotation.z = Math.PI / 2; at(rolled, OPEN_X, ROOM.h + 0.2, -2.55); building.add(rolled);
      // (A flat "warm pool" plane used to sit on the apron here. It read as a hard-edged
      // bright rectangle; the bay's own point and spot lights already throw that spill.)

      /* ---------- roof kit ----------
         One identical set per unit, laid out on the unit's own centreline: skylight over
         the front half of the bay, condenser behind it, a vent either side. Previously the
         plant, the hatches and a vent row were each placed on their own unrelated grid,
         so nothing lined up with the bay it served. */
      const skyPanes = [];
      function roofKit(ux, deck) {
        // Skylight: kerb and glazing share a centre, over the front of the bay.
        building.add(at(box(2.3, 0.22, 1.6, 0x5E574E), ux, deck + 0.11, -5.4));
        const pane = new THREE.Mesh(
          new THREE.PlaneGeometry(1.95, 1.3),
          new THREE.MeshBasicMaterial({ color: 0xDCE6EC, transparent: true, opacity: 0.55 })
        );
        pane.rotation.x = -Math.PI / 2;
        at(pane, ux, deck + 0.23, -5.4);
        addGlow(pane, 0.55, 0.45);
        building.add(pane);
        skyPanes.push(pane);

        // Condenser on its own rails, squarely behind the skylight.
        building.add(at(box(2.4, 0.14, 1.9, 0x4E4A44), ux, deck + 0.07, -10.2));
        building.add(at(box(2.2, 0.95, 1.7, 0x453F37), ux, deck + 0.62, -10.2));
        building.add(at(cyl(0.55, 0.55, 0.16, 12, 0x2E2A25), ux, deck + 1.18, -10.2));
        // Duct dropping back through the deck.
        building.add(at(box(0.6, 0.5, 0.5, 0x3A342D), ux + 1.5, deck + 0.35, -10.2));

        // A vent either side of the pair, on the same centreline.
        [-1.9, 1.9].forEach(vo => {
          building.add(at(cyl(0.18, 0.22, 0.5, 8, 0x3A342D), ux + vo, deck + 0.25, -7.8));
        });
      }

      // Neighbouring block, to imply the row
      const neighbour = box(18, 4.4, 9, C.wallAlt); at(neighbour, -26.5, 2.2, -7.0); building.add(neighbour);
      const nroof = box(18.6, 0.4, 9.8, C.roof); at(nroof, -26.5, 4.55, -7.0); building.add(nroof);
      [[-31, -5.5], [-22.5, -8.5]].forEach(([hx, hz]) => {
        const unit = box(2.2, 0.9, 1.7, 0x413B34); at(unit, hx, 5.2, hz); building.add(unit);
      });
      const nlampPlane = new THREE.Mesh(
        new THREE.PlaneGeometry(0.5, 0.3),
        new THREE.MeshBasicMaterial({ color: 0xD8C79A, transparent: true, opacity: 0.7 })
      );
      at(nlampPlane, -20.2, 3.2, -1.96); addGlow(nlampPlane, 0.7); building.add(nlampPlane);
      addLamp(at(new THREE.PointLight(0xD8C79A, 6, 12, 2), -20.2, 3.1, -1.6), 6);

      // Baked below, once everything has been added to it.

      // One kit per unit, on each bay's own centreline. Row deck is at y 5.375.
      [-8, 0, OPEN_X].forEach(ux => roofKit(ux, 5.375));
      // Same kit on the neighbouring block, whose deck sits at 4.75.
      [-31, -22].forEach(ux => roofKit(ux, 4.75));

      /* ---------- gutters and downpipes ----------
         Hung on the front eave lip rather than sitting on the deck. In the rain these
         actually run: a sheet down each pipe and a splash where it hits the apron, both
         driven by the live precip rate. */
      const EAVE_Z = -1.70, EAVE_Y = 5.26;
      building.add(at(box(26.9, 0.22, 0.26, 0x5E574E), -0.05, EAVE_Y, EAVE_Z));
      // Hung clear of the roof slab (top 4.75, front -2.10): sharing either face made it
      // flicker as the camera moved.
      building.add(at(box(18.4, 0.2, 0.24, 0x5E574E), -26.5, 4.56, -2.34));
      const DOWNPIPES = [
        { x: -13.0, y0: EAVE_Y, z: -1.86 },
        { x: -4.2,  y0: EAVE_Y, z: -1.86 },
        { x: 4.6,   y0: EAVE_Y, z: -1.86 },
        { x: 13.15, y0: EAVE_Y, z: -1.86 },
        { x: -35.0, y0: 4.56,   z: -2.46 },
        { x: -17.9, y0: 4.56,   z: -2.46 },
      ];
      DOWNPIPES.forEach(p => {
        building.add(at(cyl(0.09, 0.09, p.y0, 6, 0x5E574E), p.x, p.y0 / 2, p.z));
        // Shoe at the bottom, kicking the outfall away from the wall.
        building.add(at(box(0.2, 0.16, 0.4, 0x5E574E), p.x, 0.24, p.z + 0.18));
      });

      /* ---------- inside the bay ---------- */
      const shop = new THREE.Group();

      // Bench down the left wall, with a pegboard above it. Both run the new full depth of
      // the unit — the fitout hugs the walls so the middle stays a driveable lane.
      const bench = box(1.0, 0.9, 9.4, C.benchTop); at(bench, 5.95, 0.45, -7.9); shop.add(bench);
      const pegboard = box(0.08, 1.7, 8.6, 0x3E4A52); at(pegboard, 5.38, 2.3, -7.9); shop.add(pegboard);
      for (let i = 0; i < 11; i++) {
        const tool = box(0.05, 0.4 + (i % 3) * 0.14, 0.1, i % 2 ? 0x8A8378 : 0x6B2E24);
        at(tool, 5.45, 2.5 - (i % 2) * 0.5, -3.9 - i * 0.72); tool.castShadow = false; shop.add(tool);
      }

      // Two 3D printers on the bench, quietly running
      const makePrinter = (px, pz, s) => {
        const frame = box(0.86 * s, 0.92 * s, 0.86 * s, 0x2A2A2E); at(frame, px, 0.9 + 0.46 * s, pz); shop.add(frame);
        const bed = box(0.62 * s, 0.05, 0.62 * s, 0x45403A); at(bed, px, 0.9 + 0.3 * s, pz); shop.add(bed);
        const g = new THREE.Mesh(
          new THREE.PlaneGeometry(0.62 * s, 0.5 * s),
          new THREE.MeshBasicMaterial({ color: 0x7BE0C8, transparent: true, opacity: 0.55 })
        );
        at(g, px, 0.9 + 0.46 * s, pz + 0.44 * s); addGlow(g, 0.55, 0.55); shop.add(g);
        addLamp(at(new THREE.PointLight(0x7BE0C8, 2.6, 5, 2), px, 1.4, pz + 0.3), 2.6, 2.6);
        const spool = cyl(0.22 * s, 0.22 * s, 0.1, 12, 0xC9A227); spool.rotation.x = Math.PI / 2;
        at(spool, px - 0.4 * s, 0.9 + 0.75 * s, pz); shop.add(spool);
      };
      makePrinter(6.0, -3.9, 1.0);
      makePrinter(6.0, -6.0, 0.85);

      // Speaker driver — the thing this shop is actually full of
      const makeSpeaker = (r, depth) => {
        const g = new THREE.Group();                       // faces +z
        const basket = cyl(r, r * 0.86, depth, 14, 0x2E2C2A); basket.rotation.x = Math.PI / 2; g.add(basket);
        const cone = new THREE.Mesh(new THREE.ConeGeometry(r * 0.82, depth * 0.9, 14), mat(0x3A342C, { roughness: 0.9 }));
        cone.rotation.x = -Math.PI / 2; at(cone, 0, 0, depth * 0.1); g.add(cone);
        const cap = cyl(r * 0.24, r * 0.24, 0.06, 10, C.trim, { metalness: 0.4, roughness: 0.45 });
        cap.rotation.x = Math.PI / 2; at(cap, 0, 0, depth * 0.52); g.add(cap);
        return g;
      };
      // A pair standing against the right wall, and one lying on the bench
      const spk1 = makeSpeaker(0.42, 0.34); at(spk1, 12.1, 0.44, -3.3); spk1.rotation.y = -0.5; shop.add(spk1);
      const spk2 = makeSpeaker(0.42, 0.34); at(spk2, 12.1, 0.44, -4.2); spk2.rotation.y = -0.5; shop.add(spk2);
      const spk3 = makeSpeaker(0.3, 0.26); at(spk3, 6.0, 1.0, -8.6); spk3.rotation.x = -Math.PI / 2; shop.add(spk3);

      // Subwoofer enclosures on the floor — all of them off the lane, against a wall
      const encl1 = box(1.3, 0.85, 0.95, 0x5A4A34); at(encl1, 11.5, 0.46, -3.0); encl1.rotation.y = 0.22; shop.add(encl1);
      const sub1 = makeSpeaker(0.34, 0.2); at(sub1, 11.5, 0.6, -2.5); sub1.rotation.y = 0.22; shop.add(sub1);
      const encl2 = box(1.5, 0.95, 1.05, 0x4E4030); at(encl2, 11.85, 0.51, -8.8); encl2.rotation.y = -0.15; shop.add(encl2);
      const encl3 = box(1.1, 0.7, 0.8, 0x554636); at(encl3, 11.7, 0.39, -6.4); shop.add(encl3);

      // Cardboard cartons — new gear waiting to go in
      [[11.9, 0.36, -11.0, 0], [11.9, 1.08, -11.0, 0.2], [11.2, 0.36, -12.0, -0.3]]
        .forEach(([bx, by, bz, ry]) => {
          const carton = box(0.72, 0.72, 0.72, C.card); at(carton, bx, by, bz); carton.rotation.y = ry; shop.add(carton);
          const tape = box(0.74, 0.1, 0.2, 0x9A8258); at(tape, bx, by + 0.32, bz); tape.rotation.y = ry;
          tape.castShadow = false; shop.add(tape);
        });

      // Shelving across the back
      const shelfFrame = box(3.6, 2.6, 0.75, 0x3E3833); at(shelfFrame, 9.9, 1.3, -14.2); shop.add(shelfFrame);
      for (let r = 0; r < 3; r++) {
        for (let cx = 1; cx < 4; cx++) {
          const b = box(0.85, 0.55, 0.6, cx % 2 ? C.card : 0x4A5560);
          at(b, 7.8 + cx * 1.05, 0.45 + r * 0.85, -13.9); shop.add(b);
        }
      }

      /* ---------- the break nook ----------
         Back-left corner, past the end of the bench: a two-seat couch against the left
         wall, and a desk with a laptop under the back
         wall. Sean takes his breather here between the amp and the subs. A pendant over
         the couch and a second ceiling lamp over the back half keep it out of the gloom. */
      const COUCH = [5.95, -13.6];
      { const seat = box(0.8, 0.42, 1.6, 0x4A5660, { roughness: 1 }); at(seat, 5.85, 0.21, -13.6); shop.add(seat);
        const back = box(0.22, 0.5, 1.6, 0x3E4A54, { roughness: 1 }); at(back, 5.46, 0.67, -13.6); shop.add(back);
        [-0.86, 0.86].forEach(dz => shop.add(at(box(0.8, 0.26, 0.12, 0x3E4A54, { roughness: 1 }), 5.85, 0.55, -13.6 + dz)));
        shop.add(at(box(0.5, 0.34, 0.5, 0x8A3A2C, { roughness: 1 }), 6.0, 0.17, -12.55));     // a cushion dumped at the end
        // Pendant over the couch: cord, shade, warm bulb.
        shop.add(at(cyl(0.012, 0.012, 1.1, 6, 0x2A2825), 6.3, ROOM.h - 0.55, -13.6));
        const shade = new THREE.Mesh(new THREE.ConeGeometry(0.34, 0.3, 14, 1, true), mat(0x8A3A2C, { side: THREE.DoubleSide, roughness: 0.8 }));
        at(shade, 6.3, ROOM.h - 1.15, -13.6); shop.add(shade);
        const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), new THREE.MeshBasicMaterial({ color: 0xFFE2B0, transparent: true, opacity: 0.9 }));
        at(bulb, 6.3, ROOM.h - 1.27, -13.6); bulb.castShadow = false; addGlow(bulb, 0.9, 0.9); shop.add(bulb);
        addLamp(at(new THREE.PointLight(0xFFD9A8, 16, 6.5, 1.9), 6.3, ROOM.h - 1.4, -13.6), 16, 10);
        addLamp(at(new THREE.PointLight(0xF0D79A, 26, 7, 1.9), OPEN_X, 3.4, -12.2), 26, 9);   // back-half ceiling lamp
      }
      { const desk = box(1.3, 0.06, 0.6, 0x6B5A4A, { roughness: 0.9 }); at(desk, 7.0, 0.76, -14.45); shop.add(desk);
        [[6.45, -14.2], [7.55, -14.2], [6.45, -14.7], [7.55, -14.7]].forEach(([lx, lz]) => shop.add(at(box(0.05, 0.74, 0.05, 0x3A3632), lx, 0.37, lz)));
        // A laptop, lid open toward the chair.
        shop.add(at(box(0.36, 0.02, 0.26, 0x2A2C32), 7.0, 0.8, -14.4));                    // base
        const lid = box(0.36, 0.25, 0.015, 0x2A2C32); at(lid, 7.0, 0.91, -14.53); lid.rotation.x = -0.25; shop.add(lid);
        const mon = new THREE.Mesh(new THREE.PlaneGeometry(0.32, 0.2),
          new THREE.MeshBasicMaterial({ color: 0xB8D6E8, transparent: true, opacity: 0.6, toneMapped: false }));
        at(mon, 7.0, 0.91, -14.52); mon.rotation.x = -0.25; mon.castShadow = false; addGlow(mon, 0.6, 0.6); shop.add(mon);
        addLamp(at(new THREE.PointLight(0xB8D6E8, 1.0, 2.0, 2), 7.0, 1.0, -14.2), 1.0, 1.0);
        const chair = cyl(0.26, 0.26, 0.06, 12, 0x2A2A2E); at(chair, 6.95, 0.5, -13.95); shop.add(chair);
        shop.add(at(cyl(0.04, 0.04, 0.46, 8, 0x3A3F44), 6.95, 0.25, -13.95));
        shop.add(at(box(0.5, 0.36, 0.05, 0x2A2A2E), 6.95, 0.75, -13.7));
      }

      // Amp rack with status LEDs, a tool chest and a stool
      const rack = box(0.95, 1.5, 0.6, 0x33322F); at(rack, 12.3, 0.75, -13.0); shop.add(rack);
      for (let i = 0; i < 3; i++) {
        const led = new THREE.Mesh(
          new THREE.PlaneGeometry(0.09, 0.05),
          new THREE.MeshBasicMaterial({ color: i === 1 ? 0xC9A227 : 0x7BE0C8, transparent: true, opacity: 0.9 })
        );
        at(led, 12.05 + i * 0.22, 1.2, -12.69); addGlow(led, 0.9, 0.9); shop.add(led);
      }
      const chest = box(1.05, 1.15, 0.62, 0x6B2E24); at(chest, 12.1, 0.58, -9.8); shop.add(chest);
      for (let i = 0; i < 3; i++) {
        const drawer = box(1.0, 0.06, 0.05, 0x8A3A2C); at(drawer, 12.1, 0.35 + i * 0.34, -9.48);
        drawer.castShadow = false; shop.add(drawer);
      }
      const stoolSeat = cyl(0.26, 0.26, 0.09, 12, 0x2E2C2A); at(stoolSeat, 11.0, 0.62, -4.9); shop.add(stoolSeat);
      const stoolPost = cyl(0.06, 0.06, 0.58, 8, 0x55504A); at(stoolPost, 11.0, 0.3, -4.9); shop.add(stoolPost);

      // Wire spools under the bench
      [[6.1, -11.6], [6.1, -12.3]].forEach(([wx, wz]) => {
        const s = cyl(0.3, 0.3, 0.26, 14, 0x3A4450); s.rotation.x = Math.PI / 2; at(s, wx, 0.3, wz); shop.add(s);
      });

      // Enclosure stock leaning by the opening, pallets on the apron
      const sheet = box(1.6, 2.2, 0.12, 0x6A563C); at(sheet, 5.9, 1.1, -2.6); sheet.rotation.z = 0.07; shop.add(sheet);
      // Interior clutter is lit by non-shadow-casting lamps, so casting costs a shadow
      // pass nobody sees. Only the big silhouettes keep it.
      shop.traverse(o => {
        if (!o.isMesh) return;
        const g = o.geometry.parameters || {};
        const big = (g.width || 0) > 1.0 || (g.height || 0) > 1.4;
        o.castShadow = big;
      });
      // ~80 static props inside one bay was ~80 draw calls in every pass. Printer status
      // glows and rack LEDs stay loose so the glow pass can still reach them.
      scene.add(bakeStatic(shop, { skip: o => o.material.isMeshBasicMaterial }));
      // Pallets stacked in the alley between this row and the neighbouring block — the
      // east pad is customer parking, so the stock lives out of the way.
      [[-15.4, -5.0], [-15.4, -7.4]].forEach(([px, pz]) => {
        const p = box(1.1, 0.22, 1.5, 0x5A4A34); at(p, px, 0.11, pz); scene.add(p);
        const c2 = box(0.85, 0.7, 1.1, 0x453D33); at(c2, px, 0.57, pz); scene.add(c2);
      });

      // Bay lighting. Point lights don't cast shadows by default, so their range is
      // clamped to stop short of the back wall (z -11) rather than spilling through the
      // building onto the tree line at z -15. The bay's throw onto the apron is a
      // spotlight rather than a shadow-casting point light: a point light shadow is a
      // cube map (six render passes per frame) for one direction of spill.
      const bayLight = addLamp(at(new THREE.PointLight(C.bayGlow, 60, 11, 1.9), OPEN_X, 2.8, -2.6), 60, 16);
      addLamp(at(new THREE.PointLight(0xF0D79A, 26, 6, 1.9), OPEN_X, 3.4, -6.4), 26, 8);
      addLamp(at(new THREE.PointLight(0xE8C98A, 26, 14, 1.9), 8.8, 3.2, 2.4), 26);
      // Strip lights on the bay ceiling
      [-4.0, -7.4, -10.8, -14.0].forEach(sz => {
        const strip = new THREE.Mesh(
          new THREE.PlaneGeometry(3.4, 0.3),
          new THREE.MeshBasicMaterial({ color: 0xFFF0CE, transparent: true, opacity: 0.85 })
        );
        strip.rotation.x = Math.PI / 2; at(strip, OPEN_X, ROOM.h - 0.02, sz);
        addGlow(strip, 0.85, 0.5); building.add(strip);
      });

      /* ---------- light poles ---------- */
      // Down both sides of the road, heads cantilevered out over the carriageway. The two
      // rows are offset by half a span so no pole ever stands directly opposite another —
      // the pools alternate down the road instead of doubling up in pairs.
      const POLE_SPAN = 18;
      const POLE_X = [-54, -36, -18, 0, 18, 36, 54];
      const poleGroup = new THREE.Group();
      const poolAt = [];
      const clearOfDrives = x => { for (const [a, b] of [[-45, -39], [1.5, 8.5], [17.5, 23.5]]) if (x > a - 0.6 && x < b + 0.6) return a - 1.2; return x; };
      POLE_X.flatMap(px => [[clearOfDrives(px), 12.6], [px + POLE_SPAN / 2, 22.2]]).forEach(([px, pz]) => {
        const farSide = pz > 17.4;
        // Derive the cantilever from the carriageway centreline rather than a hand-written
        // sign, so it cannot invert: heads always reach out over the road, both rows.
        // 1.4 gives a visible overhang past the kerb rather than a token nudge.
        const arm = Math.sign(17.4 - pz) * 1.4;
        const pole = cyl(0.11, 0.13, 7, 8, 0x2A2825); at(pole, px, 3.5, pz); poleGroup.add(pole);
        // Gooseneck: a short riser above the pole top plus a horizontal cantilever out to
        // the head. Without these the head floats detached — the old 0.35 arm only looked
        // attached because the head's near face happened to touch the pole surface.
        const riser = cyl(0.075, 0.075, 0.42, 6, 0x2A2825); at(riser, px, 7.16, pz); poleGroup.add(riser);
        const boom = box(0.13, 0.13, Math.abs(arm) + 0.24, 0x2A2825);
        at(boom, px, 7.3, pz + arm / 2); poleGroup.add(boom);
        const head = box(1.1, 0.22, 0.5, 0x37332E); at(head, px, 7.16, pz + arm); poleGroup.add(head);
        const lampPlane = new THREE.Mesh(
          new THREE.PlaneGeometry(0.95, 0.42),
          new THREE.MeshBasicMaterial({ color: 0xF0DCA8, transparent: true, opacity: 0.85 })
        );
        lampPlane.rotation.x = -Math.PI / 2; at(lampPlane, px, 7.02, pz + arm);
        addGlow(lampPlane, 0.85); poleGroup.add(lampPlane);
        // Poles further from the bay carry a little less punch, so the shop stays the
        // focus. Range stops short of the building so the spill can't reach the trees.
        // 7 m up with physical falloff, 22 was ~0.5 at the kerb — invisible next to a
        // headlight. 70 puts a proper pool on the carriageway.
        poolAt.push([px, pz + arm]);
      });
      /* Their light. These used to be real point lights, but only 14 point lights are
         live at once across the whole scene, so all but the nearest poles were switched
         off — lit heads with nothing on the road below. Every pole now gets the same soft
         pool baked into one mesh (one draw call), faded with the street lights. */
      {
        const c = document.createElement('canvas'); c.width = c.height = 128;
        const g = c.getContext('2d'), rg = g.createRadialGradient(64, 64, 0, 64, 64, 64);
        rg.addColorStop(0, 'rgba(255,255,255,0.95)'); rg.addColorStop(0.35, 'rgba(255,255,255,0.5)');
        rg.addColorStop(0.7, 'rgba(255,255,255,0.14)'); rg.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = rg; g.fillRect(0, 0, 128, 128);
        const tex = new THREE.CanvasTexture(c);
        // One quad per pole, written straight into a single geometry.
        const pos = [], uv = [], idx = [];
        poolAt.forEach(([x, z], i) => {
          const hw = 5.5, hd = 4.5, y = 0.07, o = i * 4;
          pos.push(x - hw, y, z - hd, x + hw, y, z - hd, x + hw, y, z + hd, x - hw, y, z + hd);
          uv.push(0, 0, 1, 0, 1, 1, 0, 1);
          idx.push(o, o + 2, o + 1, o, o + 3, o + 2);
        });
        const pg = new THREE.BufferGeometry();
        pg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        pg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
        pg.setIndex(idx);
        const pools = new THREE.Mesh(pg,
          new THREE.MeshBasicMaterial({ map: tex, color: 0xF0D8A0, transparent: true, opacity: 0, depthWrite: false,
                                        blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
        pools.castShadow = pools.receiveShadow = false; pools.renderOrder = 1;
        addGlow(pools, 0.42); scene.add(pools);
      }
      // Lens planes stay loose — their opacity is animated per-frame by the glow pass.
      scene.add(bakeStatic(poleGroup, { skip: o => o.material.isMeshBasicMaterial }));

      /* ---------- night lighting elsewhere in the district ---------- */

      // Wall packs — above each service door, on solid pier wall. Nothing above a roll-up
      // opening, where the retracting door would hit it. The east end is lit from the
      // east wall itself (below), not from the front face.
      [[-12.0, -1.95], [-4.0, -1.95], [3.96, -1.95]].forEach(([wx, wz]) => {
        const hood = box(0.5, 0.16, 0.34, 0x2E2A25); at(hood, wx, 3.5, wz + 0.1); scene.add(hood);
        const lens = new THREE.Mesh(
          new THREE.PlaneGeometry(0.42, 0.2),
          new THREE.MeshBasicMaterial({ color: 0xFFE2A8, transparent: true, opacity: 0.9 })
        );
        lens.rotation.x = -Math.PI / 2; at(lens, wx, 3.4, wz + 0.1);
        addGlow(lens, 0.9); scene.add(lens);
        addLamp(at(new THREE.PointLight(0xFFD48A, 9, 11, 2.0), wx, 3.3, wz + 0.5), 9);
      });

      // Rear service area — the back of the row, where the bins and the back doors are.
      // Lit rudimentarily, as any business with a rear approach would be.
      const REAR_Z = -15.15;
      // Ends level with the rear pole — everything past it is field.
      const rearPad = slab(34, 5.2, C.pad, 0.03);
      rearPad.position.set(0, 0.03, REAR_Z - 2.6);
      scene.add(rearPad);

      [-8, 0, 9].forEach((wx) => {
        // Back service door
        const rdoor = box(0.95, 2.1, 0.16, C.wallAlt); at(rdoor, wx + 1.6, 1.05, REAR_Z); scene.add(rdoor);
        const step = box(1.3, 0.14, 0.6, 0x4A4740); at(step, wx + 1.6, 0.07, REAR_Z - 0.4); scene.add(step);

        // Wall pack over the door, hooded and aimed down at the pad
        const hood = box(0.46, 0.16, 0.32, 0x2E2A25); at(hood, wx + 1.6, 3.15, REAR_Z - 0.12); scene.add(hood);
        const lens = new THREE.Mesh(
          new THREE.PlaneGeometry(0.38, 0.19),
          new THREE.MeshBasicMaterial({ color: 0xFFE2A8, transparent: true, opacity: 0.85 })
        );
        lens.rotation.x = Math.PI / 2; at(lens, wx + 1.6, 3.05, REAR_Z - 0.12);
        addGlow(lens, 0.85); scene.add(lens);
        // Short range — a rear light pools on its own pad, it doesn't floodlight the lot
        addLamp(at(new THREE.PointLight(0xFFD48A, 8, 8, 2.1), wx + 1.6, 2.9, REAR_Z - 0.6), 8);
      });

      // One pole light over the middle of the rear pad. Tall enough for the head to clear
      // the roofline, and the same luminaire as the street poles so it reads as one.
      const rearPole = cyl(0.11, 0.13, 6.6, 8, 0x2A2825); at(rearPole, 2.0, 3.3, REAR_Z - 5.2); scene.add(rearPole);
      const rearHead = box(1.1, 0.22, 0.5, 0x37332E); at(rearHead, 2.0, 6.6, REAR_Z - 4.85); scene.add(rearHead);
      const rearLens = new THREE.Mesh(
        new THREE.PlaneGeometry(0.95, 0.42),
        new THREE.MeshBasicMaterial({ color: 0xF0DCA8, transparent: true, opacity: 0.85 })
      );
      rearLens.rotation.x = -Math.PI / 2; at(rearLens, 2.0, 6.46, REAR_Z - 4.85);
      addGlow(rearLens, 0.85); scene.add(rearLens);
      addLamp(at(new THREE.PointLight(0xF0DCA8, 16, 15, 1.9), 2.0, 6.2, REAR_Z - 4.85), 16);

      // Wall pack on the west block's end wall, over the side lot.
      scene.add(at(box(0.32, 0.16, 0.46, 0x2E2A25), -35.62, 3.3, -4.0));
      addLamp(at(new THREE.PointLight(0xFFD48A, 14, 14, 1.9), -36.4, 3.1, -4.0), 14);
      // East end wall — the approach past the bay. Two marked customer bays on the pad.
      const EAST_X = 13.45;
      const eastPad = slab(5.5, 14, C.pad, 0.03);
      eastPad.position.set(EAST_X + 2.4, 0.03, -8.0);
      scene.add(eastPad);

      // Stall lines — four stripes, three marked bays. Customer parking lives here so the
      // shoulder and the exit run past the bay doors stay clear.
      // Stall line at x 16.45, so a 4.65m car nosed in stops 0.67m off the wall face at
      // 13.45 instead of the 0.37m it had. Centres 3.6m apart on z, comfortably over the
      // 2.75m a stall needs, and each car sits midway between its pair of stripes.
      [-1.4, -5.0, -8.6, -12.2].forEach(sz => {
        const line = slab(4.7, 0.14, C.stripe, 0.045);
        line.position.set(16.45, 0.045, sz);
        scene.add(line);
      });

      /* ---------- the east lot ----------
         Swinging the camera round to the boot opens up the ground east of the unit. Kept
         deliberately small: a drive lane out to the road, one facing row of stalls
         mirroring the three against the east wall, and a storage block beyond to close
         the view. The cars are placed further down, once makeCar exists. */
      const eastLot = new THREE.Group();
      const lotDeck = slab(17, 15, C.pad, 0.028);
      lotDeck.position.set(23.6, 0.028, -7.5);
      eastLot.add(lotDeck);
      // The lane out: connects the head of the lot to the exit drive at the kerb.
      const lotLane = slab(6, 8, C.pad, 0.026);
      lotLane.position.set(21.0, 0.026, 2.0);
      eastLot.add(lotLane);

      // One facing row, matching the three stalls on the east wall. It used to sit at
      // x 24.4, which put its noses 1.3m INSIDE the raised walk along the storage face and
      // left only 2.2m of aisle between the two rows' tails — no car could ever have
      // reversed out. The storage block has moved 6m east and the row with it: stall line
      // at 27.9, so noses stop 1.2m short of the walk and the tails leave a 7.1m aisle,
      // clear of the 6m a 90° stall needs to manoeuvre.
      [-1.4, -5.0, -8.6, -12.2].forEach(sz => {
        const line = slab(4.7, 0.14, C.stripe, 0.045);
        line.position.set(27.9, 0.045, sz);
        eastLot.add(line);
      });


      /* ---------- storage units beyond the lot ----------
         Face at x 33, a walk's width clear of the parked noses. Nothing opens directly onto a
         stall — the ingress points sit at the two ends of the run, past the last car, with
         a raised walk in front so the doors aren't flush to the tarmac. */
      const STORE_X = 33.0, STORE_Z = -8.0, STORE_H = 4.6;
      eastLot.add(at(box(13, STORE_H, 16, C.wallAlt), 39.5, STORE_H / 2, STORE_Z));
      eastLot.add(at(box(13.6, 0.4, 16.8, C.roof), 39.5, STORE_H + 0.2, STORE_Z));
      // Parapet, so the roof plant sits in a well rather than on a bare slab.
      eastLot.add(at(box(13.6, 0.5, 0.24, C.wallAlt), 39.5, STORE_H + 0.6, STORE_Z - 8.3));
      eastLot.add(at(box(13.6, 0.5, 0.24, C.wallAlt), 39.5, STORE_H + 0.6, STORE_Z + 8.3));
      eastLot.add(at(box(0.24, 0.5, 16.8, C.wallAlt), 33.0, STORE_H + 0.6, STORE_Z));
      eastLot.add(at(box(0.24, 0.5, 16.8, C.wallAlt), 46.0, STORE_H + 0.6, STORE_Z));
      // A banded course near the top breaks up 13m of flat wall.
      eastLot.add(at(box(0.1, 0.3, 16, 0x6E675C), STORE_X - 0.02, 3.5, STORE_Z));
      // Raised walk along the whole face. West of STORE_X — the lot is on that side, so
      // anything on the face subtracts from STORE_X rather than adding to it.
      eastLot.add(at(box(1.5, 0.16, 16, 0x6B655B), STORE_X - 0.8, 0.08, STORE_Z));

      // Ingress at the ends of the run, clear of every stall.
      [-0.9, -15.4].forEach(dz => {
        eastLot.add(at(box(0.16, 2.4, 1.1, C.door), STORE_X - 0.08, 1.28, dz));
        eastLot.add(at(box(0.1, 0.12, 1.3, 0x6E675C), STORE_X - 0.14, 2.55, dz));   // lintel
      });
      // One roller shutter at the south end, past the last stall (stalls sit at z -3.2,
      // -6.8 and -10.4), so nothing ever parks across it.
      eastLot.add(at(box(0.16, 3.0, 3.2, C.door), STORE_X - 0.08, 1.58, -12.6));
      eastLot.add(at(box(0.13, 0.2, 3.4, 0x6E675C), STORE_X - 0.12, 3.2, -12.6));
      // Bollards either side of the shutter — the reason nobody parks across it.
      [-14.4, -10.8].forEach(bz => {
        eastLot.add(at(cyl(0.11, 0.11, 0.95, 8, 0xC9A227), STORE_X - 1.5, 0.48, bz));
      });
      // Downpipes at the corners and mid-run.
      [-15.6, -8.0, -0.4].forEach(pz => {
        eastLot.add(at(cyl(0.09, 0.09, STORE_H, 6, 0x6E675C), STORE_X - 0.06, STORE_H / 2, pz));
      });

      // Rooftop plant: three condensers in a line down the east side of the deck, each
      // paired with its own skylight opposite. Aligned on one axis so they read as an
      // installed run rather than dropped at random.
      const PLANT_Z = [-3.6, -8.0, -12.4];
      const PLANT_X = 41.6, SKY_X = 36.4;
      PLANT_Z.forEach(uz => {
        const ux = PLANT_X;
        eastLot.add(at(box(2.2, 0.16, 1.6, 0x4E4A44), ux, STORE_H + 0.46, uz));       // rails
        eastLot.add(at(box(2.0, 0.9, 1.4, 0x8E877B), ux, STORE_H + 0.99, uz));        // cabinet
        eastLot.add(at(box(2.04, 0.1, 1.44, 0x6E675C), ux, STORE_H + 1.46, uz));      // fan deck
        eastLot.add(at(cyl(0.42, 0.42, 0.12, 12, 0x3E3A35), ux - 0.42, STORE_H + 1.56, uz));
        eastLot.add(at(cyl(0.42, 0.42, 0.12, 12, 0x3E3A35), ux + 0.42, STORE_H + 1.56, uz));
        eastLot.add(at(box(0.7, 0.42, 0.42, 0x7E776C), ux - 1.35, STORE_H + 0.85, uz)); // duct
      });
      // Mushroom vents, kept off both runs.
      [[38.9, -14.6], [38.9, -1.4], [44.6, -15.0], [44.6, -1.0]].forEach(([vx, vz]) => {
        eastLot.add(at(cyl(0.2, 0.26, 0.34, 8, 0x6E675C), vx, STORE_H + 0.57, vz));
        eastLot.add(at(cyl(0.34, 0.34, 0.08, 8, 0x4E4A44), vx, STORE_H + 0.78, vz));
      });
      scene.add(bakeStatic(eastLot, { skip: o => o.material.isMeshBasicMaterial }));

      // Skylights — one per condenser, on the matching z so each unit reads as serving
      // the bay its light sits over.
      PLANT_Z.forEach(kz => {
        const kx = SKY_X;
        scene.add(at(box(1.9, 0.26, 1.3, 0x6E675C), kx, STORE_H + 0.5, kz));
        const pane = new THREE.Mesh(
          new THREE.PlaneGeometry(1.6, 1.05),
          new THREE.MeshBasicMaterial({ color: 0xDCE6EC, transparent: true, opacity: 0.55 })
        );
        pane.rotation.x = -Math.PI / 2;
        at(pane, kx, STORE_H + 0.64, kz);
        addGlow(pane, 0.55, 0.45);   // holds a little daylight sheen too
        scene.add(pane);
      });

      // Wall packs down the face — offset from the doors so they light the walk, not the
      // lintels, and spaced wide enough to read as separate pools.
      [-1.6, -8.0, -14.4].forEach(wz => {
        scene.add(at(box(0.34, 0.18, 0.5, 0x2E2A25), STORE_X - 0.2, 3.55, wz));
        const lens = new THREE.Mesh(
          new THREE.PlaneGeometry(0.42, 0.2),
          new THREE.MeshBasicMaterial({ color: 0xFFE2A8, transparent: true, opacity: 0.85 })
        );
        lens.rotation.x = -Math.PI / 2; lens.rotation.z = Math.PI / 2;
        at(lens, STORE_X - 0.24, 3.45, wz);
        addGlow(lens, 0.85); scene.add(lens);
        addLamp(at(new THREE.PointLight(0xFFD48A, 7, 8, 2.1), STORE_X - 0.7, 3.3, wz), 7);
      });

      [-3.2, -6.4, -9.4].forEach((wz) => {
        const hood = box(0.32, 0.16, 0.46, 0x2E2A25); at(hood, EAST_X + 0.12, 4.62, wz); scene.add(hood);
        const lens = new THREE.Mesh(
          new THREE.PlaneGeometry(0.38, 0.19),
          new THREE.MeshBasicMaterial({ color: 0xFFE2A8, transparent: true, opacity: 0.85 })
        );
        lens.rotation.x = -Math.PI / 2; lens.rotation.z = Math.PI / 2;
        at(lens, EAST_X + 0.12, 4.52, wz);
        addGlow(lens, 0.85); scene.add(lens);
        addLamp(at(new THREE.PointLight(0xFFD48A, 8, 9, 2.1), EAST_X + 0.55, 4.35, wz), 8);
      });

      /* ---------- the neighbours' storefronts ----------
         Three tenants on the west block's street face (z -2.5), the mix you'd find beside
         a car-audio shop: a tyre & alignment bay with a roll-up door, a parts counter
         with a glazed front, and a detailer with a wash bay. Fascia signs are canvas
         text; the parts store's window stays lit after dark and the detailer's is dark. */
      const FACE_Z = -2.5;
      const signTexture = (txt, bg, fg, w) => {
        const c = document.createElement('canvas'); c.width = 512; c.height = 96;
        const g = c.getContext('2d');
        g.fillStyle = bg; g.fillRect(0, 0, 512, 96);
        g.fillStyle = fg; g.font = '700 46px "Newsreader", Georgia, serif';
        g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(txt, 256, 50);
        const tx = new THREE.CanvasTexture(c); tx.anisotropy = 4; return tx;
      };
      const fascia = (x, w, txt, bg, fg) => {
        const band = box(w, 0.72, 0.1, 0x3A3632); at(band, x, 3.75, FACE_Z + 0.05); building.add(band);
        const face = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.16, 0.56),
          new THREE.MeshBasicMaterial({ map: signTexture(txt, bg, fg), transparent: true }));
        at(face, x, 3.75, FACE_Z + 0.105); face.castShadow = face.receiveShadow = false; scene.add(face);
        addGlow(face, 1.0, 0.65);
      };
      const darkPanes = [];
      const glass = (x, y, w, h, lit) => {
        const frame = box(w + 0.16, h + 0.16, 0.08, 0x2C2A28); at(frame, x, y, FACE_Z + 0.02); building.add(frame);
        const pane = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
          new THREE.MeshBasicMaterial({ color: lit ? 0xFFE0A0 : 0x5A6670, transparent: true, opacity: lit ? 0.75 : 0.55 }));
        at(pane, x, y, FACE_Z + 0.065); pane.castShadow = pane.receiveShadow = false; scene.add(pane);
        addGlow(pane, lit ? 0.75 : 0.0, lit ? 0.18 : 0.0);
        if (!lit) darkPanes.push(pane);
        return pane;
      };
      const rollDoor = (x, w, h) => {
        const d = box(w, h, 0.08, 0x8A857C, { roughness: 0.6, metalness: 0.3 }); at(d, x, h / 2, FACE_Z + 0.02); building.add(d);
        for (let i = 1; i < h / 0.45; i++) building.add(at(box(w, 0.03, 0.1, 0x6E6A63), x, i * 0.45, FACE_Z + 0.03));
        const lintel = box(w + 0.3, 0.2, 0.12, 0x3A3632); at(lintel, x, h + 0.1, FACE_Z + 0.04); building.add(lintel);
      };
      const pedDoor = (x) => {
        building.add(at(box(1.0, 2.2, 0.06, 0x2C2A28), x, 1.1, FACE_Z + 0.02));
        return glass(x, 1.3, 0.6, 1.3, true);
      };
      // Unit A — tyre & alignment: a tall roll-up with a window office beside it.
      fascia(-32.5, 5.6, 'TIRE & ALIGNMENT', '#B8322A', '#F4EBDD');
      rollDoor(-33.6, 3.0, 3.1);
      glass(-30.6, 1.9, 1.5, 1.2, false);
      building.add(at(box(0.6, 1.8, 0.6, 0x1E1E20), -35.1, 0.9, FACE_Z + 0.5));   // tyre stack
      building.add(at(box(0.6, 1.2, 0.6, 0x1E1E20), -34.4, 0.6, FACE_Z + 0.5));
      // Unit B — auto parts counter: full-height glazing, door in the middle, lit late.
      fascia(-26.5, 5.6, 'MIDWEST AUTO PARTS', '#20324A', '#E8D9A8');
      // Its interior lights keep shop hours (08:00–20:00), not Sean's — see partsOpen()
      // in the frame loop, which dims these three glows and the lamp outside that window.
      const partsGlow = [glass(-28.3, 1.75, 2.0, 2.3, true), pedDoor(-26.5), glass(-24.7, 1.75, 2.0, 2.3, true)];
      const partsLamp = addLamp(at(new THREE.PointLight(0xFFE0A0, 9, 11, 2), -26.5, 2.2, -1.6), 9);
      const partsLampRec = lamps[lamps.length - 1];
      const partsGlowRecs = partsGlow.map(m => glows.find(g => g.mesh === m));
      // Unit C — detailer: wash bay roll-up and a dark office window; closed for the night.
      fascia(-20.5, 5.6, 'SHINE AUTO DETAIL', '#2E4A3A', '#EDE6D6');
      rollDoor(-19.4, 2.8, 3.0);
      glass(-22.4, 1.9, 1.5, 1.2, false);
      const hoseReel = cyl(0.3, 0.3, 0.14, 12, 0x3B3F44); hoseReel.rotation.x = Math.PI / 2;
      at(hoseReel, -21.4, 1.2, FACE_Z + 0.1); building.add(hoseReel);
      // Kerb-height concrete walk under all three, so the fronts don't sit straight on tarmac.
      building.add(at(box(18, 0.12, 1.6, 0x6B655B), -26.5, 0.06, FACE_Z + 0.8));


      // Road-side sign for the row — stands on the west corner of the side-road junction,
      // facing the main carriageway. Carries the shop's neon (built below).
      const SIGN_X = 24.0;
      const SIGN_Z = 7.6;
      const signPost = cyl(0.16, 0.19, 6.2, 8, 0x2A2825); at(signPost, SIGN_X, 3.1, SIGN_Z); scene.add(signPost);
      const signBoard = box(4.4, 2.12, 0.2, 0x211F1D); at(signBoard, SIGN_X, 7.0, SIGN_Z); scene.add(signBoard);
      const signEdge = box(4.72, 2.44, 0.11, 0x3A342B, { roughness: 0.6, metalness: 0.35 });
      at(signEdge, SIGN_X, 7.0, SIGN_Z - 0.07); scene.add(signEdge);

      // Brass channel letters over the open bay — the shop's own sign. Hung on the fascia,
      // clear of the roof overhang: at ROOM.h + 1.35 the mount speared up through the deck
      // and read as a black bar lying on the roof.
      const shopSign = box(3.4, 0.5, 0.14, 0x2A2825); at(shopSign, OPEN_X, ROOM.h + 0.72, -2.0); building.add(shopSign);
      const shopSignFace = new THREE.Mesh(
        new THREE.PlaneGeometry(3.1, 0.3),
        new THREE.MeshBasicMaterial({ color: 0xE8B23A, transparent: true, opacity: 0.9 })
      );
      at(shopSignFace, OPEN_X, ROOM.h + 0.72, -1.91); addGlow(shopSignFace, 0.9); building.add(shopSignFace);
      addLamp(at(new THREE.PointLight(0xE8B23A, 10, 12, 2), OPEN_X, ROOM.h + 0.6, -1.4), 10);

      // The whole shell is static, so it collapses to a handful of meshes. Emissive planes
      // (bay pool, ceiling strips, sign face, neighbour's wall pack) stay loose — the glow
      // pass animates their opacity per frame.
      scene.add(bakeStatic(building, { skip: o => o.material.isMeshBasicMaterial }));

      /* ---------- running water ----------
         Streaks scroll down a plane at each downpipe outfall, with a splash disc where it
         lands. Driven off the live precip rate, so the gutters only run when it actually
         rains and taper off as the shower eases. */
      const streakTex = (() => {
        const c = document.createElement('canvas'); c.width = 32; c.height = 128;
        const g = c.getContext('2d');
        g.clearRect(0, 0, 32, 128);
        for (let i = 0; i < 14; i++) {
          const x = Math.random() * 32, h = 18 + Math.random() * 54;
          const grd = g.createLinearGradient(0, 0, 0, h);
          grd.addColorStop(0, 'rgba(226,240,248,0)');
          grd.addColorStop(0.4, 'rgba(226,240,248,0.85)');
          grd.addColorStop(1, 'rgba(226,240,248,0)');
          g.fillStyle = grd;
          g.fillRect(x, Math.random() * 128, 1.6, h);
        }
        const tx = new THREE.CanvasTexture(c);
        tx.wrapS = tx.wrapT = THREE.RepeatWrapping;
        return tx;
      })();
      const waterMat = new THREE.MeshBasicMaterial({
        map: streakTex, transparent: true, opacity: 0, depthWrite: false,
      });
      const splashMat = new THREE.MeshBasicMaterial({
        color: 0xC8DCE8, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false,
      });
      const splashes = [];
      const eaveRuns = [];
      DOWNPIPES.forEach(p => {
        // Water spouting OUT of the shoe at the bottom, not a sheet down the pipe face —
        // you should never see the flow inside the pipe. Angled out and down from the
        // outlet so it reads as a discharge.
        const spout = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.72), waterMat);
        at(spout, p.x, 0.24, p.z + 0.5);
        spout.rotation.x = -1.02;
        spout.castShadow = spout.receiveShadow = false;
        scene.add(spout);
        // Two rings, offset in phase, reading as the splash ripple where it lands.
        for (let i = 0; i < 2; i++) {
          const ring = new THREE.Mesh(new THREE.RingGeometry(0.24, 0.34, 20), splashMat);
          ring.rotation.x = -Math.PI / 2;
          at(ring, p.x, 0.075, p.z + 0.66);
          ring.castShadow = ring.receiveShadow = false;
          scene.add(ring);
          splashes.push({ ring, off: i * 0.5 });
        }
      });

      // A thin run of water travelling along the top of the gutter itself, so the eave
      // shows the flow moving toward the pipes rather than the roof simply being dry.
      [[-0.05, 5.31, EAVE_Z, 26.7], [-26.5, 4.675, -2.34, 18.2]].forEach(([gx, gy, gz, gw]) => {
        const run = new THREE.Mesh(new THREE.PlaneGeometry(gw, 0.18), waterMat);
        run.rotation.x = -Math.PI / 2;
        at(run, gx, gy, gz);
        run.castShadow = run.receiveShadow = false;
        scene.add(run);
        eaveRuns.push(run);
      });

      /* ---------- tree line behind the building ---------- */
      // Nebraska hardwoods — every tree is a central trunk with a leafy crown on top.
      // Seeded deterministically so the skyline is the same every load. Two staggered rows
      // plus a scattered far row for depth, all standing in grass rather than on concrete.
      let seedN = 20260830;
      const rnd = () => { seedN = (seedN * 1103515245 + 12345) & 0x7fffffff; return seedN / 0x7fffffff; };

      const TRUNK = 0x3A2E24;
      const FOLIAGE = [0x2E4033, 0x35492E, 0x283A2C, 0x3D4E32, 0x24352A];
      const GRASS = [0x3B4A2F, 0x43512F, 0x33422B];

      // Tree dimensions are quantized to a small set of buckets. Random sizes give every
      // tree its own geometry buffers (44 trees = ~180 unique meshes on the GPU); snapping
      // to steps lets the whole wood share a handful of cached shapes, and at this scale
      // the repetition is invisible.
      const qz = (v, step) => Math.round(v / step) * step;

      function broadleaf(h, r, tint) {
        h = qz(h, 1.5); r = qz(r, 0.5);
        const g = new THREE.Group();
        const trunk = cyl(r * 0.14, r * 0.2, h * 0.45, 6, TRUNK);
        trunk.castShadow = false;
        at(trunk, 0, h * 0.22, 0); g.add(trunk);
        // Three overlapping lumps read as a canopy without costing much geometry
        [[0, h * 0.62, 0, r], [r * 0.42, h * 0.52, r * 0.2, r * 0.66], [-r * 0.38, h * 0.55, -r * 0.24, r * 0.7]]
          .forEach(([lx, ly, lz, lr]) => {
            const lump = new THREE.Mesh(icoGeo(qz(lr, 0.25)), mat(tint, { roughness: 0.94 }));
            at(lump, lx, ly, lz);
            lump.scale.y = 0.82;
            lump.castShadow = false; lump.receiveShadow = true;
            g.add(lump);
          });
        return g;
      }

      function roundleaf(h, r, tint) {
        h = qz(h, 1.5); r = qz(r, 0.5);
        const g = new THREE.Group();
        const trunk = cyl(r * 0.13, r * 0.2, h * 0.64, 6, TRUNK);
        trunk.castShadow = false;
        at(trunk, 0, h * 0.32, 0); g.add(trunk);
        // A single tall crown with a smaller cap — the elm/ash silhouette, not a conifer.
        [[0, h * 0.76, 0, r * 1.02, 0.92], [r * 0.14, h * 0.95, -r * 0.1, r * 0.6, 0.8]]
          .forEach(([lx, ly, lz, lr, sy]) => {
            const lump = new THREE.Mesh(icoGeo(qz(lr, 0.25)), mat(tint, { roughness: 0.94 }));
            at(lump, lx, ly, lz);
            lump.scale.y = sy;
            lump.castShadow = false; lump.receiveShadow = true;
            g.add(lump);
          });
        return g;
      }

      const trees = new THREE.Group();
      const treeSpots = [];   // {x, z, h, r} for the cheap ground shadows
      function plantRow(z, xFrom, xTo, spacing, hMin, hMax, jitter) {
        for (let x = xFrom; x <= xTo; x += spacing) {
          const px = x + (rnd() - 0.5) * jitter;
          const pz = z + (rnd() - 0.5) * jitter;
          const h = hMin + rnd() * (hMax - hMin);
          const tint = FOLIAGE[Math.floor(rnd() * FOLIAGE.length)];
          const r = h * (0.28 + rnd() * 0.1);
          const t = rnd() > 0.5 ? roundleaf(h, r, tint) : broadleaf(h, r, tint);
          at(t, px, 0, pz);
          t.rotation.y = rnd() * Math.PI * 2;
          trees.add(t);
          treeSpots.push({ x: px, z: pz, h, r });
        }
      }

      // One unbroken field behind the row rather than a patch per tree — overlapping
      // skirts left concrete showing through and fought each other for depth. It starts
      // level with the rear pole, at the back edge of the service pad.
      const GRASS_Z = REAR_Z - 5.2;
      [[0, -72.2, 260, 103.6], [-78, -40.0, 64, 39.2], [78, -40.0, 64, 39.2]].forEach(([gx, gz, gw, gd]) => {
        // Well clear of the ground plane below it — a 1cm gap z-fights at this camera range.
        const field = slab(gw, gd, 0x3B4A2F, 0.05);
        field.position.set(gx, 0.05, gz);
        field.receiveShadow = true;
        scene.add(field);
      });

      plantRow(-25.0, -46, 46, 6.4, 7, 12, 3.0);    // first line, just past the rear pole
      plantRow(-34.0, -58, 58, 7.8, 8, 14, 4.0);    // second, taller
      plantRow(-46.0, -72, 72, 10.5, 9, 16, 5.5);   // far ridge

      /* ---------- cheap tree shadows ----------
         The trees stay OUT of the real shadow map (drawing ~100 trees into it every frame
         was the expensive part). Instead each tree gets a soft blob on the grass: one
         InstancedMesh, one draw call, no shadow pass. When the sun moves, each blob slides
         away from the sun and stretches with its tree's height; it fades with sun strength. */
      const treeShadowTex = (() => {
        const c = document.createElement('canvas'); c.width = c.height = 64;
        const g = c.getContext('2d');
        const rg = g.createRadialGradient(32, 32, 0, 32, 32, 32);
        rg.addColorStop(0, 'rgba(0,0,0,1)'); rg.addColorStop(0.55, 'rgba(0,0,0,0.7)'); rg.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = rg; g.fillRect(0, 0, 64, 64);
        return new THREE.CanvasTexture(c);
      })();
      const treeShadowMat = new THREE.MeshBasicMaterial({ map: treeShadowTex, color: 0x050804, transparent: true, opacity: 0.4, depthWrite: false, toneMapped: false,
        polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -8 });
      const treeShadowGeo = new THREE.PlaneGeometry(1, 1); treeShadowGeo.rotateX(-Math.PI / 2);
      const treeShadows = new THREE.InstancedMesh(treeShadowGeo, treeShadowMat, treeSpots.length);
      treeShadows.castShadow = treeShadows.receiveShadow = false;
      treeShadows.renderOrder = 1;
      treeShadows.frustumCulled = false;
      scene.add(treeShadows);
      const tsM = new THREE.Matrix4(), tsQ = new THREE.Quaternion(), tsS = new THREE.Vector3(), tsP = new THREE.Vector3(), tsUp = new THREE.Vector3(0, 1, 0);
      let tsLast = '';
      function updateTreeShadows(sunPos, sunI) {
        const key = sunPos.x.toFixed(1) + ',' + sunPos.y.toFixed(1) + ',' + sunPos.z.toFixed(1);
        // A contact-shadow floor that never fades (crowns darken the ground under them even
        // under cloud or at night), plus the sun-cast part on top.
        treeShadowMat.opacity = 0.24 + Math.min(1, sunI / 1.45) * 0.2;
        if (key === tsLast) return;
        tsLast = key;
        // Direction the shadow falls (away from the sun), and how far per metre of height.
        const len = Math.hypot(sunPos.x, sunPos.z) || 1;
        const dx = -sunPos.x / len, dz = -sunPos.z / len;
        const reach = Math.min(2.2, len / Math.max(4, sunPos.y));
        tsQ.setFromAxisAngle(tsUp, Math.atan2(dx, dz));
        treeSpots.forEach((t, i) => {
          // Sun-cast throw kept short and anchored on the trunk, so most of the patch sits
          // in front of and around the tree where the camera can actually see it.
          const throwLen = t.h * 0.22 * reach;
          tsP.set(t.x + dx * throwLen * 0.3, 0.075, t.z + dz * throwLen * 0.3);
          tsS.set(t.r * 1.6, 1, t.r * 1.6 + throwLen);
          tsM.compose(tsP, tsQ, tsS);
          treeShadows.setMatrixAt(i, tsM);
        });
        treeShadows.instanceMatrix.needsUpdate = true;
      }
      scene.add(bakeStatic(trees));

      // Distant town glow on the horizon, and aircraft-warning reds on far masts
      [[-64, 5.5, -46], [58, 4.5, -52]].forEach(([mx, my, mz]) => {
        const mast = cyl(0.16, 0.2, my * 2, 6, 0x24221F); at(mast, mx, my, mz); scene.add(mast);
        const beacon = new THREE.Mesh(
          new THREE.SphereGeometry(0.5, 8, 6),
          new THREE.MeshBasicMaterial({ color: 0xE2402C, transparent: true, opacity: 0.9 })
        );
        at(beacon, mx, my * 2 + 0.4, mz); addGlow(beacon, 0.9); scene.add(beacon);
      });
      const townGlow = new THREE.Mesh(
        new THREE.PlaneGeometry(200, 26),
        new THREE.MeshBasicMaterial({ color: 0xE0A860, transparent: true, opacity: 0 })
      );
      at(townGlow, 0, 9, -74); addGlow(townGlow, 0.3); scene.add(townGlow);

      /* ---------- neon sign: wordmark riding a live spectrum analyser ---------- */
      function neonSign() {
        const W = 1024, H = 448;
        const BASE = 396;        // bar baseline
        const BARS = 23;
        const SPAN = 960;
        const bw = SPAN / BARS * 0.6;
        const step = SPAN / BARS;
        const x0 = (W - SPAN) / 2 + step / 2;
        const AUTO_PX = 168;
        const AUTO_Y = 296;
        let gapHalf = 190;       // measured from the type once the font is ready

        const pass = (ctx, fn, blur, color, width, alpha) => {
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = alpha;
          ctx.shadowColor = color;
          ctx.shadowBlur = blur;
          ctx.strokeStyle = color;
          ctx.lineWidth = width;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          fn();
          ctx.restore();
        };

        // The type is static, so it's rendered once to its own layer and blitted — only
        // the analyser bars are redrawn per frame.
        const textLayer = document.createElement('canvas');
        textLayer.width = W; textLayer.height = H;
        const tl = textLayer.getContext('2d');

        const drawText = () => {
          tl.clearRect(0, 0, W, H);
          tl.textAlign = 'center';
          tl.textBaseline = 'middle';
          const script = (px) => '400 ' + px + 'px "Newsreader", Georgia, serif';

          // The analyser runs behind the wordmark, so measure 'Auto' and keep the bars
          // out of the horizontal space its letters occupy — plus a full bar's width of
          // breathing room either side.
          tl.font = script(AUTO_PX);
          gapHalf = tl.measureText('Auto').width / 2 + 30 + step;

          const wordmark = () => { tl.font = script(168); tl.strokeText('Spectrum', W / 2, 116); };
          const sub = () => { tl.font = script(AUTO_PX); tl.strokeText('Auto', W / 2, AUTO_Y); };
          [wordmark, sub].forEach((fn, i) => {
            const w = i === 0 ? 11 : 11;
            pass(tl, fn, 22, '#6B4408', w + 5, 0.3);
            pass(tl, fn, 9,  '#D89E22', w, 0.72);
            pass(tl, fn, 0,  '#FFF6E2', Math.max(2.5, w - 5), 1);
          });

          // The rail the bars stand on is static, so it's baked into this layer instead of
          // being restroked (twice, with blur) on every analyser repaint.
          const rail = () => {
            const L = x0 - step / 2, R = x0 + SPAN - step / 2;
            tl.beginPath();
            tl.moveTo(L, BASE + 14); tl.lineTo(W / 2 - gapHalf, BASE + 14);
            tl.moveTo(W / 2 + gapHalf, BASE + 14); tl.lineTo(R, BASE + 14);
            tl.stroke();
          };
          pass(tl, rail, 14, '#4A4038', 9, 0.3);
          pass(tl, rail, 4,  '#9A8A70', 4, 0.6);
        };

        const cv = document.createElement('canvas');
        cv.width = W; cv.height = H;
        const g2 = cv.getContext('2d');

        // A plausible frequency response: energy peaks in the low-mids and rolls off up
        // top, so the silhouette reads like a real analyser rather than a random row.
        const shape = [];
        for (let i = 0; i < BARS; i++) {
          const u = i / (BARS - 1);
          shape.push(0.34 + Math.sin(Math.pow(u, 0.55) * Math.PI) * 0.66 * (1 - u * 0.42));
        }
        const seed = [];
        for (let i = 0; i < BARS; i++) {
          seed.push({ a: 1.7 + Math.random() * 2.9, b: 4.1 + Math.random() * 5.3, p: Math.random() * 6.28 });
        }
        const level = new Float32Array(BARS);

        // Bars are tinted across the audible range. The near-white core pass that suits
        // the amber wordmark washes hue out entirely, so bars keep a saturated core and
        // sweep a wide arc — red at the low end through violet/blue to green up top.
        const tint = [];
        for (let i = 0; i < BARS; i++) {
          const u = i / (BARS - 1);
          // Skip the warm band entirely — red/orange/yellow read as the same amber as the
          // wordmark. Sweep magenta -> violet -> blue -> cyan -> green instead.
          const hue = 305 - u * 195;
          tint.push({
            halo: 'hsl(' + hue + ',100%,34%)',
            tube: 'hsl(' + hue + ',100%,54%)',
            core: 'hsl(' + hue + ',96%,68%)',
          });
        }

        const drawBars = (t) => {
          // A slow musical pulse everything rides on
          const beat = 0.62 + Math.pow(Math.max(0, Math.sin(t * 2.4)), 3) * 0.38;

          for (let i = 0; i < BARS; i++) {
            const s = seed[i];
            const osc = (Math.sin(t * s.a + s.p) * 0.5 + Math.sin(t * s.b + s.p * 1.7) * 0.32 + 0.82) / 1.64;
            const target = shape[i] * osc * beat;
            // Attack fast, release slow — the asymmetry is what makes it read as audio
            const d = target - level[i];
            level[i] += d * (d > 0 ? 0.55 : 0.12);

            const x = x0 + i * step;
            if (Math.abs(x - W / 2) < gapHalf) continue;   // clear of the wordmark

            const h = 16 + level[i] * 176;
            const c = tint[i];
            const bar = () => {
              g2.beginPath();
              g2.moveTo(x, BASE);
              g2.lineTo(x, BASE - h);
              g2.stroke();
            };
            pass(g2, bar, 22, c.halo, bw + 6, 0.5);
            pass(g2, bar, 9,  c.tube, bw, 0.95);
            pass(g2, bar, 0,  c.core, Math.max(2, bw - 8), 0.9);
          }

          // The rail the bars stand on is static — it lives on the text layer, not here.
        };

        const render = (t) => {
          g2.clearRect(0, 0, W, H);
          g2.drawImage(textLayer, 0, 0);
          drawBars(t);
        };

        drawText();
        render(0);
        const tex = new THREE.CanvasTexture(cv);
        tex.anisotropy = 4;
        if (document.fonts && document.fonts.ready) {
          document.fonts.ready.then(() => { drawText(); render(0); tex.needsUpdate = true; });
        }
        return { tex, render };
      }

      const NEON = { w: 4.2, h: 1.94 };
      const neonArt = neonSign();
      const neonFace = new THREE.Mesh(
        new THREE.PlaneGeometry(NEON.w, NEON.h),
        new THREE.MeshBasicMaterial({ map: neonArt.tex, transparent: true, opacity: 0.95 })
      );
      at(neonFace, SIGN_X, 7.0, SIGN_Z + 0.11);
      addGlow(neonFace, 0.95, 0.3);   // keeps a little presence in daylight
      scene.add(neonFace);

      // The amber the sign throws onto the road and the ground under the post
      addLamp(at(new THREE.PointLight(0xE8B23A, 15, 16, 2.0), SIGN_X, 7.0, SIGN_Z + 1.0), 15);
      addLamp(at(new THREE.PointLight(0xC9821E, 8, 10, 2.1), SIGN_X, 2.2, SIGN_Z + 0.6), 8);

      /* ---------- cars ---------- */
      function makeCar(paint) {
        const g = new THREE.Group();                 // faces +z
        // 4.65 rather than 4.3: the bonnet panel runs from the cowl at z 0.82 out to 2.32,
        // so a 4.3 shell left the lid overhanging its own nose.
        const body = box(1.95, 0.62, 4.65, paint, { roughness: 0.5, metalness: 0.25 });
        at(body, 0, 0.66, 0.09); g.add(body);
        const cabin = box(1.72, 0.6, 2.1, paint, { roughness: 0.5, metalness: 0.25 });
        at(cabin, 0, 1.24, -0.15); g.add(cabin);
        const glass = box(1.74, 0.42, 2.0, C.glass, { roughness: 0.25, metalness: 0.1 });
        at(glass, 0, 1.3, -0.15); g.add(glass);
        [[-0.98, 1.42], [0.98, 1.42], [-0.98, -1.42], [0.98, -1.42]].forEach(([wx, wz]) => {
          const w = cyl(0.42, 0.42, 0.3, 12, C.tire, { roughness: 0.95 });
          w.rotation.z = Math.PI / 2; g.add(at(w, wx, 0.42, wz));
        });
        const lampGeo = new THREE.PlaneGeometry(0.4, 0.16);
        const hl = new THREE.Mesh(lampGeo, new THREE.MeshBasicMaterial({ color: 0xF3E6C4, transparent: true, opacity: 0.25 }));
        at(hl, -0.6, 0.7, 2.16); g.add(hl);
        const hr = hl.clone(); hr.material = hl.material.clone(); at(hr, 0.6, 0.7, 2.16); g.add(hr);
        g.userData.heads = [hl, hr];

        // Real forward-throwing beams. The spot target is parented to the car, so its
        // world position travels with it and the cone always points down the bonnet.
        const beams = [];
        [0].forEach((bx) => {
          const beam = new THREE.SpotLight(0xF6EBD2, 0, 32, 0.44, 0.6, 1.3);
          // A zero-intensity light is NOT free: three.js still allocates it a slot in the
          // spotLights uniform array and every fragment of every mesh iterates it, and the
          // count is baked into the shader define — so beams are ALWAYS visible and are
          // driven by intensity alone. Shadow flags are set once, below, never per frame.
          beam.position.set(bx, 0.68, 2.2);
          const tgt = new THREE.Object3D();
          tgt.position.set(0, -0.5, 24);          // forward, aimed down
          g.add(tgt);
          beam.target = tgt;
          g.add(beam);
          beams.push(beam);
        });
        g.userData.beams = beams;
        // Hiding a car for being out of range must not hide its beam light: a light under
        // a hidden parent leaves the renderer's light list, which changes a shader define
        // and recompiles every material. So "hide" toggles the meshes only.
        g.userData.setShown = (on) => {
          if (g.userData.shown === on) return;
          g.userData.shown = on;
          g.traverse(o => { if (o.isMesh) o.visible = on; });
        };
        g.userData.shown = true;
        return g;
      }

      // Two on the shoulder, and two nosed into the marked bays on the east pad. Their
      // headlight glows are driven by the day cycle too, so nothing sits lit in daylight.
      const parkedCars = [];
      [[-13, 6.6, Math.PI / 2, 1],
       // Two in the neighbours' side lot, nosed to the end wall (facing +x).
       [-38.2, -8.8, Math.PI / 2, 2], [-38.2, -5.6, Math.PI / 2, 3]].forEach(([px, pz, ry, ci]) => {
        const c2 = makeCar(CAR_PAINT[ci]);
        c2.position.set(px, 0, pz); c2.rotation.y = ry;
        c2.userData.heads.forEach(h => (h.material.opacity = 0));
        scene.add(c2);
        parkedCars.push(c2);
      });

      // The facing row across the lot — same three positions as the east wall, nosed the
      // other way so the two rows meet at the island.
      [[27.9, -3.2, 2], [27.9, -6.8, 1], [27.9, -10.4, 3]].forEach(([px, pz, ci]) => {
        const c3 = makeCar(CAR_PAINT[ci]);
        c3.position.set(px, 0, pz);
        c3.rotation.y = Math.PI / 2;
        c3.userData.heads.forEach(h => (h.material.opacity = 0));
        scene.add(c3);
        parkedCars.push(c3);
      });

      /* ---------- traffic passing on the road ----------
         `dir` is the direction of travel along x. A car body faces +z locally, so a car
         travelling +x must be yawed +90° and one travelling -x, -90°. Right-hand traffic
         puts the +x flow in the near lane. */
      const traffic = [];
      [[0, 1, +1], [1, 3, -1], [2, 0, +1]].forEach(([i, ci, dir]) => {
        const t2 = makeCar(CAR_PAINT[ci]);
        t2.position.set(0, 0, dir > 0 ? 15.4 : 19.6);
        t2.rotation.y = dir > 0 ? Math.PI / 2 : -Math.PI / 2;
        // Tail lights, so a car going away still reads at night
        const tailGeo = new THREE.PlaneGeometry(0.34, 0.14);
        const tl = new THREE.Mesh(tailGeo, new THREE.MeshBasicMaterial({ color: 0xE23A22, transparent: true, opacity: 0.8 }));
        at(tl, -0.6, 0.7, -2.16); tl.rotation.y = Math.PI; t2.add(tl);
        const tr = tl.clone(); tr.material = tl.material.clone(); at(tr, 0.6, 0.7, -2.16); tr.rotation.y = Math.PI; t2.add(tr);
        t2.userData.tails = [tl, tr];
        scene.add(t2);
        traffic.push({ car: t2, dir, x: -60 + i * 42 + Math.random() * 20, speed: 16 + Math.random() * 7 });
      });

      /* ---------- the customers' cars ----------
         Two of them, running the same visit half a cycle apart, so one is always on the
         bay while the next waits in the stall by the door. Each carries its own lids,
         installs, underglow and bass rig; the state that used to be loose globals lives on
         the returned record. */
      const glowTex = (() => {
        const c = document.createElement('canvas'); c.width = c.height = 128;
        const g = c.getContext('2d');
        const rg = g.createRadialGradient(64, 64, 0, 64, 64, 64);
        rg.addColorStop(0, 'rgba(255,255,255,1)');
        rg.addColorStop(0.45, 'rgba(255,255,255,0.55)');
        rg.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = rg; g.fillRect(0, 0, 128, 128);
        return new THREE.CanvasTexture(c);
      })();
      // Hood past 60° (front-hinged, so negative). The boot lifts its rear edge, a POSITIVE
      // rotation about x — 97°, past upright so the open lid leans forward over the cabin
      // and leaves real daylight between it and the enclosure fronts.
      const HOOD_OPEN = -1.12, TRUNK_OPEN = 1.70;
      function makeHero(paint) {
        const car = makeCar(paint);
        // One of the beam pair casts the shadow — two overlapping maps of the same wall is
        // a wasted pass.
        car.userData.beams.forEach((b, i) => {
          if (i > 0) return;
          // Shadow-casting is switched on only after dark (see the frame loop).
          b.castShadow = false;
          b.userData.heroBeam = true;
          b.shadow.mapSize.set(512, 512);
          b.shadow.camera.near = 0.5;
          b.shadow.camera.far = 30;
          b.shadow.bias = -0.003;
        });
        scene.add(car);
        // Lids hinge on pivots sitting OUTSIDE the cabin footprint (z -1.2..0.9). The boot
        // hinges at the cabin end and runs rearward, as a real lid is hung.
        const hoodPivot = new THREE.Group(); at(hoodPivot, 0, 1.0, 0.96); car.add(hoodPivot);
        const hood = box(1.8, 0.1, 1.36, paint, { roughness: 0.5, metalness: 0.25 });
        at(hood, 0, 0, 0.68); hoodPivot.add(hood);
        const trunkPivot = new THREE.Group(); at(trunkPivot, 0, 1.0, -1.34); car.add(trunkPivot);
        const trunk = box(1.8, 0.1, 0.96, paint, { roughness: 0.5, metalness: 0.25 });
        at(trunk, 0, 0, -0.48); trunkPivot.add(trunk);
        // What Sean installs. The body is a solid box, so each rig lifts out of the shell
        // as its lid swings up.
        const ampRig = new THREE.Group(); at(ampRig, 0, 0.55, 0); car.add(ampRig);
        const amplifier = box(0.8, 0.22, 0.5, 0x2A2C30, { metalness: 0.4, roughness: 0.45 });
        at(amplifier, 0, 0, 1.45); ampRig.add(amplifier);
        const ampLed = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.05),
          new THREE.MeshBasicMaterial({ color: 0x7BE0C8, transparent: true, opacity: 0 }));
        ampLed.rotation.x = -Math.PI / 2; at(ampLed, 0, 0.12, 1.45); ampRig.add(ampLed);
        const subRig = new THREE.Group(); at(subRig, 0, 0.55, 0); car.add(subRig);
        const subCones = [], subUnits = [];
        [-0.44, 0.44].forEach(sx => {
          const unit = new THREE.Group(); subRig.add(unit); subUnits.push(unit);
          const encl = box(0.74, 0.56, 0.66, 0x2A241E); at(encl, sx, 0, -1.79); unit.add(encl);
          const baffle = box(0.78, 0.6, 0.06, 0xC7B28A); at(baffle, sx, 0, -2.10); unit.add(baffle);
          const surround = cyl(0.27, 0.27, 0.05, 16, 0xC9A227);
          surround.rotation.x = Math.PI / 2; at(surround, sx, 0.02, -2.14); unit.add(surround);
          const cone = cyl(0.21, 0.21, 0.05, 16, 0x8A8F94);
          cone.rotation.x = Math.PI / 2; at(cone, sx, 0.02, -2.16); unit.add(cone);
          const dust = cyl(0.08, 0.08, 0.05, 12, 0xE8B23A);
          dust.rotation.x = Math.PI / 2; at(dust, sx, 0.02, -2.19); unit.add(dust);
          subCones.push(cone, dust, surround);
        });
        ampRig.visible = subRig.visible = false;
        // Underglow: a radial sprite the size of the car's footprint.
        const underGlow = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 8.0),
          new THREE.MeshBasicMaterial({ map: glowTex, color: 0x9B5CF0, transparent: true, opacity: 0,
            blending: THREE.AdditiveBlending, depthWrite: false }));
        underGlow.rotation.x = -Math.PI / 2; at(underGlow, 0, 0.11, 0);
        underGlow.renderOrder = 2;
        underGlow.castShadow = underGlow.receiveShadow = false; car.add(underGlow);
        const underLight = new THREE.PointLight(0x9B5CF0, 0, 5.5, 2.4);
        at(underLight, 0, 0.3, 0); car.add(underLight);
        // The bass in the air: half-rings standing off the back of the car.
        const bassArcs = [];
        for (let i = 0; i < 4; i++) {
          const a2 = new THREE.Mesh(new THREE.RingGeometry(0.97, 1.03, 56, 1, 0, Math.PI),
            new THREE.MeshBasicMaterial({ color: 0x1B7F72, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
          a2.rotation.y = Math.PI / 2;
          at(a2, 0, 1.16, -2.43);
          a2.castShadow = a2.receiveShadow = false; a2.visible = false;
          car.add(a2); bassArcs.push(a2);
        }
        return { car, hoodPivot, trunkPivot, ampRig, ampLed, subRig, subCones, subUnits, underGlow, underLight, bassArcs, underAmt: 0 };
      }
      const heroA = makeHero(CAR_PAINT[4]);
      const heroB = makeHero(CAR_PAINT[3]);
      const hero = heroA.car;
      // Five in the pool: one on the bay, three in the stalls, one leaving at most.
      const heroes = [heroA, heroB, makeHero(CAR_PAINT[0]), makeHero(CAR_PAINT[2]), makeHero(0x2E3A5C)];

      // A parts-store customer: their own slow loop, about one visit per two of Sean's.
      const shopperCar = makeCar(CAR_PAINT[0]);
      shopperCar.userData.setShown(false); scene.add(shopperCar);
      const shopper = makePerson({ shirt: 0x4A6A8A, pants: 0x3A3A3A, cap: true });
      shopper.scale.setScalar(1.18); scene.add(shopper);
      // Someone waiting for the bus — there about half the time, sat on the bench.
      const busRider = makePerson({ shirt: 0x6A4A5A, pants: 0x2E2E36, cap: false });
      busRider.scale.setScalar(1.18); scene.add(busRider);
      function stepBusRider(T, dt) {
        const d = busRider.userData;
        const ph = T % 150;
        const shown = ph > 20 && ph < 95;
        if (d.shown !== shown) { d.shown = shown; d.bodyParts.forEach(m => (m.visible = shown)); }
        // Props aren't body parts (they keep their own visibility), so they leave with them.
        if (!shown) { d.phone.visible = false; d.part.visible = false; d.subProp.visible = false; return; }
        busRider.position.set(BUS_SEAT[0] + 0.3, 0, BUS_SEAT[1]);
        d.h = Math.PI; busRider.rotation.y = Math.PI;   // facing the road and the shop
        d.ph += dt * 1.1;
        d.hips.position.y = -0.4;
        d.legL.rotation.x = -1.4; d.legR.rotation.x = -1.3;
        d.torso.rotation.x = 0.08;
        // Glances down the road for the bus, then back to the phone.
        const look = Math.sin(T * 0.3) > 0.6;
        d.armL.rotation.x = look ? -0.2 : -0.9; d.armR.rotation.x = look ? -0.15 : -0.95;
        d.armL.rotation.z = 0; d.armR.rotation.z = 0;
        d.phone.visible = !look;
        busRider.rotation.y = Math.PI + (look ? -0.7 : 0);
      }
      // The rideshare that collects the customer and later brings them back.
      const ride = makeCar(CAR_PAINT[1]);
      const beacon = box(0.34, 0.14, 0.1, 0xE8EEF2, { emissive: 0x9FB6C4 });
      at(beacon, 0, 1.34, 0.55); beacon.castShadow = false; ride.add(beacon);
      scene.add(ride);
      // A second one, for when a drop-off and a pickup overlap.
      const ride2 = makeCar(CAR_PAINT[1]);
      { const b2 = beacon.clone(); ride2.add(b2); }
      scene.add(ride2);

      /* ---------- people ---------- */
      function makePerson(o) {
        const shirt = o.shirt, pants = o.pants;
        const g = new THREE.Group();
        const hips = new THREE.Group(); g.add(hips);
        const torso = box(0.52, 0.66, 0.3, shirt); at(torso, 0, 1.16, 0); hips.add(torso);
        const head = box(0.3, 0.3, 0.3, C.skin); at(head, 0, 1.62, 0); hips.add(head);
        if (o.cap) { const cap = box(0.34, 0.1, 0.34, 0x22282E); at(cap, 0, 1.79, 0); hips.add(cap); }
        const limb = (color, h, w, d) => {
          const pivot = new THREE.Group();
          pivot.add(at(box(w, h, d, color), 0, -h / 2, 0));
          return pivot;
        };
        const armL = limb(shirt, 0.54, 0.14, 0.16); at(armL, -0.33, 1.44, 0); hips.add(armL);
        const armR = limb(shirt, 0.54, 0.14, 0.16); at(armR, 0.33, 1.44, 0); hips.add(armR);
        const legL = limb(pants, 0.72, 0.18, 0.2); at(legL, -0.14, 0.82, 0); hips.add(legL);
        const legR = limb(pants, 0.72, 0.18, 0.2); at(legR, 0.14, 0.82, 0); hips.add(legR);
        [legL, legR].forEach(l => l.add(at(box(0.2, 0.12, 0.3, C.boots), 0, -0.76, 0.04)));
        const part = box(0.3, 0.22, 0.3, C.trim, { emissive: 0x2A2205 });
        at(part, 0, 1.1, 0.36); part.visible = false; hips.add(part);
        // Held in the raised hand — a real handset rather than a blue chip, because the
        // selfie only reads if you can see what she's holding and which way it points.
        // The arm pivots about x, so with the arm raised the arm's local +y runs back
        // toward her face: every face of the phone that should be looking at her gets a
        // +y normal.
        const phone = new THREE.Group();
        at(phone, 0, -0.56, 0.1); phone.visible = false; armR.add(phone);
        const shell = box(0.11, 0.018, 0.2, 0x1A1C20); shell.castShadow = false; phone.add(shell);
        const screen = new THREE.Mesh(
          new THREE.PlaneGeometry(0.095, 0.185),
          new THREE.MeshBasicMaterial({ color: 0x9AC4D8, transparent: true, opacity: 0.95 })
        );
        screen.rotation.x = -Math.PI / 2; at(screen, 0, 0.011, 0);
        screen.castShadow = false; phone.add(screen);
        // The burst. Sits just off the screen face and blows out on the shutter.
        const flash = new THREE.Mesh(
          new THREE.PlaneGeometry(0.5, 0.5),
          new THREE.MeshBasicMaterial({
            color: 0xFFFDF2, transparent: true, opacity: 0,
            blending: THREE.AdditiveBlending, depthWrite: false,
          })
        );
        flash.rotation.x = -Math.PI / 2; at(flash, 0, 0.03, 0);
        flash.castShadow = false; phone.add(flash);
        const flashLight = new THREE.PointLight(0xFFFDF2, 0, 4, 2);
        at(flashLight, 0, -0.5, 0.1); armR.add(flashLight);   // on the arm, so it's never under a hidden phone
        // A subwoofer carried in both arms during the fitout.
        const subProp = box(0.5, 0.4, 0.46, 0x2A241E);
        at(subProp, 0, 1.02, 0.44); subProp.visible = false; hips.add(subProp);
        const bodyParts = [];
        g.traverse(o => { if (o.isMesh && o !== part && o !== subProp && !phone.getObjectById(o.id)) bodyParts.push(o); });
        g.userData = { hips, torso, armL, armR, legL, legR, part, phone, screen, flash, flashLight, subProp, bodyParts, shown: true, h: 0, ph: 0 };
        return g;
      }
      const sean = makePerson({ shirt: C.shirt, pants: C.jeans, cap: true });
      sean.scale.setScalar(1.22);
      scene.add(sean);
      // The customer — lighter jacket, no cap, so the two never read as the same person.
      const cust = makePerson({ shirt: 0x8A7C6A, pants: 0x33384A, cap: false });
      cust.scale.setScalar(1.2);
      // The second car's owner — green jacket, so the two customers never read as one.
      const cust2 = makePerson({ shirt: 0x5C7A5E, pants: 0x2E2E36, cap: false });
      cust2.scale.setScalar(1.2);
      scene.add(cust2);
      scene.add(cust);
      const customers = [cust, cust2];
      [[0x7A4A5A, 0x2A2E3A], [0x4A5E7A, 0x3A3530], [0xA88A4A, 0x2E3436]].forEach(([sh, pa]) => {
        const p = makePerson({ shirt: sh, pants: pa, cap: false }); p.scale.setScalar(1.2); scene.add(p); customers.push(p);
      });

      /* ---------- the shop cats ----------
         A bonded pair — a black tuxedo and a white-and-grey. After dark they play out on
         the apron in front of the bays: one bolts, the other gives chase, a pounce turns
         into a tussle or a role swap, and now and then they sit together and wait. By day,
         while Sean works, they sleep — on the tool chest, up the carton stack, on the
         bench, the stool, a patch of sun by the door, or the first car in the east row:
         its roof, its warm hood, or underneath it. Each keeps its own clock, so they come
         and go, and the second one usually follows the first. Rain sends them indoors at
         any hour, and a car on the move scatters anything on the ground near it. */
      function makeCat(o) {
        const g = new THREE.Group();
        // rig pivots about the rear hips (z -0.14) so sitting tips the front up, not the tail.
        const rig = new THREE.Group(); rig.position.z = -0.14; g.add(rig);
        const R0 = new THREE.Group(); R0.position.z = 0.14; rig.add(R0);
        const fur = (w, h, d, c, x, y, z, parent) => {
          const m = box(w, h, d, c, { roughness: 0.95 }); at(m, x, y, z); (parent || R0).add(m); return m;
        };
        fur(0.16, 0.15, 0.40, o.coat, 0, 0.2, 0);
        if (o.bib) fur(0.12, 0.11, 0.05, o.bib, 0, 0.18, 0.185);
        if (o.saddle) fur(0.166, 0.05, 0.24, o.saddle, 0, 0.255, -0.04);
        const head = new THREE.Group(); at(head, 0, 0.3, 0.23); R0.add(head);
        fur(0.15, 0.13, 0.13, o.coat, 0, 0, 0, head);
        if (o.cap) fur(0.156, 0.045, 0.136, o.cap, 0, 0.05, 0, head);
        fur(0.08, 0.05, 0.04, o.muzzle, 0, -0.03, 0.075, head);
        [-1, 1].forEach(sd => { const e = fur(0.045, 0.06, 0.025, o.ear, sd * 0.045, 0.085, -0.01, head); e.rotation.z = -sd * 0.3; });
        const eyeMat = new THREE.MeshBasicMaterial({ color: 0x8A9A44, toneMapped: false });
        const eyes = [-1, 1].map(sd => {
          const e = new THREE.Mesh(boxGeo(0.026, 0.018, 0.01), eyeMat);
          at(e, sd * 0.036, 0.012, 0.066); e.castShadow = false; head.add(e); return e;
        });
        const legs = [[-0.05, 0.15], [0.05, 0.15], [-0.05, -0.14], [0.05, -0.14]].map(([x, z]) => {
          const p = new THREE.Group(); at(p, x, 0.14, z); R0.add(p);
          const l = box(0.045, 0.14, 0.05, o.coat); at(l, 0, -0.07, 0); l.castShadow = false; p.add(l);
          const paw = box(0.05, 0.03, 0.065, o.paw); at(paw, 0, -0.13, 0.012); paw.castShadow = false; p.add(paw);
          return p;
        });
        const tail = new THREE.Group(); at(tail, 0, 0.25, -0.19); R0.add(tail);
        fur(0.035, 0.035, 0.17, o.tail, 0, 0, -0.085, tail);
        const tail2 = new THREE.Group(); at(tail2, 0, 0, -0.17); tail.add(tail2);
        fur(0.032, 0.032, 0.16, o.tailTip || o.tail, 0, 0, -0.08, tail2);
        // Real-cat scale (1.0) is ~2 px from the diorama camera; 1.4 keeps them readable.
        g.scale.setScalar(1.4);
        g.userData = { rig, R0, head, eyes, eyeMat, legs, tail, tail2 };
        return g;
      }
      const CAT_POSES = {
        stand:  { y: 0,      p: 0,     hp: 0.05, hy: 0,   tl: 0.9,  tc: 0,   t2: 0,   t2x: 0.5 },
        crawl:  { y: -0.11,  p: 0,     hp: 0.35, hy: 0,   tl: 0.05, tc: 0,   t2: 0,   t2x: 0 },
        sit:    { y: -0.04,  p: -0.55, hp: -0.1, hy: 0,   tl: 0.45, tc: 1.3, t2: 0.9, t2x: 0 },
        sleep:  { y: -0.125, p: 0,     hp: 0.5,  hy: 0.9, tl: -0.05, tc: 1.7, t2: 1.1, t2x: 0 },
        crouch: { y: -0.07,  p: 0.08,  hp: -0.15, hy: 0,  tl: 0.15, tc: 0,   t2: 0,   t2x: 0 },
      };
      const CAT_ZONE = { x0: 1.5, x1: 14.4, z0: -1.25, z1: 4.6 };
      /* Waypoint graph round the buildings. A cat walks nearest-node → … → nearest-node →
         goal, so it goes round the row to the back pad instead of through the wall, and
         enters the bay by the door. */
      const CAT_NODES = [
        [9.0, 1.5],      // 0 apron
        [13.8, -0.8],    // 1 east corner — the strip between the wall (13.45) and the parked noses (14.1)
        [13.8, -16.6],   // 2 behind the east corner
        [0.0, -17.2],    // 3 rear pad
        [-14.2, -16.6],  // 4 behind the west corner
        [-15.3, -13.5],  // 5 back of the gap between the two blocks
        [-15.3, -0.6],   // 6 front of the gap
        [-26.0, -0.6],   // 7 the neighbours' walk
        [-41.0, -3.0],   // 8 the side lot
        [22.0, -6.0],    // 9 east lot aisle
        [31.5, -5.0],    // 10 storage walk
        [10.6, -1.3],    // 11 bay door
        [10.45, -5.0],   // 12 inside, right-hand strip
        [10.45, -11.0],  // 13 inside, back
        [20.5, 3.5],     // 14 exit drive
        [19.6, -13.6],   // 15 clear of the last parked car's tail, on the way to the lot
        [0.0, -22.5],    // 16 the grass, middle
        [-20.0, -22.5],  // 17 grass, west
        [20.0, -22.5],   // 18 grass, east
      ];
      const CAT_EDGES = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 0], [6, 7], [7, 8],
                         [1, 9], [9, 10], [2, 15], [15, 9], [3, 16], [4, 17], [2, 18], [16, 17], [16, 18], [0, 11], [11, 12], [12, 13], [1, 14], [14, 9]];
      const catAdj = CAT_NODES.map(() => []);
      CAT_EDGES.forEach(([a, b]) => {
        const d = Math.hypot(CAT_NODES[a][0] - CAT_NODES[b][0], CAT_NODES[a][1] - CAT_NODES[b][1]);
        catAdj[a].push([b, d]); catAdj[b].push([a, d]);
      });
      // Which enclosed region a point is in: 1 = inside Sean's bay, 0 = outdoors. A bay
      // point must snap to a bay node, otherwise a cat beside the east wall snaps to the
      // corner node outside and walks straight through the blockwork to reach it.
      const catRegion = (x, z) => (catInBay(x, z) ? 1 : 0);
      const catNearest = (x, z) => {
        const reg = catRegion(x, z);
        let best = -1, bd = Infinity;
        CAT_NODES.forEach((n, i) => {
          if (catRegion(n[0], n[1]) !== reg) return;
          const d = Math.hypot(n[0] - x, n[1] - z); if (d < bd) { bd = d; best = i; }
        });
        return best < 0 ? 0 : best;
      };
      function catGraphPath(a, b) {
        const dist = CAT_NODES.map(() => Infinity), prev = CAT_NODES.map(() => -1), done = CAT_NODES.map(() => false);
        dist[a] = 0;
        for (;;) {
          let u = -1, ud = Infinity;
          for (let i = 0; i < dist.length; i++) if (!done[i] && dist[i] < ud) { ud = dist[i]; u = i; }
          if (u < 0 || u === b) break;
          done[u] = true;
          catAdj[u].forEach(([v, w]) => { if (dist[u] + w < dist[v]) { dist[v] = dist[u] + w; prev[v] = u; } });
        }
        const out = [];
        for (let v = b; v !== -1; v = prev[v]) out.unshift(v);
        return out;
      }
      const catInBay = (x, z) => z < -1.9 && x > 5 && x < 13;
      // climb: ground entry first, then each hop/walk up to the perch. Bay routes stay on
      // the strip right of the lane (x 10.45) so they never cross a car parked in the bay.
      const STALLS = [-3.2, -6.8, -10.4].map((z, k) => ({ k, x: 16.45, z, door: [16.6, z + 1.6], job: null }));
      const stallOk = sp => sp.stall == null || (STALLS[sp.stall].job && STALLS[sp.stall].job.state === 'parked');
      const CAT_SPOTS = [
        // The three east-wall stalls hold customers' cars waiting their turn (see the job
        // director). A spot tagged with a stall only exists while a car is parked in it.
        // The first stall by the door is the customers' waiting bay now, so the cats use
        // the far car in the row (z -10.4) — nobody drives that one away under them.
        { id: 'roof', stall: 2, safe: true, outdoor: true, climb: [[14.5, 0, -8.75], [14.85, 0.97, -9.9], [16.0, 1.54, -10.2]],
          slots: [[16.4, 1.54, -10.15, 1.5], [16.95, 1.54, -10.65, -1.7]] },
        { id: 'hood', stall: 2, safe: true, outdoor: true, climb: [[14.5, 0, -8.75], [14.85, 0.97, -9.9]],
          slots: [[14.8, 0.97, -10.25, 0.4], [15.15, 0.97, -10.8, 2.8]] },
        { id: 'under', stall: 2, safe: true, outdoor: true, crawl: true, climb: [[16.4, 0, -8.7], [16.4, 0, -9.7]],
          slots: [[16.55, 0, -10.2, -1.4], [15.95, 0, -10.7, 1.6]] },
        { id: 'chest', safe: true, climb: [[10.45, 0, -9.3], [11.85, 1.15, -9.8]],
          slots: [[12.1, 1.15, -9.8, 1.6]] },
        { id: 'cartons', safe: true, climb: [[10.45, 0, -11.7], [11.15, 0.72, -12.0]],
          slots: [[11.9, 1.44, -11.0, 0.7], [11.2, 0.72, -12.05, -0.8]] },
        { id: 'stool', safe: true, climb: [[10.3, 0, -5.4]], slots: [[11.0, 0.67, -4.9, 0.6]] },
        { id: 'bench', safe: true, climb: [[10.45, 0, -10.6], [7.3, 0, -10.9], [6.0, 0.9, -10.7]],
          slots: [[5.95, 0.9, -10.3, 0.1], [5.95, 0.9, -11.0, 3.0]] },
        { id: 'sun', outdoor: true, sunny: true, climb: [[12.3, 0, -0.6]],
          slots: [[12.45, 0, -0.95, 1.3], [12.95, 0, -0.6, -2.0]] },
        // Visible from the camera in any dry weather: the second east-row car, the stoop
        // beside the open door, and the kerb strip across the lot.
        { id: 'roof2', stall: 1, safe: true, outdoor: true, climb: [[14.5, 0, -5.15], [14.85, 0.97, -6.3], [16.0, 1.54, -6.6]],
          slots: [[16.4, 1.54, -6.55, 1.5], [16.95, 1.54, -7.05, -1.7]] },
        // West of the door opening, clear of the bay lane (x 7.8–10.2) the car drives through.
        { id: 'stoop', outdoor: true, climb: [[6.6, 0, -0.4]],
          slots: [[6.2, 0, -0.9, 0.9], [6.85, 0, -1.0, -2.2]] },
        // Just inside the door, on the right-hand strip clear of the bay lane — dry, and in
        // plain view through the lit opening, so rainy days still show the pair.
        { id: 'mat', visible: true, climb: [[11.4, 0, -1.6]],
          slots: [[11.55, 0, -2.45, 1.2], [12.1, 0, -2.75, -2.4]] },
        { id: 'crate', visible: true, climb: [[12.0, 0, -1.6], [12.2, 0, -2.6]],
          slots: [[12.45, 0.42, -2.95, -1.6]] },
        { id: 'kerb', outdoor: true, climb: [[24.6, 0, -4.5]],
          slots: [[25.2, 0, -5.2, 0.2], [25.2, 0, -5.75, 3.0]] },
        { id: 'warmbed', visible: true, warm: true, climb: [[10.9, 0, -4.3]],
          slots: [[12.0, 0.18, -4.15, 2.6], [12.25, 0.18, -4.5, -0.6]] },
        // Her meeting spots: out front of the neighbours' doors and beside Sean's opening.
        { id: 'greetParts', outdoor: true, greet: true, climb: [[-25.2, 0, -1.0]], slots: [[-25.3, 0, -1.6, 2.6]] },
        { id: 'greetTire', outdoor: true, greet: true, climb: [[-31.4, 0, -1.0]], slots: [[-31.6, 0, -1.5, 2.9]] },
        { id: 'greetBay', outdoor: true, greet: true, climb: [[12.6, 0, -0.4]], slots: [[12.9, 0, -1.2, 2.8]] },
        { id: 'greetBayW', outdoor: true, greet: true, climb: [[5.4, 0, -0.4]], slots: [[5.2, 0, -1.2, -2.8]] },
        // Their own tower on the rear pad behind Sean's unit: a roofed house at the bottom
        // (dry — a rain refuge), a middle shelf and a top perch. 'home' spots are the
        // night-time bed; by day they're one more option among the rest.
        { id: 'towerTop', home: true, safe: true, outdoor: true,
          climb: [[11.6, 0, -17.6], [11.6, 0.95, -16.7], [11.6, 1.55, -16.2]],
          slots: [[11.6, 1.55, -16.2, Math.PI]] },
        { id: 'towerMid', home: true, safe: true, outdoor: true,
          climb: [[11.6, 0, -17.6], [11.6, 0.95, -16.7]],
          slots: [[11.6, 0.95, -16.55, Math.PI]] },
        { id: 'towerHouse', home: true, safe: true, crawl: true,
          climb: [[11.6, 0, -17.4], [11.6, 0, -16.85]],
          slots: [[11.55, 0.09, -16.18, 0.5]] },
      ];
      { // the tower itself
        const tw = new THREE.Group();
        // The house is a hollow shell: the side that faces the camera (+x, toward the east
        // lot) is a glass pane, so a cat curled up inside is on show. The way in is a
        // doorway in the back-facing end (-z), on the climb route from the pad.
        const wood = { roughness: 0.95 };
        tw.add(at(box(1.0, 0.04, 0.9, 0x4A3A2C, wood), 0, 0.02, 0));                 // floor
        // Pieces butt together rather than overlap, and stand on the floor and stop just
        // under the lid: shared, coplanar faces z-fought (flickered) whenever the camera moved.
        tw.add(at(box(0.08, 0.5, 0.9, 0x5A4636, wood), -0.46, 0.29, 0));             // back wall (toward the shop)
        tw.add(at(box(0.88, 0.5, 0.08, 0x5A4636, wood), 0.02, 0.29, 0.41));          // +z end (stops short of the glass)
        tw.add(at(box(0.26, 0.5, 0.08, 0x5A4636, wood), -0.29, 0.29, -0.41));        // -z end, door's left
        tw.add(at(box(0.30, 0.5, 0.08, 0x5A4636, wood), 0.31, 0.29, -0.41));         // -z end, door's right
        tw.add(at(box(0.32, 0.15, 0.08, 0x5A4636, wood), 0, 0.465, -0.41));          // door header
        const glass = new THREE.Mesh(boxGeo(0.03, 0.5, 0.86),
          new THREE.MeshStandardMaterial({ color: 0xBFD8E6, transparent: true, opacity: 0.28, roughness: 0.08, metalness: 0.3, depthWrite: false }));
        at(glass, 0.485, 0.29, 0); glass.castShadow = false; tw.add(glass);
        [[0.485, 0.285, -0.425], [0.485, 0.285, 0.425]].forEach(([px, py, pz]) => tw.add(at(box(0.036, 0.49, 0.036, 0x3A3028), px, py, pz)));
        tw.add(at(box(0.036, 0.025, 0.84, 0x3A3028), 0.487, 0.522, 0));               // glazing frame
        const cushion = cyl(0.3, 0.3, 0.05, 14, 0x8A3A34, { roughness: 1 }); at(cushion, -0.05, 0.065, 0.02); tw.add(cushion);
        const lid = box(1.08, 0.08, 0.98, 0x3A3028); at(lid, 0, 0.59, 0); tw.add(lid);
        const post = cyl(0.075, 0.075, 1.0, 10, 0xB89B6A, { roughness: 1 }); at(post, 0.28, 1.1, 0.22); tw.add(post);
        const post2 = cyl(0.06, 0.06, 0.45, 10, 0xB89B6A, { roughness: 1 }); at(post2, -0.3, 0.85, -0.25); tw.add(post2);
        const mid = box(0.7, 0.06, 0.6, 0x6B5A4A, { roughness: 1 }); at(mid, -0.05, 0.95, -0.3); tw.add(mid);
        const top = box(0.62, 0.06, 0.56, 0x6B5A4A, { roughness: 1 }); at(top, 0.0, 1.55, 0.0); tw.add(top);
        const lip = box(0.6, 0.14, 0.05, 0x5A4A3C); at(lip, 0, 1.64, 0.26); tw.add(lip);
        // A lean-to off the back wall keeps rain and snow off the whole tower.
        // Glazed, so the top perch stays in view from the camera. A thin frame carries it.
        const awn = new THREE.Mesh(boxGeo(2.0, 0.03, 1.9), new THREE.MeshPhysicalMaterial({
          color: 0xBFD3DF, transparent: true, opacity: 0.22, roughness: 0.08, metalness: 0,
          transmission: 0, side: THREE.DoubleSide, depthWrite: false }));
        at(awn, 0, 2.15, -0.25); awn.rotation.x = 0.1; awn.castShadow = false; awn.receiveShadow = false; tw.add(awn);
        [[0, 0.7], [0, -1.2]].forEach(([px, pz]) => { const r = box(2.0, 0.05, 0.06, 0x3A3028); at(r, px, 2.15 + (pz + 0.25) * -0.1, pz); r.rotation.x = 0.1; tw.add(r); });
        [[-0.98, -0.25], [0.98, -0.25]].forEach(([px, pz]) => { const r = box(0.06, 0.05, 1.9, 0x3A3028); at(r, px, 2.15, pz); r.rotation.x = 0.1; tw.add(r); });
        [[-0.9, -1.1], [0.9, -1.1]].forEach(([px, pz]) => { tw.add(at(cyl(0.04, 0.04, 2.0, 8, 0x5E574E), px, 1.03, pz)); });
        // A string of warm bulbs slung round the awning's three open edges, sagging a
        // little between fixings. Bulbs are glow planes so they come up with the lamps.
        const bulbMat = new THREE.MeshBasicMaterial({ color: 0xFFD08A, transparent: true, opacity: 0.9 });
        const strandMat = mat(0x2A2622, { roughness: 1 });
        // One continuous string: up the left leg, round the three open edges, down the right.
        const run = [[-0.94, 0.05, -1.1], [-0.94, 2.08, -1.1], [-0.98, 2.08, 0.7], [-0.98, 2.08, -1.2],
                     [0.98, 2.08, -1.2], [0.98, 2.08, 0.7], [0.94, 2.08, -1.1], [0.94, 0.05, -1.1]];
        for (let e = 0; e < run.length - 1; e++) {
          const [ax, ay, az] = run[e], [bx, by, bz] = run[e + 1];
          const L = Math.hypot(bx - ax, by - ay, bz - az), nb = Math.max(1, Math.round(L / 0.32));
          const vertical = Math.abs(by - ay) > 0.5;
          // Legs: spiral-wrap the post. Edges: sag between fixings.
          const pt = u => {
            if (vertical) {
              const a2 = u * Math.PI * 7, sx = Math.sign(ax) || 1;
              return [ax + Math.cos(a2) * 0.065 - sx * 0.02, ay + (by - ay) * u, az + Math.sin(a2) * 0.065];
            }
            return [ax + (bx - ax) * u, ay - Math.sin(u * Math.PI) * 0.09, az + (bz - az) * u];
          };
          const steps = vertical ? nb * 6 : nb;
          for (let k = 0; k <= steps; k++) {
            const u = k / steps, [x, y, z] = pt(u);
            if (!vertical || k % 6 === 0) {
              const bulb = new THREE.Mesh(boxGeo(0.045, 0.07, 0.045), bulbMat);
              at(bulb, x, y - 0.035, z); bulb.castShadow = false; tw.add(bulb);
            }
            if (k < steps) {
              const [x2, y2, z2] = pt((k + 1) / steps);
              const seg = new THREE.Mesh(boxGeo(0.012, 0.012, Math.hypot(x2 - x, y2 - y, z2 - z)), strandMat);
              at(seg, (x + x2) / 2, (y + y2) / 2, (z + z2) / 2); seg.lookAt(tw.localToWorld(new THREE.Vector3(x2, y2, z2)));
              seg.castShadow = false; tw.add(seg);
            }
          }
        }
        addGlow({ material: bulbMat }, 0.9);
        addLamp(at(new THREE.PointLight(0xFFD08A, 4, 4.5, 2), 11.6, 1.9, -16.5), 4);
        tw.position.set(11.6, 0.03, -16.2);
        scene.add(tw);
        catTowerObj = tw;
      }
      CAT_SPOTS.forEach(sp => (sp.occ = sp.slots.map(() => null)));
      { const crate = box(0.6, 0.42, 0.5, 0x5C4A36, { roughness: 0.9 }); at(crate, 12.45, 0.21, -2.95); scene.add(crate);
        const mat = slab(0.9, 0.7, 0x3A3F44, 0.012); mat.position.set(11.8, 0.012, -2.6); scene.add(mat); }
      // Winter quarters: a padded bed by the right wall with a little space heater beside
      // it. The element only glows when it's actually cold out.
      const heaterGlow = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.14),
        new THREE.MeshBasicMaterial({ color: 0xFF7A2A, transparent: true, opacity: 0 }));
      const heaterLight = new THREE.PointLight(0xFF7A2A, 0, 3.2, 2);
      { const bed = cyl(0.5, 0.46, 0.14, 16, 0x6B4A3A, { roughness: 1 }); at(bed, 12.1, 0.07, -4.3); scene.add(bed);
        const pad = cyl(0.36, 0.36, 0.04, 16, 0xB8A48C, { roughness: 1 }); at(pad, 12.1, 0.16, -4.3); scene.add(pad);
        const htr = box(0.34, 0.42, 0.22, 0x2A2A2E); at(htr, 12.7, 0.21, -5.1); scene.add(htr);
        at(heaterGlow, 12.56, 0.22, -5.1); heaterGlow.rotation.y = -Math.PI / 2; heaterGlow.castShadow = false; scene.add(heaterGlow);
        at(heaterLight, 12.3, 0.4, -5.0); scene.add(heaterLight); }
      /* ---------- critters in the grass ----------
         Field mice and a couple of ground birds in the grass behind the row. They potter,
         freeze, dart; a cat within a couple of metres sends them bolting, and a caught
         one goes to ground and turns up again elsewhere a while later. */
      const CRIT_ZONE = { x0: -30, x1: 30, z0: -31, z1: -20.8 };
      const critPt = () => [CRIT_ZONE.x0 + Math.random() * (CRIT_ZONE.x1 - CRIT_ZONE.x0),
                            CRIT_ZONE.z0 + Math.random() * (CRIT_ZONE.z1 - CRIT_ZONE.z0)];
      const critters = [];
      for (let i = 0; i < 5; i++) {
        const bird = i >= 3;
        const g = new THREE.Group();
        if (bird) {
          const body = box(0.12, 0.1, 0.18, 0x5A4A3C); at(body, 0, 0.1, 0); g.add(body);
          const head = box(0.08, 0.07, 0.08, 0x4A3C30); at(head, 0, 0.17, 0.1); g.add(head);
          const beak = box(0.025, 0.02, 0.05, 0xC9A227); at(beak, 0, 0.16, 0.16); beak.castShadow = false; g.add(beak);
          const tailf = box(0.07, 0.02, 0.1, 0x3A2E24); at(tailf, 0, 0.12, -0.12); tailf.castShadow = false; g.add(tailf);
        } else {
          const body = box(0.08, 0.06, 0.14, 0x7A6A58); at(body, 0, 0.04, 0); g.add(body);
          const ear = box(0.07, 0.03, 0.02, 0x8C7A66); at(ear, 0, 0.08, 0.05); ear.castShadow = false; g.add(ear);
          const tail = box(0.012, 0.012, 0.12, 0xB09A86); at(tail, 0, 0.03, -0.12); tail.castShadow = false; g.add(tail);
        }
        const p = critPt(); g.position.set(p[0], 0.05, p[1]);
        scene.add(g);
        critters.push({ g, bird, x: p[0], z: p[1], tx: p[0], tz: p[1], h: 0, wait: Math.random() * 3, hidden: 0, spd: bird ? 1.6 : 1.1, ph: Math.random() * 9 });
      }
      function stepCritters(dt, T) {
        critters.forEach(cr => {
          if (cr.hidden > 0) {
            cr.hidden -= dt;
            if (cr.hidden <= 0) { const p = critPt(); cr.x = cr.tx = p[0]; cr.z = cr.tz = p[1]; cr.g.visible = true; }
            return;
          }
          // Nearest hunting cat on the ground
          let threat = null, td = 9;
          cats.forEach(c => { const d = Math.hypot(c.g.position.x - cr.x, c.g.position.z - cr.z); if (d < td && c.y < 0.3) { td = d; threat = c; } });
          // A cat creeping low gets much closer before it's noticed.
          const sneaky = threat && threat.act === 'stalk' && !threat.pounce;
          if (threat && td < (sneaky ? 0.75 : 1.7)) {
            const ax = cr.x - threat.g.position.x, az = cr.z - threat.g.position.z, n = Math.hypot(ax, az) || 1;
            cr.tx = cr.x + ax / n * 2.5 + (Math.random() - 0.5); cr.tz = cr.z + az / n * 2.5 + (Math.random() - 0.5);
            cr.tx = Math.min(CRIT_ZONE.x1, Math.max(CRIT_ZONE.x0, cr.tx)); cr.tz = Math.min(CRIT_ZONE.z1, Math.max(CRIT_ZONE.z0, cr.tz));
            cr.wait = 0; cr.flee = 1;
            if (cr.bird && td < 0.9 && !cr.fly) { cr.fly = 1.0; cr.hidden = 25 + Math.random() * 30; }
          }
          if (cr.fly) {
            // A startled bird goes up and away, then is simply gone for a while.
            cr.fly -= dt;
            cr.g.position.y += dt * 2.2; cr.x += (cr.tx - cr.x) * dt * 2; cr.z += (cr.tz - cr.z) * dt * 2;
            cr.g.position.x = cr.x; cr.g.position.z = cr.z;
            if (cr.fly <= 0) { cr.fly = 0; cr.g.visible = false; cr.g.position.y = 0.05; }
            return;
          }
          const dx = cr.tx - cr.x, dz = cr.tz - cr.z, d = Math.hypot(dx, dz);
          if (d < 0.05) {
            cr.wait -= dt;
            if (cr.wait <= 0) {
              const r = cr.bird ? 1.2 : 0.8;
              cr.tx = Math.min(CRIT_ZONE.x1, Math.max(CRIT_ZONE.x0, cr.x + (Math.random() - 0.5) * 2 * r));
              cr.tz = Math.min(CRIT_ZONE.z1, Math.max(CRIT_ZONE.z0, cr.z + (Math.random() - 0.5) * 2 * r));
              cr.wait = 0.8 + Math.random() * 3; cr.flee = 0;
            }
          } else {
            const sp = cr.spd * (cr.flee ? 2.4 : 1), st = Math.min(d, sp * dt);
            cr.x += dx / d * st; cr.z += dz / d * st; cr.h = Math.atan2(dx, dz);
            cr.ph += dt * 14;
          }
          cr.g.position.x = cr.x; cr.g.position.z = cr.z; cr.g.rotation.y = cr.h;
          cr.g.position.y = 0.05 + (cr.bird && d > 0.05 ? Math.abs(Math.sin(cr.ph)) * 0.04 : 0);
        });
      }
      const W_ = 0xE6E3DC;
      const cats = [
        makeCat({ coat: 0x18181C, bib: W_, muzzle: W_, paw: W_, ear: 0x18181C, tail: 0x18181C }),
        makeCat({ coat: 0xE4E1DA, saddle: 0x7E8186, cap: 0x7E8186, muzzle: 0xF2F0EA, paw: 0xF2F0EA,
                  ear: 0x7E8186, tail: 0x7E8186, tailTip: 0xE4E1DA }),
      ].map((g, i) => {
        scene.add(g);
        return { g, i, y: 0, h: 0, path: [], jump: null, act: 'idle', pose: 'stand', speed: 1, ph: i * 1.3,
                 // i 0: the tuxedo — she's the sociable explorer. i 1: her brother, the white
                 // one — skittish, keeps near her and near home, soft spot for Sean.
                 shy: i === 1, greeted: new Map(),
                 gait: 0, wait: 0, timer: 0, pause: 0, hold: 0, flee: 0, repath: 0, face: null,
                 res: null, perch: null, climbIdx: 0, crawl: false, then: null,
                 ps: Object.assign({}, CAT_POSES.stand) };
      });
      cats[0].mate = cats[1]; cats[1].mate = cats[0];
      const angTo = (a, b, k) => {
        const d = ((b - a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
        return a + d * Math.min(1, k);
      };
      const zonePt = () => [CAT_ZONE.x0 + Math.random() * (CAT_ZONE.x1 - CAT_ZONE.x0),
                            CAT_ZONE.z0 + Math.random() * (CAT_ZONE.z1 - CAT_ZONE.z0)];
      const catRelease = c => { if (c.res) { c.res.spot.occ[c.res.k] = null; c.res = null; } };
      function catExit(c) {
        if (!c.perch) return [];
        const sp = c.perch, out = [];
        for (let i = c.climbIdx; i >= 0; i--) out.push({ x: sp.climb[i][0], y: sp.climb[i][1], z: sp.climb[i][2], crawl: !!sp.crawl });
        c.perch = null;
        return out;
      }
      function catRoute(pts, c, bx, bz) {
        const last = pts.length ? pts[pts.length - 1] : { x: c.g.position.x, z: c.g.position.z };
        const a = catNearest(last.x, last.z), b = catNearest(bx, bz);
        if (a !== b) {
          const nodes = catGraphPath(a, b);
          nodes.forEach((n, i) => {
            const p = CAT_NODES[n];
            if (i === 0 && Math.hypot(p[0] - last.x, p[1] - last.z) < 1.2) return;
            pts.push({ x: p[0], y: 0, z: p[1] });
          });
        } else if (catRegion(last.x, last.z) === 1) {
          // Same bay node both ends: route via the right-hand strip so the straight line
          // between two interior points never clips the wall or the car in the lane.
          const sameSide = (last.x > 10.2) === (bx > 10.2);
          if (!sameSide) pts.push({ x: 10.45, y: 0, z: (last.z + bz) / 2 });
        }
        pts.push({ x: bx, y: 0, z: bz });
        return pts;
      }
      function catToSleep(c, home) {
        catRelease(c);
        const wet = catRain(), cold = catCold();
        const sunny = !wet && WEATHER.precip === 'none' && WEATHER.cloud < 0.6 && dayState.lamp < 0.2;
        let ok = CAT_SPOTS.filter(sp => sp.occ.some(o => !o) && !sp.greet && stallOk(sp) && (!sp.sunny || sunny)
                                        && (!wet || !sp.outdoor) && (!cold || !sp.outdoor || sp.home));
        // In the rain he'll take the glazed house or Sean's bay, but not the open shelves.
        if (wet && c.shy) ok = ok.filter(sp => !sp.home || sp.id === 'towerHouse');
        if (home) { const h = ok.filter(sp => sp.home); if (h.length) ok = h; }
        else if (dayState.lamp < 0.5 && !c.shy) ok = ok.filter(sp => !sp.home || Math.random() < 0.3);
        if (!ok.length) ok = CAT_SPOTS.filter(sp => sp.occ.some(o => !o) && !sp.greet && stallOk(sp));
        const ms = c.mate.res && c.mate.res.spot;
        let sp = (ms && ok.includes(ms) && Math.random() < 0.65) ? ms : null;
        if (!sp) {
          const fresh = ok.filter(o => o !== c.perch);
          const pool = fresh.length ? fresh : ok;
          // Indoor perches sit under the bay roof, out of the camera's sight — weight the
          // visible ones heavily so the pair is usually on show by day.
          const w = pool.map(o => {
            let k = o.outdoor || o.visible ? 3 : 0.5;
            if (c.shy && (o.id === 'roof' || o.id === 'hood' || o.id === 'under' || o.id === 'roof2' || o.sunny)) k *= 2.5;
            // Fair weather: he'd rather be out on the catio than shut in the bay.
            if (c.shy && !wet && !cold) { if (o.home) k *= 4; else if (!o.outdoor) k *= 0.35; }
            if (cold && o.warm) k *= 6;
            if (cold && o.home && o.id !== 'towerHouse') k *= 0.3;
            return k;
          });
          let r = Math.random() * w.reduce((a, b) => a + b, 0);
          sp = pool.find((o, i) => (r -= w[i]) <= 0) || pool[0];
        }
        const k = sp.occ.findIndex(o => !o);
        sp.occ[k] = c; c.res = { spot: sp, k };
        const pts = catRoute(catExit(c), c, sp.climb[0][0], sp.climb[0][2]);
        const tail = pts[pts.length - 1];
        tail.cb = () => { c.perch = sp; c.climbIdx = 0; };
        for (let i = 1; i < sp.climb.length; i++) {
          const q = sp.climb[i];
          pts.push({ x: q[0], y: q[1], z: q[2], crawl: !!sp.crawl, cb: () => { c.climbIdx = i; } });
        }
        const sl = sp.slots[k];
        pts.push({ x: sl[0], y: sl[1], z: sl[2], crawl: !!sp.crawl, cb: () => { c.climbIdx = sp.climb.length - 1; } });
        c.path = pts; c.act = 'go'; c.speed = 0.85;
        c.then = () => { c.act = 'sleep'; c.pose = 'sleep'; c.face = sl[3]; c.timer = 180 + Math.random() * 1020; };   // a proper nap: 3–20 minutes
      }
      const SEAN_PET = { cat: null, x: 0, z: 0, y: 0 };
      function catToPlay(c) {
        catRelease(c);
        const m = c.mate;
        let q = zonePt();
        if (m.act === 'lead' || m.act === 'chase') q = [m.g.position.x + (Math.random() - 0.5) * 2, m.g.position.z + 1.2];
        q[0] = Math.min(CAT_ZONE.x1, Math.max(CAT_ZONE.x0, q[0])); q[1] = Math.min(CAT_ZONE.z1, Math.max(CAT_ZONE.z0, q[1]));
        c.path = catRoute(catExit(c), c, q[0], q[1]); c.act = 'go'; c.speed = 1.3;
        c.then = () => {
          if (m.act === 'lead') { c.act = 'chase'; c.hold = 0.4; }
          else { c.act = 'lead'; c.pause = 0.8; }
          // The other one, if it's loafing about nearby, is fair game to be roped in.
          if ((m.act === 'linger' || m.act === 'idle') && m.mode !== 'play' && Math.random() < 0.5) {
            m.path.length = 0; m.then = null; m.mode = 'play'; m.modeT = 20 + Math.random() * 30;
            m.act = 'chase'; m.hold = 0.6; catRelease(m);
          }
        };
      }
      // Somewhere worth a look. All off the road, and nothing inside a building footprint.
      const CAT_HAUNTS = [[-30, -0.6], [-40, -6], [-15.3, -7], [-6, -17.6], [4, -18.4], [-20, -15],
                          [20.5, 2.5], [22, -7.5], [31.2, -9], [16, -13.5], [-2, 3.2], [24.5, 6.4], [-36.5, 1.5]];
      // His world: the shop, its lots, the tower and the grass directly behind.
      const HOME_R = 15, HOME_C = [11, -8];
      const nearHome = (x, z) => Math.hypot(x - HOME_C[0], z - HOME_C[1]) < HOME_R;
      function catToExplore(c) {
        catRelease(c);
        const n = 2 + Math.floor(Math.random() * 3);
        let pts = catExit(c);
        let last = pts.length ? [pts[pts.length - 1].x, pts[pts.length - 1].z] : [c.g.position.x, c.g.position.z];
        const haunts = c.shy ? CAT_HAUNTS.filter(h => nearHome(h[0], h[1])) : CAT_HAUNTS;
        // Favour haunts a fair walk away, so an exploring cat actually leaves the shop.
        for (let i = 0; i < n; i++) {
          const far = haunts.filter(h => Math.hypot(h[0] - last[0], h[1] - last[1]) > 8);
          const pool = far.length ? far : haunts;
          const h = pool[Math.floor(Math.random() * pool.length)];
          const gx = h[0] + (Math.random() - 0.5) * 2.4, gz = h[1] + (Math.random() - 0.5) * 2.4;
          pts = catRoute(pts, c, gx, gz);
          const tail = pts[pts.length - 1];
          // Linger at each: sit, or nose about low to the ground.
          tail.cb = () => { c.act = 'linger'; c.pose = Math.random() < 0.4 ? 'crouch' : 'sit';
                            c.face = Math.random() * Math.PI * 2; c.timer = 2 + Math.random() * 5; };
          last = [gx, gz];
        }
        c.path = pts; c.act = 'go'; c.speed = 1.0 + Math.random() * 0.4;
        c.then = () => catChoose(c);
      }
      function catToHunt(c) {
        catRelease(c);
        const live = critters.filter(cr => cr.g.visible && (!c.shy || Math.abs(cr.x - HOME_C[0]) < 16));
        if (!live.length) return catToExplore(c);
        const cr = live[Math.floor(Math.random() * live.length)];
        c.prey = cr;
        // Walk to the edge of the grass near it, then stalk.
        const pts = catRoute(catExit(c), c, cr.x + (Math.random() - 0.5) * 4, Math.max(cr.z + 3.5, CRIT_ZONE.z1 - 0.3));
        c.path = pts; c.act = 'go'; c.speed = 1.3; c.modeT = 30 + Math.random() * 25;
        c.then = () => { c.act = 'stalk'; c.repath = 0; };
      }
      // He tags along a few paces behind her when she's out and about.
      function catToFollow(c) {
        catRelease(c);
        const m = c.mate;
        c.path = catRoute(catExit(c), c, m.g.position.x + (Math.random() - 0.5) * 1.6, m.g.position.z + 1.4);
        c.act = 'go'; c.speed = 1.3; c.modeT = 25 + Math.random() * 25;
        c.then = () => { c.act = 'follow'; c.repath = 0; };
      }
      // She sits out front somewhere people pass, waiting to be noticed.
      function catToGreetPost(c) {
        catRelease(c);
        const posts = CAT_SPOTS.filter(sp => sp.greet && !sp.occ[0]);
        if (!posts.length) return catToExplore(c);
        const sp = posts[Math.floor(Math.random() * posts.length)];
        sp.occ[0] = c; c.res = { spot: sp, k: 0 };
        const sl = sp.slots[0];
        const pts = catRoute(catExit(c), c, sp.climb[0][0], sp.climb[0][2]);
        pts[pts.length - 1].cb = () => { c.perch = sp; c.climbIdx = 0; };
        pts.push({ x: sl[0], y: 0, z: sl[2] });
        c.path = pts; c.act = 'go'; c.speed = 1.2;
        c.then = () => { c.act = 'post'; c.pose = 'sit'; c.face = sl[3]; c.timer = 25 + Math.random() * 40; };
      }
      const PEOPLE = () => [sean, ...customers, shopper];
      // Sitting with Sean on the couch, on his left (the -z cushion). A pseudo-spot so the
      // usual exit path (catExit) brings the cat back down to the floor afterwards.
      const LAP = { cat: null };
      const COUCH_SPOT = { id: 'couch', safe: true, climb: [[6.8, 0, -14.1], [5.95, 0.42, -14.15]], slots: [[5.95, 0.42, -14.15, Math.PI / 2]] };
      function catToLap(c) {
        catRelease(c);
        LAP.cat = c;
        const pts = catRoute(catExit(c), c, COUCH_SPOT.climb[0][0], COUCH_SPOT.climb[0][2]);
        pts[pts.length - 1].cb = () => { c.perch = COUCH_SPOT; c.climbIdx = 0; };
        const q = COUCH_SPOT.climb[1];
        pts.push({ x: q[0], y: q[1], z: q[2], cb: () => { c.climbIdx = 1; } });
        c.path = pts; c.act = 'go'; c.mode = 'lap'; c.speed = 1.6; c.wait = 0;
        c.then = () => { c.act = 'lap'; c.timer = 0; c.face = Math.PI / 2; };
      }
      // Someone she hasn't said hello to lately, on foot, close enough to bother with.
      function catSpotPerson(c, range) {
        let best = null, bd = range;
        PEOPLE().forEach(f => {
          if (!f.userData.shown) return;
          const last = c.greeted.get(f) || -1e9;
          if (performance.now() / 1000 - last < 45) return;
          const d = Math.hypot(f.position.x - c.g.position.x, f.position.z - c.g.position.z);
          if (d < bd) { bd = d; best = f; }
        });
        return best;
      }
      function catToGreet(c, f) {
        catRelease(c); c.perch = null;
        c.greetee = f; c.act = 'approach'; c.path.length = 0; c.repath = 0; c.modeT = 14; c.mode = 'greet';
      }
      /* Each cat decides for itself. Night favours play and roaming with the tower as
         bed; day favours naps with a bit of roaming. Rain means a dry spot, full stop.
         They only play when the other is up for it, so the pair drift together and
         apart instead of moving as one. */
      function catChoose(c) {
        const m = c.mate, night = dayState.lamp > 0.5, wet = WEATHER.precip !== 'none';
        const mateUp = m.act === 'lead' || m.act === 'chase' || m.act === 'tussle' || m.act === 'linger'
                       || (m.act === 'go' && m.mode === 'explore');
        const cold = catCold();
        const mateOut = m.mode === 'explore' || m.mode === 'hunt' || m.act === 'linger' || m.act === 'stalk';
        let w;
        if (wet) w = { sleep: 0.6, home: c.shy ? 0.25 : 0.4, play: 0, explore: 0, hunt: 0, follow: 0, greet: 0 };
        else if (night) w = { play: mateUp ? 0.35 : 0.18, explore: 0.22, hunt: 0.4, home: 0.3, sleep: 0.05, follow: 0, greet: 0 };
        else w = { sleep: 0.3, explore: 0.2, hunt: 0.28, home: 0.1, play: mateUp ? 0.15 : 0.05, follow: 0, greet: 0 };
        if (c.shy) { w.follow = mateOut ? 0.45 : 0; w.explore *= 0.6; if (!wet && !cold) w.home *= 2.5; }
        else if (!wet) { w.greet = night ? 0.15 : 0.35; }
        if (cold && !wet) { w.sleep += 0.5; w.home *= 0.4; w.play *= 0.6; w.greet *= 0.6; }
        const keys = ['play', 'explore', 'hunt', 'follow', 'greet', 'home', 'sleep'];
        let r = Math.random() * keys.reduce((a, k) => a + w[k], 0), mode = 'sleep';
        for (const k of keys) { if ((r -= w[k]) <= 0) { mode = k; break; } }
        c.mode = mode;
        if (mode === 'play') { c.modeT = 25 + Math.random() * 35; catToPlay(c); }
        else if (mode === 'explore') catToExplore(c);
        else if (mode === 'hunt') catToHunt(c);
        else if (mode === 'follow') catToFollow(c);
        else if (mode === 'greet') catToGreetPost(c);
        else catToSleep(c, mode === 'home');
      }
      const catPlan = c => catChoose(c);
      function catInit(c) {
        catChoose(c);
        if (c.act !== 'go' || !c.then || c.mode === 'explore' || c.mode === 'play') {
          // Start mid-roam: stand wherever the first leg ends.
          const q = c.path.length ? c.path[Math.min(c.path.length - 1, 1)] : { x: 9, z: 2 };
          c.g.position.set(q.x, 0, q.z); c.y = 0;
          if (c.mode === 'play') { c.path.length = 0; c.then = null; c.act = c.i === 0 ? 'lead' : 'chase'; c.pause = 1.5; }
          return;
        }
        const last = c.path[c.path.length - 1];
        c.path.forEach(e => e.cb && e.cb());
        c.g.position.set(last.x, 0, last.z); c.y = last.y; c.path = [];
        const f = c.then; c.then = null; f(); c.h = c.face; c.ps = Object.assign({}, CAT_POSES.sleep);
        c.timer = 20 + Math.random() * c.timer;
      }
      function catMove(c, dt) {
        const pos = c.g.position;
        if (c.jump) {
          const j = c.jump; j.t += dt / j.dur;
          const u = Math.min(1, j.t), e = u * u * (3 - 2 * u);
          pos.x = j.a.x + (j.b.x - j.a.x) * e; pos.z = j.a.z + (j.b.z - j.a.z) * e;
          c.y = j.a.y + (j.b.y - j.a.y) * u + Math.sin(u * Math.PI) * j.arc;
          if (u >= 1) { c.y = j.b.y; c.jump = null; if (j.b.cb) j.b.cb(); }
          return;
        }
        if (!c.path.length) return;
        const q = c.path[0];
        const dx = q.x - pos.x, dz = q.z - pos.z, d = Math.hypot(dx, dz);
        c.crawl = !!q.crawl;
        if (Math.abs(q.y - c.y) > 0.12) {
          c.path.shift();
          if (d > 0.05) c.h = Math.atan2(dx, dz);
          c.jump = { a: { x: pos.x, y: c.y, z: pos.z }, b: q, t: 0, dur: 0.34 + d * 0.16,
                     arc: Math.max(0, q.y - c.y) * 0.35 + 0.16 };
          return;
        }
        if (d < 0.04) {
          c.path.shift();
          if (c.pounce && c.act === 'stalk') { c.act = 'linger'; c.pose = 'sit'; c.timer = 2 + Math.random() * 2; c.then = () => catToHunt(c); }
          c.pounce = false; if (q.cb) q.cb(); return;
        }
        c.h = angTo(c.h, Math.atan2(dx, dz), dt * 10);
        const st = Math.min(d, c.speed * (c.crawl ? 0.5 : 1) * dt);
        pos.x += dx / d * st; pos.z += dz / d * st;
      }
      function catThink(c, dt, T) {
        const m = c.mate, pos = c.g.position;
        if (c.wait > 0) { c.wait -= dt; if (c.wait <= 0) catPlan(c); return; }
        const dxm = m.g.position.x - pos.x, dzm = m.g.position.z - pos.z, dm = Math.hypot(dxm, dzm) || 1e-3;
        // Play sessions end on their own clock, at a calm moment.
        if ((c.act === 'lead' || c.act === 'chase') && c.mode === 'play') {
          c.modeT -= dt;
          if (c.modeT <= 0 && !c.path.length) { c.mode = null; catChoose(c); return; }
        }
        switch (c.act) {
          case 'go':
            if (!c.path.length && !c.jump) { const f = c.then; c.then = null; f ? f() : catPlan(c); }
            break;
          case 'linger':
            c.timer -= dt;
            if (c.timer <= 0) { c.act = 'go'; }
            break;
          case 'lap':
            // Sits up for the first few seconds, then curls up against him.
            c.timer += dt; c.pose = c.timer < 3 ? 'sit' : 'sleep';
            c.face = Math.PI / 2;
            break;
          case 'post': {
            // Sitting out front. Anyone walking within range gets approached.
            c.pose = 'sit'; c.timer -= dt;
            const f = catSpotPerson(c, 7);
            if (f) { catToGreet(c, f); break; }
            if (c.timer <= 0) { c.perch = null; catChoose(c); }
            break;
          }
          case 'approach': {
            const f = c.greetee;
            c.modeT -= dt;
            if (!f.userData.shown || c.modeT <= 0) { c.act = 'idle'; c.wait = 0.5; break; }
            const dx = f.position.x - pos.x, dz = f.position.z - pos.z, d = Math.hypot(dx, dz);
            if (d < 0.55) {
              c.act = 'rub'; c.timer = 4 + Math.random() * 3; c.path.length = 0; c.rubA = Math.atan2(-dx, -dz);
              c.greeted.set(f, performance.now() / 1000);
              break;
            }
            c.repath -= dt;
            if (c.repath <= 0) {
              c.repath = 0.3;
              const gx = f.position.x - dx / d * 0.4, gz = f.position.z - dz / d * 0.4;
              c.path = catRegion(pos.x, pos.z) === catRegion(gx, gz) && d < 6 ? [{ x: gx, y: 0, z: gz }] : catRoute([], c, gx, gz);
              c.speed = f.userData.moving ? 2.4 : 1.5;
            }
            break;
          }
          case 'rub': {
            // Winds round their ankles; if they're standing still they bend down to her.
            const f = c.greetee;
            c.timer -= dt; c.pose = 'stand';
            c.rubA += dt * 1.6;
            const r = 0.42;
            pos.x = f.position.x + Math.sin(c.rubA) * r; pos.z = f.position.z + Math.cos(c.rubA) * r;
            c.h = c.rubA + Math.PI / 2;
            c.face = null;
            if (!f.userData.shown || f.userData.moving) { c.timer -= dt * 2; }
            if (c.timer <= 0) { c.greetee = null; c.act = 'linger'; c.pose = 'sit'; c.timer = 1.5; c.mode = null;
                                c.path.length = 0; c.then = () => catChoose(c); c.face = Math.atan2(f.position.x - pos.x, f.position.z - pos.z); }
            break;
          }
          case 'follow': {
            c.modeT -= dt;
            if (c.modeT <= 0 || m.act === 'sleep' || m.act === 'post') { c.act = 'idle'; c.wait = 0.5; break; }
            if (dm > 2.2) {
              c.repath -= dt;
              if (c.repath <= 0) {
                c.repath = 0.6;
                c.path = catRoute([], c, m.g.position.x - dxm / dm * 1.4, m.g.position.z - dzm / dm * 1.4);
                c.speed = Math.max(1.0, Math.min(2.8, m.speed + 0.2));
              }
            } else { c.path.length = 0; c.pose = m.pose === 'crouch' ? 'crouch' : 'sit'; c.face = Math.atan2(dxm, dzm); }
            break;
          }
          case 'stalk': {
            const cr = c.prey;
            c.modeT -= dt;
            if (!cr || !cr.g.visible || c.modeT <= 0) { c.prey = null; c.act = 'idle'; c.wait = 0.5; break; }
            const dx = cr.x - pos.x, dz = cr.z - pos.z, d = Math.hypot(dx, dz);
            if (d < 0.28) {
              // Got it. A flurry of paws, then it's gone to ground.
              cr.g.visible = false; cr.hidden = 30 + Math.random() * 40; c.prey = null;
              c.act = 'tussle'; c.timer = 1.6; c.tc = { x: pos.x, z: pos.z, ax: dx / (d || 1), az: dz / (d || 1) };
              c.then = null; c.mode = null;
              break;
            }
            if (d > 12) { c.path.length = 0; c.prey = null; c.act = 'idle'; c.wait = 0.4; break; }
            // Within range: pounce, whether or not the last creep has finished.
            if (d < 1.8 && !c.pounce && Math.random() < dt * 2.5) {
              // Pounce: one bound onto it (or where it was).
              c.path = [{ x: cr.x, y: 0, z: cr.z }]; c.speed = 4.2; c.crawl = false; c.pounce = true; break;
            }
            c.repath -= dt;
            if (c.repath <= 0) {
              c.repath = 0.4;
              c.path = [{ x: cr.x - dx / d * 0.6, y: 0, z: cr.z - dz / d * 0.6, crawl: d > 1.0 }];
              c.speed = d > 4 ? 1.3 : 0.9; c.pose = 'crouch';
            }
            break;
          }
          case 'sleep':
            if (SEAN_PET.cat === c && SEAN_PET.on) {
              // Woken for a fuss: sits up and leans into Sean's hand, nap clock paused.
              c.pose = 'sit'; c.face = Math.atan2(sean.position.x - pos.x, sean.position.z - pos.z);
              break;
            }
            c.pose = 'sleep'; c.timer -= dt;
            if (c.timer <= 0) catPlan(c);
            break;
          case 'lead':
            if (!c.path.length) {
              c.pause -= dt;
              c.pose = c.pause > 0.9 ? 'sit' : 'stand';
              c.face = Math.atan2(dxm, dzm);
              if (c.pause <= 0) {
                const q = zonePt();
                c.path = [{ x: q[0], y: 0, z: q[1] }];
                c.speed = Math.random() < 0.35 ? 3.0 : 1.3 + Math.random() * 0.9;
                c.pause = 0.6 + Math.random() * 2.8;
              }
            }
            break;
          case 'chase': {
            if (c.hold > 0) { c.hold -= dt; c.pose = 'crouch'; c.path.length = 0; c.face = Math.atan2(dxm, dzm); break; }
            if (m.act !== 'lead') {
              c.path.length = 0; c.pose = 'sit'; c.face = Math.atan2(dxm, dzm);
              c.modeT -= dt * 3;   // a chase with nobody to chase fizzles out quickly
              break;
            }
            const running = m.path.length > 0;
            if (dm < 0.5 && running) {
              if (Math.random() < 0.4) {
                const cx = (pos.x + m.g.position.x) / 2, cz = (pos.z + m.g.position.z) / 2, ax = dxm / dm, az = dzm / dm;
                [c, m].forEach((k, n) => {
                  k.act = 'tussle'; k.timer = 1.4 + Math.random() * 0.8; k.path.length = 0; k.pose = 'crouch';
                  k.tc = { x: cx, z: cz, ax: n ? -ax : ax, az: n ? -az : az };
                });
                m.timer = c.timer;
              } else {
                c.act = 'lead'; c.pause = 0; c.path.length = 0;
                m.act = 'chase'; m.hold = 0.5 + Math.random() * 0.6; m.path.length = 0;
              }
            } else if (dm < 0.8 && !running) {
              c.path.length = 0; c.pose = 'sit'; c.face = Math.atan2(dxm, dzm);
            } else {
              c.repath -= dt;
              if (c.repath <= 0) {
                c.repath = 0.25;
                c.path = [{ x: m.g.position.x - dxm / dm * 0.35, y: 0, z: m.g.position.z - dzm / dm * 0.35 }];
                c.speed = Math.min(3.3, (running ? m.speed : 1.2) + 0.4);
              }
            }
            break;
          }
          case 'tussle': {
            const tc = c.tc;
            c.timer -= dt; c.pose = 'crouch';
            pos.x = tc.x - tc.ax * (0.17 + Math.sin(T * 9 + c.i * 2) * 0.05);
            pos.z = tc.z - tc.az * (0.17 + Math.sin(T * 9 + c.i * 2) * 0.05);
            c.h = Math.atan2(tc.ax, tc.az);
            if (c.timer <= 0) {
              if (m.act !== 'tussle' && c.mode !== 'play') { c.act = 'linger'; c.pose = 'sit'; c.timer = 2; c.then = () => catChoose(c); break; }
              const lead = Math.random() < 0.5 ? c : m, chase = lead === c ? m : c;
              lead.act = 'lead'; lead.pause = 0;
              if (chase.act === 'tussle') { chase.act = 'chase'; chase.hold = 0.8; }
            }
            break;
          }
        }
      }
      function catAnim(c, dt, T, lampOn) {
        const u = c.g.userData;
        const moving = c.path.length > 0 || !!c.jump;
        const key = moving ? (c.crawl ? 'crawl' : 'stand') : c.pose;
        const P = CAT_POSES[key], sp = c.ps;
        const k = Math.min(1, dt * (key === 'sleep' ? 2.2 : 7));
        for (const n in P) sp[n] += (P[n] - sp[n]) * k;
        const spd = moving && !c.jump ? c.speed : 0;
        c.gait += ((spd > 0 ? 1 : 0) - c.gait) * Math.min(1, dt * 8);
        c.ph += dt * (4 + spd * 4.2);
        const bound = c.speed > 2.2;
        const sw = Math.sin(c.ph) * Math.min(0.85, 0.35 + spd * 0.18) * c.gait;
        let pitch = sp.p + (bound ? Math.sin(c.ph) * 0.12 * c.gait : 0);
        let jl = 0;
        if (c.jump) {
          jl = Math.sin(Math.min(1, c.jump.t) * Math.PI);
          pitch = -0.35 * Math.sign(c.jump.b.y - c.jump.a.y || 1) * jl;
        }
        u.rig.rotation.x = pitch;
        u.rig.position.y = sp.y + Math.abs(Math.sin(c.ph)) * 0.014 * c.gait;
        const front = Math.max(0.06, Math.min(1.9, (0.14 + sp.y + 0.29 * Math.sin(-sp.p)) / 0.14));
        const rear = Math.max(0.06, Math.min(1, (0.14 + sp.y) / 0.14));
        u.legs.forEach((l, i) => {
          const isF = i < 2;
          let sg = bound ? (isF ? sw : -sw) : ((i === 0 || i === 3) ? sw : -sw);
          if (c.jump) sg = (isF ? -0.9 : 0.9) * jl;
          l.rotation.x = -pitch + sg;
          l.scale.y = c.jump ? 1 : (isF ? front : rear);
        });
        u.head.rotation.x = sp.hp - sp.p;
        u.head.rotation.y = sp.hy;
        const fast = c.act === 'chase' || key === 'crouch';
        const wag = Math.sin(T * (fast ? 7 : 1.6) + c.i * 2);
        const asleep = key === 'sleep';
        u.tail.rotation.x = sp.tl + (asleep ? 0 : wag * 0.08);
        u.tail.rotation.y = sp.tc + wag * (asleep ? 0.04 : 0.25);
        u.tail2.rotation.x = sp.t2x;
        u.tail2.rotation.y = sp.t2 + wag * 0.2;
        u.R0.scale.y = 1 + (asleep ? Math.sin(T * 1.7 + c.i) * 0.03 : 0);
        u.rig.rotation.z = c.act === 'tussle' ? Math.sin(T * 13 + c.i * 1.7) * 0.45 : u.rig.rotation.z * 0.8;
        u.eyes.forEach(e => (e.visible = !asleep));
        u.eyeMat.color.setHex(lampOn ? 0xDDF27A : 0x8A9A44);
        if (!moving && c.face != null && c.act !== 'tussle') c.h = angTo(c.h, c.face, dt * 4);
        c.g.position.y = c.y;
        c.g.rotation.y = c.h;
      }
      let catsStarted = false, catNight = null;
      function stepCats(dt, T, movers) {
        const lamp = dayState.lamp;
        if (!catsStarted) { catsStarted = true; catNight = lamp > 0.5; cats.forEach(c => catInit(c)); }
        // Dusk and dawn each prompt a fresh decision, at staggered moments.
        const nightNow = catNight ? lamp > 0.3 : lamp > 0.5;
        if (nightNow !== catNight) {
          catNight = nightNow;
          cats.forEach((c, i) => {
            if (c.act === 'sleep') return;   // a nap runs its course; they decide when they wake
            if (c.act === 'go' && c.mode !== 'play') return;   // finish the walk first
            c.path.length = 0; c.then = null; c.act = 'idle';
            if (c.pose !== 'sleep') c.pose = 'sit';
            c.wait = 0.6 + i * 1.8 + Math.random() * 1.5;
          });
        }
        const wetNow = catRain();
        stepCritters(dt, T);
        // Heater on when it's cold
        const heatWant = catCold() ? 1 : 0;
        heaterGlow.material.opacity += (heatWant * 0.9 - heaterGlow.material.opacity) * Math.min(1, dt * 2);
        heaterLight.intensity += (heatWant * 3 - heaterLight.intensity) * Math.min(1, dt * 2);
        cats.forEach((c, i) => {
          const inTower = c.res && c.res.spot.id === 'towerHouse';
          const outside = c.res ? c.res.spot.outdoor : !catInBay(c.g.position.x, c.g.position.z);
          const heading = c.act === 'go' && c.then && c.mode !== 'explore' && c.mode !== 'play';
          if (wetNow && c.wait <= 0 && !heading && !c.jump && outside && !inTower) {
            c.path.length = 0; c.then = null;
            c.act = 'idle'; c.pose = 'sit'; c.wait = 0.4 + i * 1.2 + Math.random();
          }
        });
        cats.forEach(c => {
          const pos = c.g.position;
          c.flee -= dt;
          const perched = c.perch && c.perch.safe && (c.act === 'sleep' || c.climbIdx > 0);
          // He keeps his distance from strangers on foot — anyone but Sean. Not a bolt,
          // a brisk withdrawal, unless he's up somewhere safe.
          if (c.shy && c.flee <= 0 && !c.jump && !perched && c.act !== 'go') {
            for (const f of [...customers, shopper]) {
              if (!f.userData.shown) continue;
              const dx = pos.x - f.position.x, dz = pos.z - f.position.z, d = Math.hypot(dx, dz);
              if (d > 4) continue;
              const n = d || 1;
              let fx = pos.x + dx / n * 4, fz = Math.min(7, pos.z + dz / n * 4);
              if (catInBay(pos.x, pos.z)) { fx = 10.45; fz = Math.min(-2.6, Math.max(-12.4, fz)); }
              else if (catInBay(fx, fz)) { fx = Math.max(fx, 14.0); }
              c.perch = null; catRelease(c);
              c.path = [{ x: fx, y: 0, z: fz }]; c.speed = 2.2; c.act = 'go'; c.mode = null; c.wait = 0;
              c.then = () => { c.act = 'idle'; c.pose = 'sit'; c.wait = 1.5 + Math.random() * 2; };
              c.flee = 2.5;
              break;
            }
          }
          if (c.flee <= 0 && !c.jump && c.y < 0.05 && !perched) {
            for (const mv of movers) {
              if (mv.v < 0.3) continue;
              const dx = pos.x - mv.p.x, dz = pos.z - mv.p.z, d = Math.hypot(dx, dz);
              // Look down the road ahead of the car, not just around it: a cat sitting in
              // the lane 8 m ahead has to go NOW, and it has to go sideways. Fleeing
              // radially from a car coming head-on just ran it further up the lane.
              const along = dx * mv.dx + dz * mv.dz;          // metres ahead of the car
              const side = dx * mv.dz - dz * mv.dx;            // metres off its centreline
              const reach = Math.max(5, mv.v * 3.2) * (c.shy ? 1.4 : 1);
              const inPath = along > -1.5 && along < reach && Math.abs(side) < (c.shy ? 2.8 : 2.0);
              if (!inPath && d > (c.shy ? 3.8 : 2.6)) continue;
              const sg = side >= 0 ? 1 : -1;
              let fx = pos.x + sg * mv.dz * 3.2 + mv.dx * 0.8 + (Math.random() - 0.5) * 0.6;
              let fz = pos.z - sg * mv.dx * 3.2 + mv.dz * 0.8;
              if (catInBay(pos.x, pos.z)) { fx = sg > 0 ? 10.6 : 6.9; fz = Math.min(-2.6, Math.max(-12.4, fz)); }
              else if (pos.z > -1.6 && pos.x > 0 && pos.x < 15) { fx = Math.min(CAT_ZONE.x1, Math.max(CAT_ZONE.x0, fx)); fz = Math.min(CAT_ZONE.z1, Math.max(CAT_ZONE.z0, fz)); }
              else { fz = Math.min(7.4, fz); if (catInBay(fx, fz)) fx = 14.0; }
              if (c.act === 'tussle') { c.mate.act = 'lead'; c.mate.pause = 0; }
              c.perch = null; catRelease(c);
              c.path = [{ x: fx, y: 0, z: fz }]; c.speed = 3.2; c.act = 'go'; c.wait = 0; c.mode = null;
              c.then = () => { c.act = 'idle'; c.pose = 'sit'; c.wait = 1 + Math.random() * 2; };
              c.flee = 1.5;
              break;
            }
          }
          catThink(c, dt, T);
          catMove(c, dt);
          catAnim(c, dt, T, lamp > 0.4);
        });
      }

      /* ---------- action timelines ----------
         The story, per car (phase 0–220): the customer drives in and talks it over with
         Sean; the bay is busy, so Sean parks it in the stall by the door and the customer
         books a ride. When the car on the bay is finished and gone, Sean fetches this one
         in and works on it. The ride brings the customer back for the reveal and they
         drive off. Two cars run this 110 s apart, so Sean's own loop is 110 s: each loop
         he parks one arrival, finishes the car on the bay, and fetches the one waiting.
         `hide` swaps a figure out while they're inside a car. */
      const SEAN_HOME = [11.3, -6.0];   // the strip beside the car on the bay
      const STALL_DOOR = [16.6, -1.6];  // driver's door of a car nosed into the first stall
      const SEAN_KEYS = [
        { t: 0.0,   x: 7.7,  z: -5.0, a: 'idle', hide: true },   // still driving the waiting car in
        { t: 2.4,   x: 7.7,  z: -5.0, a: 'idle', hide: true },
        { t: 3.0,   x: 7.7,  z: -5.0, a: 'idle' },
        { t: 4.0,   x: 7.7,  z: -5.0, a: 'walk' },
        { t: 5.0,   x: SEAN_HOME[0], z: SEAN_HOME[1], a: 'idle' },
        { t: 5.5,   x: SEAN_HOME[0], z: SEAN_HOME[1], a: 'walk' },  // hears the next car pull in
        { t: 7.2,   x: 10.6, z: -0.8, a: 'walk' },
        { t: 9.4,   x: 5.2,  z: 4.6,  a: 'talk' },                 // meets them at the driver's door
        { t: 15.5,  x: 5.2,  z: 4.6,  a: 'walk' },
        { t: 16.4,  x: 7.6,  z: 4.8,  a: 'idle', hide: true },    // takes the keys, gets in
        { t: 24.0,  x: STALL_DOOR[0], z: STALL_DOOR[1], a: 'idle', hide: true },  // parks it in the stall
        { t: 24.6,  x: STALL_DOOR[0], z: STALL_DOOR[1], a: 'idle' },
        { t: 25.4,  x: STALL_DOOR[0], z: STALL_DOOR[1], a: 'walk' },
        { t: 28.4,  x: 10.8, z: -0.6, a: 'walk' },
        // Back to the car on the bay. It sits nose-in, so the engine bay is at the BACK of
        // the unit and the boot faces the door. Amp first, a breather, then the subs.
        { t: 31.0,  x: 10.9, z: -8.4, a: 'work' },
        { t: 38.0,  x: 10.9, z: -8.4, a: 'walk' },
        { t: 39.0,  x: SEAN_HOME[0], z: SEAN_HOME[1], a: 'idle' },   // breather (the cats' window)
        { t: 53.0,  x: SEAN_HOME[0], z: SEAN_HOME[1], a: 'walk' },
        { t: 54.8,  x: 8.6,  z: -12.8, a: 'idle' },                // shelving across the back wall
        { t: 55.8,  x: 8.6,  z: -12.8, a: 'carrySub' },
        { t: 58.4,  x: 10.9, z: -3.9,  a: 'carrySub' },            // first sub to the boot
        { t: 59.0,  x: 10.9, z: -3.9,  a: 'work' },
        { t: 63.5,  x: 10.9, z: -3.9,  a: 'walk' },
        { t: 65.3,  x: 8.6,  z: -12.8, a: 'idle' },                // back for the second
        { t: 66.3,  x: 8.6,  z: -12.8, a: 'carrySub' },
        { t: 68.7,  x: 10.9, z: -3.9,  a: 'carrySub' },
        { t: 69.3,  x: 10.9, z: -3.9,  a: 'work' },
        { t: 74.6,  x: 10.9, z: -3.9,  a: 'idle' },                // shuts the boot
        { t: 75.4,  x: 10.9, z: -3.9,  a: 'walk' },
        { t: 76.6,  x: 7.7,  z: -5.6,  a: 'idle', hide: true },    // brings it out
        { t: 81.6,  x: 5.6,  z: 4.3,   a: 'idle', hide: true },
        { t: 82.4,  x: 5.6,  z: 4.3,   a: 'idle' },
        { t: 82.8,  x: 5.6,  z: 4.3,   a: 'walk' },
        { t: 83.8,  x: 6.4,  z: 3.4,   a: 'proud' },               // lets it speak for itself
        { t: 94.6,  x: 6.4,  z: 3.4,   a: 'walk' },
        { t: 96.2,  x: 5.4,  z: 4.0,   a: 'talk' },                // hands the keys back
        { t: 98.1,  x: 5.4,  z: 4.0,   a: 'walk' },
        { t: 101.8, x: STALL_DOOR[0], z: STALL_DOOR[1], a: 'idle' },  // and goes for the waiting car
        { t: 102.8, x: STALL_DOOR[0], z: STALL_DOOR[1], a: 'idle', hide: true },
        { t: SEAN_H, x: 7.7, z: -5.0, a: 'idle', hide: true },
      ];
      const CUST_KEYS = [
        { t: 0.0,   x: 7.4,  z: 4.6, a: 'idle', hide: true },    // still in the car
        { t: 8.0,   x: 7.4,  z: 4.6, a: 'idle', hide: true },
        { t: 8.2,   x: 7.4,  z: 4.6, a: 'idle' },                // steps out
        { t: 8.8,   x: 7.4,  z: 4.6, a: 'walk' },
        { t: 9.8,   x: 6.6,  z: 5.2, a: 'talk' },
        { t: 15.5,  x: 6.6,  z: 5.2, a: 'walk' },                // round the tail, clear of the car
        { t: 16.6,  x: 7.0,  z: 7.8, a: 'walk' },
        { t: 18.2,  x: 13.0, z: 6.2, a: 'phone' },               // books a ride
        { t: 24.5,  x: 13.0, z: 6.2, a: 'walk' },
        { t: 26.4,  x: 6.4,  z: 8.0, a: 'idle' },
        { t: 26.9,  x: 6.4,  z: 8.0, a: 'idle', hide: true },    // rides away
        { t: 184.2, x: 6.4,  z: 8.0, a: 'idle', hide: true },    // dropped back off
        { t: 184.5, x: 6.4,  z: 8.0, a: 'walk' },
        { t: 186.4, x: 12.4, z: 5.0, a: 'idle' },
        { t: 192.1, x: 12.4, z: 5.0, a: 'walk' },
        // A lap of the car, stopping at each thing Sean fitted.
        { t: 193.4, x: 10.9, z: 6.4, a: 'wow' },                 // engine bay, hood up
        { t: 195.6, x: 10.9, z: 6.4, a: 'walk' },
        { t: 197.0, x: 8.2,  z: 7.0, a: 'inspect' },             // hand along the flank
        { t: 198.2, x: 8.2,  z: 7.0, a: 'walk' },
        { t: 199.4, x: 5.6,  z: 6.8, a: 'wow' },                 // round the back — the subs
        { t: 201.0, x: 5.6,  z: 6.8, a: 'walk' },
        { t: 202.0, x: 4.3,  z: 5.6, a: 'selfie' },              // one for the group chat
        { t: 205.0, x: 4.3,  z: 5.6, a: 'walk' },
        { t: 206.0, x: 5.2,  z: 7.0, a: 'walk' },                // clear of the boot corner
        { t: 207.0, x: 6.4,  z: 6.6, a: 'talk' },
        { t: 208.2, x: 6.4,  z: 6.6, a: 'idle' },
        { t: 208.5, x: 6.4,  z: 6.6, a: 'idle', hide: true },
        { t: CYCLE, x: 6.4,  z: 6.6, a: 'idle', hide: true },
      ];
      /* ---------- a customer car's route ----------
         Each entry is one manoeuvre on one gear: an arc-length-parameterised Catmull-Rom
         through its points, heading read off the tangent (flipped on a reverse leg). v0/v1
         are the end speeds; 0 is a genuine stop. */
      const STALL = [16.45, -3.2];
      const ROUTE = [
        // Holds (and teleports) at -62, past the visibility cut-off at ±56.
        { t0: 0.0,   t1: 0.8,   hold: [-62.0, 15.4], head: Math.PI / 2, jump: true },
        // In off the road, nose up in front of the open bay.
        { t0: 0.8,   t1: 8.0,   v0: 1, v1: 0, pts: [
            [-62.0, 15.4], [-30.0, 15.4], [-6.0, 15.4], [1.0, 15.0], [4.0, 12.8], [5.4, 10.0],
            [7.0, 7.0], [8.6, 5.4], [8.9, 4.6]] },
        { t0: 8.0,   t1: 17.0,  hold: [8.9, 4.6], head: Math.PI },      // keys handed over
        // The bay's busy: Sean takes it right along the apron, round in the lot, and noses
        // it into the first stall by the door.
        { t0: 17.0,  t1: 24.0,  v0: 0, v1: 0, pts: [
            [8.9, 4.6], [9.1, 2.6], [10.4, 1.2], [13.0, 0.8], [17.5, 1.0], [21.3, 0.0],
            [22.8, -2.3], [21.4, -4.6], [19.0, -3.4], [17.8, -3.2], STALL] },
        { t0: 24.0,  t1: 103.4, hold: STALL, head: -Math.PI / 2 },      // waits its turn
        // Fetched: reverses out with the tail swinging south so it leaves the stall facing
        // the apron, then west along the apron and north onto the bay.
        { t0: 103.4, t1: 106.8, v0: 0, v1: 0, gear: -1, pts: [
            STALL, [19.6, -3.25], [21.5, -4.4], [21.9, -6.6]] },
        { t0: 106.8, t1: 112.4, v0: 0, v1: 0, pts: [
            [21.9, -6.6], [21.6, -3.4], [20.4, -0.2], [17.6, 1.2], [13.4, 1.1], [10.4, 0.3],
            [9.2, -1.8], [9.0, -4.4], [9.0, -6.2]] },
        { t0: 112.4, t1: 186.6, hold: [9.0, -6.2], head: Math.PI },     // up on the bay
        // Out of the bay in ONE reversing arc, finishing broadside on the reveal spot.
        { t0: 186.6, t1: 191.6, v0: 0, v1: 0, gear: -1, pts: [
            [9.0, -6.2], [9.0, -3.0], [8.95, 0.6], [8.9, 3.2], [8.7, 4.6],
            [8.4, 5.2], [7.6, 5.2]] },
        { t0: 191.6, t1: 208.6, hold: [7.6, 5.2], head: Math.PI / 2 },
        // East along the lane, right into the exit drive, out onto the eastbound lane.
        { t0: 208.6, t1: 215.0, v0: 0, v1: 1, pts: [
            [7.6, 5.2], [11.0, 4.9], [15.6, 4.7], [19.2, 5.2], [20.4, 7.4],
            [20.8, 10.4], [21.8, 13.6], [24.4, 15.2], [31.0, 15.4], [44.0, 15.4]] },
        { t0: 215.0, t1: CYCLE, jump: true, hold: [-62.0, 15.4], head: Math.PI / 2 },
      ];

      // The rideshare: in off the road, onto the top of the apron, waits, leaves. Four trips
      // a cycle — collect and return for each of the two customers.
      const RIDE_IN = [[-70.0, 15.4], [-36.0, 15.4], [-10.0, 15.4], [0.0, 15.2],
                       [3.6, 13.4], [5.0, 10.6], [6.6, 8.0], [8.4, 7.3]];
      const RIDE_OUT = [[8.4, 7.3], [13.0, 7.0], [17.6, 7.2], [20.2, 8.6], [21.0, 11.0],
                        [22.2, 13.8], [25.0, 15.3], [32.0, 15.4], [48.0, 15.4]];
      const RIDE_ROUTE = [];
      { const trips = [22.0, 179.6, 22.0 + SEAN_H, 179.6 - SEAN_H].sort((a, b) => a - b);
        let prev = 0;
        trips.forEach(T => {
          RIDE_ROUTE.push({ t0: prev, t1: T, jump: true, hold: [-70.0, 15.4], head: Math.PI / 2 });
          RIDE_ROUTE.push({ t0: T, t1: T + 4.4, v0: 1, v1: 0, pts: RIDE_IN });
          RIDE_ROUTE.push({ t0: T + 4.4, t1: T + 5.8, hold: [8.4, 7.3], head: Math.PI / 2 });
          RIDE_ROUTE.push({ t0: T + 5.8, t1: T + 10.6, v0: 0, v1: 1, pts: RIDE_OUT });
          prev = T + 10.6;
        });
        RIDE_ROUTE.push({ t0: prev, t1: CYCLE, jump: true, hold: [-70.0, 15.4], head: Math.PI / 2 });
      }

      /* The parts-store customer. In off the eastbound lane with a right turn into the
         side lot, nose into the stall by the end wall; later reverses out swinging the
         tail into the lot so it leaves nose-first, and turns left across onto the
         westbound lane. */
      const SHOP_CYCLE = 190;
      const SHOP_STALL = [-38.2, -2.4];
      const SHOP_ROUTE = [
        { t0: 0.0,   t1: 60.0,  jump: true, hold: [-70.0, 15.4], head: Math.PI / 2 },
        { t0: 60.0,  t1: 68.0,  v0: 1, v1: 0, pts: [
            [-70.0, 15.4], [-56.0, 15.4], [-48.5, 15.0], [-44.6, 13.0], [-43.4, 10.0],
            [-43.4, 4.6], [-43.4, 1.0], [-42.6, -1.6], [-40.6, -2.4], SHOP_STALL] },
        { t0: 68.0,  t1: 140.0, hold: SHOP_STALL, head: Math.PI / 2 },
        { t0: 140.0, t1: 144.4, v0: 0, v1: 0, gear: -1, pts: [
            SHOP_STALL, [-41.0, -2.4], [-42.6, -3.6], [-43.2, -6.4]] },
        { t0: 144.4, t1: 151.0, v0: 0, v1: 1, pts: [
            [-43.2, -6.4], [-43.3, -1.0], [-43.3, 6.0], [-43.2, 10.5], [-44.4, 14.4],
            [-46.8, 17.6], [-50.5, 19.4], [-56.0, 19.6], [-70.0, 19.6]] },
        { t0: 151.0, t1: SHOP_CYCLE, jump: true, hold: [-70.0, 15.4], head: Math.PI / 2 },
      ];
      // Driver's door is on the +z side of a car facing +x. Walks along the block's front
      // walk (z ≈ -1) round the corner to the parts-store door at -26.5.
      const SHOP_DOOR = [-38.6, -1.3];
      const SHOPPER_KEYS = [
        { t: 0.0,   x: SHOP_DOOR[0], z: SHOP_DOOR[1], a: 'idle', hide: true },
        { t: 68.2,  x: SHOP_DOOR[0], z: SHOP_DOOR[1], a: 'idle', hide: true },
        { t: 68.5,  x: SHOP_DOOR[0], z: SHOP_DOOR[1], a: 'idle' },
        { t: 69.3,  x: SHOP_DOOR[0], z: SHOP_DOOR[1], a: 'walk' },
        { t: 71.5,  x: -36.2, z: -0.5, a: 'walk' },
        { t: 77.5,  x: -27.6, z: -1.3, a: 'walk' },
        { t: 78.4,  x: -26.5, z: -1.9, a: 'idle' },
        { t: 78.8,  x: -26.5, z: -1.9, a: 'idle', hide: true },    // inside the store
        { t: 128.0, x: -26.5, z: -1.9, a: 'idle', hide: true },
        { t: 128.3, x: -26.5, z: -1.9, a: 'walk' },
        { t: 129.5, x: -27.6, z: -1.3, a: 'walk' },
        { t: 135.5, x: -36.2, z: -0.5, a: 'walk' },
        { t: 137.8, x: SHOP_DOOR[0], z: SHOP_DOOR[1], a: 'idle' },
        { t: 138.8, x: SHOP_DOOR[0], z: SHOP_DOOR[1], a: 'idle', hide: true },
        { t: SHOP_CYCLE, x: SHOP_DOOR[0], z: SHOP_DOOR[1], a: 'idle', hide: true },
      ];

      [ROUTE, RIDE_ROUTE, SHOP_ROUTE].forEach(r => r.forEach(leg => {
        if (!leg.pts) return;
        leg.curve = new THREE.CatmullRomCurve3(
          leg.pts.map(([x, z]) => new THREE.Vector3(x, 0, z)), false, 'centripetal', 0.5);
        leg.curve.arcLengthDivisions = 120;
        leg.len = leg.curve.getLength();
      }));

      // Cubic Hermite on normalised time with the end speeds as its slopes: f(0)=0, f(1)=1,
      // f'(0)=v0, f'(1)=v1. A leg with v0=v1=1 runs at constant speed, so two legs that
      // meet at speed 1 join seamlessly.
      function ease(p, v0, v1) {
        const p2 = p * p, p3 = p2 * p;
        return v0 * (p3 - 2 * p2 + p) + (-2 * p3 + 3 * p2) + v1 * (p3 - p2);
      }
      function easeD(p, v0, v1) {
        return v0 * (3 * p * p - 4 * p + 1) + (-6 * p * p + 6 * p) + v1 * (3 * p * p - 2 * p);
      }

      const carPt = new THREE.Vector3(), carTan = new THREE.Vector3();
      function driveCar(route, t) {
        let leg = route[route.length - 1];
        for (let i = 0; i < route.length; i++) {
          if (t >= route[i].t0 && t < route[i].t1) { leg = route[i]; break; }
        }
        if (!leg.curve) {
          return { x: leg.hold[0], z: leg.hold[1], head: leg.head,
                   rev: false, jump: !!leg.jump, speed: 0 };
        }
        const v0 = leg.v0 ?? 1, v1 = leg.v1 ?? 1, gear = leg.gear ?? 1;
        const p = Math.max(0, Math.min(1, (t - leg.t0) / (leg.t1 - leg.t0)));
        const f = Math.max(0, Math.min(1, ease(p, v0, v1)));
        leg.curve.getPointAt(f, carPt);
        leg.curve.getTangentAt(f, carTan);
        return {
          x: carPt.x, z: carPt.z,
          head: Math.atan2(carTan.x * gear, carTan.z * gear),
          rev: gear < 0, jump: false,
          speed: Math.abs(easeD(p, v0, v1)) * leg.len / (leg.t1 - leg.t0),
        };
      }

      function sample(keys, t) {
        for (let i = keys.length - 2; i >= 0; i--) {
          if (t >= keys[i].t) {
            const a = keys[i], b = keys[i + 1];
            // A jump leg must not interpolate — that would drag the car across the whole
            // scene in a tenth of a second. Snap straight to the destination.
            if (a.jump) {
              return { x: b.x, z: b.z, a: a.a, rev: false, jump: true,
                       moving: false, dirx: 0, dirz: 1, speed: 0 };
            }
            const span = b.t - a.t || 1;
            let u = (t - a.t) / span;
            u = u * u * (3 - 2 * u);
            const dx = b.x - a.x, dz = b.z - a.z;
            return {
              x: a.x + dx * u, z: a.z + dz * u, a: a.a, rev: !!a.rev, jump: !!a.jump,
              hide: !!a.hide,
              moving: Math.hypot(dx, dz) > 0.08,
              dirx: dx, dirz: dz, speed: Math.hypot(dx, dz) / span,
            };
          }
        }
        const k = keys[0];
        return { x: k.x, z: k.z, a: k.a, rev: false, jump: false, hide: !!k.hide, moving: false, dirx: 0, dirz: 1, speed: 0 };
      }

      /* One animation driver for both figures. Each keeps its own smoothed heading and
         walk phase in userData, so they never share a gait. */
      /* Rainy days: in the gap between jobs (t 83 → wraps → 5, Sean standing idle at
         9,-4.6 with the bay empty) he walks to whichever cat is asleep indoors, gives it a
         fuss for a few seconds and walks back. Layered over the keyframed pose. */
      /* Fair weather: the breather is spent on the couch instead. Round the nose of the car
         on the bay via the right-hand strip, sit, watch the TV, walk back. Overrides the
         keyframed idle at SEAN_HOME. */
      const RELAX = { on: false };
      function seanRelax(t, dt) {
        const u = t - 38.4;
        const LEN = 14.6, WALK = 2.2;
        const want = u >= 0 && u <= LEN && WEATHER.precip === 'none' && !catCold() && sean.userData.shown;
        RELAX.on = want;
        // One cat comes to sit with him: whichever is nearest and not busy far away.
        const seated = want && u > WALK && u < LEN - WALK - 0.8;
        if (seated && !LAP.cat && u < WALK + 1.2) {
          let best = null, bd = 30;
          cats.forEach(c => {
            if (c.jump || c.act === 'tussle' || c.act === 'rub' || c.act === 'sleep') return;
            const dd = Math.hypot(c.g.position.x - COUCH[0], c.g.position.z - COUCH[1]);
            if (dd < bd) { bd = dd; best = c; }
          });
          if (best) catToLap(best);
        }
        if (!seated && LAP.cat) { const c = LAP.cat; LAP.cat = null; if (c.act === 'lap' || (c.act === 'go' && c.mode === 'lap')) { c.act = 'idle'; c.mode = null; c.path.length = 0; c.then = null; c.wait = 0.3; } }
        if (!want) return;
        const d = sean.userData;
        const P = [SEAN_HOME, [10.6, -10.6], [COUCH[0] + 0.45, COUCH[1]]];
        const L0 = Math.hypot(P[1][0] - P[0][0], P[1][1] - P[0][1]), L1 = Math.hypot(P[2][0] - P[1][0], P[2][1] - P[1][1]);
        const along = (k) => {
          let dd = k * (L0 + L1);
          if (dd <= L0) { const f = dd / L0; return [P[0][0] + (P[1][0] - P[0][0]) * f, P[0][1] + (P[1][1] - P[0][1]) * f]; }
          const f = Math.min(1, (dd - L0) / L1);
          return [P[1][0] + (P[2][0] - P[1][0]) * f, P[1][1] + (P[2][1] - P[1][1]) * f];
        };
        const walking = u < WALK || u > LEN - WALK;
        if (walking) {
          const out = u < WALK;
          const k = out ? u / WALK : 1 - (u - (LEN - WALK)) / WALK;
          const [x, z] = along(k);
          const [nx, nz] = along(Math.min(1, Math.max(0, k + (out ? 0.02 : -0.02))));
          sean.position.x = x; sean.position.z = z;
          d.ph += dt * 8.4;
          const sw = Math.sin(d.ph);
          d.legL.rotation.x = sw * 0.62; d.legR.rotation.x = -sw * 0.62;
          d.armL.rotation.x = -sw * 0.5; d.armR.rotation.x = sw * 0.5;
          d.torso.rotation.x = 0.06;
          d.hips.position.y = Math.abs(Math.cos(d.ph)) * 0.045;
          if (Math.hypot(nx - x, nz - z) > 1e-4) d.h += shortestArc(Math.atan2(nx - x, nz - z), d.h) * Math.min(1, dt * 9);
          sean.rotation.y = d.h;
          return;
        }
        // Sat down: phone in his right hand, thumbing through it; left hand on the cat if
        // one has settled beside him, otherwise resting on the cushion.
        sean.position.x = COUCH[0] + 0.1; sean.position.z = COUCH[1];
        d.ph += dt * 1.2;
        d.hips.position.y = -0.42;
        d.legL.rotation.x = -1.35; d.legR.rotation.x = -1.2;
        d.torso.rotation.x = 0.1;
        d.armR.rotation.x = -1.0 + Math.sin(clock.elapsedTime * 0.9) * 0.04; d.armR.rotation.z = 0.15;
        d.phone.visible = true;
        const petting = LAP.cat && LAP.cat.act === 'lap';
        if (petting) { d.armL.rotation.x = -0.55 + Math.sin(clock.elapsedTime * 2.6) * 0.22; d.armL.rotation.z = -0.55; }
        else { d.armL.rotation.x = -0.25; d.armL.rotation.z = -0.25; }
        d.h += shortestArc(Math.PI / 2, d.h) * Math.min(1, dt * 6);
        sean.rotation.y = d.h;
      }
      function seanPetCats(t, dt) {
        // Sean's breather between the amp and the subs (loop time 39 → 53).
        const u = t - 39;
        const LEN = 14.0;
        if (u < 0 || u > LEN || (WEATHER.precip === 'none' && !catCold()) || !sean.userData.shown) {
          SEAN_PET.cat = null; SEAN_PET.on = false; return;
        }
        if (!SEAN_PET.cat) {
          if (u > 0.4) return;   // only start a visit at the top of the window
          const c = cats.find(k => k.act === 'sleep' && k.res && !k.res.spot.outdoor);
          if (!c) return;
          SEAN_PET.cat = c;
          const p = c.g.position, home = SEAN_HOME;
          let dx = home[0] - p.x, dz = home[1] - p.z; const d = Math.hypot(dx, dz) || 1;
          SEAN_PET.x = p.x + dx / d * 0.62; SEAN_PET.z = p.z + dz / d * 0.62; SEAN_PET.y = c.y;
        }
        const c = SEAN_PET.cat, d = sean.userData;
        const T0 = 1.6, T1 = LEN - 1.6;
        const k = u < T0 ? u / T0 : u > T1 ? 1 - (u - T1) / 1.6 : 1;
        const e = k * k * (3 - 2 * k);
        sean.position.x += (SEAN_PET.x - sean.position.x) * e;
        sean.position.z += (SEAN_PET.z - sean.position.z) * e;
        const walking = u < T0 || u > T1;
        SEAN_PET.on = !walking;
        if (walking) {
          d.ph += dt * 8.4;
          const sw = Math.sin(d.ph);
          d.legL.rotation.x = sw * 0.62; d.legR.rotation.x = -sw * 0.62;
          d.armL.rotation.x = -sw * 0.5; d.armR.rotation.x = sw * 0.5;
          d.hips.position.y = Math.abs(Math.cos(d.ph)) * 0.045;
          const tx = u < T0 ? SEAN_PET.x : SEAN_HOME[0], tz = u < T0 ? SEAN_PET.z : SEAN_HOME[1];
          d.h += shortestArc(Math.atan2(tx - sean.position.x, tz - sean.position.z), d.h) * Math.min(1, dt * 7);
          sean.rotation.y = d.h;
          return;
        }
        // Low cat: crouch right down. Perched cat (bench, chest): stoop and reach.
        const low = SEAN_PET.y < 0.5;
        d.ph += dt * 3.2;
        const stroke = Math.sin(d.ph) * 0.18;
        d.torso.rotation.x = low ? 0.75 : 0.32;
        d.hips.position.y = low ? -0.32 : -0.04;
        d.legL.rotation.x = low ? -1.1 : 0.1; d.legR.rotation.x = low ? 0.5 : -0.05;
        d.armR.rotation.x = (low ? -0.55 : -1.05) + stroke;
        d.armL.rotation.x = low ? -0.2 : 0.05;
        d.armR.rotation.z = 0; d.armL.rotation.z = 0;
        const p = c.g.position;
        d.h += shortestArc(Math.atan2(p.x - sean.position.x, p.z - sean.position.z), d.h) * Math.min(1, dt * 7);
        sean.rotation.y = d.h;
      }
      function stepPerson(fig, keys, t, dt, personTarget, carTarget) {
        const s = sample(keys, t);
        // Hiding the figure must not hide its flash light (see makeCar's setShown), so the
        // limbs/torso hide individually and the props below OR in the hide flag.
        const shown = !s.hide;
        if (fig.userData.shown !== shown) {
          fig.userData.shown = shown;
          fig.userData.bodyParts.forEach(m => (m.visible = shown));
        }
        fig.position.x = s.x; fig.position.z = s.z;
        const d = fig.userData;
        d.moving = s.moving; d.action = s.a;
        let want = d.h;
        // Only the celebration poses splay the arms sideways, so reset every frame.
        d.armL.rotation.z = 0; d.armR.rotation.z = 0;
        const look = (s.a === 'talk') ? personTarget : carTarget;
        const faceLook = () => {
          if (look) want = Math.atan2(look.x - s.x, look.z - s.z);
        };
        if (s.moving) {
          d.ph += dt * 8.4;
          const swing = Math.sin(d.ph);
          d.legL.rotation.x = swing * 0.62; d.legR.rotation.x = -swing * 0.62;
          d.armL.rotation.x = -swing * 0.5; d.armR.rotation.x = swing * 0.5;
          d.torso.rotation.x = 0.06;
          d.hips.position.y = Math.abs(Math.cos(d.ph)) * 0.045;
          want = Math.atan2(s.dirx, s.dirz);
        } else if (s.a === 'work') {
          d.ph += dt * 5.5;
          d.legL.rotation.x = 0.22; d.legR.rotation.x = -0.1;
          d.torso.rotation.x = 0.42;
          d.armL.rotation.x = -0.9 + Math.sin(d.ph) * 0.42;
          d.armR.rotation.x = -1.15 + Math.cos(d.ph * 1.3) * 0.3;
          d.hips.position.y = -0.05;
          faceLook();
        } else if (s.a === 'talk') {
          // Weight shifts and the odd hand gesture — enough to read as a conversation.
          d.ph += dt * 2.2;
          d.legL.rotation.x = d.legR.rotation.x = 0;
          d.torso.rotation.x = 0.02;
          const g = Math.max(0, Math.sin(d.ph * 1.7));
          d.armR.rotation.x = -0.15 - g * 0.85;
          d.armL.rotation.x = 0.06;
          d.hips.position.y = Math.sin(d.ph * 1.1) * 0.02;
          faceLook();
        } else if (s.a === 'wow') {
          // Both hands up, bouncing on the balls of the feet — the customer seeing the
          // subs for the first time.
          d.ph += dt * 5.6;
          const b = Math.abs(Math.sin(d.ph));
          d.legL.rotation.x = d.legR.rotation.x = 0;
          d.armL.rotation.x = d.armR.rotation.x = -1.78 - b * 0.22;
          d.armL.rotation.z = 0.58; d.armR.rotation.z = -0.58;
          d.torso.rotation.x = -0.07;
          d.hips.position.y = b * 0.07;
          faceLook();
        } else if (s.a === 'proud') {
          // Hands on hips, weight rocking slowly. Sean letting the car do the talking.
          d.ph += dt * 1.5;
          d.legL.rotation.x = d.legR.rotation.x = 0;
          d.armL.rotation.x = -0.42; d.armR.rotation.x = -0.42;
          d.armL.rotation.z = 0.78; d.armR.rotation.z = -0.78;
          d.torso.rotation.x = -0.05;
          d.hips.position.y = Math.sin(d.ph) * 0.02;
          faceLook();
        } else if (s.a === 'inspect') {
          // Leaning in with a hand on the panel, the way you check somebody else's work.
          d.ph += dt * 2.6;
          d.legL.rotation.x = 0.08; d.legR.rotation.x = -0.06;
          d.armR.rotation.x = -0.95 + Math.sin(d.ph) * 0.2;
          d.armR.rotation.z = -0.22;
          d.armL.rotation.x = 0.1;
          d.torso.rotation.x = 0.18;
          d.hips.position.y = -0.02;
          faceLook();
        } else if (s.a === 'selfie') {
          // Phone out at arm's length with her back to the car, so the subs are in shot.
          d.ph += dt * 2.0;
          d.legL.rotation.x = d.legR.rotation.x = 0;
          d.armR.rotation.x = -1.52 + Math.sin(d.ph * 1.6) * 0.04;
          d.armR.rotation.z = -0.26;
          d.armL.rotation.x = -0.28;
          d.torso.rotation.x = -0.04;
          d.hips.position.y = Math.sin(d.ph * 1.3) * 0.016;
          if (look) want = Math.atan2(s.x - look.x, s.z - look.z);
          // Shutter every 1.15s: a hard spike with a short decay, plus a real light so the
          // burst lands on her face and the boot lid behind her.
          const shut = (t % 1.15) / 1.15;
          const burst = shut < 0.12 ? Math.pow(1 - shut / 0.12, 1.8) : 0;
          d.flash.material.opacity = burst * 0.95;
          d.flash.scale.setScalar(0.7 + burst * 0.5);
          d.flashLight.intensity = burst * 9;
        } else if (s.a === 'phone') {
          d.ph += dt * 1.4;
          d.legL.rotation.x = d.legR.rotation.x = 0;
          d.torso.rotation.x = 0.08;
          d.armR.rotation.x = -1.42 + Math.sin(d.ph) * 0.05;   // phone up at eye level
          d.armL.rotation.x = -0.35;
          d.hips.position.y = Math.sin(d.ph * 0.9) * 0.014;
          want = 0.35;                                          // half-turned to the road
        } else {
          d.legL.rotation.x = d.legR.rotation.x = 0;
          d.armL.rotation.x = d.armR.rotation.x = 0.06;
          d.torso.rotation.x = 0;
          d.hips.position.y = Math.sin(t * 1.6) * 0.012;
        }
        d.phone.visible = shown && (s.a === 'phone' || s.a === 'selfie');
        if (s.a !== 'selfie') { d.flash.material.opacity = 0; d.flashLight.intensity = 0; }
        d.part.visible = shown && (s.a === 'carry');
        d.subProp.visible = shown && (s.a === 'carrySub');
        if (s.a === 'carry' || s.a === 'carrySub') { d.armL.rotation.x = -1.3; d.armR.rotation.x = -1.3; }
        d.h += shortestArc(want, d.h) * Math.min(1, dt * 7);
        fig.rotation.y = d.h;
        return s;
      }

      /* ---------- day / night cycle ----------
         p = 0 dawn · 0.3 midday · 0.55 golden · 0.68 dusk · 0.85 night */
      // Daytime is deliberately bright: 0.30–0.52 is full sun, and the warm falloff is
      // compressed into the last stretch before real sunset (0.66) so a 5:30pm summer
      // afternoon still reads as daylight.
      const STOPS = [
        { p: 0.00, sky: 0x4A4668, fog: 0x5A5470, sun: 0xE8A878, sunI: 0.85, hemi: 0.95, hs: 0x6E6E8C, hg: 0x3A342C, lamp: 0.75, exp: 1.20 },
        { p: 0.06, sky: 0xB0B4C2, fog: 0xBCBEC8, sun: 0xFFCFA0, sunI: 2.90, hemi: 2.10, hs: 0xAFC0D8, hg: 0x6A6156, lamp: 0.00, exp: 1.16 },
        { p: 0.18, sky: 0xBECEE4, fog: 0xCED8E4, sun: 0xFFF2DC, sunI: 4.10, hemi: 2.85, hs: 0xC2D4EA, hg: 0x776D60, lamp: 0.00, exp: 1.18 },
        { p: 0.30, sky: 0xC6D6EA, fog: 0xD6E0EC, sun: 0xFFFBF2, sunI: 4.60, hemi: 3.15, hs: 0xCBDBEE, hg: 0x7D7365, lamp: 0.00, exp: 1.20 },
        { p: 0.44, sky: 0xC2D2E6, fog: 0xD2DCE8, sun: 0xFFF8EA, sunI: 4.40, hemi: 3.05, hs: 0xC6D6EA, hg: 0x7A7062, lamp: 0.00, exp: 1.20 },
        { p: 0.54, sky: 0xBAC8DC, fog: 0xCAD4E0, sun: 0xFFEED2, sunI: 3.80, hemi: 2.75, hs: 0xBCCCE2, hg: 0x776B5C, lamp: 0.00, exp: 1.18 },
        { p: 0.62, sky: 0xCE9464, fog: 0xC08A60, sun: 0xFFB878, sunI: 2.60, hemi: 2.15, hs: 0xC0A48E, hg: 0x7A6653, lamp: 0.00, exp: 1.10 },
        { p: 0.68, sky: 0x6E5A6E, fog: 0x6A5A6E, sun: 0xE09068, sunI: 1.35, hemi: 1.45, hs: 0x93808E, hg: 0x554A40, lamp: 0.45, exp: 1.20 },
        { p: 0.76, sky: 0x2E2A44, fog: 0x302C46, sun: 0x9AA8CE, sunI: 0.50, hemi: 0.62, hs: 0x5A5F7C, hg: 0x2C2822, lamp: 0.92, exp: 1.28 },
        { p: 0.88, sky: 0x0C0C0D, fog: 0x171519, sun: 0xB4C6DE, sunI: 0.34, hemi: 0.48, hs: 0x4A5A72, hg: 0x1E1B16, lamp: 1.00, exp: 1.34 },
        { p: 1.00, sky: 0x4A4668, fog: 0x5A5470, sun: 0xE8A878, sunI: 0.85, hemi: 0.95, hs: 0x6E6E8C, hg: 0x3A342C, lamp: 0.75, exp: 1.20 },
      ];
      const cA = new THREE.Color(), cB = new THREE.Color();
      const dayState = { lamp: 1 };

      function applyDay(p) {
        let i = 0;
        while (i < STOPS.length - 2 && p >= STOPS[i + 1].p) i++;
        const a = STOPS[i], b = STOPS[i + 1];
        let u = (p - a.p) / (b.p - a.p || 1);
        u = u * u * (3 - 2 * u);

        scene.background.lerpColors(cA.setHex(a.sky), cB.setHex(b.sky), u);
        scene.fog.color.lerpColors(cA.setHex(a.fog), cB.setHex(b.fog), u);
        sun.color.lerpColors(cA.setHex(a.sun), cB.setHex(b.sun), u);
        // The ambient light's COLOURS must travel with the cycle too. Animating only its
        // intensity multiplies a fixed night-slate/near-black pair, which can never
        // produce daylight no matter how high the intensity goes.
        hemi.color.lerpColors(cA.setHex(a.hs), cB.setHex(b.hs), u);
        hemi.groundColor.lerpColors(cA.setHex(a.hg), cB.setHex(b.hg), u);
        sun.intensity = a.sunI + (b.sunI - a.sunI) * u;
        const updTS = true;
        hemi.intensity = a.hemi + (b.hemi - a.hemi) * u;
        renderer.toneMappingExposure = a.exp + (b.exp - a.exp) * u;
        const lampF = a.lamp + (b.lamp - a.lamp) * u;
        dayState.lamp = lampF;

        // Sun arcs overhead through the day; a moon takes over from the other side at night.
        const DAWN = 0.02, DUSK = 0.66;
        if (p > DAWN && p < DUSK) {
          const ang = ((p - DAWN) / (DUSK - DAWN)) * Math.PI;
          sun.position.set(Math.cos(ang) * 46, Math.max(Math.sin(ang) * 40, 5), 20);
        } else {
          const q = p >= DUSK ? (p - DUSK) / (1 - DUSK + DAWN) : (p + (1 - DUSK)) / (1 - DUSK + DAWN);
          const ang = q * Math.PI;
          sun.position.set(-Math.cos(ang) * 44, Math.max(Math.sin(ang) * 32, 10), -14);
        }
        if (updTS) updateTreeShadows(sun.position, sun.intensity);

        // Real weather modifies daylight: cloud flattens and greys it, precipitation dims
        // it further, fog closes the distance down, and a dark sky brings the shop lights
        // up early. WEATHER is populated before the first applyDay() call.
        const cl = WEATHER.cloud, fg = WEATHER.fog;
        // Overcast raises the artificial lights, but only when they'd plausibly be on
        // at all — a grey noon is still far too bright for the wall packs.
        const dusky = lampF > 0.01;
        let lampFinal = lampF;
        if (cl > 0.05) {
          // An overcast sky is a huge diffuse source, not an absence of light. Kill nearly
          // all the directional punch — shadows are what actually read as "overcast" — and
          // push the ambient up to compensate so a grey morning isn't a dark one.
          sun.intensity *= 1 - cl * 0.86;
          hemi.intensity *= 1 + cl * 0.9;
          hemi.color.lerp(cA.setHex(0xD2DAE4), cl * 0.75);
          hemi.groundColor.lerp(cA.setHex(0x8A8478), cl * 0.6);
          renderer.toneMappingExposure *= 1 - cl * 0.06;
          scene.background.lerp(cA.setHex(0xAEB4BC), cl * 0.85);
          scene.fog.color.lerp(cA.setHex(0xB4B9C0), cl * 0.85);
          lampFinal = dusky ? Math.min(1, lampF + cl * 0.45) : 0;
        }
        if (WEATHER.precip !== 'none') {
          const wetness = 0.2 + WEATHER.rate * 0.5;
          sun.intensity *= 1 - wetness * 0.3;
          hemi.intensity *= 1 - wetness * 0.12;
          scene.background.lerp(cA.setHex(WEATHER.precip === 'snow' ? 0x8E97A2 : 0x8A9099), wetness * 0.75);
          lampFinal = dusky ? Math.min(1, lampFinal + WEATHER.rate * 0.3) : 0;
        }
        if (fg > 0.02) {
          scene.fog.near = THREE.MathUtils.lerp(70, 8, fg);
          scene.fog.far = THREE.MathUtils.lerp(190, 52, fg);
          scene.background.lerp(cA.setHex(0xC6CAD0), fg * 0.6);
        } else {
          scene.fog.near = 70;
          scene.fog.far = 190;
        }
        dayState.lamp = lampFinal;

        // Park the sun/moon disc out past the scene along the light's direction, facing
        // the camera, and swap it to a cool moon after dark.
        const night = p > 0.70;
        disc.position.copy(sun.position).multiplyScalar(1.9);
        halo.position.copy(sun.position).multiplyScalar(1.86);
        disc.lookAt(controls.target);
        halo.lookAt(controls.target);
        disc.scale.setScalar(night ? 0.55 : 1);
        halo.scale.setScalar(night ? 0.5 : 1);
        disc.material.color.copy(sun.color).lerp(cA.setHex(0xFFFFFF), night ? 0.5 : 0.35);
        halo.material.color.copy(sun.color);
        const skyClear = 1 - Math.max(cl, fg);
        disc.material.opacity = 0.95 * skyClear;
        halo.material.opacity = (night ? 0.10 : 0.18) * skyClear;
        disc.visible = halo.visible = skyClear > 0.08;

        lamps.forEach(l => { l.light.intensity = l.culled ? 0 : Math.max(l.floor, l.base * lampFinal); });
        glows.forEach(g => { g.mesh.material.opacity = Math.max(g.floor * 0.35, g.base * Math.max(lampFinal, g.floor ? 0.5 : 0)); });
        neonBase = neonFace.material.opacity;
      }

      // Neon flicker and the analyser repaint used to live inside applyDay. They have to
      // run every frame while applyDay does not, so they're their own pass — and the
      // flicker multiplies a stored base rather than the live opacity, which would
      // compound down to nothing on any frame applyDay skipped.
      let neonBase = 0;
      function stepNeon(t2) {
        if (neonBase <= 0.05) return;
        const breathe = 0.965 + Math.sin(t2 * 1.7) * 0.02 + Math.sin(t2 * 5.3) * 0.012;
        const stutter = (Math.sin(t2 * 0.37) > 0.9985) ? 0.55 : 1;
        const op = neonBase * breathe * stutter;
        neonFace.material.opacity = op;
        // Canvas -> GPU texture upload plus ~70 blurred strokes is the most expensive
        // thing in the frame, so it runs at 10fps and stops when the sign is barely lit.
        if (op > 0.25 && t2 - neonLastPaint > 0.1) {
          neonLastPaint = t2;
          neonArt.render(t2);
          neonArt.tex.needsUpdate = true;
        }
      }

      /* ---------- visible sun / moon disc ---------- */
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(3.2, 32),
        new THREE.MeshBasicMaterial({ color: 0xFFF4D8, transparent: true, opacity: 0.95 })
      );
      scene.add(disc);
      const halo = new THREE.Mesh(
        new THREE.CircleGeometry(7.5, 32),
        new THREE.MeshBasicMaterial({ color: 0xFFD9A0, transparent: true, opacity: 0.16 })
      );
      scene.add(halo);

      /* ---------- weather: precipitation + wet ground ---------- */
      const WEATHER = { cloud: 0, precip: 'none', rate: 0, fog: 0, wind: 0, windDeg: 0, tempC: 15 };
      // Rain is what sends the cats indoors. Cold (or snow) makes shelter the preferred
      // place to be without stopping them going out.
      const catRain = () => WEATHER.precip === 'rain';
      const catCold = () => WEATHER.precip === 'snow' || WEATHER.tempC < 4;
      // Spread over the whole visible scene, not just the apron: the road to the south,
      // the east lot, and the grassland and tree line to the north all need weather.
      // Count scales with that area so the shower doesn't thin out to a drizzle.
      const PCOUNT = 4200;
      const pGeo = new THREE.BufferGeometry();
      const pPos = new Float32Array(PCOUNT * 3);
      const pVel = new Float32Array(PCOUNT);
      const P_AREA = { x: 170, z: 130, y: 24, cx: 0, cz: -32 };
      for (let i = 0; i < PCOUNT; i++) {
        pPos[i * 3]     = P_AREA.cx + (Math.random() - 0.5) * P_AREA.x;
        pPos[i * 3 + 1] = Math.random() * P_AREA.y;
        pPos[i * 3 + 2] = P_AREA.cz + (Math.random() - 0.5) * P_AREA.z;
        pVel[i] = 0.6 + Math.random() * 0.7;
      }
      pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
      // Soft round flake. A bare square point reads as grit; the sprite also lets the
      // flake be large enough to actually see without looking like a tile.
      const flakeTex = (() => {
        const c = document.createElement('canvas'); c.width = c.height = 32;
        const g = c.getContext('2d');
        const rg = g.createRadialGradient(16, 16, 0, 16, 16, 16);
        rg.addColorStop(0, 'rgba(255,255,255,1)');
        rg.addColorStop(0.5, 'rgba(255,255,255,0.75)');
        rg.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = rg; g.beginPath(); g.arc(16, 16, 16, 0, Math.PI * 2); g.fill();
        return new THREE.CanvasTexture(c);
      })();
      const pMat = new THREE.PointsMaterial({
        map: flakeTex, color: 0xFFFFFF, size: 6, transparent: true, opacity: 0,
        depthWrite: false,
        // The scene camera is ORTHOGRAPHIC. Size attenuation divides by view-space depth,
        // which under an ortho projection collapses the point to sub-pixel — no size value
        // could ever have made these visible. With it off, size is in device pixels.
        sizeAttenuation: false,
        // ACES tone mapping pulls a white flake down to ~0.8, which is indistinguishable
        // from the snow-covered ground behind it. Opting out keeps flakes at full white,
        // the same trick the lamp glows use.
        toneMapped: false,
      });
      const precip = new THREE.Points(pGeo, pMat);
      precip.frustumCulled = false;
      precip.visible = false;
      scene.add(precip);

      /* Rain as streaks, not dots. A 0.075-unit point at this camera distance is a
         sub-pixel speck — the shower was running the whole time and simply couldn't be
         seen. Drops are drawn as short line segments driven off the same position buffer,
         so one update loop serves both this and the snow points. */
      const rGeo = new THREE.BufferGeometry();
      const rPos = new Float32Array(PCOUNT * 6);
      rGeo.setAttribute('position', new THREE.BufferAttribute(rPos, 3));
      const rMat = new THREE.LineBasicMaterial({
        color: 0xE6F0FA, transparent: true, opacity: 0, depthWrite: false, toneMapped: false,
      });
      const rain = new THREE.LineSegments(rGeo, rMat);
      rain.frustumCulled = false;
      rain.visible = false;
      scene.add(rain);

      // Sheen laid over every paved surface when it's wet — apron, road, pads and the east
      // lot. A 30×12 patch in front of the bay read as a puddle rather than wet ground.
      // Cut out round every roofed footprint. As one unbroken plane it ran straight
      // through the bay floor and under the walls, so the bay lamps raised highlights on
      // dry concrete and in spots no light can reach — reading as lamps mirrored beneath
      // the building. Shape coords are (x, -z); the mesh is laid flat at the origin.
      const wetShape = new THREE.Shape();
      wetShape.moveTo(-130, -43); wetShape.lineTo(130, -43); wetShape.lineTo(130, 107); wetShape.lineTo(-130, 107); wetShape.closePath();
      [[-13.7, 13.6, -15.5, -1.5],    // main row incl. Sean's bay
       [-35.9, -17.1, -12.0, -2.0],   // west block
       [32.6, 46.4, -16.5, 0.5]]      // storage block
        .forEach(([x0, x1, z0, z1]) => {
          const h = new THREE.Path();
          h.moveTo(x0, -z1); h.lineTo(x0, -z0); h.lineTo(x1, -z0); h.lineTo(x1, -z1); h.closePath();
          wetShape.holes.push(h);
        });
      const wet = new THREE.Mesh(
        new THREE.ShapeGeometry(wetShape),
        new THREE.MeshStandardMaterial({
          // A broad sheen, not a mirror: at roughness 0.18 / metal 0.5 with no env map the
          // bay's interior spot threw a tight hotspot onto the apron outside the door that
          // read as a lamp reflected beneath the building.
          // depthWrite off: it's a transparent overlay, and with polygon offset its depth
          // buried anything a few cm above it (the tree shadows) even while invisible.
          color: 0x2A3038, transparent: true, opacity: 0, depthWrite: false,
          roughness: 0.46, metalness: 0,
          polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6,
        })
      );
      wet.rotation.x = -Math.PI / 2;
      wet.position.set(0, 0.055, 0);
      // Shadowed, so a lamp's highlight can't show up under a car or bench that blocks it.
      wet.receiveShadow = true;
      scene.add(wet);

      // Settled snow over the same ground the wet sheen covers.
      const snowGround = new THREE.Mesh(
        new THREE.PlaneGeometry(260, 150),
        new THREE.MeshStandardMaterial({
          color: 0xDCE3EA, transparent: true, opacity: 0, roughness: 0.92, depthWrite: false,
          polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6,
        })
      );
      snowGround.rotation.x = -Math.PI / 2;
      snowGround.position.set(0, 0.056, -32);
      snowGround.receiveShadow = false;
      snowGround.visible = false;
      scene.add(snowGround);

      /* Roofs the weather can't fall through. A drop or flake that enters one of these
         boxes below its roof line is recycled to the top of the column — otherwise it
         rains inside Sean's bay. */
      const SHELTERS = [
        { x0: -13.4, x1: 13.4, z0: -15.5, z1: -1.5, y: 5.4 },   // the row, Sean's included
        { x0: -35.9, x1: -17.1, z0: -12.0, z1: -2.0, y: 4.8 },  // neighbouring block
        { x0: 10.5, x1: 12.7, z0: -17.4, z1: -15.2, y: 2.1 },   // the cats' tower awning
        { x0: 32.9, x1: 46.1, z0: -16.1, z1: 0.1, y: 4.8 },     // storage units
      ];
      function sheltered(x, y, z) {
        for (let i = 0; i < SHELTERS.length; i++) {
          const s = SHELTERS[i];
          if (y < s.y && x > s.x0 && x < s.x1 && z > s.z0 && z < s.z1) return true;
        }
        return false;
      }

      // Snow settling on flat surfaces. The row's two roof slabs are capped as ONE plate:
      // capping each separately put two coplanar boxes over the shared edge at x 4.7–5.3,
      // which z-fights into a bright seam running down the roof.
      const snowCaps = new THREE.Group();
      snowCaps.visible = false;
      const capMat = new THREE.MeshStandardMaterial({ color: 0xDCE3EA, roughness: 0.9, transparent: true, opacity: 0 });
      [[-0.05, 5.4, -8.5, 27.0, 13.8], [-26.5, 4.78, -7.0, 18.6, 9.8],
       // The storage block east of the lot — roof deck at 4.8, so its cap sits at 5.06.
       [39.5, 5.06, -8.0, 13.6, 16.8]]
        .forEach(([cx, cy, cz, cw, cd]) => {
          const cap = new THREE.Mesh(new THREE.BoxGeometry(cw, 0.12, cd), capMat);
          cap.position.set(cx, cy, cz); cap.receiveShadow = true; snowCaps.add(cap);
        });
      scene.add(snowCaps);

      function applyWeather(w) {
        weatherDirty = true;
        WEATHER.cloud = w.cloud; WEATHER.precip = w.precip;
        WEATHER.rate = w.precipRate; WEATHER.fog = w.fog;
        WEATHER.wind = w.windSpeed || 0; WEATHER.windDeg = w.windDeg || 0;
        WEATHER.tempC = typeof w.tempC === 'number' ? w.tempC : (w.precip === 'snow' ? -3 : 15);

        const snowing = w.precip === 'snow';
        const raining = w.precip === 'rain';
        // Snow keeps the points; rain gets the line streaks.
        precip.visible = snowing;
        rain.visible = raining;
        pMat.opacity = snowing ? 1 : 0;
        // Device pixels, not world units — see the sizeAttenuation note above.
        pMat.size = 5 + w.precipRate * 4;
        pMat.color.setHex(0xFFFFFF);
        rMat.opacity = raining ? 0.5 * (0.4 + w.precipRate * 0.6) : 0;
        wet.material.opacity = raining ? 0.3 + w.precipRate * 0.28 : 0;
        wet.visible = raining;
        snowGround.visible = snowing;
        // Deliberately short of white: pure white ground swallows white flakes whole.
        snowGround.material.opacity = snowing ? Math.min(0.42, 0.18 + w.precipRate * 0.28) : 0;
        snowCaps.visible = snowing;
        capMat.opacity = snowing ? Math.min(0.9, 0.3 + w.precipRate * 0.7) : 0;
      }

      // Bounded azimuth drift — done with spherical math rather than a controls setter
      // that only exists in some three.js builds.
      const driftSph = new THREE.Spherical();
      const driftOff = new THREE.Vector3();

      const shortestArc = (want, cur) => Math.atan2(Math.sin(want - cur), Math.cos(want - cur));

      // WebGL evaluates every visible light per fragment, so 40+ lit lamps at night costs
      // far more than it shows. Distant lamps keep their emissive lens plane (free) but
      // give up their actual light: past ~26 units their contribution is invisible anyway.
      // Distant lamps keep their emissive lens plane (free) but give up their actual
      // light. 20 covers the shop plus the storage block's wall packs, which sat just
      // outside a 14-light budget and never lit at night.
      // 28, and ranked by reach rather than bare distance: the two dozen small lamps
      // inside the bay (printers, LEDs, the pendant) all sit nearer the orbit target than
      // any street pole, so a plain nearest-N pass culled every pole on the road.
      const LIGHT_BUDGET = 22;
      const lampDist = [];
      /* Light culling with a FIXED visible count per light type. three.js compiles the
         number of point and spot lights into every shader: too many visible lights makes
         each pixel loop over all of them (holding all ~66 visible at zero intensity froze
         the browser), and a changing count recompiles everything. So exactly POINT_CAP
         points and SPOT_CAP non-shadow spots are visible at all times; the budget only
         swaps WHICH ones. Shadow-casting beams sit outside the pool. */
      const POINT_CAP = 14, SPOT_CAP = 5;
      let lightPool = null;
      const lampBase = new Map();
      function budgetLights() {
        if (!lightPool) {
          lamps.forEach(l => lampBase.set(l.light, l));
          lightPool = { points: [], spots: [] };
          scene.traverse(o => {
            if (o.isPointLight) lightPool.points.push(o);
            else if (o.isSpotLight && !o.castShadow && !o.userData.heroBeam) lightPool.spots.push(o);
          });
        }
        const rank = (arr, cap) => {
          lampDist.length = 0;
          for (const L of arr) {
            const rec = lampBase.get(L);
            L.getWorldPosition(tmpVec);
            const lit = rec ? rec.base * Math.max(dayState.lamp, rec.floor ? 1 : 0) + rec.floor : L.intensity;
            const d = lit > 0.02 ? tmpVec.distanceToSquared(controls.target) / Math.max(1, rec ? rec.base : 40) : 1e12;
            lampDist.push({ L, rec, d });
          }
          lampDist.sort((a, b) => a.d - b.d);
          lampDist.forEach((e, i) => { const on = i < cap; e.L.visible = on; if (e.rec) e.rec.culled = !on; });
        };
        rank(lightPool.points, POINT_CAP);
        rank(lightPool.spots, SPOT_CAP);
      }
      const tmpVec = new THREE.Vector3();

      // Minimum longitudinal gap between the hero and following traffic. A car is 4.3
      // long, so this leaves better than a car's length of clear road.
      const GAP_MIN = 8.5;
      const clock = new THREE.Clock();
      let neonLastPaint = -1, lastBudget = -1, lastAppliedP = -9, weatherDirty = true, underAmt = 0, lastDraw = 0, gutterFlow = 0;
      // The overlay may still be streaming when this boots, so resolve the nodes lazily —
      // but cache them once found. Four querySelectors per frame at 60fps is 240 DOM
      // walks a second for text that changes once a minute.
      const q = (sel) => document.querySelector(sel);
      let elCache = null;
      const els = () => {
        if (elCache && elCache.clock && elCache.clock.isConnected) return elCache;
        const e = {
          clock: q('[data-diorama-clock]'),
          phase: q('[data-diorama-phase]'),
          cond: q('[data-diorama-condition]'),
          temp: q('[data-diorama-temp]'),
          source: q('[data-diorama-source]'),
        };
        if (e.clock) elCache = e;
        return e;
      };
      let lastLabel = '';

      // What the console has pinned, if anything. The readout has to agree with what is
      // actually on screen — a plate insisting on a clear afternoon while the scene is a
      // dark rainstorm is worse than no plate at all.
      const PINNED = { phase: null, wx: null };
      const WX_LABEL = {
        clear: 'Clear', overcast: 'Overcast', rain: 'Rain', snow: 'Snow', fog: 'Fog',
      };

      function paintOverlay() {
        if (!ENV) return;
        const d = ENV.get();
        const e = els();
        const pinnedDay = PINNED.phase != null;
        const pinnedWx = PINNED.wx != null;
        if (e.clock) {
          e.clock.textContent = pinnedDay ? '——:——' : d.clockLabel;
          e.clock.style.color = pinnedDay ? '#8C877E' : '#FBFAF7';
        }
        if (e.phase) {
          e.phase.textContent = pinnedDay && ENV.labelFor
            ? ENV.labelFor(PINNED.phase) : d.phaseLabel;
        }
        if (e.cond) {
          e.cond.textContent = pinnedWx
            ? (WX_LABEL[PINNED.wx] || PINNED.wx)
            : d.conditionLabel + (d.live ? '' : ' · offline');
        }
        if (e.temp) e.temp.textContent = (pinnedWx || d.tempF == null) ? '' : Math.round(d.tempF) + '°F';
        if (e.source) {
          const pinned = pinnedDay || pinnedWx;
          e.source.textContent = pinned ? 'Pinned · shop console' : 'Live · Papillion, NE';
          e.source.style.color = pinned ? '#FBDE9A' : '#DBD6CC';
        }
      }

      /* ---------- real shop time + real Omaha weather ---------- */
      const ENV = window.SpectrumEnv || null;
      if (ENV) {
        applyWeather(ENV.data);
        ENV.onUpdate((w) => {
          applyWeather(w);
          paintOverlay();
        });
        paintOverlay();
        // The overlay must keep ticking even while the render loop is paused
        // (browsers suspend animation frames in hidden tabs).
        this._overlayTimer = setInterval(paintOverlay, 5000);
        setTimeout(paintOverlay, 1200);
      }

      /* ---------- the job director ----------
         Customers turn up at irregular times — sometimes a rush that fills all three
         stalls, sometimes a lull long enough for Sean to clear the lot. Each car is a job
         that runs arrive → (stall →) bay → finish. Sean works one task at a time, in
         order of priority each time he's free:
           1. greet a customer who's due, if there's somewhere to put the car and the apron
              is clear — straight onto the bay if it's empty and nobody's waiting, otherwise
              into the first free stall. Lot full: they're turned away and come back later.
           2. the next step on the car on the bay: amp, a breather, then the subs + reveal.
           3. fetch the longest-waiting car from the stalls.
           4. idle by the bay.
         Every path, route and keyframe below is built at the moment a task starts. */
      const T_OFF = [-62.0, 15.4], R_OFF = [-70.0, 15.4], APRON = [8.9, 4.6], BAY_SPOT = [9.0, -6.2];
      const BAY_V = new THREE.Vector3(9.0, 0, -6.2);
      const HIDE_KEYS = [{ t: 0, x: 0, z: 30, a: 'idle', hide: true }, { t: 1e9, x: 0, z: 30, a: 'idle', hide: true }];
      function mkRoute(segs) {
        let t = 0;
        return segs.map(sg => {
          const leg = Object.assign({}, sg, { t0: t, t1: t + sg.dur }); t += sg.dur;
          if (leg.pts) {
            leg.curve = new THREE.CatmullRomCurve3(leg.pts.map(([x, z]) => new THREE.Vector3(x, 0, z)), false, 'centripetal', 0.5);
            leg.curve.arcLengthDivisions = 120; leg.len = leg.curve.getLength();
          }
          return leg;
        });
      }
      const OFF_ROUTE = () => mkRoute([{ dur: 1e9, hold: T_OFF, head: Math.PI / 2, jump: true }]);
      const parkPts = (z) => [[8.9, 4.6], [9.1, 2.6], [10.4, 1.2], [13.0, 0.8], [17.5, 1.0], [21.3, 0.0],
                              [22.8, z + 0.9], [21.4, z - 1.4], [19.0, z - 0.2], [17.8, z], [16.45, z]];
      const fetchFwd = (z) => {
        const p = [[21.9, z - 3.4], [21.6, z - 0.2]]; let zz = z - 0.2, xx = 21.6;
        while (zz + 3.4 < -0.21) { zz += 3.4; xx -= 0.3; p.push([xx, zz]); }
        return p.concat([[20.4, -0.2], [17.6, 1.2], [13.4, 1.1], [10.4, 0.3], [9.2, -1.8], [9.0, -4.4], BAY_SPOT]);
      };
      const DRIVE_IN = [[-62.0, 15.4], [-30.0, 15.4], [-6.0, 15.4], [1.0, 15.0], [4.0, 12.8], [5.4, 10.0], [7.0, 7.0], [8.6, 5.4], APRON];
      const BAY_IN = [APRON, [9.0, 1.6], [9.0, -2.6], BAY_SPOT];
      const REVEAL_OUT = [BAY_SPOT, [9.0, -3.0], [8.95, 0.6], [8.9, 3.2], [8.7, 4.6], [8.4, 5.2], [7.6, 5.2]];
      const EXIT = [[7.6, 5.2], [11.0, 4.9], [15.6, 4.7], [19.2, 5.2], [20.4, 7.4], [20.8, 10.4], [21.8, 13.6], [24.4, 15.2], [31.0, 15.4], [44.0, 15.4]];

      // Sean's walking: through the bay door, and round the noses of the stall cars.
      const sReg = p => (p[0] > 5 && p[0] < 13 && p[1] < -1.9) ? 'bay' : (p[0] > 13.4 && p[1] < -0.4) ? 'east' : 'out';
      function sPath(a, b) {
        const ra = sReg(a), rb = sReg(b), pts = [a];
        if (ra !== rb) {
          if (ra === 'bay') pts.push([10.6, -2.6], [10.6, -0.8]);
          if (ra === 'east') pts.push([13.8, a[1]], [13.8, -0.9]);
          if (rb === 'east') pts.push([13.8, -0.9], [13.8, b[1]]);
          if (rb === 'bay') pts.push([10.6, -0.8], [10.6, -2.6]);
        }
        pts.push(b); return pts;
      }
      const segT = (p, q) => Math.max(0.25, Math.hypot(q[0] - p[0], q[1] - p[1]) / 1.5);
      const pathDur = pts => { let d = 0; for (let i = 1; i < pts.length; i++) d += segT(pts[i - 1], pts[i]); return d; };
      function walkKeys(keys, pts, t, endA) {
        for (let i = 0; i < pts.length; i++) {
          keys.push({ t, x: pts[i][0], z: pts[i][1], a: i < pts.length - 1 ? 'walk' : endA });
          if (i < pts.length - 1) t += segT(pts[i], pts[i + 1]);
        }
        return t;
      }
      const sealKeys = keys => { const k = keys[keys.length - 1]; keys.push({ t: k.t + 1e6, x: k.x, z: k.z, a: 'idle', hide: k.hide }); return keys; };

      const custArriveKeys = sealKeys(CUST_KEYS.filter(k => k.t <= 26.9).map(k => Object.assign({}, k, { t: k.t - 0.8 })));
      const custReturnKeys = sealKeys([{ t: 0, x: 6.4, z: 8.0, a: 'idle', hide: true }]
        .concat(CUST_KEYS.filter(k => k.t >= 184.2 && k.t < CYCLE).map(k => Object.assign({}, k, { t: k.t - 163 }))));
      const finishKeys = SEAN_KEYS.filter(k => k.t >= 53 && k.t <= 98.1).map(k => Object.assign({}, k, { t: k.t - 53 }));
      finishKeys[finishKeys.length - 1] = Object.assign({}, finishKeys[finishKeys.length - 1], { a: 'idle' });   // setTask seals it

      const jobs = heroes.map((H, i) => ({ H, cust: customers[i], state: 'free', route: OFF_ROUTE(), rt0: 0, ck: HIDE_KEYS, ck0: 0,
                                           stall: null, dest: null, arrT: 0, bayT: null, f0: 0, next: null }));
      const rides = [ride, ride2].map(car => ({ car, route: mkRoute([{ dur: 1e9, hold: R_OFF, head: Math.PI / 2, jump: true }]), rt0: 0, busy: -1 }));
      function bookRide(T, at) {
        const r = rides.find(q => q.busy <= T) || rides.reduce((a, b) => (a.busy < b.busy ? a : b));
        r.rt0 = T; r.busy = at + 10.6;
        r.route = mkRoute([{ dur: Math.max(0.01, at - T), hold: R_OFF, head: Math.PI / 2, jump: true },
                           { dur: 4.4, v0: 1, v1: 0, pts: RIDE_IN }, { dur: 1.4, hold: [8.4, 7.3], head: Math.PI / 2 },
                           { dur: 4.8, v0: 0, v1: 1, pts: RIDE_OUT }, { dur: 1e9, hold: R_OFF, head: Math.PI / 2, jump: true }]);
      }
      function arrivalGap() {
        const r = Math.random();
        return r < 0.35 ? 22 + Math.random() * 25 : r < 0.8 ? 70 + Math.random() * 80 : 180 + Math.random() * 140;
      }
      let sTask = null, seanAt = SEAN_HOME.slice(), nextArrival = 0, dirStarted = false;
      function setTask(kind, job, T, keys, onEnd, extra) {
        sealKeys(keys);
        const last = keys[keys.length - 2];
        sTask = Object.assign({ kind, job, t0: T, keys, end: T + last.t, endPos: [last.x, last.z], onEnd }, extra || {});
      }
      function taskIdle(T) {
        const keys = []; const t = walkKeys(keys, sPath(seanAt, SEAN_HOME), 0, 'idle');
        keys.push({ t: t + 3, x: SEAN_HOME[0], z: SEAN_HOME[1], a: 'idle' });
        setTask('idle', null, T, keys);
      }
      function taskGreet(j, T, stall) {
        j.state = 'arriving'; j.arrT = T; j.stall = stall; j.dest = stall ? 'stall' : 'bay';
        if (stall) stall.job = j;
        j.ck = custArriveKeys; j.ck0 = T;
        const pts = sPath(seanAt, [5.2, 4.6]), w = pathDur(pts);
        const keys = [{ t: 0, x: seanAt[0], z: seanAt[1], a: 'idle' }];
        const talk = walkKeys(keys, pts, Math.max(0.01, 8.6 - w), 'talk');
        const tIn = talk + 7.0, go = tIn + 0.6;
        keys.push({ t: talk + 6.1, x: 5.2, z: 4.6, a: 'walk' }, { t: tIn, x: 7.6, z: 4.8, a: 'idle', hide: true });
        const segs = [{ dur: 0.8, hold: T_OFF, head: Math.PI / 2, jump: true }, { dur: 7.2, v0: 1, v1: 0, pts: DRIVE_IN },
                      { dur: go - 8.0, hold: APRON, head: Math.PI }];
        if (stall) {
          const d = 7 + (-3.2 - stall.z) * 0.35;
          segs.push({ dur: d, v0: 0, v1: 0, pts: parkPts(stall.z) }, { dur: 1e9, hold: [stall.x, stall.z], head: -Math.PI / 2 });
          keys.push({ t: go + d + 0.2, x: stall.door[0], z: stall.door[1], a: 'idle', hide: true },
                    { t: go + d + 0.8, x: stall.door[0], z: stall.door[1], a: 'idle' });
          walkKeys(keys, sPath(stall.door, SEAN_HOME), go + d + 1.2, 'idle');
        } else {
          segs.push({ dur: 5.2, v0: 0, v1: 0, pts: BAY_IN }, { dur: 1e9, hold: BAY_SPOT, head: Math.PI });
          j.bayT = T + go + 5.2;
          keys.push({ t: go + 5.4, x: 7.7, z: -5.0, a: 'idle', hide: true }, { t: go + 6.0, x: 7.7, z: -5.0, a: 'idle' });
        }
        j.route = mkRoute(segs); j.rt0 = T;
        bookRide(T, T + 21.2);   // the customer's ride home
        setTask('greet', j, T, keys, () => { if (stall) j.state = 'parked'; else { j.state = 'bay'; j.next = 'amp'; } });
      }
      function taskFetch(j, T) {
        const st = j.stall;
        // Anyone napping on (or under) this car gets up first.
        cats.forEach(c => { if (c.res && c.res.spot.stall === st.k) { catRelease(c); c.path.length = 0; c.then = null; c.act = 'idle'; c.pose = 'sit'; c.wait = 0.3 + Math.random(); } });
        j.state = 'fetching';
        const pts = sPath(seanAt, st.door), keys = [];
        const w = walkKeys(keys, pts, 0, 'idle');
        keys.push({ t: w + 0.5, x: st.door[0], z: st.door[1], a: 'idle', hide: true });
        const fwd = 5.6 + (-3.2 - st.z) * 0.3, arrive = w + 0.6 + 3.4 + fwd;
        keys.push({ t: arrive + 0.2, x: 7.7, z: -5.0, a: 'idle', hide: true }, { t: arrive + 0.8, x: 7.7, z: -5.0, a: 'idle' });
        j.route = mkRoute([{ dur: w + 0.6, hold: [st.x, st.z], head: -Math.PI / 2 },
                           { dur: 3.4, v0: 0, v1: 0, gear: -1, pts: [[st.x, st.z], [19.6, st.z - 0.05], [21.5, st.z - 1.2], [21.9, st.z - 3.4]] },
                           { dur: fwd, v0: 0, v1: 0, pts: fetchFwd(st.z) }, { dur: 1e9, hold: BAY_SPOT, head: Math.PI }]);
        j.rt0 = T; j.bayT = T + arrive;
        setTask('fetch', j, T, keys, () => { st.job = null; j.stall = null; j.state = 'bay'; j.next = 'amp'; });
      }
      function taskAmp(j, T) {
        const keys = []; const t = walkKeys(keys, sPath(seanAt, [10.9, -8.4]), 0, 'work');
        keys.push({ t: t + 7, x: 10.9, z: -8.4, a: 'idle' });
        setTask('amp', j, T, keys, () => { j.next = 'breather'; });
      }
      function taskBreather(j, T) {
        const pts = sPath(seanAt, SEAN_HOME), w = pathDur(pts), keys = [];
        const t = walkKeys(keys, pts, 0, 'idle');
        keys.push({ t: t + 14, x: SEAN_HOME[0], z: SEAN_HOME[1], a: 'idle' });
        // seanRelax / seanPetCats were written against loop time 38 = start of this walk.
        setTask('breather', j, T, keys, () => { j.next = 'finish'; }, { ovOff: w - 1 });
      }
      function taskFinish(j, T) {
        j.state = 'finish'; j.f0 = T; j.next = null;
        j.ck = custReturnKeys; j.ck0 = T;
        bookRide(T, T + 16.6);   // brings the customer back for the reveal
        j.route = mkRoute([{ dur: 23.6, hold: BAY_SPOT, head: Math.PI }, { dur: 5.0, v0: 0, v1: 0, gear: -1, pts: REVEAL_OUT },
                           { dur: 17.0, hold: [7.6, 5.2], head: Math.PI / 2 }, { dur: 6.4, v0: 0, v1: 1, pts: EXIT },
                           { dur: 1e9, hold: T_OFF, head: Math.PI / 2, jump: true }]);
        j.rt0 = T;
        setTask('finish', j, T, finishKeys.map(k => Object.assign({}, k)));
      }
      function jobFlags(j, T) {
        const f = j.state === 'finish' ? T - j.f0 : -1;
        const atBay = j.bayT != null && T > j.bayT;
        return { inBay: atBay && f < 23.4, bootWork: f > 5 && f < 21.6, revealOpen: f > 30.4 && f < 41.4,
                 bassOn: f > 31 && f < 41, subsIn: f > 16.3 ? 2 : f > 6 ? 1 : 0, under: f > 30 && f < 52 };
      }
      function director(T) {
        if (!dirStarted) {
          // Open on a working shop: one car on the bay, one waiting by the door.
          dirStarted = true;
          const a = jobs[0]; a.state = 'bay'; a.next = 'amp'; a.bayT = T - 1; a.route = mkRoute([{ dur: 1e9, hold: BAY_SPOT, head: Math.PI }]); a.rt0 = T;
          const b = jobs[1]; b.state = 'parked'; b.stall = STALLS[0]; STALLS[0].job = b; b.arrT = T - 30;
          b.route = mkRoute([{ dur: 1e9, hold: [STALLS[0].x, STALLS[0].z], head: -Math.PI / 2 }]); b.rt0 = T;
          nextArrival = T + 18 + Math.random() * 25;
          taskAmp(a, T);
        }
        jobs.forEach(j => { if (j.state === 'finish' && T - j.f0 > 53) { j.state = 'free'; j.bayT = null; j.route = OFF_ROUTE(); j.ck = HIDE_KEYS; } });
        if (T < sTask.end) return;
        const done = sTask; seanAt = done.endPos.slice(); sTask = null;
        if (done.onEnd) done.onEnd();
        const bayJob = jobs.find(j => j.state === 'bay');
        const bayBusy = !!bayJob || jobs.some(j => j.state === 'fetching' || (j.state === 'arriving' && j.dest === 'bay') || (j.state === 'finish' && T - j.f0 < 28.8));
        const apronBusy = jobs.some(j => j.state === 'finish' && T - j.f0 < 50);
        const waiting = jobs.filter(j => j.state === 'parked').sort((a, b) => a.arrT - b.arrT);
        if (T >= nextArrival && !apronBusy && !(bayJob && bayJob.next === 'finish') && rides.some(r => r.busy <= T)) {
          const free = jobs.find(j => j.state === 'free'), stall = STALLS.find(st => !st.job);
          const toBay = !bayBusy && !waiting.length;
          nextArrival = T + arrivalGap();
          if (free && (toBay || stall)) return taskGreet(free, T, toBay ? null : stall);
          // Lot's full: they drive on and the next customer is a while off.
        }
        if (bayJob) {
          if (bayJob.next === 'amp') return taskAmp(bayJob, T);
          if (bayJob.next === 'breather') return taskBreather(bayJob, T);
          if (bayJob.next === 'finish') return taskFinish(bayJob, T);
        }
        if (!bayBusy && waiting.length) return taskFetch(waiting[0], T);
        taskIdle(T);
      }

      /* One customer car for one frame: drive it along ROUTE at its own phase, and run the
         lids, installs, underglow and bass off that same phase. */
      function stepHero(H, c2, F, dt) {
        const car = H.car;
        car.position.x = c2.x; car.position.z = c2.z;
        car.userData.setShown(Math.abs(c2.x) < 56);
        const driving = c2.speed > 0.25;
        car.rotation.y = c2.head;
        // Headlights follow the ambient level with no daytime floor — off in daylight.
        const headOn = (driving && !c2.rev) ? dayState.lamp : dayState.lamp * 0.25;
        car.userData.heads.forEach(h => (h.material.opacity = headOn));
        const heroBeam = (driving && !c2.rev) ? 160 * dayState.lamp : 0;
        car.userData.beams.forEach(b => { b.intensity = heroBeam; });
        // Both visitor beams flip together, once per dusk/dawn, so the shader recompile
        // that comes with a change in shadow-caster count happens twice a day, not per car.
        const wantCast = dayState.lamp > 0.3;
        if (car.userData.beams[0].castShadow !== wantCast) car.userData.beams[0].castShadow = wantCast;

        /* The reveal: hood up while Sean works on the bay, hood AND boot up out on the
           apron so the amp and both subs are visible, everything shut before they leave. */
        const inBay = F.inBay, bootWork = F.bootWork, revealOpen = F.revealOpen, bassOn = F.bassOn;
        const lidRate = Math.min(1, dt * 2.4);
        H.hoodPivot.rotation.x = THREE.MathUtils.lerp(H.hoodPivot.rotation.x, (inBay || revealOpen) ? HOOD_OPEN : 0, lidRate);
        H.trunkPivot.rotation.x = THREE.MathUtils.lerp(H.trunkPivot.rotation.x, (bootWork || revealOpen) ? TRUNK_OPEN : 0, lidRate);
        const hoodOpen = Math.min(1, H.hoodPivot.rotation.x / HOOD_OPEN);
        const trunkOpen = Math.min(1, H.trunkPivot.rotation.x / TRUNK_OPEN);
        // Subs hold inside the shell until the lid is past ~60°, then rise over the last of
        // the swing, so the sweep never crosses them.
        const subCue = THREE.MathUtils.smoothstep(trunkOpen, 0.62, 1.0);
        H.ampRig.position.y = 0.55 + hoodOpen * 0.62;
        H.subRig.position.y = 0.55 + subCue * 0.70;
        H.ampRig.visible = hoodOpen > 0.04 && !inBay;
        // Each sub appears as Sean sets it in (loop 59 and 69.3 → phase 169 and 179.3).
        const subsIn = F.subsIn;
        H.subRig.visible = trunkOpen > 0.04 && subsIn > 0;
        H.subUnits.forEach((u, i) => { u.visible = i < subsIn; });
        H.ampLed.material.opacity = H.ampRig.visible ? 0.9 : 0;

        const lampMix = Math.max(0.3, dayState.lamp);
        // Underglow comes on with the reveal and stays lit as they drive away.
        const wantUnder = F.under ? 1 : 0;
        H.underAmt += (wantUnder - H.underAmt) * Math.min(1, dt * 2.2);
        const hue = 0.74 + Math.sin(clock.elapsedTime * 0.5) * 0.06;
        H.underGlow.material.color.setHSL(hue, 0.85, 0.6);
        H.underLight.color.setHSL(hue, 0.85, 0.6);
        // The beat: fast attack, slow release.
        const thump = Math.pow(Math.max(0, Math.sin(clock.elapsedTime * 4.6)), 3);
        const bassAmp = bassOn ? 0.55 + thump * 0.45 : 0;
        H.underGlow.material.opacity = H.underAmt * lampMix * (0.55 + bassAmp * 0.35);
        H.underLight.intensity = H.underAmt * lampMix * (3 + bassAmp * 5);
        // The car rocks on its springs with the bass, and the cones move with it.
        car.position.y = bassAmp * 0.035 * thump;
        car.rotation.z = bassAmp * 0.012 * Math.sin(clock.elapsedTime * 4.6);
        H.subCones.forEach(c => { c.position.z = c.userData.z0 ?? (c.userData.z0 = c.position.z); });
        if (H.subRig.visible) H.subCones.forEach(c => { c.position.z = c.userData.z0 - thump * 0.05; });
        for (let i = 0; i < H.bassArcs.length; i++) {
          const a2 = H.bassArcs[i];
          a2.visible = bassOn;
          if (!bassOn) continue;
          const ph = (clock.elapsedTime * 0.5 + i / H.bassArcs.length) % 1;
          const s2 = 0.3 + ph * 1.95;
          a2.scale.set(s2, s2, 1);
          a2.material.opacity = Math.sin(ph * Math.PI) * 0.6 * bassAmp;
        }
        return c2;
      }

      // Profiling hook: window.__spectrumProfile() returns per-stage ms averaged over the
      // last 60 frames, plus renderer counters.
      const PROF = { marks: {}, n: 0, t0: 0 };
      const pmark = (k, t) => { PROF.marks[k] = (PROF.marks[k] || 0) + (performance.now() - t); };
      window.__spectrumProfile = () => {
        const out = {}; for (const k in PROF.marks) out[k] = +(PROF.marks[k] / Math.max(1, PROF.n)).toFixed(2);
        const i = renderer.info;
        return { frames: PROF.n, stagesMs: out, calls: i.render.calls, tris: i.render.triangles, geoms: i.memory.geometries, tex: i.memory.textures,
                 programs: i.programs.length, lightsOn: (lightPool ? lightPool.points.concat(lightPool.spots) : []).filter(L => L.visible).length, lampsTotal: lamps.length,
                 shadowCasters: (() => { let n = 0; scene.traverse(o => { if (o.isLight && o.castShadow && o.visible) n++; }); return n; })(),
                 castMeshes: (() => { let n = 0; scene.traverse(o => { if (o.isMesh && o.castShadow && o.visible) n++; }); return n; })(),
                 meshes: (() => { let n = 0; scene.traverse(o => { if (o.isMesh && o.visible) n++; }); return n; })(),
                 heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(0) : null };
      };
      window.__spectrumProfileReset = () => { PROF.marks = {}; PROF.n = 0; };
      function frame() {
        if (this._dead) { this._looping = false; return; }
        this._raf = requestAnimationFrame(loop);

        // Hard stop when nobody can see it. A background tab or a scrolled-past canvas has
        // no business holding the GPU while the user is on a video call.
        if (document.hidden || this._offscreen) { clock.getDelta(); return; }

        // 30fps cap. This is a slow diorama — a day cycle, a car at walking pace — and it
        // reads identically at half the frames for half the power.
        const now = performance.now();
        if (now - lastDraw < 32) return;
        const _pf = performance.now(); let _pt = _pf;
        lastDraw = now;

        const dt = Math.min(clock.getDelta(), 0.05);
        const t = clock.elapsedTime % CYCLE;          // car A's phase
        const pB = (t + SEAN_H) % CYCLE;              // car B runs half a cycle behind
        const ts = t % SEAN_H;                        // Sean's loop
        // Real shop-local time drives the cycle; _dayOverride pins it for capture.
        let p;
        if (this._dayOverride != null) p = this._dayOverride;
        else if (ENV) p = ENV.get().phase;
        else p = (clock.elapsedTime % DAY) / DAY;

        // applyDay walks every lamp and glow and relerps the whole palette. The day phase
        // moves by ~1e-5 per frame, so recomputing it 60 times a second is pure waste —
        // run it when the phase has actually moved, or when the weather changed under us.
        if (Math.abs(p - lastAppliedP) > 3e-4 || weatherDirty) {
          lastAppliedP = p;
          weatherDirty = false;
          applyDay(p);
        }
        stepNeon(clock.elapsedTime);
        stepHoliday(clock.elapsedTime, dt);
        // The parts store closes at eight. After hours its windows go dark and cool like
        // the detailer's — only Spectrum works this late. Hour comes from the shop clock;
        // without live data it follows the synthetic day instead.
        {
          const hr = ENV ? (ENV.get().hour ?? 12) : (p * 24 + 5) % 24;
          const open = hr >= 8 && hr < 20;
          partsGlowRecs.forEach(g => { if (!g) return; g.base = open ? 0.75 : 0; g.floor = open ? 0.18 : 0; });
          partsLampRec.base = open ? 9 : 0;
          // Closed: near-black glass with a faint night tint, so the panes read as dark
          // windows in a dark front rather than grey cards. By day the unlit tint can stay
          // pale, like the detailer's.
          const dark = dayState.lamp > 0.3;
          partsGlow.forEach(m => {
            m.material.color.setHex(open ? 0xFFE0A0 : dark ? 0x141A22 : 0x5A6670);
            if (!open) m.material.opacity = dark ? 0.85 : 0.55;
          });
          partsLamp.intensity = open ? partsLamp.intensity : 0;
          darkPanes.forEach(m => { m.material.color.setHex(dark ? 0x141A22 : 0x5A6670); m.material.opacity = dark ? 0.85 : 0.55; });
        }

        /* Sean, the customers and their cars, all run by the job director. */
        const Tn = clock.elapsedTime;
        director(Tn);
        // Read-only status for a host page (the home page's live captions). Updated in place.
        { const st = renderer.domElement.__status || (renderer.domElement.__status = {});
          st.task = sTask ? sTask.kind : 'idle';
          let w = 0; for (const j of jobs) if (j.state === 'parked') w++;
          st.waiting = w; st.couch = RELAX.on; st.lap = !!(LAP.cat && LAP.cat.act === 'lap'); st.petting = !!SEAN_PET.on;
          st.night = dayState.lamp > 0.5; }
        { const tk = sTask, tl = Tn - tk.t0;
          stepPerson(sean, tk.keys, tl, dt, tk.job ? tk.job.cust.position : null, tk.job ? tk.job.H.car.position : BAY_V);
          const bl = tk.kind === 'breather' ? 38 + tl - tk.ovOff : 0;
          seanPetCats(bl, dt);
          seanRelax(bl, dt); }
        jobs.forEach(j => stepPerson(j.cust, j.ck, Tn - j.ck0, dt, sean.position, j.H.car.position));
        const heroStates = jobs.map(j => stepHero(j.H, driveCar(j.route, Tn - j.rt0), jobFlags(j, Tn), dt));

        /* The rideshares */
        const rideStates = rides.map(r => {
          const r2 = driveCar(r.route, Tn - r.rt0), car = r.car;
          car.position.x = r2.x; car.position.z = r2.z; car.rotation.y = r2.head;
          car.userData.setShown(Math.abs(r2.x) < 56);
          const drv = r2.speed > 0.25;
          car.userData.heads.forEach(h => (h.material.opacity = dayState.lamp * (drv ? 1 : 0.3)));
          const bm = drv ? 160 * dayState.lamp : 0;
          car.userData.beams.forEach(b => { b.intensity = bm; });
          return r2;
        });



        /* Overlay clock */
        const e0 = els();
        if (e0.clock) {
          let label, ph;
          if (ENV) { const d0 = ENV.get(); label = d0.clockLabel; ph = d0.phaseLabel; }
          else {
            const h24 = (p * 24 + 5) % 24;
            label = String(Math.floor(h24)).padStart(2, '0') + ':' +
                    String(Math.floor((h24 % 1) * 60)).padStart(2, '0');
            ph = p < 0.08 ? 'Dawn' : p < 0.42 ? 'Morning' : p < 0.56 ? 'Afternoon'
               : p < 0.66 ? 'Golden hour' : p < 0.78 ? 'Dusk' : 'Night';
          }
          if (label !== lastLabel) {
            e0.clock.textContent = label;
            if (e0.phase) e0.phase.textContent = ph;
            lastLabel = label;
          }
        }

        /* Passing traffic on the far lane */
        /* Passing traffic on the road */
        parkedCars.forEach(c3 => {
          c3.userData.heads.forEach(h => (h.material.opacity = dayState.lamp * 0.22));
        });
        /* Car-following. Both the hero and the rideshare use the eastbound lane to come
           and go, and the through traffic has no lane of its own to escape to, so every
           car on the road yields to whatever is in its lane: the two visitors (counted
           from the moment they're in the exit drive or the entry sweep, z > ~6.8, not
           only once they're centred in the lane), and the other through cars travelling
           the same way — which previously ran at independent speeds round a 140 m loop
           and simply drove through one another when the faster caught the slower. */
        /* The parts-store customer */
        const tShop = clock.elapsedTime % SHOP_CYCLE;
        const s3 = driveCar(SHOP_ROUTE, tShop);
        shopperCar.position.x = s3.x; shopperCar.position.z = s3.z; shopperCar.rotation.y = s3.head;
        shopperCar.userData.setShown(Math.abs(s3.x) < 56);
        const shopDriving = s3.speed > 0.25;
        shopperCar.userData.heads.forEach(h => (h.material.opacity = dayState.lamp * (shopDriving ? 1 : 0)));
        const shopBeam = (shopDriving && !s3.rev) ? 160 * dayState.lamp : 0;
        shopperCar.userData.beams.forEach(b => { b.intensity = shopBeam; });
        stepPerson(shopper, SHOPPER_KEYS, tShop, dt, null, shopperCar.position);
        stepBusRider(clock.elapsedTime, dt);
        // Anyone standing still with the tuxedo winding round their ankles bends down to
        // her. Layered over the keyframed pose, same as Sean's rainy-day visits.
        cats.forEach(c => {
          if (c.act !== 'rub' || !c.greetee || !c.greetee.userData.shown || c.greetee.userData.moving) return;
          const f = c.greetee, d = f.userData;
          d.ph += dt * 3.2;
          const stroke = Math.sin(d.ph) * 0.18;
          d.torso.rotation.x = 0.7; d.hips.position.y = -0.3;
          d.legL.rotation.x = -1.0; d.legR.rotation.x = 0.45;
          d.armR.rotation.x = -0.5 + stroke; d.armL.rotation.x = -0.15;
          d.armR.rotation.z = 0; d.armL.rotation.z = 0;
          d.h += shortestArc(Math.atan2(c.g.position.x - f.position.x, c.g.position.z - f.position.z), d.h) * Math.min(1, dt * 6);
          f.rotation.y = d.h;
        });

        /* The cats */
        // Each mover carries its direction of travel (nose, or tail when reversing).
        const mover = (car, d2, on) => {
          const a = d2.head + (d2.rev ? Math.PI : 0);
          return { p: car.position, v: on ? d2.speed : 0, dx: Math.sin(a), dz: Math.cos(a) };
        };
        stepCats(dt, clock.elapsedTime, jobs.map((j, i) => mover(j.H.car, heroStates[i], j.H.car.userData.shown))
          .concat(rides.map((r, i) => mover(r.car, rideStates[i], r.car.userData.shown)), [mover(shopperCar, s3, shopperCar.userData.shown)]));

        const laneCars = [];
        jobs.forEach((j, i) => { if (j.H.car.userData.shown) laneCars.push({ x: j.H.car.position.x, z: j.H.car.position.z, v: Math.abs(heroStates[i].speed) }); });
        rides.forEach((r, i) => { if (r.car.userData.shown) laneCars.push({ x: r.car.position.x, z: r.car.position.z, v: Math.abs(rideStates[i].speed) }); });
        if (shopperCar.userData.shown) laneCars.push({ x: s3.x, z: s3.z, v: Math.abs(s3.speed) });
        traffic.forEach(t2 => {
          const obs = laneCars.filter(o => Math.abs(o.z - t2.car.position.z) < 3.6);
          traffic.forEach(o => { if (o !== t2 && o.dir === t2.dir) obs.push({ x: o.x, z: o.car.position.z, v: o.speed }); });
          let speed = t2.speed;
          // The nearest obstacle ahead in the direction of travel sets the pace.
          let lead = null, leadGap = Infinity;
          obs.forEach(o => {
            const g = (o.x - t2.x) * t2.dir;
            if (g > 0 && g < leadGap) { lead = o; leadGap = g; }
          });
          if (lead && leadGap < GAP_MIN * 1.6) speed = Math.min(speed, Math.max(lead.v, 2));
          t2.x += speed * t2.dir * dt;
          // Hard gap on whichever side of each obstacle this car already sits.
          obs.forEach(o => {
            const g = (t2.x - o.x) * t2.dir;
            if (g >= 0) t2.x = o.x + Math.max(g, GAP_MIN) * t2.dir;
            else t2.x = o.x - Math.max(-g, GAP_MIN) * t2.dir;
          });
          // Wrap round out of view — and never into a car already holding at that end.
          if (t2.x * t2.dir > 70) {
            let nx = -70 * t2.dir;
            for (let k = 0; k < 6; k++) {
              const hit = obs.find(o => Math.abs(o.x - nx) < GAP_MIN);
              if (!hit) break;
              nx -= GAP_MIN * 1.2 * t2.dir;
            }
            t2.x = nx;
          }
          t2.car.position.x = t2.x;
          const lit = dayState.lamp;
          t2.car.userData.heads.forEach(h => (h.material.opacity = lit));
          t2.car.userData.tails.forEach(h => (h.material.opacity = 0.75 * lit));
          t2.car.userData.beams[0].intensity = 160 * dayState.lamp;
        });

        /* Weather motion */
        // Gutters run only in rain, and lag the shower a little so they keep dripping as
        // it eases rather than snapping off.
        const wantFlow = WEATHER.precip === 'rain' ? Math.min(1, 0.35 + WEATHER.rate * 0.9) : 0;
        gutterFlow += (wantFlow - gutterFlow) * Math.min(1, dt * 0.9);
        const running = gutterFlow > 0.02;
        waterMat.visible = running;
        if (running) {
          // Positive offset scrolls the sampled window up, which reads as the water
          // travelling DOWN the plane. The old sign ran it backwards, up the pipe.
          streakTex.offset.y += dt * (2.2 + gutterFlow * 2.6);
          waterMat.opacity = gutterFlow * 0.7;
          splashMat.opacity = gutterFlow * 0.4;
          for (let i = 0; i < splashes.length; i++) {
            const s2 = splashes[i];
            s2.ring.visible = true;
            const ph = (clock.elapsedTime * 1.7 + s2.off) % 1;
            s2.ring.scale.setScalar(0.35 + ph * 1.25);
            s2.ring.material = splashMat;
            s2.ring.visible = ph < 0.95;
          }
        } else {
          for (let i = 0; i < splashes.length; i++) splashes[i].ring.visible = false;
        }
        if (precip.visible || rain.visible) {
          const snowing = WEATHER.precip === 'snow';
          const fall = (snowing ? 2.2 : 26) * (0.55 + WEATHER.rate * 0.75);
          const wRad = (WEATHER.windDeg + 180) * Math.PI / 180;
          const drift = Math.min(WEATHER.wind, 40) * (snowing ? 0.055 : 0.016);
          const dx = Math.sin(wRad) * drift, dz = Math.cos(wRad) * drift;
          const arr = pGeo.attributes.position.array;
          for (let i = 0; i < PCOUNT; i++) {
            const j = i * 3;
            arr[j + 1] -= fall * pVel[i] * dt;
            arr[j]     += dx * dt * (snowing ? pVel[i] : 1);
            arr[j + 2] += dz * dt * (snowing ? pVel[i] : 1);
            if (snowing) arr[j] += Math.sin(clock.elapsedTime * 1.7 + i) * 0.006;
            if (arr[j + 1] < 0 || sheltered(arr[j], arr[j + 1], arr[j + 2])) {
              arr[j + 1] = P_AREA.y;
              arr[j]     = P_AREA.cx + (Math.random() - 0.5) * P_AREA.x;
              arr[j + 2] = P_AREA.cz + (Math.random() - 0.5) * P_AREA.z;
            }
          }
          if (snowing) {
            pGeo.attributes.position.needsUpdate = true;
          } else {
            // Each drop becomes a streak leaning with the wind — length scales with the
            // fall rate, so a heavy shower reads as longer, faster lines.
            const len = 0.5 + WEATHER.rate * 0.9;
            const lx = dx * 0.06, lz = dz * 0.06;
            for (let i = 0; i < PCOUNT; i++) {
              const j = i * 3, k = i * 6;
              rPos[k]     = arr[j];
              rPos[k + 1] = arr[j + 1];
              rPos[k + 2] = arr[j + 2];
              rPos[k + 3] = arr[j] + lx;
              rPos[k + 4] = arr[j + 1] + len * pVel[i];
              rPos[k + 5] = arr[j + 2] + lz;
            }
            rGeo.attributes.position.needsUpdate = true;
          }
        }

        pmark('sim', _pt); _pt = performance.now();
        if (drifting) {
          driftOff.copy(camera.position).sub(controls.target);
          driftSph.setFromVector3(driftOff);
          driftSph.theta = AZ_BASE + Math.sin(clock.elapsedTime * 0.075) * AZ_SWING;
          driftOff.setFromSpherical(driftSph);
          camera.position.copy(controls.target).add(driftOff);
        }
        // Light budget is only worth recomputing a few times a second.
        if (clock.elapsedTime - lastBudget > 0.25) {
          lastBudget = clock.elapsedTime;
          budgetLights();
        }
        if (PEEK.hush && PEEK.k === 0 && performance.now() - (PEEK.lastWheel || 0) > 450) { PEEK.hush = false; controls.enableZoom = true; }
        if (PEEK.on || PEEK.k > 0.001) {
          // Ease in and out of the peek over the orbit's last state.
          const want = PEEK.on ? 1 : 0;
          PEEK.k += (want - PEEK.k) * Math.min(1, dt * 3.2);
          if (!PEEK.on && PEEK.k < 0.02) {
            PEEK.k = 0;
            camera.position.copy(peekFrom.pos); controls.target.copy(peekFrom.tgt); camera.zoom = peekFrom.zoom;
            camera.near = BASE_NEAR; fadeHud(false); followCat = null;
            camera.updateProjectionMatrix();
            controls.enabled = live();
          } else {
            const e = PEEK.k * PEEK.k * (3 - 2 * PEEK.k);
            if (followCat) {
              tmpVec.copy(followCat.g.position); tmpVec.y += 0.3;
              PEEK_PIVOT.lerp(tmpVec, Math.min(1, dt * 5));
            }
            // Live look-around: the arm's end is the peek camera position.
            const cp = Math.cos(PEEK_LOOK.pitch);
            const yw = peekCfg.yaw0 + PEEK_LOOK.yaw;
            PEEK_POS.set(PEEK_PIVOT.x + Math.sin(yw) * cp * PEEK_ARM, PEEK_PIVOT.y + Math.sin(PEEK_LOOK.pitch) * PEEK_ARM, PEEK_PIVOT.z + Math.cos(yw) * cp * PEEK_ARM);
            PEEK_TGT.copy(PEEK_PIVOT);
            // Level changes blend between the two fixed views over a second.
            let px = PEEK_POS, ptg = PEEK_TGT, pz = PEEK_ZOOM;
            if (PEEK.stage) {
              PEEK.stage.t = Math.min(1, PEEK.stage.t + dt * 1.1);
              const q = PEEK.stage.t * PEEK.stage.t * (3 - 2 * PEEK.stage.t), F = PEEK_VIEWS[PEEK.stage.from];
              px = peekStage.pos.lerpVectors(F.pos, PEEK_POS, q);
              ptg = peekStage.tgt.lerpVectors(F.tgt, PEEK_TGT, q);
              pz = F.zoom + (PEEK_ZOOM - F.zoom) * q;
              if (PEEK.stage.t >= 1) PEEK.stage = null;
            }
            camera.position.lerpVectors(peekFrom.pos, px, e);
            tmpVec.lerpVectors(peekFrom.tgt, ptg, e);
            camera.zoom = peekFrom.zoom + (pz - peekFrom.zoom) * e;
            fadeHud(PEEK.on && e > 0.92);
            // Push the near plane out to just short of the cat, but never past where the
            // frame's bottom edge meets the ground, or the ground itself is cut away.
            if (followCat && PEEK.on && e > 0.92) {
              const p = PEEK_LOOK.pitch, sp = Math.max(0.05, Math.sin(p));
              const toGround = (camera.position.y - (VIEW / camera.zoom) * Math.cos(p)) / sp - 0.3;
              camera.near = Math.max(BASE_NEAR, Math.min(PEEK_ARM - 1.6, toGround));
            } else camera.near = BASE_NEAR;
            camera.updateProjectionMatrix();
            camera.lookAt(tmpVec);
          }
        } else {
          controls.update();
        }
        pmark('camera', _pt); _pt = performance.now();
        renderer.render(scene, camera);
        pmark('render', _pt); pmark('total', _pf); PROF.n++;
      }
      const loop = frame.bind(this);

      /* ---------- sizing ---------- */
      const PIXEL_BUDGET = 2.6e6;   // ~2.0k × 1.3k device pixels
      const resize = () => {
        const w = this.clientWidth || 960, h = this.clientHeight || 600;
        const pr = Math.min(devicePixelRatio || 1, 2, Math.sqrt(PIXEL_BUDGET / (w * h)));
        renderer.setPixelRatio(Math.max(1, pr));
        renderer.setSize(w, h, false);
        const aspect = w / h;
        camera.left = -VIEW * aspect; camera.right = VIEW * aspect;
        camera.top = VIEW; camera.bottom = -VIEW;
        camera.updateProjectionMatrix();
      };
      resize();
      this._ro = new ResizeObserver(resize);
      this._ro.observe(this);

      // Scrolled out of view is the same as hidden as far as the GPU is concerned.
      this._offscreen = false;
      this._io = new IntersectionObserver(([e]) => { this._offscreen = !e.isIntersecting; }, { threshold: 0 });
      this._io.observe(this);
      this._onVis = () => { if (!document.hidden) { clock.getDelta(); lastDraw = 0; } };
      document.addEventListener('visibilitychange', this._onVis);

      // Preview any condition without waiting for the real weather to change:
      //   el.setWeather({ precip: 'snow', precipRate: 0.8, cloud: 0.9 })
      //   el.setWeather(null)  // back to live
      // Pin a holiday from the console: a key from HOLIDAY_LABEL, 'none', or null for live.
      this.setHoliday = (k) => { holPinned = k === null || k === undefined ? undefined : (k === 'none' ? null : k); holCheck = -1; };
      this.getHoliday = () => ({ key: holKey, label: holKey ? HOLIDAY_LABEL[holKey] : null, live: holPinned === undefined });
      this.setWeather = (w) => {
        PINNED.wx = (w && w.label) || (w && w.precip !== 'none' ? w.precip : (w ? 'clear' : null));
        if (w == null) { PINNED.wx = null; applyWeather(ENV ? ENV.data : { cloud: 0, precip: 'none', precipRate: 0, fog: 0 }); paintOverlay(); return; }
        applyWeather(Object.assign({ cloud: 0, precip: 'none', precipRate: 0, fog: 0, windSpeed: 8, windDeg: 180 }, w));
        paintOverlay();
      };
      this.scene = scene;
      this.camera = camera;
      this.controls = controls;
      // Pin the cycle to a phase (0 dawn · 0.3 midday · 0.6 golden · 0.86 night),
      // or pass null to resume the rotation.
      this.setDayPhase = (v) => {
        this._dayOverride = (v == null) ? null : Math.max(0, Math.min(0.9999, v));
        PINNED.phase = this._dayOverride;
        paintOverlay();
      };
      // Paint a single frame on demand. requestAnimationFrame is suspended whenever the
      // document is hidden, so capture and export need a way to force one render.
      this.renderOnce = (p) => {
        const phase = (p != null) ? Math.max(0, Math.min(0.9999, p))
                    : (this._dayOverride != null ? this._dayOverride
                    : (ENV ? ENV.get().phase : 0.86));
        applyDay(phase);   // render-only — does not touch _dayOverride
        // The live loop skips applyDay unless the phase has moved, so a one-off render at
        // a pinned phase must invalidate that comparison or the scene stays where capture
        // left it for ~26 seconds.
        lastAppliedP = -9;
        budgetLights();
        controls.update();
        renderer.render(scene, camera);
      };
      this._resume = () => {
        if (this._looping || this._dead) return;
        this._looping = true;
        loop();
      };
      this.dispatchEvent(new CustomEvent('diorama-ready', { bubbles: true }));
      this._resume();
    }
  }

  if (!customElements.get('shop-diorama')) customElements.define('shop-diorama', ShopDiorama);
})();
