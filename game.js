/* ==========================================================================
   Berry Snake — game logic
   --------------------------------------------------------------------------
   Sections in this file (search for the banner comments):

     1. Config & helpers   constants, small maths helpers, safe localStorage
     2. AudioManager       sound effects synthesised with the Web Audio API
     3. Snake              the snake's tiles, direction and movement
     4. Food               the berries: spawning, eating
     5. Renderer           everything that draws on the <canvas>
     6. Input              keyboard + swipe, with a small direction queue
     7. Game               state machine, fixed-tick loop, UI wiring

   The key idea: the game *logic* advances in fixed steps ("ticks"), while
   *drawing* happens every animation frame and blends between the previous
   tick and the current one. See Game.frame() and Renderer.buildSnakePath().
   ========================================================================== */

'use strict';

/* ==========================================================================
   1. Config & helpers
   ========================================================================== */

/** Milliseconds per snake move for each speed setting. */
const SPEEDS = { slow: 190, normal: 130, fast: 85 };

/** Board dimensions (in tiles) for each size setting. */
const BOARDS = {
  small:  { cols: 11, rows: 9 },
  medium: { cols: 17, rows: 15 },
  large:  { cols: 25, rows: 21 },
};

const FRUIT_COUNTS = [1, 3, 5];

const DEFAULT_SETTINGS = { speed: 'normal', board: 'medium', fruit: 1, wrap: false };

/** Unit vectors for the four directions (y grows downward on a canvas). */
const DIRS = {
  up:    { x: 0,  y: -1 },
  down:  { x: 0,  y: 1 },
  left:  { x: -1, y: 0 },
  right: { x: 1,  y: 0 },
};

/** Keyboard key -> direction name. Letters are compared in lower case. */
const KEY_TO_DIR = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  w: 'up', s: 'down', a: 'left', d: 'right',
};

const START_LENGTH = 4;
const MAX_QUEUED_TURNS = 2;

/** Colours used on the canvas. */
const COLORS = {
  tileA: '#2a2552',
  tileB: '#312b5e',
  snakeHead: [111, 240, 200],  // mint
  snakeTail: [30, 140, 130],   // deeper teal
  berry: '#ff5d73',
  berryDark: '#d83a58',
  leaf: '#b8f06a',
};

/** Linear interpolation: t = 0 gives a, t = 1 gives b. */
const lerp = (a, b, t) => a + (b - a) * t;

/** True modulo that also works for negative numbers (-1 mod 5 = 4). */
const mod = (n, m) => ((n % m) + m) % m;

/**
 * "Overshoot" easing used for the berry pop-in: goes a bit past 1 and settles.
 */
function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

/**
 * Tiny wrapper around localStorage. Storage can throw (private browsing,
 * disabled cookies, file:// restrictions), so every access is in try/catch
 * and the game simply carries on without persistence if it fails.
 */
const Store = {
  prefix: 'berrySnake.',
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(this.prefix + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (err) {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(this.prefix + key, JSON.stringify(value));
    } catch (err) {
      /* ignore — the value just won't be remembered */
    }
  },
};

const prefersReducedMotion =
  window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ==========================================================================
   2. AudioManager
   --------------------------------------------------------------------------
   No audio files: each effect is one or more short oscillator "beeps" whose
   pitch and volume are shaped over time.
   ========================================================================== */

class AudioManager {
  constructor() {
    this.ctx = null; // created lazily — browsers require a user gesture first
    this.muted = Store.get('muted', false) === true;
  }

  /** Call from any user gesture (key press, tap) to create/resume audio. */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return; // very old browser: play silently
      try {
        this.ctx = new AC();
      } catch (err) {
        return;
      }
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  setMuted(muted) {
    this.muted = muted;
    Store.set('muted', muted);
  }

  /**
   * Play one beep.
   * @param {object} o
   * @param {number} o.freq   start frequency in Hz
   * @param {number} [o.to]   optional end frequency (pitch slides towards it)
   * @param {number} o.dur    duration in seconds
   * @param {string} [o.type] oscillator waveform
   * @param {number} [o.vol]  peak volume (0..1)
   * @param {number} [o.delay] seconds to wait before starting
   */
  tone({ freq, to, dur, type = 'sine', vol = 0.15, delay = 0 }) {
    if (this.muted || !this.ctx) return;
    const t0 = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);

