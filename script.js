(function() {
  const pl = planck; // from CDN
  const Vec2 = pl.Vec2;

  // ----- Canvas & coordinate helpers -----
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  function resize() {
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    canvas.style.width = '100vw';
    canvas.style.height = '100vh';
    createBoundaries();
  }
  window.addEventListener('resize', resize);
  
  const PPM = 50;
  function worldToScreen(v) { return { x: v.x * PPM * dpr, y: canvas.height - v.y * PPM * dpr }; }
  function screenToWorld(px, py) { const rect = canvas.getBoundingClientRect(); const cx = (px - rect.left) * dpr; const cy = (py - rect.top) * dpr; return Vec2(cx / (PPM * dpr), (canvas.height - cy) / (PPM * dpr)); }
  function vAdd(a,b){ return Vec2(a.x + b.x, a.y + b.y); }
  function vSub(a,b){ return Vec2(a.x - b.x, a.y - b.y); }
  function vMul(a, s){ return Vec2(a.x * s, a.y * s); }
  function vLen(v){ return Math.hypot(v.x, v.y); }
  function vNorm(v){ const L = vLen(v); return L > 1e-8 ? vMul(v, 1/L) : Vec2(0,0); }
  function clampVec(v, max){ const L = vLen(v); return L > max ? vMul(v, max / L) : v; }

  // ----- Physics world -----
  const GRAVITY = Vec2(0, -10);
  let world = new pl.World(GRAVITY);

  // ----- Game Settings -----
  let buildingSettings = {
    numBuildings: 1,
    minWidth: 6,
    maxWidth: 6,
    minHeight: 10,
    maxHeight: 10,
  };

  // ----- Game State -----
  let level = 1;
  let blocks = [];
  let levelIsClearing = false;
  let boundaryBody = null;
  let levelClearCountdown = 0;
  let countdownInterval = null;
  let destructibleMode = true;
  let bodiesToDestroy = [];
  const DAMAGE_IMPULSE_THRESHOLD = 3.0;
  const INITIAL_BLOCK_HEALTH = 100;

  function createBoundaries() {
      if (boundaryBody) world.destroyBody(boundaryBody);
      boundaryBody = world.createBody();
      boundaryBody.createFixture(pl.Edge(Vec2(-50, 0), Vec2(50, 0)), {friction: 0.9});
      const rightEdgeX = screenToWorld(window.innerWidth, 0).x;
      boundaryBody.createFixture(pl.Edge(Vec2(rightEdgeX, -10), Vec2(rightEdgeX, 100)), {});
  }
  
  function makeBox(x, y, w, h, opts) {
    const b = world.createDynamicBody({ 
        position: Vec2(x, y),
        userData: { type: 'block', health: INITIAL_BLOCK_HEALTH } 
    });
    b.createFixture(pl.Box(w/2, h/2), Object.assign({ density: 0.2, friction: 0.6, restitution: 0.05 }, opts||{}));
    blocks.push(b);
    return b;
  }
  
  /**
   * Creates a cityscape based on the current buildingSettings.
   */
  function createCityscape() {
    const startScreenX = window.innerWidth / 2;
    const startWorldX = screenToWorld(startScreenX, 0).x;
    const endWorldX = screenToWorld(window.innerWidth, 0).x - 1.0;
    const availableWidth = endWorldX - startWorldX;

    const blockWorldW = 0.4;
    const blockWorldH = 0.4;
    const buildingColors = ['#dc2626', '#71717a', '#06b6d4'];
    let currentWorldX = startWorldX;
    
    const numBuildings = buildingSettings.numBuildings;
    const totalGapWidth = (numBuildings - 1) * blockWorldW * 2; // Estimate gap space
    const totalBuildingWidth = availableWidth - totalGapWidth;
    const avgBuildingWidth = numBuildings > 0 ? totalBuildingWidth / numBuildings : 0;


    for (let i = 0; i < numBuildings; i++) {
        const widthRange = buildingSettings.maxWidth - buildingSettings.minWidth;
        const heightRange = buildingSettings.maxHeight - buildingSettings.minHeight;
        
        const buildingWidthInBlocks = buildingSettings.minWidth + Math.floor(Math.random() * (widthRange + 1));
        const buildingHeightInBlocks = buildingSettings.minHeight + Math.floor(Math.random() * (heightRange + 1));
        
        const buildingWorldW = buildingWidthInBlocks * blockWorldW;

        if (currentWorldX + buildingWorldW > endWorldX) break; // Don't build off-screen

        const wallColor = buildingColors[Math.floor(Math.random() * buildingColors.length)];

        for (let r = 0; r < buildingHeightInBlocks; r++) {
            for (let c = 0; c < buildingWidthInBlocks; c++) {
                const isWindow = (r > 0 && c > 0 && c < buildingWidthInBlocks - 1 && r % 2 !== 0 && c % 2 !== 0) && (Math.random() < 0.8);
                const x = currentWorldX + (c * blockWorldW) + blockWorldW / 2;
                const y = (r * blockWorldH) + blockWorldH / 2;
                const userData = {
                    type: 'block',
                    health: isWindow ? INITIAL_BLOCK_HEALTH * 0.7 : INITIAL_BLOCK_HEALTH,
                    isWindow: isWindow,
                    baseColor: isWindow ? '#facc15' : wallColor
                };
                const opts = { density: isWindow ? 0.15 : 0.2, userData: userData };
                makeBox(x, y, blockWorldW, blockWorldH, opts);
            }
        }
        currentWorldX += buildingWorldW + blockWorldW * (Math.random() * 2 + 1.5);
    }
  }

  // ----- Slingshot config -----
  const slingBase = Vec2(3.0, 2.0), maxPull = 1.25, kSpeed = 18.0, gamma = 1.10, minSpeed = 1.5, mouthOffset = 0.16;

  // State
  let isAiming = false, pointerWorld = slingBase.clone(), launched = false, bird = null, showDrag = false, enableDrag = false;

  function spawnBird(pos, v0) {
    if (bird) world.destroyBody(bird);
    bird = world.createDynamicBody({ position: pos, bullet: true, linearDamping: 0.0, angularDamping: 0.05, userData: { type: 'bird' } });
    bird.createFixture(pl.Circle(0.18), { density: 2.5, friction: 0.6, restitution: 0.2 });
    bird.setLinearVelocity(v0);
    bird.setSleepingAllowed(true);
    launched = true;
  }

  function applyAirDrag(body) { if (!body) return; const v = body.getLinearVelocity(), speed = vLen(v); if (speed < 0.01) return; const rho = 1.2, Cd = 0.47, r = 0.18, A = Math.PI * r * r, mag = 0.5 * rho * Cd * A * speed * speed, Fd = vMul(v, -mag / (speed||1)); body.applyForceToCenter(Fd, true); }
  function sampleTrajectory(p0, v0, samples = 30, dt = 0.05) { const pts = []; for (let i = 1; i <= samples; i++) { const t = i * dt, x = p0.x + v0.x * t, y = p0.y + v0.y * t + 0.5 * GRAVITY.y * t * t; if (y < 0) break; pts.push(Vec2(x, y)); } return pts; }

  // Input handling
  function beginAim(evt) { if (bird) { world.destroyBody(bird); bird = null; } launched = false; isAiming = true; showDrag = true; pointerWorld = getWorldFromEvent(evt); evt.preventDefault(); }
  function moveAim(evt) { if (!isAiming) return; pointerWorld = getWorldFromEvent(evt); evt.preventDefault(); }
  function endAim(evt) { if (!isAiming) return; isAiming = false; showDrag = false; const pull = clampVec(vSub(pointerWorld, slingBase), maxPull), pullLen = vLen(pull); if (pullLen < 0.1) return; const launchDir = vMul(pull, -1), dir = vNorm(launchDir); let speed = kSpeed * Math.pow(pullLen, gamma); speed = Math.max(speed, minSpeed); const v0 = vMul(dir, speed), mouth = vAdd(slingBase, vMul(dir, mouthOffset)); spawnBird(mouth, v0); evt.preventDefault(); }
  function getWorldFromEvent(evt) { const t = (evt.touches && evt.touches.length) ? evt.touches[0] : evt; return screenToWorld(t.clientX, t.clientY); }

  canvas.addEventListener('mousedown', beginAim); canvas.addEventListener('mousemove', moveAim); window.addEventListener('mouseup', endAim);
  canvas.addEventListener('touchstart', beginAim, {passive:false}); canvas.addEventListener('touchmove', moveAim, {passive:false}); canvas.addEventListener('touchend', endAim, {passive:false});
  
  window.addEventListener('keydown', (e)=>{ 
    if (e.key === 'r' || e.key === 'R') resetLevel(); 
    else if (e.key === 'd' || e.key === 'D') enableDrag = !enableDrag; 
    else if (e.key === 'h' || e.key === 'H') destructibleMode = !destructibleMode;
    else if (e.key.toLowerCase() === 'h') toggleHelp();
  });

  function cleanupLevel() {
      blocks.forEach(b => world.destroyBody(b)); blocks = [];
      if(bird) { world.destroyBody(bird); bird = null; }
      bodiesToDestroy = [];
      if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
  }
  
  function startNewLevel() { level++; cleanupLevel(); createCityscape(); launched = false; }
  function resetLevel() { level = 1; cleanupLevel(); createCityscape(); launched = false; isAiming = false; showDrag = false; levelIsClearing = false; levelClearCountdown = 0; }
  
  // ----- Level Clear Logic -----
  const FLAT_ANGLE_TOLERANCE = 0.1;
  const STOPPED_LINEAR_VELOCITY = 0.05;
  const STOPPED_ANGULAR_VELOCITY = 0.05;
  function isAngleFlat(angle) { const normalizedAngle = Math.abs(angle % (Math.PI / 2)); return Math.min(normalizedAngle, Math.PI / 2 - normalizedAngle) < FLAT_ANGLE_TOLERANCE; }
  function checkWinCondition() {
    if (blocks.length === 0) return true;
    for (const block of blocks) { if (block.getLinearVelocity().length() > STOPPED_LINEAR_VELOCITY || Math.abs(block.getAngularVelocity()) > STOPPED_ANGULAR_VELOCITY) return false; }
    for (const block of blocks) {
      if (!isAngleFlat(block.getAngle())) return false;
      let isTouchingGround = false;
      for (let ce = block.getContactList(); ce; ce = ce.next) { if (ce.contact.isTouching()) { const otherBody = (ce.contact.getFixtureA().getBody() === block) ? ce.contact.getFixtureB().getBody() : ce.contact.getFixtureA().getBody(); if (otherBody === boundaryBody) { isTouchingGround = true; break; } } }
      if (!isTouchingGround) return false;
    }
    return true;
  }

  world.on('post-solve', function(contact, impulse) {
    if (!destructibleMode) return;
    const fA = contact.getFixtureA(), fB = contact.getFixtureB(), bA = fA.getBody(), bB = fB.getBody();
    const dataA = bA.getUserData(), dataB = bB.getUserData(); let blockBody = null;
    if (dataA && dataA.type === 'bird' && dataB && dataB.type === 'block') blockBody = bB;
    else if (dataB && dataB.type === 'bird' && dataA && dataA.type === 'block') blockBody = bA;
    if (blockBody) {
      const totalImpulse = impulse.normalImpulses[0];
      if (totalImpulse > DAMAGE_IMPULSE_THRESHOLD) {
        const blockData = blockBody.getUserData();
        blockData.health -= (totalImpulse * 25);
        if (blockData.health <= 0 && !bodiesToDestroy.includes(blockBody)) bodiesToDestroy.push(blockBody);
      }
    }
  });
  
  // ----- Help Menu & Controls Setup -----
  function setupUI() {
    const helpButton = document.getElementById('help-button');
    const helpModal = document.getElementById('help-modal');
    const helpBackdrop = document.getElementById('help-backdrop');
    const closeBtn = helpModal.querySelector('.close-btn');

    window.toggleHelp = () => helpModal.classList.toggle('visible');

    helpButton.addEventListener('click', toggleHelp);
    helpBackdrop.addEventListener('click', toggleHelp);
    closeBtn.addEventListener('click', toggleHelp);

    // --- Sliders ---
    const sliders = {
      numBuildings: document.getElementById('num-buildings-slider'),
      minWidth: document.getElementById('min-width-slider'),
      maxWidth: document.getElementById('max-width-slider'),
      minHeight: document.getElementById('min-height-slider'),
      maxHeight: document.getElementById('max-height-slider'),
    };
    const values = {
      numBuildings: document.getElementById('num-buildings-value'),
      minWidth: document.getElementById('min-width-value'),
      maxWidth: document.getElementById('max-width-value'),
      minHeight: document.getElementById('min-height-value'),
      maxHeight: document.getElementById('max-height-value'),
    };
    
    for (const key in sliders) {
      sliders[key].addEventListener('input', (e) => {
        const value = parseInt(e.target.value);
        buildingSettings[key] = value;
        values[key].textContent = value;

        // Ensure min is not greater than max
        if (key === 'minWidth' && value > buildingSettings.maxWidth) {
          sliders.maxWidth.value = value;
          buildingSettings.maxWidth = value;
          values.maxWidth.textContent = value;
        }
        if (key === 'maxWidth' && value < buildingSettings.minWidth) {
          sliders.minWidth.value = value;
          buildingSettings.minWidth = value;
          values.minWidth.textContent = value;
        }
        if (key === 'minHeight' && value > buildingSettings.maxHeight) {
          sliders.maxHeight.value = value;
          buildingSettings.maxHeight = value;
          values.maxHeight.textContent = value;
        }
        if (key === 'maxHeight' && value < buildingSettings.minHeight) {
          sliders.minHeight.value = value;
          buildingSettings.minHeight = value;
          values.minHeight.textContent = value;
        }
      });
    }
  }

  // ----- Initial Setup -----
  resize(); 
  setupUI();
  createCityscape();

  // ----- Simulation loop -----
  const hz = 60; const dt = 1 / hz; let acc = 0; let last = performance.now();
  function loop(now) {
    const elapsed = Math.min(0.25, (now - last) / 1000); last = now; acc += elapsed;
    while (acc >= dt) {
      if (enableDrag && bird) applyAirDrag(bird);
      world.step(dt, 8, 3);
      acc -= dt;
    }
    
    if (bodiesToDestroy.length > 0) {
        bodiesToDestroy.forEach(body => { blocks = blocks.filter(b => b !== body); world.destroyBody(body); });
        bodiesToDestroy = [];
    }
    if (bird) {
        const isOffScreen = bird.getPosition().y < -5 || bird.getPosition().x > 50;
        const isStopped = launched && !bird.isAwake();
        if (isOffScreen || isStopped) { world.destroyBody(bird); bird = null; }
    }
    
    if (!bird && launched && !levelIsClearing) { 
        if (checkWinCondition()) {
            levelIsClearing = true;
            levelClearCountdown = 3;
            countdownInterval = setInterval(() => {
                levelClearCountdown--;
                if (levelClearCountdown <= 0) clearInterval(countdownInterval);
            }, 1000);
            setTimeout(() => {
                startNewLevel();
                levelIsClearing = false;
                levelClearCountdown = 0;
                if (countdownInterval) clearInterval(countdownInterval);
            }, 3000); 
        }
    }
    draw();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // ----- Rendering -----
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const grd = ctx.createLinearGradient(0, 0, 0, canvas.height);
    grd.addColorStop(0, '#0ea5e9'); grd.addColorStop(1, '#0f172a');
    ctx.fillStyle = grd; ctx.fillRect(0, 0, canvas.width, canvas.height);
    const slingPix = worldToScreen(slingBase);
    ctx.fillStyle = '#7c3e1d';
    ctx.beginPath(); ctx.arc(slingPix.x, slingPix.y, 10*dpr, 0, Math.PI*2); ctx.fill();
    if (!launched) {
      const clamped = clampVec(vSub(pointerWorld, slingBase), maxPull), pullEnd = vAdd(slingBase, clamped), pullLen = vLen(clamped), launchDir = vMul(clamped, -1), dir = vNorm(launchDir), mouth = vAdd(slingBase, vMul(dir, mouthOffset));
      if (showDrag) { const pA = worldToScreen(slingBase), pB = worldToScreen(pullEnd); ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 4 * dpr; ctx.beginPath(); ctx.moveTo(pA.x, pA.y); ctx.lineTo(pB.x, pB.y); ctx.stroke(); }
      const mouthPix = worldToScreen(mouth); ctx.fillStyle = '#ef4444'; ctx.beginPath(); ctx.arc(mouthPix.x, mouthPix.y, 9*dpr, 0, Math.PI*2); ctx.fill();
      if (pullLen > 0.1) {
          let speed = kSpeed * Math.pow(pullLen, gamma); speed = Math.max(speed, minSpeed); const v0 = vMul(dir, speed), pts = sampleTrajectory(mouth, v0, 36, 0.05);
          ctx.fillStyle = '#e5e7eb'; pts.forEach(p => { const s = worldToScreen(p); ctx.beginPath(); ctx.arc(s.x, s.y, 3 * dpr, 0, Math.PI * 2); ctx.fill(); });
      }
    }
    for (let b = world.getBodyList(); b; b = b.getNext()) {
        if (!b.isActive() || b === boundaryBody) continue;
        for (let f = b.getFixtureList(); f; f = f.getNext()) {
            const type = f.getShape().getType();
            if (type === 'circle') drawCircle(b, f.getShape());
            else if (type === 'polygon') drawPolygon(b, f.getShape());
        }
    }
    const defaultFontSize = 14;
    ctx.fillStyle = '#e2e8f0'; ctx.font = `${defaultFontSize*dpr}px system-ui, -apple-system, Segoe UI, Roboto`;
    ctx.fillText(`Air drag: ${enableDrag ? 'ON' : 'OFF'}`, 16*dpr, canvas.height - 36*dpr);
    ctx.fillText(`Mode: ${destructibleMode ? 'Destructible' : 'Classic'}`, 16*dpr, canvas.height - 16*dpr);
    ctx.textAlign = 'right';
    if (levelIsClearing && levelClearCountdown > 0) {
        ctx.fillStyle = '#f59e0b'; ctx.font = `bold ${16*dpr}px system-ui, -apple-system, Segoe UI, Roboto`;
        ctx.fillText(`Next level in ${levelClearCountdown}...`, canvas.width - 16*dpr, canvas.height - 16*dpr);
    } else {
        ctx.font = `${defaultFontSize*dpr}px system-ui, -apple-system, Segoe UI, Roboto`; ctx.fillStyle = '#e2e8f0';
        ctx.fillText(`Level: ${level}`, canvas.width - 16*dpr, canvas.height - 16*dpr);
    }
    ctx.textAlign = 'left';
  }
  function drawCircle(body, circle) { const pos = body.getPosition(), r = circle.m_radius * PPM * dpr; const s = worldToScreen(pos); ctx.save(); ctx.translate(s.x, s.y); ctx.rotate(-body.getAngle()); ctx.fillStyle = (body === bird) ? '#ef4444' : '#94a3b8'; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI*2); ctx.fill(); ctx.restore(); }
  function drawPolygon(body, poly) { 
    const xf = body.getTransform(), vcount = poly.m_vertices.length; ctx.beginPath(); 
    for (let i=0;i<vcount;i++) { const v = pl.Transform.mul(xf, poly.m_vertices[i]); const s = worldToScreen(v); if (i===0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y); } ctx.closePath(); 
    let color = '#94a3b8';
    const userData = body.getUserData();
    if (userData && userData.type === 'block' && destructibleMode) {
        const baseColorHex = userData.baseColor || '#94a3b8'; 
        const damagedColor = { r: 82, g: 82, b: 91 }; 
        const baseR = parseInt(baseColorHex.slice(1, 3), 16);
        const baseG = parseInt(baseColorHex.slice(3, 5), 16);
        const baseB = parseInt(baseColorHex.slice(5, 7), 16);
        const maxHealth = userData.isWindow ? INITIAL_BLOCK_HEALTH * 0.7 : INITIAL_BLOCK_HEALTH;
        const hRatio = Math.max(0, userData.health / maxHealth);
        const r = Math.floor(baseR * hRatio + damagedColor.r * (1 - hRatio));
        const g = Math.floor(baseG * hRatio + damagedColor.g * (1 - hRatio));
        const b = Math.floor(baseB * hRatio + damagedColor.b * (1 - hRatio));
        color = `rgb(${r}, ${g}, ${b})`;
    } else if (userData && userData.baseColor) {
        color = userData.baseColor;
    }
    ctx.fillStyle = color; ctx.fill(); ctx.lineWidth = 1*dpr; ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.stroke(); 
  }
})();
