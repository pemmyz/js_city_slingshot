(function() {
  const pl = planck;
  const Vec2 = pl.Vec2;

  // ----- Global App State -----
  const APP = {
    world: null,
    physicsManager: null,
    uiPanelManager: null,
    physicsTelemetry: null,
    // Game state
    blocks: [],
    bird: null,
    boundaryBody: null,
    destructibleMode: true,
    bodiesToDestroy: [],
    // Slingshot
    slingshot: {
      base: Vec2(3.0, 2.0), isAiming: false, showDrag: false,
      pointerWorld: Vec2(3.0, 2.0), launched: false,
    },
    // Configs
    buildingSettings: {
      numBuildings: 1, minWidth: 6, maxWidth: 6, minHeight: 10, maxHeight: 10,
    },
    // Canvas & rendering
    canvas: document.getElementById('c'),
    ctx: null,
    dpr: Math.max(1, window.devicePixelRatio || 1),
    PPM: 50,
    camera: { pos: Vec2(15, 8) }
  };
  APP.ctx = APP.canvas.getContext('2d');

  /**
   * Manages all physics settings, performance profiles, and advanced optimizations.
   */
  class PhysicsManager {
    constructor(world) {
      this.world = world;
      this.grid = new SpatialHashGrid(1.0);
      this.deactivatedBodies = new Map();
      this.settings = this.getProfile('original');
      this.telemetry = {
        step_ms: 0, substeps: 0, bodies_active: 0, bodies_deactivated: 0,
        contacts_solved: 0, contacts_disabled: 0, fps: 0,
      };
      this.lastStepTimes = [];
      this.whitelist = new Set();
      this.world.on('pre-solve', this.preSolve.bind(this));
    }

    getProfile(name) {
      const base = {
        velocityIterations: 8, positionIterations: 3, hz: 60,
        enableCCDForBullets: true, allowSleep: true, timeToSleep: 0.5,
        linearSleepTolerance: 0.05, angularSleepTolerance: 0.05,
      };
      switch (name) {
        case 'original':
          return { ...base,
            enableNeighborFilter: false, gridCellSize: 1.0, neighborRadiusCells: 1,
            enableDeactivation: false, maxActiveDistance: 100, reactivateMargin: 10,
          };
        case 'neighbor':
          return { ...base,
            velocityIterations: 7, positionIterations: 2,
            enableNeighborFilter: true, gridCellSize: 0.6, neighborRadiusCells: 1,
            enableDeactivation: false, maxActiveDistance: 100, reactivateMargin: 10,
          };
        case 'aggressive':
          return { ...base,
            velocityIterations: 6, positionIterations: 2, hz: 45,
            enableNeighborFilter: true, gridCellSize: 0.6, neighborRadiusCells: 1,
            enableDeactivation: true, maxActiveDistance: 40, reactivateMargin: 5,
          };
      }
    }

    applyProfile(name) {
      this.settings = this.getProfile(name);
      this.updateAllBodies();
      this.updateFromSettings();
    }

    updateFromSettings() {
      this.world.setAllowSleeping(this.settings.allowSleep);
      this.grid.cellSize = this.settings.gridCellSize;
    }
    
    updateAllBodies() {
      for (const [body, data] of this.deactivatedBodies.entries()) {
        if(body.m_world) body.setActive(true);
      }
      this.deactivatedBodies.clear();
      if (APP.bird) {
        APP.bird.setBullet(this.settings.enableCCDForBullets);
      }
    }

    step(dt) {
      const stepStart = performance.now();
      this.world.step(dt, this.settings.velocityIterations, this.settings.positionIterations);
      const stepTime = performance.now() - stepStart;
      this.lastStepTimes.push(stepTime);
      if (this.lastStepTimes.length > 10) this.lastStepTimes.shift();
      this.telemetry.step_ms = this.lastStepTimes.reduce((a,b)=>a+b,0)/(this.lastStepTimes.length || 1);
    }

    updatePostStep() {
      this.telemetry.contacts_disabled = 0;
      if (this.settings.enableNeighborFilter) this.updateGrid();
      if (this.settings.enableDeactivation) this.updateLOD();
    }

    updateGrid() {
      this.grid.clear();
      for (let b = this.world.getBodyList(); b; b = b.getNext()) {
        if (b.isDynamic() && b.isActive()) this.grid.add(b);
      }
    }
    
    updateLOD() {
      const camPos = APP.camera.pos;
      for (let b = this.world.getBodyList(); b; b = b.getNext()) {
        if (!b.isDynamic() || !b.isActive() || b.isAwake()) continue;
        const dist = Vec2.distance(b.getPosition(), camPos);
        if (dist > this.settings.maxActiveDistance && !this.deactivatedBodies.has(b)) {
          b.setActive(false);
          this.deactivatedBodies.set(b, true);
        }
      }
      const reactivateDist = this.settings.maxActiveDistance - this.settings.reactivateMargin;
      for (const [body, _] of this.deactivatedBodies.entries()) {
        if (!body.m_world) { this.deactivatedBodies.delete(body); continue; }
        const dist = Vec2.distance(body.getPosition(), camPos);
        if (dist < reactivateDist) {
          body.setActive(true);
          this.deactivatedBodies.delete(body);
        }
      }
    }

    preSolve(contact) {
      if (!this.settings.enableNeighborFilter) return;
      const bA = contact.getFixtureA().getBody();
      const bB = contact.getFixtureB().getBody();
      if (this.whitelist.has(bA) || this.whitelist.has(bB) || !bA.isDynamic() || !bB.isDynamic()) return;
      if (!this.grid.areNeighbors(bA, bB, this.settings.neighborRadiusCells)) {
        contact.setEnabled(false);
        this.telemetry.contacts_disabled++;
      }
    }
    
    collectTelemetry() {
      let activeBodies = 0;
      for (let b = this.world.getBodyList(); b; b = b.getNext()) {
        if(b.isDynamic() && b.isActive()) activeBodies++;
      }
      this.telemetry.bodies_active = activeBodies;
      this.telemetry.bodies_deactivated = this.deactivatedBodies.size;
      this.telemetry.contacts_solved = this.world.getContactCount();
    }
  }

  /** Manages the performance UI panel. */
  class UIPanelManager {
    constructor(physicsManager) {
      this.physicsManager = physicsManager;
      this.panel = document.getElementById('perf-panel');
      this.dom = {}; this.init();
    }

    init() {
      document.getElementById('perf-handle').addEventListener('click', () => this.panel.classList.toggle('open'));
      document.getElementById('panel-close-btn').addEventListener('click', () => this.panel.classList.remove('open'));
      window.addEventListener('keydown', (e) => { if (e.key.toLowerCase() === 'p') this.panel.classList.toggle('open'); });

      this.panel.querySelectorAll('.collapsible').forEach(h => h.addEventListener('click', () => h.classList.toggle('active')));
      this.panel.querySelectorAll('[data-profile]').forEach(btn => {
        btn.addEventListener('click', () => {
          this.physicsManager.applyProfile(btn.dataset.profile);
          this.updateAllControls();
          this.panel.querySelector('[data-profile].active').classList.remove('active');
          btn.classList.add('active');
        });
      });
      
      this.panel.querySelectorAll('.perf-slider').forEach(el => this.createSlider(el));
      this.panel.querySelectorAll('.perf-toggle').forEach(el => this.createToggle(el));
      this.panel.querySelectorAll('.perf-select').forEach(el => this.createSelect(el));
      this.panel.querySelectorAll('[data-stat]').forEach(el => this.dom[el.dataset.stat] = el);
      this.updateAllControls();
      this.disableUnsupportedControls();
    }
    
    createSlider(container) {
      const setting = container.dataset.setting, label = container.dataset.label;
      const min = container.dataset.min, max = container.dataset.max, step = container.dataset.step;
      container.classList.add('perf-control');
      container.innerHTML = `<label>${label}</label><input type="range" min="${min}" max="${max}" step="${step}"><span class="value-display"></span>`;
      const input = container.querySelector('input'), display = container.querySelector('.value-display');
      input.addEventListener('input', () => {
        const value = parseFloat(input.value);
        this.physicsManager.settings[setting] = value;
        display.textContent = value.toFixed(step < 1 ? 2 : 0);
        this.physicsManager.updateFromSettings();
      });
      this.dom[setting] = { input, display };
    }

    createToggle(container) {
      const setting = container.dataset.setting, labelText = container.dataset.label;
      container.innerHTML = `<label>${labelText}</label><label class="switch"><input type="checkbox"><span class="slider"></span></label>`;
      const input = container.querySelector('input');
      input.addEventListener('change', () => {
        this.physicsManager.settings[setting] = input.checked;
        this.physicsManager.updateFromSettings();
      });
      this.dom[setting] = { input };
    }

    createSelect(container) {
      const setting = container.dataset.setting, labelText = container.dataset.label;
      const options = container.dataset.options.split(',');
      container.innerHTML = `<label>${labelText}</label><select>${options.map(o => `<option value="${o}">${o}</option>`).join('')}</select>`;
      const select = container.querySelector('select');
      select.addEventListener('change', () => {
        this.physicsManager.settings[setting] = parseInt(select.value);
        this.physicsManager.updateFromSettings();
      });
      this.dom[setting] = { select };
    }

    updateAllControls() {
      const settings = this.physicsManager.settings;
      for (const key in settings) {
        if (this.dom[key]) {
          const control = this.dom[key], value = settings[key];
          if (control.input) {
            if (control.input.type === 'range') {
              control.input.value = value;
              control.display.textContent = value.toFixed(control.input.step < 1 ? 2 : 0);
            } else if (control.input.type === 'checkbox') control.input.checked = value;
          } else if (control.select) control.select.value = value;
        }
      }
    }

    disableUnsupportedControls() {
        const unsupported = ['timeToSleep', 'linearSleepTolerance', 'angularSleepTolerance'];
        unsupported.forEach(setting => {
            if (this.dom[setting] && this.dom[setting].input) {
                const controlElement = this.dom[setting].input.closest('.perf-slider');
                if (controlElement) {
                    controlElement.style.opacity = '0.5';
                    controlElement.style.pointerEvents = 'none';
                    controlElement.title = 'This setting is not runtime-configurable in Planck.js';
                }
            }
        });
    }
    
    updateTelemetry(telemetry) {
      for(const key in telemetry) {
        if (this.dom[key]) {
          const value = telemetry[key], el = this.dom[key];
          const text = typeof value === 'number' ? value.toFixed(key.includes('ms') ? 2 : 0) : value;
          if (el.textContent !== text) el.textContent = text;
        }
      }
    }
  }
  
  /** A uniform grid spatial hash for broad-phase neighbor checks. */
  class SpatialHashGrid {
    constructor(cellSize) { this.cellSize = cellSize; this.grid = new Map(); }
    clear() { this.grid.clear(); }
    getKey(p) { return `${Math.floor(p.x / this.cellSize)},${Math.floor(p.y / this.cellSize)}`; }
    add(body) {
      const key = this.getKey(body.getPosition());
      if (!this.grid.has(key)) this.grid.set(key, []);
      this.grid.get(key).push(body);
    }
    areNeighbors(bodyA, bodyB, radius) {
      const pA = bodyA.getPosition(), pB = bodyB.getPosition();
      const cA = { x: Math.floor(pA.x / this.cellSize), y: Math.floor(pA.y / this.cellSize) };
      const cB = { x: Math.floor(pB.x / this.cellSize), y: Math.floor(pB.y / this.cellSize) };
      return Math.abs(cA.x - cB.x) <= radius && Math.abs(cA.y - cB.y) <= radius;
    }
  }

  /** A detailed physics performance telemetry module. */
  class PhysicsTelemetry {
    constructor(world, damageThreshold) {
      this.world = world;
      this.damageThreshold = damageThreshold;
      this.stepTimeBuffer = []; this.impulseBuffer = []; this.bufferSize = 120;
      this.lastUpdateTime = 0; this.updateInterval = 250;
      this.frame = { stepTime: 0, substeps: 0 };
      this.second = { damageEvents: 0, wakeups: 0, sleepdowns: 0, contactsNew: 0, contactsDestroyed: 0 };
      this.lastSecondTime = 0; this.lastAwakeCount = 0; this.lastContactCount = 0;
      this.stats = {}; this.initDOM();
    }
    initDOM() {
      this.dom = {};
      const elements = document.querySelectorAll('#telemetry-content [data-stat-detailed]');
      elements.forEach(el => { this.dom[el.dataset.statDetailed] = el; });
      document.getElementById('telemetry-handle').addEventListener('click', () => {
        document.getElementById('telemetry-panel').classList.toggle('open');
      });
    }
    beginFrame() { this.frame.stepTime = 0; this.frame.substeps = 0; }
    beginStep() { this.stepStartTime = performance.now(); }
    endStep() { this.frame.stepTime += performance.now() - this.stepStartTime; this.frame.substeps++; }
    postSolve(impulse) {
      const normalImpulse = impulse.normalImpulses[0];
      if (normalImpulse > 0) {
        this.impulseBuffer.push(normalImpulse);
        if (this.impulseBuffer.length > this.bufferSize) this.impulseBuffer.shift();
        if (normalImpulse > this.damageThreshold) this.second.damageEvents++;
      }
    }
    endFrame(accumulator) {
      this.stepTimeBuffer.push(this.frame.stepTime);
      if (this.stepTimeBuffer.length > this.bufferSize) this.stepTimeBuffer.shift();
      const now = performance.now();
      if (now >= this.lastSecondTime + 1000) {
        let bodyCount = 0, dynamicCount = 0, awakeCount = 0, fixtureCount = 0;
        for (let b = this.world.getBodyList(); b; b = b.getNext()) {
          bodyCount++;
          if (b.isDynamic()) {
            dynamicCount++;
            if (b.isAwake()) awakeCount++;
          }
          for (let f = b.getFixtureList(); f; f = f.getNext()) fixtureCount++;
        }
        const currentContactCount = this.world.getContactCount();
        const contactDelta = currentContactCount - this.lastContactCount;
        this.second.contactsNew = Math.max(0, contactDelta);
        this.second.contactsDestroyed = Math.max(0, -contactDelta);
        const awakeDelta = awakeCount - this.lastAwakeCount;
        this.second.wakeups = Math.max(0, awakeDelta);
        this.second.sleepdowns = Math.max(0, -awakeDelta);
        this.stats.s_damageEvents = this.second.damageEvents;
        this.stats.s_wakeups = this.second.wakeups;
        this.stats.s_sleepdowns = this.second.sleepdowns;
        this.stats.s_contactsNew = this.second.contactsNew;
        this.stats.s_contactsDestroyed = this.second.contactsDestroyed;
        this.stats.bodies_total = bodyCount;
        this.stats.bodies_dynamic = dynamicCount;
        this.stats.fixtures_total = fixtureCount;
        this.second.damageEvents = 0; this.lastSecondTime = now;
        this.lastAwakeCount = awakeCount; this.lastContactCount = currentContactCount;
      }
      if (now >= this.lastUpdateTime + this.updateInterval) {
        this.hz = APP.physicsManager.settings.hz;
        this.stats.step_time_ms = this.frame.stepTime.toFixed(2);
        this.stats.step_substeps = this.frame.substeps;
        this.stats.step_accumulator = accumulator.toFixed(4);
        const budget = 1000 / this.hz;
        this.stats.step_budget_hit = this.frame.stepTime > budget ? 'YES' : 'NO';
        this.stats.step_hz_target = this.hz;
        this.stats.step_dt = (1/this.hz).toPrecision(4);
        const dynamicCount = this.stats.bodies_dynamic || 0;
        this.stats.bodies_awake = this.lastAwakeCount;
        this.stats.bodies_sleeping = dynamicCount - this.lastAwakeCount;
        this.stats.bodies_sleep_ratio = dynamicCount > 0 ? ((dynamicCount - this.lastAwakeCount) / dynamicCount).toFixed(2) : '0.00';
        this.stats.awake_ratio = dynamicCount > 0 ? (this.lastAwakeCount / dynamicCount).toFixed(2) : '0.00';
        this.stats.contacts_active = this.world.getContactCount();
        if (this.stepTimeBuffer.length > 0) {
          const sorted = [...this.stepTimeBuffer].sort((a,b) => a-b);
          this.stats.step_time_p95 = sorted[Math.floor(sorted.length * 0.95)].toFixed(2);
        }
        if (this.impulseBuffer.length > 0) {
          const sorted = [...this.impulseBuffer].sort((a,b) => a-b);
          this.stats.normal_impulse_p95 = sorted[Math.floor(sorted.length * 0.95)].toFixed(2);
          const sum = this.impulseBuffer.reduce((a,b) => a+b, 0);
          this.stats.normal_impulse_avg = (sum / this.impulseBuffer.length).toFixed(2);
        }
        this.updateDOM(); this.lastUpdateTime = now;
      }
    }
    updateDOM() {
      for (const key in this.stats) {
          if (this.dom[key]) {
              const value = this.stats[key];
              const el = this.dom[key];
              if(el.textContent !== String(value)) el.textContent = value;
          }
      }
      this.dom.damage_events.textContent = this.stats.s_damageEvents || 0;
      this.dom.wakeups_per_s.textContent = this.stats.s_wakeups || 0;
      this.dom.sleepdowns_per_s.textContent = this.stats.s_sleepdowns || 0;
      this.dom.contacts_new_per_s.textContent = this.stats.s_contactsNew || 0;
      this.dom.contacts_destroyed_per_s.textContent = this.stats.s_contactsDestroyed || 0;
      const budgetHit = this.stats.step_budget_hit === 'YES';
      this.dom.step_time_ms.style.color = budgetHit ? '#ef4444' : '';
      this.dom.step_budget_hit.style.color = budgetHit ? '#ef4444' : '';
    }
  }

  // ----- Main App Functions -----
  
  function init() {
    APP.world = new pl.World(Vec2(0, -10));
    APP.physicsManager = new PhysicsManager(APP.world);
    APP.uiPanelManager = new UIPanelManager(APP.physicsManager);
    APP.physicsTelemetry = new PhysicsTelemetry(APP.world, DAMAGE_IMPULSE_THRESHOLD);
    
    setupUIControls();
    setupInputHandlers();
    
    resize();
    resetLevel();
    
    let last = performance.now(); let frameTimes = [];
    function loop(now) {
      const elapsed = now - last; last = now;
      frameTimes.push(elapsed);
      if (frameTimes.length > 60) frameTimes.shift();
      APP.physicsManager.telemetry.fps = 1000 / (frameTimes.reduce((a, b) => a + b, 0) / (frameTimes.length || 1));
      
      gameStep(elapsed / 1000);
      draw();
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
  }

  let accumulator = 0;
  function gameStep(elapsed) {
      const settings = APP.physicsManager.settings;
      const dt = 1 / settings.hz;
      accumulator += Math.min(0.25, elapsed);
      let substeps = 0;
      const maxSubsteps = 5;
      
      APP.physicsTelemetry.beginFrame();
      while (accumulator >= dt && substeps < maxSubsteps) {
        if (APP.bird) APP.physicsManager.whitelist.add(APP.bird);
        
        APP.physicsTelemetry.beginStep();
        APP.physicsManager.step(dt);
        APP.physicsTelemetry.endStep();

        APP.physicsManager.updatePostStep();
        accumulator -= dt;
        substeps++;
      }
      APP.physicsManager.telemetry.substeps = substeps;
      updateGameLogic();
      
      APP.physicsManager.collectTelemetry();
      APP.uiPanelManager.updateTelemetry(APP.physicsManager.telemetry);
      APP.physicsTelemetry.endFrame(accumulator);
  }

  let enableDrag = false;
  const DAMAGE_IMPULSE_THRESHOLD = 3.0;

  function updateGameLogic() {
    if (APP.bodiesToDestroy.length > 0) {
        APP.bodiesToDestroy.forEach(body => { 
            APP.blocks = APP.blocks.filter(b => b !== body); 
            if (APP.world.isLocked() === false && body.m_world === APP.world) APP.world.destroyBody(body);
        });
        APP.bodiesToDestroy = [];
    }
    if (APP.bird) {
        if (enableDrag) applyAirDrag(APP.bird);
        const isOffScreen = APP.bird.getPosition().y < -5 || APP.bird.getPosition().x > 50;
        const isStopped = !APP.bird.isAwake();
        if ((isOffScreen || isStopped) && !APP.world.isLocked()) {
            APP.physicsManager.whitelist.delete(APP.bird);
            APP.world.destroyBody(APP.bird); 
            APP.bird = null;
            APP.slingshot.launched = false;
        }
    }
  }

  function resetLevel() {
    for (let b = APP.world.getBodyList(); b; b = b.getNext()) {
      if (b.isDynamic()) APP.world.destroyBody(b);
    }
    APP.blocks = []; APP.bird = null; APP.bodiesToDestroy = [];
    APP.physicsManager.whitelist.clear();
    APP.physicsManager.deactivatedBodies.clear();
    APP.physicsManager.grid.clear();
    APP.slingshot.launched = false; APP.slingshot.isAiming = false; APP.slingshot.showDrag = false;
    createCityscape();
  }

  function createBoundaries() {
    if (APP.boundaryBody) APP.world.destroyBody(APP.boundaryBody);
    APP.boundaryBody = APP.world.createBody();
    APP.boundaryBody.createFixture(pl.Edge(Vec2(-50, 0), Vec2(50, 0)), {friction: 0.9});
    const rightEdgeX = screenToWorld(window.innerWidth, 0).x;
    APP.boundaryBody.createFixture(pl.Edge(Vec2(rightEdgeX, -10), Vec2(rightEdgeX, 100)), {});
  }
  
  function createCityscape() {
    const startX = screenToWorld(window.innerWidth / 2, 0).x;
    const endX = screenToWorld(window.innerWidth, 0).x - 1.0;
    const blockW = 0.4, blockH = 0.4;
    let currentX = startX;
    for (let i = 0; i < APP.buildingSettings.numBuildings; i++) {
      const w = APP.buildingSettings.minWidth + Math.floor(Math.random() * (APP.buildingSettings.maxWidth - APP.buildingSettings.minWidth + 1));
      const h = APP.buildingSettings.minHeight + Math.floor(Math.random() * (APP.buildingSettings.maxHeight - APP.buildingSettings.minHeight + 1));
      const buildingWorldW = w * blockW;
      if (currentX + buildingWorldW > endX) break;
      for (let r = 0; r < h; r++) {
        for (let c = 0; c < w; c++) {
          makeBox(currentX + c*blockW + blockW/2, r*blockH + blockH/2, blockW, blockH);
        }
      }
      currentX += buildingWorldW + blockW * (Math.random() * 2 + 1.5);
    }
  }

  function makeBox(x, y, w, h) {
    const b = APP.world.createDynamicBody({ position: Vec2(x, y), userData: { type: 'block', health: 100 } });
    b.createFixture(pl.Box(w/2, h/2), { density: 0.2, friction: 0.6, restitution: 0.05 });
    APP.blocks.push(b);
  }
  
  function spawnBird(pos, v0) {
    if (APP.bird) {
        if (!APP.world.isLocked()) {
            APP.physicsManager.whitelist.delete(APP.bird);
            APP.world.destroyBody(APP.bird);
        }
    }
    APP.bird = APP.world.createDynamicBody({ position: pos, bullet: APP.physicsManager.settings.enableCCDForBullets, userData: { type: 'bird' } });
    APP.bird.createFixture(pl.Circle(0.18), { density: 2.5, friction: 0.6, restitution: 0.2 });
    APP.bird.setLinearVelocity(v0);
    APP.slingshot.launched = true;
  }
  
  function applyAirDrag(body) { if (!body) return; const v = body.getLinearVelocity(), speed = v.length(); if (speed < 0.01) return; const dragMag = 0.5 * 1.2 * 0.47 * (Math.PI * 0.18 * 0.18) * speed * speed; const Fd = Vec2.mul(v, -dragMag / (speed||1)); body.applyForceToCenter(Fd, true); }
  
  function beginAim(evt) {
    APP.slingshot.launched = false;
    APP.slingshot.isAiming = true;
    APP.slingshot.showDrag = true;
    APP.slingshot.pointerWorld = getWorldFromEvent(evt);
    evt.preventDefault();
  }

  function moveAim(evt) { if (!APP.slingshot.isAiming) return; APP.slingshot.pointerWorld = getWorldFromEvent(evt); evt.preventDefault(); }
  function endAim(evt) {
    if (!APP.slingshot.isAiming) return;
    APP.slingshot.isAiming = false; APP.slingshot.showDrag = false;
    const { base } = APP.slingshot;
    const maxPull = 1.25, kSpeed = 18.0, gamma = 1.10, minSpeed = 1.5, mouthOffset = 0.16;
    let pull = Vec2.sub(APP.slingshot.pointerWorld, base);
    if (pull.length() > maxPull) { pull.normalize(); pull = Vec2.mul(pull, maxPull); }
    if (pull.length() < 0.1) return;
    const launchDir = Vec2.mul(pull, -1);
    const dir = Vec2.clone(launchDir); dir.normalize();
    let speed = Math.max(minSpeed, kSpeed * Math.pow(pull.length(), gamma));
    const v0 = Vec2.mul(dir, speed), mouth = Vec2.add(base, Vec2.mul(dir, mouthOffset));
    spawnBird(mouth, v0);
    evt.preventDefault();
  }
  function getWorldFromEvent(evt) { const t = (evt.touches && evt.touches.length) ? evt.touches[0] : evt; return screenToWorld(t.clientX, t.clientY); }

  function setupInputHandlers() {
    const canvas = APP.canvas;
    canvas.addEventListener('mousedown', beginAim); canvas.addEventListener('mousemove', moveAim); window.addEventListener('mouseup', endAim);
    canvas.addEventListener('touchstart', beginAim, {passive:false}); canvas.addEventListener('touchmove', moveAim, {passive:false}); canvas.addEventListener('touchend', endAim, {passive:false});
    window.addEventListener('keydown', (e) => {
      if (e.key.toLowerCase() === 'r') resetLevel();
      if (e.key.toLowerCase() === 'd') enableDrag = !enableDrag;
      if (e.key.toLowerCase() === 'h' && document.activeElement.type !== 'range') {
        APP.destructibleMode = !APP.destructibleMode;
      };
    });
    APP.world.on('post-solve', function(contact, impulse) {
      APP.physicsTelemetry.postSolve(impulse);
      if (!APP.destructibleMode) return;
      const bA = contact.getFixtureA().getBody(), bB = contact.getFixtureB().getBody();
      const dataA = bA.getUserData(), dataB = bB.getUserData(); let blockBody = null;
      if (dataA && dataA.type === 'bird' && dataB && dataB.type === 'block') blockBody = bB;
      else if (dataB && dataB.type === 'bird' && dataA && dataA.type === 'block') blockBody = bA;
      if (blockBody) {
        if (impulse.normalImpulses[0] > DAMAGE_IMPULSE_THRESHOLD) {
          const blockData = blockBody.getUserData();
          blockData.health -= (impulse.normalImpulses[0] * 25);
          if (blockData.health <= 0 && !APP.bodiesToDestroy.includes(blockBody)) APP.bodiesToDestroy.push(blockBody);
        }
      }
    });
  }

  function setupUIControls() {
    const sliders = { numBuildings: 'num-buildings', minWidth: 'min-width', maxWidth: 'max-width', minHeight: 'min-height', maxHeight: 'max-height' };
    for (const key in sliders) {
      const slider = document.getElementById(`${sliders[key]}-slider`);
      const valueSpan = document.getElementById(`${sliders[key]}-value`);
      slider.value = APP.buildingSettings[key]; valueSpan.textContent = APP.buildingSettings[key];
      slider.addEventListener('input', (e) => {
        APP.buildingSettings[key] = parseInt(e.target.value); 
        valueSpan.textContent = e.target.value;
      });
    }
    const helpModal = document.getElementById('help-modal');
    document.getElementById('help-button').addEventListener('click', () => helpModal.classList.toggle('visible'));
    document.getElementById('help-backdrop').addEventListener('click', () => helpModal.classList.toggle('visible'));
    helpModal.querySelector('.close-btn').addEventListener('click', () => helpModal.classList.toggle('visible'));
  }

  function resize() { APP.canvas.width = Math.floor(window.innerWidth * APP.dpr); APP.canvas.height = Math.floor(window.innerHeight * APP.dpr); createBoundaries(); }
  window.addEventListener('resize', resize);
  function worldToScreen(v) { return { x: v.x * APP.PPM * APP.dpr, y: APP.canvas.height - v.y * APP.PPM * APP.dpr }; }
  function screenToWorld(px, py) { const r = APP.canvas.getBoundingClientRect(); return Vec2((px - r.left) * APP.dpr / (APP.PPM * APP.dpr), (APP.canvas.height - ((py - r.top) * APP.dpr)) / (APP.PPM * APP.dpr)); }

  function draw() {
    const { ctx, canvas, world } = APP;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const grd = ctx.createLinearGradient(0, 0, 0, canvas.height);
    grd.addColorStop(0, '#0ea5e9'); grd.addColorStop(1, '#0f172a');
    ctx.fillStyle = grd; ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    for (let b = world.getBodyList(); b; b = b.getNext()) {
      if (!b.isActive() || b === APP.boundaryBody) continue;
      for (let f = b.getFixtureList(); f; f = f.getNext()) {
        if (f.getShape().getType() === 'circle') drawCircle(b, f.getShape());
        else if (f.getShape().getType() === 'polygon') drawPolygon(b, f.getShape());
      }
    }
    drawSlingshotAndMarker();
  }
  
  function drawSlingshotAndMarker() {
      const { ctx, dpr } = APP;
      const { base, pointerWorld, isAiming } = APP.slingshot;
      const mouthOffset = 0.16;
      const radius = 9 * dpr;

      // --- 1. ALWAYS draw the static marker at the home position ---
      const markerDir = Vec2(1, 0); 
      const markerMouth = Vec2.add(base, Vec2.mul(markerDir, mouthOffset));
      const mouthPix = worldToScreen(markerMouth);
      
      ctx.fillStyle = '#ef4444';
      ctx.beginPath();
      ctx.arc(mouthPix.x, mouthPix.y, radius, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(1, 2 * dpr);
      const crossSize = radius * 0.7;
      ctx.beginPath();
      ctx.moveTo(mouthPix.x - crossSize, mouthPix.y);
      ctx.lineTo(mouthPix.x + crossSize, mouthPix.y);
      ctx.moveTo(mouthPix.x, mouthPix.y - crossSize);
      ctx.lineTo(mouthPix.x, mouthPix.y + crossSize);
      ctx.stroke();

      // --- 2. ONLY draw aiming visuals if aiming ---
      if (isAiming) {
          const maxPull = 1.25, kSpeed = 18.0, gamma = 1.10, minSpeed = 1.5;
          let pull = Vec2.sub(pointerWorld, base);
          if (pull.length() > maxPull) { pull.normalize(); pull = Vec2.mul(pull, maxPull); }
          const pullLen = pull.length();

          const pA = worldToScreen(base), pB = worldToScreen(Vec2.add(base, pull));
          ctx.strokeStyle = '#f59e0b';
          ctx.lineWidth = 4 * dpr;
          ctx.beginPath();
          ctx.moveTo(pA.x, pA.y);
          ctx.lineTo(pB.x, pB.y);
          ctx.stroke();

          const launchDir = Vec2.mul(pull, -1);
          const dir = Vec2.clone(launchDir);
          if (dir.length() > 0) dir.normalize();

          const aimingMouth = Vec2.add(base, Vec2.mul(dir, mouthOffset));
          const aimingMouthPix = worldToScreen(aimingMouth);
          
          // Draw the plain red ghost projectile (it will draw over the static marker)
          ctx.fillStyle = '#ef4444';
          ctx.beginPath();
          ctx.arc(aimingMouthPix.x, aimingMouthPix.y, radius, 0, Math.PI * 2);
          ctx.fill();

          if (pullLen > 0.1) {
              let speed = Math.max(minSpeed, kSpeed * Math.pow(pullLen, gamma));
              const v0 = Vec2.mul(dir, speed);
              const pts = sampleTrajectory(aimingMouth, v0, 36, 0.05);
              ctx.fillStyle = '#e5e7eb';
              pts.forEach(p => { const s = worldToScreen(p); ctx.beginPath(); ctx.arc(s.x, s.y, 3 * dpr, 0, Math.PI * 2); ctx.fill(); });
          }
      }
  }

  function sampleTrajectory(p0, v0, s, dt) { const pts = []; for (let i=1; i<=s; i++) { const t=i*dt, x=p0.x+v0.x*t, y=p0.y+v0.y*t + 0.5*-10*t*t; if(y<0)break; pts.push(Vec2(x, y)); } return pts; }
  
  // **MODIFIED**: This now draws a plain red circle for the bird.
  function drawCircle(body, circle) {
    const p = body.getPosition();
    const r = circle.m_radius * APP.PPM * APP.dpr;
    const s = worldToScreen(p);
    
    if (body.getUserData() && body.getUserData().type === 'bird') {
        APP.ctx.save();
        APP.ctx.translate(s.x, s.y);
        APP.ctx.rotate(-body.getAngle());
        APP.ctx.fillStyle = '#ef4444'; // Just red
        APP.ctx.beginPath();
        APP.ctx.arc(0, 0, r, 0, Math.PI * 2);
        APP.ctx.fill();
        APP.ctx.restore();
    }
  }
  
  function drawPolygon(body, poly) { 
    const xf = body.getTransform(); APP.ctx.beginPath(); 
    for (let i=0;i<poly.m_vertices.length;i++) { const v=pl.Transform.mul(xf, poly.m_vertices[i]); const s=worldToScreen(v); if (i===0) APP.ctx.moveTo(s.x, s.y); else APP.ctx.lineTo(s.x, s.y); } APP.ctx.closePath(); 
    const data = body.getUserData(); let color = '#71717a';
    if(data && data.type === 'block' && APP.destructibleMode){
      const hRatio = Math.max(0, data.health / 100);
      const r=Math.floor(82*(1-hRatio)+113*hRatio), g=Math.floor(82*(1-hRatio)+113*hRatio), b=Math.floor(91*(1-hRatio)+122*hRatio);
      color = `rgb(${r},${g},${b})`;
    }
    APP.ctx.fillStyle = color; APP.ctx.fill(); APP.ctx.lineWidth = 1*APP.dpr; APP.ctx.strokeStyle = 'rgba(0,0,0,0.25)'; APP.ctx.stroke(); 
  }

  // ----- Start -----
  init();
})();