    // Fade out quickly so the beep doesn't end with an audible click.
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    osc.connect(gain).connect(this.ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  eat() {
    this.tone({ freq: 520, to: 780, dur: 0.08, type: 'triangle', vol: 0.2 });
    this.tone({ freq: 780, to: 1040, dur: 0.1, type: 'triangle', vol: 0.18, delay: 0.07 });
  }

  turn() {
    this.tone({ freq: 300, to: 360, dur: 0.035, type: 'sine', vol: 0.06 });
  }

  gameOver() {
    this.tone({ freq: 330, to: 70, dur: 0.45, type: 'sawtooth', vol: 0.16 });
    this.tone({ freq: 165, to: 50, dur: 0.5, type: 'square', vol: 0.07, delay: 0.05 });
  }

  win() {
    // A little rising arpeggio (C E G C).
    [523, 659, 784, 1047].forEach((freq, i) => {
      this.tone({ freq, dur: 0.18, type: 'triangle', vol: 0.18, delay: i * 0.11 });
    });
  }
}

/* ==========================================================================
   3. Snake
   --------------------------------------------------------------------------
   `segments` is the list of tiles the snake occupies, head first.
   `prev` is the same list as it was *before* the latest move; the renderer
   blends between the two to make the movement smooth.
   ========================================================================== */

class Snake {
  constructor(cols, rows) {
    // Start near the left-centre, lying horizontally, facing right.
    const y = Math.floor(rows / 2);
    const headX = START_LENGTH; // leaves one empty tile behind the tail
    this.segments = [];
    for (let i = 0; i < START_LENGTH; i++) {
      this.segments.push({ x: headX - i, y });
    }
    this.dir = DIRS.right;
    this.prev = this.segments.map((s) => ({ ...s }));
  }

  get head() {
    return this.segments[0];
  }

  get length() {
    return this.segments.length;
  }

  /**
   * Is tile (x, y) part of the snake?
   * @param {boolean} ignoreTail  true when the tail is about to move away,
   *                              so stepping onto its tile is safe.
   */
  occupies(x, y, ignoreTail = false) {
    const end = ignoreTail ? this.segments.length - 1 : this.segments.length;
    for (let i = 0; i < end; i++) {
      if (this.segments[i].x === x && this.segments[i].y === y) return true;
    }
    return false;
  }

  /**
   * Move the head onto `newHead`. When `grow` is true the tail stays where
   * it is, so the snake becomes one tile longer.
   */
  advance(newHead, grow) {
    const old = this.segments;
    // Remember the pre-move positions for interpolation.
    this.prev = old.map((s) => ({ ...s }));

    this.segments = [newHead, ...old];
    if (grow) {
      // The new last segment sits on the old tail tile and didn't move,
      // so its "previous" position is the same tile.
      this.prev.push({ ...old[old.length - 1] });
    } else {
      this.segments.pop();
    }
  }

  /** Stop any in-progress interpolation (used when the snake dies). */
  freeze() {
    this.prev = this.segments.map((s) => ({ ...s }));
  }
}

/* ==========================================================================
   4. Food
   ========================================================================== */

class Food {
  constructor() {
    /** Each item: { x, y, born } — `born` is a timestamp for the pop-in. */
    this.items = [];
  }

  indexAt(x, y) {
    return this.items.findIndex((f) => f.x === x && f.y === y);
  }

  remove(index) {
    this.items.splice(index, 1);
  }

  /**
   * Top the board back up to `count` berries. A berry is only ever placed
   * on a tile that holds neither the snake nor another berry: we build the
   * list of free tiles first and pick from that list, which (unlike
   * "pick random tiles until one is free") can never loop forever or
   * pick an occupied tile.
   */
  fill(count, snake, cols, rows) {
    while (this.items.length < count) {
      const free = [];
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          if (!snake.occupies(x, y) && this.indexAt(x, y) === -1) {
            free.push({ x, y });
          }
        }
      }
      if (free.length === 0) return; // board is full — nothing to spawn
      const spot = free[Math.floor(Math.random() * free.length)];
      this.items.push({ x: spot.x, y: spot.y, born: performance.now() });
    }
  }
}

/* ==========================================================================
   5. Renderer
   --------------------------------------------------------------------------
   All drawing uses *tile units*: after resize() the canvas transform is
   scaled so that 1 unit = 1 tile. Tile (3, 2) therefore covers the square
   from (3, 2) to (4, 3) and its centre is (3.5, 2.5), whatever the screen
   size or pixel density.
   ========================================================================== */

class Renderer {
  constructor(canvas, stage) {
    this.canvas = canvas;
    this.stage = stage;
    this.ctx = canvas.getContext('2d');
    this.cols = 1;
    this.rows = 1;
    this.shakeUntil = 0;
    this.flashUntil = 0;
  }

  /** Fit the board into the stage, keeping tiles square and pixels crisp. */
  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;

    // The 8px margin leaves room for the board's outer ring/shadow.
    const availW = this.stage.clientWidth - 8;
    const availH = this.stage.clientHeight - 8;
    const tile = Math.max(6, Math.floor(Math.min(availW / cols, availH / rows)));

    // CSS size (layout pixels)…
    this.canvas.style.width = cols * tile + 'px';
    this.canvas.style.height = rows * tile + 'px';

    // …and backing-store size (device pixels) so it's sharp on HiDPI screens.
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(cols * tile * dpr);
    this.canvas.height = Math.round(rows * tile * dpr);

    // From now on, 1 drawing unit = 1 tile.
    this.ctx.setTransform(tile * dpr, 0, 0, tile * dpr, 0, 0);
    this.tilePx = tile;
  }

  /** Start the game-over effect. */
  impact(now) {
    this.flashUntil = now + 220;
    this.shakeUntil = prefersReducedMotion ? 0 : now + 380;
  }

  /**
   * Draw one frame.
   * @param {Game} game
   * @param {number} t    progress through the current tick, 0..1
   * @param {number} now  timestamp from requestAnimationFrame
   */
  draw(game, t, now) {
    const { ctx, cols, rows } = this;

    this.applyShake(now);
    this.drawBoard();

    for (const item of game.food.items) this.drawBerry(item, now);

    // Build the snake's centre line once, then stroke it.
    const path = this.buildSnakePath(game.snake, t, game.settings.wrap);

    if (game.settings.wrap) {
      // In wrap mode the path is built in "unwrapped" coordinates, so part
      // of it may lie outside the board (e.g. x = -0.4 while crossing the
      // left edge). Drawing it again shifted by a whole board width/height
      // makes the part that left one side appear on the opposite side.
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const p of path) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
      // Which copies of the board does the path touch? (±1 tile of margin
      // for the body's thickness.)
      const kx0 = Math.floor((minX - 1) / cols), kx1 = Math.floor((maxX + 1) / cols);
      const ky0 = Math.floor((minY - 1) / rows), ky1 = Math.floor((maxY + 1) / rows);
      for (let ky = ky0; ky <= ky1; ky++) {
        for (let kx = kx0; kx <= kx1; kx++) {
          ctx.save();
          ctx.translate(-kx * cols, -ky * rows);
          this.drawSnake(path, game.snake.dir);
          ctx.restore();
        }
      }
    } else {
      this.drawSnake(path, game.snake.dir);
    }

    // Brief white flash on game over, fading out.
    if (now < this.flashUntil) {
      ctx.fillStyle = `rgba(255, 255, 255, ${0.55 * ((this.flashUntil - now) / 220)})`;
      ctx.fillRect(0, 0, cols, rows);
    }
  }

  /** Screen shake: nudge the whole canvas by a random, shrinking offset. */
  applyShake(now) {
    if (now < this.shakeUntil) {
      const strength = ((this.shakeUntil - now) / 380) * 9; // pixels
      const dx = (Math.random() * 2 - 1) * strength;
      const dy = (Math.random() * 2 - 1) * strength;
      this.canvas.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;
    } else if (this.canvas.style.transform) {
      this.canvas.style.transform = '';
    }
  }

  /** Two-tone checkerboard. */
  drawBoard() {
    const { ctx, cols, rows } = this;
    ctx.fillStyle = COLORS.tileA;
    ctx.fillRect(0, 0, cols, rows);
    ctx.fillStyle = COLORS.tileB;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if ((x + y) % 2 === 1) ctx.fillRect(x, y, 1, 1);
      }
    }
  }

  /** A round berry with a leaf; scales up from nothing when it spawns. */
  drawBerry(item, now) {
    const { ctx } = this;
    const age = now - item.born;
    const pop = prefersReducedMotion ? 1 : easeOutBack(Math.min(1, Math.max(0, age / 280)));
    // After the pop, a slow "breathing" pulse keeps it lively.
    const pulse = prefersReducedMotion ? 1 : 1 + 0.04 * Math.sin(now / 260);
    const scale = pop * pulse;
    if (scale <= 0) return;

    ctx.save();
    ctx.translate(item.x + 0.5, item.y + 0.5);
    ctx.scale(scale, scale);

    // soft shadow
    ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
    ctx.beginPath();
    ctx.ellipse(0.03, 0.34, 0.26, 0.08, 0, 0, Math.PI * 2);
    ctx.fill();

    // body
    const grad = ctx.createRadialGradient(-0.1, -0.06, 0.05, 0, 0.04, 0.36);
    grad.addColorStop(0, COLORS.berry);
    grad.addColorStop(1, COLORS.berryDark);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0.05, 0.32, 0, Math.PI * 2);
    ctx.fill();

    // highlight
    ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.beginPath();
    ctx.arc(-0.12, -0.06, 0.08, 0, Math.PI * 2);
    ctx.fill();

    // leaf
    ctx.fillStyle = COLORS.leaf;
    ctx.beginPath();
    ctx.ellipse(0.1, -0.29, 0.15, 0.07, -0.6, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  /**
   * Work out the snake's centre line for this frame, as a list of points in
   * tile coordinates (tile corners — add 0.5 for centres when drawing).
   *
   * This is where the smooth movement comes from. After a tick, every body
   * segment sits exactly where the one in front of it used to be, so the
   * body always lies along the same chain of tile centres. Only the two
   * ENDS need to slide:
   *
   *     head tip:  from prev[0]      towards segments[0]      as t: 0 -> 1
   *     tail tip:  from prev[last]   towards segments[last]   as t: 0 -> 1
   *
   * The path is therefore:
   *     [ sliding head, segments[1], segments[2], …, segments[last], sliding tail ]
   *
   * Because the middle points are real tile centres, corners stay crisp
   * 90° turns (the round line joins soften them) instead of being cut
   * diagonally, which is what you'd get by interpolating every segment.
   */
  buildSnakePath(snake, t, wrap) {
    const { cols, rows } = this;
    const cur = snake.segments;
    const prev = snake.prev;
    const last = cur.length - 1;

    // In wrap mode two neighbouring segments can be on opposite edges of
    // the board (x = 0 and x = cols - 1). `near` shifts a point by whole
    // board widths/heights so it lands right next to the reference point,
    // giving us one continuous "unwrapped" line.
    const near = (p, ref) =>
      wrap
        ? {
            x: p.x + Math.round((ref.x - p.x) / cols) * cols,
            y: p.y + Math.round((ref.y - p.y) / rows) * rows,
          }
        : p;

    const points = [];

    // Head: slide from where it was to where it is now.
    const headNow = cur[0];
    const headWas = near(prev[0], headNow);
    let ref = { x: lerp(headWas.x, headNow.x, t), y: lerp(headWas.y, headNow.y, t) };
    points.push(ref);

    // Body: fixed tile centres.
    for (let i = 1; i <= last; i++) {
      ref = near(cur[i], ref);
      points.push(ref);
    }

    // Tail: slide from its old tile to its current one. (When the snake has
    // just grown, old and current are the same tile, so the tail holds
    // still while the head moves on — that's the growth.)
    const tailWas = near(prev[last], ref);
    points.push({ x: lerp(tailWas.x, ref.x, t), y: lerp(tailWas.y, ref.y, t) });

    return points;
  }

  /** Stroke the centre line as one thick, rounded, gradient body + eyes. */
  drawSnake(points, dir) {
    const { ctx } = this;
    const width = 0.76;
    const n = points.length;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Drop shadow: the whole line once, slightly offset.
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.22)';
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(points[0].x + 0.5, points[0].y + 0.58);
    for (let i = 1; i < n; i++) ctx.lineTo(points[i].x + 0.5, points[i].y + 0.58);
    ctx.stroke();

    // Body: a canvas line can only have one colour, so to fade from head
    // to tail we stroke each short piece separately in its own shade.
    // Round caps make the pieces overlap into one continuous shape. We go
    // tail -> head so lighter pieces (and the head) end up on top.
    const [hr, hg, hb] = COLORS.snakeHead;
    const [tr, tg, tb] = COLORS.snakeTail;
    // Each tile-long piece is further split into STEPS slices so the
    // colour changes too gradually to see any banding.
    const STEPS = 4;
    const total = (n - 1) * STEPS;
    for (let j = total - 1; j >= 0; j--) {
      const i = Math.floor(j / STEPS);       // which piece: points[i] -> points[i + 1]
      const a = (j % STEPS) / STEPS;         // slice start within the piece
      const b = a + 1 / STEPS;               // slice end
      const k = j / Math.max(1, total - 1);  // 0 at the head, 1 at the tail
      const p = points[i];
      const q = points[i + 1];
      ctx.strokeStyle = `rgb(${Math.round(lerp(hr, tr, k))}, ${Math.round(lerp(hg, tg, k))}, ${Math.round(lerp(hb, tb, k))})`;
      ctx.beginPath();
      ctx.moveTo(lerp(p.x, q.x, b) + 0.5, lerp(p.y, q.y, b) + 0.5);
      ctx.lineTo(lerp(p.x, q.x, a) + 0.5, lerp(p.y, q.y, a) + 0.5);
      ctx.stroke();
    }

    // Head: a slightly larger circle so it reads as a head.
    const hx = points[0].x + 0.5;
    const hy = points[0].y + 0.5;
    ctx.fillStyle = `rgb(${hr}, ${hg}, ${hb})`;
    ctx.beginPath();
    ctx.arc(hx, hy, 0.43, 0, Math.PI * 2);
    ctx.fill();

    // Eyes: placed either side of the direction of travel. (px, py) is the
    // direction rotated 90°, i.e. "sideways" relative to the head.
    const px = -dir.y;
    const py = dir.x;
    for (const side of [-1, 1]) {
      const ex = hx + dir.x * 0.1 + px * 0.2 * side;
      const ey = hy + dir.y * 0.1 + py * 0.2 * side;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(ex, ey, 0.125, 0, Math.PI * 2);
      ctx.fill();
      // Pupils sit towards the front of each eye, so the snake "looks"
      // where it's going.
      ctx.fillStyle = '#17142b';
      ctx.beginPath();
      ctx.arc(ex + dir.x * 0.05, ey + dir.y * 0.05, 0.065, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/* ==========================================================================
   6. Input
   --------------------------------------------------------------------------
   Turns are not applied immediately. They go into a short queue and the
   game takes one per tick. That way pressing Up then Left very quickly
   (both within one tick) performs both turns on consecutive tiles instead
   of the second key press overwriting the first.
   ========================================================================== */

class Input {
  constructor(game, stage) {
    this.game = game;
    this.queue = []; // pending directions, oldest first

    window.addEventListener('keydown', (e) => this.onKeyDown(e));

    // Swipe controls.
    this.touchStart = null;
    stage.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: true });
    stage.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
    stage.addEventListener('touchend', () => { this.touchStart = null; });
    stage.addEventListener('touchcancel', () => { this.touchStart = null; });
  }

  clear() {
    this.queue.length = 0;
  }

  /** Called by the game once per tick; returns undefined if nothing queued. */
  next() {
    return this.queue.shift();
  }

  /**
   * Try to queue a turn. Each new turn is validated against the direction
   * the snake will be travelling *when the turn is applied* — the last
   * queued direction, or the current one if the queue is empty.
   */
  enqueue(dir) {
    if (this.queue.length >= MAX_QUEUED_TURNS) return;
    const basis = this.queue.length
      ? this.queue[this.queue.length - 1]
      : this.game.snake.dir;

    const same = dir.x === basis.x && dir.y === basis.y;
    const reverse = dir.x === -basis.x && dir.y === -basis.y;
    // Same direction = nothing to do. Reverse = a 180° turn straight back
    // into the snake's own neck, which is never allowed.
    if (same || reverse) return;

    this.queue.push(dir);
    this.game.audio.turn();
  }

  /** A direction was requested by key or swipe. */
  steer(dir) {
    const game = this.game;
    if (game.settingsOpen) return;
    if (game.state === 'ready') game.start(); // any direction starts the game
    if (game.state === 'playing') this.enqueue(dir);
  }

  onKeyDown(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return; // leave browser shortcuts alone
    const game = this.game;
    game.audio.unlock();

    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

    // Direction keys
    const dirName = KEY_TO_DIR[key];
    if (dirName) {
      e.preventDefault(); // stop arrow keys scrolling the page
      this.steer(DIRS[dirName]);
      return;
    }

    if (key === 'Escape' && game.settingsOpen) {
      game.closeSettings();
      return;
    }

    if (key === ' ' || key === 'Enter') {
      // If a button has focus, let the browser "click" it as usual.
      if (e.target instanceof HTMLButtonElement) return;
      e.preventDefault();
      if (!e.repeat) game.primaryAction();
      return;
    }

    if ((key === 'p' || key === 'Escape') && !e.repeat) {
      game.togglePause();
    }
  }

  onTouchStart(e) {
    this.game.audio.unlock();
    const touch = e.touches[0];
    this.touchStart = { x: touch.clientX, y: touch.clientY };
  }

  onTouchMove(e) {
    const game = this.game;
    if (!this.touchStart || game.settingsOpen) return;
    if (game.state !== 'playing' && game.state !== 'ready') return;
    if (game.state === 'playing') e.preventDefault(); // no scroll / pull-to-refresh

    const touch = e.touches[0];
    const dx = touch.clientX - this.touchStart.x;
    const dy = touch.clientY - this.touchStart.y;
    const THRESHOLD = 24; // pixels the finger must travel to count as a swipe
    if (Math.max(Math.abs(dx), Math.abs(dy)) < THRESHOLD) return;

    // Whichever axis moved more decides the direction.
    if (Math.abs(dx) > Math.abs(dy)) {
      this.steer(dx > 0 ? DIRS.right : DIRS.left);
    } else {
      this.steer(dy > 0 ? DIRS.down : DIRS.up);
    }
    // Restart the measurement from here so one continuous drag can make
    // several turns without lifting the finger.
    this.touchStart = { x: touch.clientX, y: touch.clientY };
  }
}

/* ==========================================================================
   7. Game
   --------------------------------------------------------------------------
   States:
     'ready'    start screen, snake waiting
     'playing'  ticks are running
     'paused'   frozen mid-game
     'over'     snake crashed
     'won'      snake fills the whole board
   The settings panel is a separate flag (settingsOpen) layered on top.
   ========================================================================== */

class Game {
  constructor() {
    // --- DOM references ---
    this.el = {
      stage: document.getElementById('stage'),
      canvas: document.getElementById('board'),
      score: document.getElementById('score'),
      best: document.getElementById('best'),
      overlayStart: document.getElementById('overlay-start'),
      overlayPause: document.getElementById('overlay-pause'),
      overlayEnd: document.getElementById('overlay-end'),
      overlaySettings: document.getElementById('overlay-settings'),
      endTitle: document.getElementById('end-title'),
      endScore: document.getElementById('end-score'),
      endBest: document.getElementById('end-best'),
      endRecord: document.getElementById('end-record'),
      btnPlay: document.getElementById('btn-play'),
      btnResume: document.getElementById('btn-resume'),
      btnAgain: document.getElementById('btn-again'),
      btnPause: document.getElementById('btn-pause'),
      btnMute: document.getElementById('btn-mute'),
      btnSettings: document.getElementById('btn-settings'),
      btnSettingsDone: document.getElementById('btn-settings-done'),
    };

    // --- Persistent data ---
    this.settings = this.loadSettings();
    this.best = Number(Store.get('best', 0)) || 0;

    // --- Parts ---
    this.audio = new AudioManager();
    this.renderer = new Renderer(this.el.canvas, this.el.stage);
    this.input = new Input(this, this.el.stage);

    // --- Runtime state ---
    this.state = 'ready';
    this.settingsOpen = false;
    this.endScreenVisible = false; // the end card appears after a short delay
    this.newRecord = false;
    this.score = 0;
    this.accumulator = 0; // ms of game time not yet consumed by ticks
    this.lastFrameTime = 0;
    this.round = 0;       // increases every reset; used to cancel stale timers

    this.bindUI();
    this.reset();

    // Kick off the render loop. It runs for the lifetime of the page.
    requestAnimationFrame((now) => {
      this.lastFrameTime = now;
      this.frame(now);
    });
  }

  /* ---------- settings ---------- */

  /** Read saved settings, falling back to defaults for anything invalid. */
  loadSettings() {
    const saved = Store.get('settings', {}) || {};
    const s = { ...DEFAULT_SETTINGS };
    if (saved.speed in SPEEDS) s.speed = saved.speed;
    if (saved.board in BOARDS) s.board = saved.board;
    if (FRUIT_COUNTS.includes(saved.fruit)) s.fruit = saved.fruit;
    if (typeof saved.wrap === 'boolean') s.wrap = saved.wrap;
    return s;
  }

  get tickMs() {
    return SPEEDS[this.settings.speed];
  }

  get cols() {
    return BOARDS[this.settings.board].cols;
  }

  get rows() {
    return BOARDS[this.settings.board].rows;
  }

  /** Apply one change from the settings panel. */
  changeSetting(name, rawValue) {
    // Buttons carry their value as text; convert to the real type.
    let value = rawValue;
    if (name === 'fruit') value = Number(rawValue);
    if (name === 'wrap') value = rawValue === 'true';
    if (this.settings[name] === value) return;

    this.settings[name] = value;
    Store.set('settings', this.settings);

    // Speed can change mid-game. Everything else changes the rules of the
    // board, so it starts a fresh game.
    if (name !== 'speed') this.reset();
    this.updateUI();
  }

  /* ---------- lifecycle ---------- */

  /** Build a fresh board and go to the start screen. */
  reset() {
    this.round++;
    this.snake = new Snake(this.cols, this.rows);
    this.food = new Food();
    this.food.fill(this.settings.fruit, this.snake, this.cols, this.rows);
    this.input.clear();
    this.score = 0;
    this.accumulator = 0;
    this.state = 'ready';
    this.endScreenVisible = false;
    this.newRecord = false;
    this.renderer.resize(this.cols, this.rows);
    this.updateUI();
  }

  start() {
    if (this.state !== 'ready') return;
    this.state = 'playing';
    this.accumulator = 0;
    this.updateUI();
  }

  /** Play Again: fresh board, straight into play. */
  restart() {
    this.reset();
    this.start();
  }

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.updateUI();
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = 'playing';
    this.updateUI();
  }

  togglePause() {
    if (this.settingsOpen) return;
    if (this.state === 'playing') this.pause();
    else if (this.state === 'paused') this.resume();
  }

  /** What Space / Enter does depends on the current screen. */
  primaryAction() {
    if (this.settingsOpen) return;
    if (this.state === 'ready') this.start();
    else if (this.state === 'paused') this.resume();
    else if (this.state === 'over' || this.state === 'won') this.restart();
  }

  openSettings() {
    this.pause(); // no-op unless a game is in progress
    this.settingsOpen = true;
    this.updateUI();
  }

  closeSettings() {
    this.settingsOpen = false;
    this.updateUI();
  }

  /* ---------- the game loop ---------- */

  /**
   * Called by the browser before every repaint (usually 60+ times/second).
   *
   * Logic and drawing run at different rates:
   *   - `accumulator` collects real elapsed time.
   *   - Every time it holds a full tick's worth (e.g. 130 ms) we run ONE
   *     logic step and subtract that amount. Game speed is therefore the
   *     same on a 60 Hz and a 144 Hz screen.
   *   - Whatever is left over (0..tickMs) says how far we are into the
   *     current tick. Dividing by tickMs gives t in 0..1, which the
   *     renderer uses to draw the snake part-way between tiles.
   */
  frame(now) {
    // Time since the previous frame. Capped so a long stall (debugger,
    // slow frame) can't make the snake leap several tiles at once.
    const dt = Math.min(now - this.lastFrameTime, 100);
    this.lastFrameTime = now;

    if (this.state === 'playing') {
      this.accumulator += dt;
      while (this.accumulator >= this.tickMs && this.state === 'playing') {
        this.accumulator -= this.tickMs;
        this.tick();
      }
    } else if (this.state === 'won') {
      // Let the final move finish gliding into place, then hold.
      this.accumulator = Math.min(this.accumulator + dt, this.tickMs);
    }

    const t = Math.min(1, this.accumulator / this.tickMs);
    this.renderer.draw(this, t, now);

    requestAnimationFrame((ts) => this.frame(ts));
  }

  /** One step of game logic: move the snake by exactly one tile. */
  tick() {
    const snake = this.snake;

    // Take at most one queued turn per tick.
    const turn = this.input.next();
    if (turn) snake.dir = turn;

    let x = snake.head.x + snake.dir.x;
    let y = snake.head.y + snake.dir.y;

    // Walls: either wrap to the opposite edge, or crash.
    if (this.settings.wrap) {
      x = mod(x, this.cols);
      y = mod(y, this.rows);
    } else if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) {
      this.gameOver();
      return;
    }

    const foodIndex = this.food.indexAt(x, y);
    const eating = foodIndex !== -1;

    // Self collision. If we're not growing, the tail moves away this tick,
    // so moving onto the tail's current tile is fine.
    if (snake.occupies(x, y, !eating)) {
      this.gameOver();
      return;
    }

    snake.advance({ x, y }, eating);

    if (eating) {
      this.food.remove(foodIndex);
      this.score++;
      this.audio.eat();

      if (snake.length === this.cols * this.rows) {
        this.win(); // every tile is snake — nothing left to eat
        return;
      }
      this.food.fill(this.settings.fruit, snake, this.cols, this.rows);
      this.updateUI();
    }
  }

  gameOver() {
    this.snake.freeze();
    this.audio.gameOver();
    this.renderer.impact(performance.now());
    this.finish('over', 520);
  }

  win() {
    this.audio.win();
    this.finish('won', 700);
  }

  /** Shared ending: record the high score and show the end card shortly. */
  finish(state, delayMs) {
    this.state = state;
    this.input.clear();

    if (this.score > this.best) {
      this.best = this.score;
      this.newRecord = true;
      Store.set('best', this.best);
    }
    this.updateUI();

    // Wait a moment so the player sees what happened before the card
    // covers the board. `round` guards against the player having already
    // restarted by the time the timer fires.
    const round = this.round;
    setTimeout(() => {
      if (this.round !== round) return;
      this.endScreenVisible = true;
      this.updateUI();
      this.el.btnAgain.focus({ preventScroll: true });
    }, delayMs);
  }

  /* ---------- UI ---------- */

  /** Push the current state into the DOM (scores, overlays, buttons). */
  updateUI() {
    const el = this.el;
    el.score.textContent = this.score;
    el.best.textContent = Math.max(this.best, this.score);

    const ended = this.state === 'over' || this.state === 'won';

    // Only one overlay at a time; settings takes priority.
    el.overlaySettings.hidden = !this.settingsOpen;
    el.overlayStart.hidden = this.settingsOpen || this.state !== 'ready';
    el.overlayPause.hidden = this.settingsOpen || this.state !== 'paused';
    el.overlayEnd.hidden = this.settingsOpen || !ended || !this.endScreenVisible;

    el.endTitle.textContent = this.state === 'won' ? 'You win!' : 'Game over';
    el.endScore.textContent = this.score;
    el.endBest.textContent = this.best;
    el.endRecord.hidden = !this.newRecord;

    el.btnPause.disabled = !(this.state === 'playing' || this.state === 'paused');
    el.btnPause.style.opacity = el.btnPause.disabled ? 0.35 : 1;
    el.btnPause.setAttribute('aria-label', this.state === 'paused' ? 'Resume' : 'Pause');

    el.btnMute.setAttribute('aria-pressed', String(this.audio.muted));
    el.btnMute.setAttribute('aria-label', this.audio.muted ? 'Unmute sound' : 'Mute sound');

    // Highlight the active option in each settings group.
    document.querySelectorAll('.segmented').forEach((group) => {
      const current = String(this.settings[group.dataset.setting]);
      group.querySelectorAll('button').forEach((btn) => {
        btn.setAttribute('aria-pressed', String(btn.dataset.value === current));
      });
    });
  }

  /** Attach all button, window and document listeners. */
  bindUI() {
    const el = this.el;

    // Helper: run `fn` on click, wake up audio, and drop focus afterwards
    // so Space/Enter go back to controlling the game rather than
    // re-pressing the button.
    const onClick = (button, fn) => {
      button.addEventListener('click', () => {
        this.audio.unlock();
        fn();
        button.blur();
      });
    };

    onClick(el.btnPlay, () => this.start());
    onClick(el.btnResume, () => this.resume());
    onClick(el.btnAgain, () => this.restart());
    onClick(el.btnPause, () => this.togglePause());
    onClick(el.btnSettings, () => (this.settingsOpen ? this.closeSettings() : this.openSettings()));
    onClick(el.btnSettingsDone, () => this.closeSettings());
    onClick(el.btnMute, () => {
      this.audio.setMuted(!this.audio.muted);
      this.updateUI();
    });

    // Settings: one listener per group, reading the clicked button's value.
    document.querySelectorAll('.segmented').forEach((group) => {
      group.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (btn) this.changeSetting(group.dataset.setting, btn.dataset.value);
      });
    });

    // Auto-pause when the player looks away: tab hidden or window unfocused.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.pause();
    });
    window.addEventListener('blur', () => this.pause());

    // Keep the board fitted to the window.
    window.addEventListener('resize', () => this.renderer.resize(this.cols, this.rows));
  }
}

/* ---------- boot ---------- */

// The <script> tag is at the end of <body>, so the DOM is ready here.
// The instance is exposed on window purely so you can poke at it from the
// browser console (try: game.snake, game.settings).
window.game = new Game();
