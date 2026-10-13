/* ============================================================
   奶龙 2048  —  game.js
   纯原生实现，无依赖。数据存在 localStorage。
   ============================================================ */
(function () {
  'use strict';

  /* ---------------- 常量 ---------------- */

  var SIZE = 4;
  var TARGET = 1024;              // 通关目标（素材里最大的奶龙数字）
  var MOVE_MS = 118;
  var IMG_VALUES = { 1:1, 2:1, 4:1, 8:1, 16:1, 32:1, 64:1, 128:1, 256:1, 512:1, 1024:1 };

  var LS_BEST  = 'nailong2048.best';
  var LS_STATE = 'nailong2048.state';
  var LS_SOUND = 'nailong2048.sound';

  var VEC = {
    up:    [-1, 0],
    down:  [ 1, 0],
    left:  [ 0,-1],
    right: [ 0, 1]
  };

  /* ---------------- 安全存储（file:// 下也尽量可用） ---------------- */

  var store = (function () {
    var ok = true, mem = {};
    try {
      window.localStorage.setItem('__nl_t', '1');
      window.localStorage.removeItem('__nl_t');
    } catch (e) { ok = false; }
    return {
      ok: ok,
      get: function (k) {
        try { return ok ? window.localStorage.getItem(k) : (k in mem ? mem[k] : null); }
        catch (e) { return null; }
      },
      set: function (k, v) {
        try { if (ok) window.localStorage.setItem(k, v); else mem[k] = v; } catch (e) {}
      },
      del: function (k) {
        try { if (ok) window.localStorage.removeItem(k); else delete mem[k]; } catch (e) {}
      }
    };
  })();

  /* ---------------- 音效（WebAudio，无外部资源） ---------------- */

  var Sound = (function () {
    var ctx = null, on = true;
    function ac() {
      if (!ctx) {
        var C = window.AudioContext || window.webkitAudioContext;
        if (!C) return null;
        ctx = new C();
      }
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
      return ctx;
    }
    function blip(freq, dur, type, vol) {
      if (!on) return;
      var c = ac(); if (!c) return;
      try {
        var o = c.createOscillator(), g = c.createGain();
        o.type = type || 'sine';
        o.frequency.value = freq;
        var t = c.currentTime;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(vol || 0.05, t + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g); g.connect(c.destination);
        o.start(t); o.stop(t + dur + 0.03);
      } catch (e) {}
    }
    return {
      move:  function () { blip(300, 0.07, 'sine', 0.03); },
      merge: function (v) { blip(300 + Math.log(v) / Math.LN2 * 42, 0.13, 'triangle', 0.045); },
      win:   function () { [523, 659, 784, 1047].forEach(function (f, i) { setTimeout(function () { blip(f, 0.26, 'triangle', 0.05); }, i * 105); }); },
      over:  function () { [392, 311, 233].forEach(function (f, i) { setTimeout(function () { blip(f, 0.3, 'sawtooth', 0.03); }, i * 150); }); },
      setOn: function (v) { on = !!v; },
      isOn:  function () { return on; }
    };
  })();

  /* ---------------- DOM ---------------- */

  var board       = document.getElementById('board');
  var cellsLayer  = document.getElementById('cells');
  var tilesLayer  = document.getElementById('tiles');
  var scoreEl     = document.getElementById('score');
  var bestEl      = document.getElementById('best');
  var undoBtn     = document.getElementById('undo');
  var newBtn      = document.getElementById('new-game');
  var soundBtn    = document.getElementById('sound');
  var helpBtn     = document.getElementById('help');
  var overlay     = document.getElementById('overlay');
  var overlayTitle= document.getElementById('overlay-title');
  var overlayText = document.getElementById('overlay-text');
  var overlayActs = document.getElementById('overlay-actions');
  var modal       = document.getElementById('modal');
  var modalClose  = document.getElementById('modal-close');
  var storageNote = document.getElementById('storage-note');

  /* ---------------- 状态 ---------------- */

  var grid   = [];            // SIZE x SIZE，存 tile 对象或 null
  var tiles  = [];            // 存活方块（tile 对象数组）
  var nextId = 1;
  var score  = 0;
  var best   = 0;
  var won    = false;
  var over   = false;
  var busy   = false;
  var history = [];           // 撤销栈
  var cellPx = 90;
  var gapPx  = 12;

  /* ---------------- 工具 ---------------- */

  function emptyGrid() {
    var g = [];
    for (var r = 0; r < SIZE; r++) {
      var row = [];
      for (var c = 0; c < SIZE; c++) row.push(null);
      g.push(row);
    }
    return g;
  }

  /* 方块图案用 CSS 背景图渲染（不用 <img>）：
     背景图不会出现「碎图」占位，也不会因为元素异步加载而出现空白方块。
     启动时统一预加载一次，任何一张加载失败都会退化成文字方块，绝不会留白。 */
  var tileReady = {};                    // value -> true(可用) / false(加载失败)

  function TILE_SRC(v) {
    return 'assets/tiles/tile-' + v + '.png';
  }

  function paintFace(faceEl, v) {
    if (!faceEl) return;
    var useImg = !!IMG_VALUES[v] && tileReady[v] !== false;
    faceEl.classList.toggle('img-face', useImg);
    faceEl.style.backgroundImage = useImg ? 'url("' + TILE_SRC(v) + '")' : '';
    faceEl.innerHTML = useImg ? '' : '<span class="txt">' + v + '</span>';
  }

  function refreshFaces() {
    for (var i = 0; i < tiles.length; i++) {
      var t = tiles[i];
      if (t.el) paintFace(t.el.querySelector('.face'), t.value);
    }
  }

  function preloadTiles(done) {
    var list = Object.keys(IMG_VALUES).map(Number);
    var left = list.length;
    if (!left) { done(); return; }

    function finish() { if (--left === 0) done(); }

    list.forEach(function (v) {
      var im = new Image();
      im.onload = function () { tileReady[v] = true; finish(); };
      im.onerror = function () {
        // 再试一次（带参数绕开可能存在的负缓存），仍失败就标记为不可用
        var retry = new Image();
        retry.onload = function () { tileReady[v] = true; finish(); };
        retry.onerror = function () { tileReady[v] = false; finish(); };
        retry.src = TILE_SRC(v) + '?retry=1';
      };
      im.src = TILE_SRC(v);
    });
  }

  function place(el, r, c) {
    var step = cellPx + gapPx;
    el.style.transform = 'translate3d(' + (c * step) + 'px,' + (r * step) + 'px,0)';
  }

  function buzz(ms) {
    if (navigator.vibrate) { try { navigator.vibrate(ms); } catch (e) {} }
  }

  /* ---------------- 布局 ---------------- */

  function layout() {
    var bw = board.clientWidth;
    if (!bw) return;
    var gap = Math.max(6, Math.round(bw * 0.026));
    var cell = (bw - gap * 5) / SIZE;
    gapPx = gap;
    cellPx = cell;
    board.style.setProperty('--gap', gap + 'px');
    board.style.setProperty('--cell', cell + 'px');

    tilesLayer.classList.add('no-anim');
    for (var i = 0; i < tiles.length; i++) place(tiles[i].el, tiles[i].r, tiles[i].c);
    void tilesLayer.offsetWidth;            // 强制回流，避免位移被动画
    tilesLayer.classList.remove('no-anim');
  }

  /* ---------------- 方块 ---------------- */

  function makeTile(value, r, c, isSpawn) {
    var t = { id: ++nextId, value: value, r: r, c: c, el: null, pending: null };
    var el = document.createElement('div');
    el.className = 'tile' + (isSpawn ? ' spawn' : '');
    el.dataset.v = value;
    var face = document.createElement('div');
    face.className = 'face';
    paintFace(face, value);
    el.appendChild(face);
    place(el, r, c);
    tilesLayer.appendChild(el);
    t.el = el;
    if (isSpawn) {
      setTimeout(function () { el.classList.remove('spawn'); }, 220);
    }
    grid[r][c] = t;
    tiles.push(t);
    return t;
  }

  function clearBoard() {
    for (var i = 0; i < tiles.length; i++) {
      if (tiles[i].el && tiles[i].el.parentNode) tiles[i].el.parentNode.removeChild(tiles[i].el);
      tiles[i].el = null;
    }
    tiles = [];
    grid = emptyGrid();
  }

  function spawnRandom() {
    var empties = [];
    for (var r = 0; r < SIZE; r++) {
      for (var c = 0; c < SIZE; c++) if (!grid[r][c]) empties.push([r, c]);
    }
    if (!empties.length) return null;
    var pick = empties[Math.floor(Math.random() * empties.length)];
    return makeTile(Math.random() < 0.9 ? 1 : 2, pick[0], pick[1], true);
  }

  /* ---------------- 计分 ---------------- */

  function floatScore(n) {
    var box = scoreEl.parentNode;
    var s = document.createElement('span');
    s.className = 'float-score';
    s.textContent = '+' + n;
    box.appendChild(s);
    setTimeout(function () { if (s.parentNode) s.parentNode.removeChild(s); }, 830);
  }

  function addScore(n) {
    score += n;
    scoreEl.textContent = score;
    if (score > best) {
      best = score;
      bestEl.textContent = best;
      store.set(LS_BEST, String(best));
    }
    floatScore(n);
  }

  /* ---------------- 核心：移动 ---------------- */

  function linesFor(dr, dc) {
    var lines = [], i, k, line;
    if (dc === 0) {
      for (k = 0; k < SIZE; k++) {
        line = [];
        for (i = 0; i < SIZE; i++) line.push([dr === -1 ? i : SIZE - 1 - i, k]);
        lines.push(line);
      }
    } else {
      for (k = 0; k < SIZE; k++) {
        line = [];
        for (i = 0; i < SIZE; i++) line.push([k, dc === -1 ? i : SIZE - 1 - i]);
        lines.push(line);
      }
    }
    return lines;
  }

  function move(dir) {
    if (busy || over) return;
    var v = VEC[dir];
    if (!v) return;
    var dr = v[0], dc = v[1];

    var lines = linesFor(dr, dc);
    var snapshot = serialize();
    var newGrid = emptyGrid();
    var dying = [];
    var mergedLeads = [];
    var moved = false, gained = 0;

    for (var li = 0; li < lines.length; li++) {
      var line = lines[li];
      var seq = [];
      for (var j = 0; j < line.length; j++) {
        var t0 = grid[line[j][0]][line[j][1]];
        if (t0) seq.push(t0);
      }
      // 压缩 + 合并
      var slots = [];
      for (var s = 0; s < seq.length; s++) {
        var t = seq[s];
        var last = slots[slots.length - 1];
        if (last && !last.merged && last.value === t.value) {
          last.merged = true;
          last.value *= 2;
          last.absorbed.push(t);
        } else {
          slots.push({ lead: t, value: t.value, merged: false, absorbed: [] });
        }
      }
      // 落位
      for (var k = 0; k < slots.length; k++) {
        var slot = slots[k];
        var pos = line[k];
        var lead = slot.lead;
        if (lead.r !== pos[0] || lead.c !== pos[1]) moved = true;
        lead.r = pos[0]; lead.c = pos[1];
        newGrid[pos[0]][pos[1]] = lead;
        for (var a = 0; a < slot.absorbed.length; a++) {
          var ab = slot.absorbed[a];
          ab.r = pos[0]; ab.c = pos[1];
          dying.push(ab);
          moved = true;
        }
        if (slot.merged) {
          lead.pending = slot.value;
          gained += slot.value;
          mergedLeads.push(lead);
        }
      }
    }

    if (!moved) {
      // 满盘且无路可走：即使这次没动，也要给出结束提示
      if (!over && isGameOver()) {
        over = true;
        Sound.over();
        showOver();
        save();
      }
      return;
    }

    history.push(snapshot);
    if (history.length > 40) history.shift();
    updateUndoBtn();

    grid = newGrid;
    // 被吞掉的方块从存活列表摘掉，但元素留着做位移动画
    for (var d = 0; d < dying.length; d++) {
      var idx = tiles.indexOf(dying[d]);
      if (idx >= 0) tiles.splice(idx, 1);
    }

    // 位移动画
    for (var i2 = 0; i2 < tiles.length; i2++) place(tiles[i2].el, tiles[i2].r, tiles[i2].c);
    for (var i3 = 0; i3 < dying.length; i3++) place(dying[i3].el, dying[i3].r, dying[i3].c);

    if (gained) addScore(gained);
    if (mergedLeads.length) { Sound.merge(mergedLeads[mergedLeads.length - 1].pending); buzz(12); }
    else Sound.move();

    busy = true;
    window.setTimeout(function () {
      // 结算合并
      for (var i = 0; i < dying.length; i++) {
        if (dying[i].el && dying[i].el.parentNode) dying[i].el.parentNode.removeChild(dying[i].el);
        dying[i].el = null;
      }
      for (var j2 = 0; j2 < mergedLeads.length; j2++) {
        var lead = mergedLeads[j2];
        lead.value = lead.pending;
        lead.pending = null;
        lead.el.dataset.v = lead.value;
        paintFace(lead.el.querySelector('.face'), lead.value);
        lead.el.classList.add('pop');
        (function (el) { setTimeout(function () { el.classList.remove('pop'); }, 230); })(lead.el);
      }
      spawnRandom();
      busy = false;
      save();
      checkState();
    }, MOVE_MS);
  }

  /* ---------------- 胜负判定 ---------------- */

  function hasValueAtLeast(n) {
    for (var i = 0; i < tiles.length; i++) if (tiles[i].value >= n) return true;
    return false;
  }

  function isGameOver() {
    for (var r = 0; r < SIZE; r++) {
      for (var c = 0; c < SIZE; c++) {
        var t = grid[r][c];
        if (!t) return false;
        if (c + 1 < SIZE && grid[r][c + 1] && grid[r][c + 1].value === t.value) return false;
        if (r + 1 < SIZE && grid[r + 1][c] && grid[r + 1][c].value === t.value) return false;
      }
    }
    return true;
  }

  function checkState() {
    if (!won && hasValueAtLeast(TARGET)) {
      won = true;
      Sound.win();
      buzz([18, 60, 18, 60, 30]);
      showWin();
      save();
      return;
    }
    if (isGameOver()) {
      over = true;
      Sound.over();
      showOver();
      save();
    }
  }

  /* ---------------- 遮罩 / 弹窗 ---------------- */

  function showOverlay(title, text, actions) {
    overlayTitle.textContent = title;
    overlayText.innerHTML = text;
    overlayActs.innerHTML = '';
    for (var i = 0; i < actions.length; i++) {
      (function (a) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn' + (a.primary ? ' primary' : '');
        b.textContent = a.label;
        b.addEventListener('click', a.onClick);
        overlayActs.appendChild(b);
      })(actions[i]);
    }
    overlay.hidden = false;
  }

  function hideOverlay() { overlay.hidden = true; }

  function showWin() {
    showOverlay(
      '🎉 1024 奶龙达成！',
      '你把小奶龙一路叠到了 1024，已经是奶龙收藏家了。<br>要不要继续往上冲？',
      [
        { label: '继续挑战', onClick: function () { hideOverlay(); board.focus({ preventScroll: true }); } },
        { label: '重新开始', primary: true, onClick: newGame }
      ]
    );
  }

  function showOver() {
    showOverlay(
      '😵 格子满啦',
      '本局得分 <b>' + score + '</b>　最高分 <b>' + best + '</b><br>要不要退一步再想想？',
      [
        { label: '撤销一步', onClick: function () { undo(); } },
        { label: '再来一局', primary: true, onClick: newGame }
      ]
    );
  }

  function openModal() { modal.hidden = false; }
  function closeModal() { modal.hidden = true; }

  /* ---------------- 撤销 ---------------- */

  function serialize() {
    var g = [], r, c, row;
    for (r = 0; r < SIZE; r++) {
      row = [];
      for (c = 0; c < SIZE; c++) row.push(grid[r][c] ? grid[r][c].value : 0);
      g.push(row);
    }
    return { grid: g, score: score, won: won };
  }

  function restore(snap) {
    clearBoard();
    score = snap.score || 0;
    won = !!snap.won;
    over = false;
    busy = false;
    scoreEl.textContent = score;
    for (var r = 0; r < SIZE; r++) {
      for (var c = 0; c < SIZE; c++) {
        var v = snap.grid[r][c];
        if (v) makeTile(v, r, c, false);
      }
    }
    hideOverlay();
    save();
    updateUndoBtn();
  }

  function undo() {
    if (busy || !history.length) return;
    var snap = history.pop();
    restore(snap);
    Sound.move();
    board.focus({ preventScroll: true });
  }

  function updateUndoBtn() {
    undoBtn.disabled = history.length === 0;
  }

  /* ---------------- 存档 ---------------- */

  function save() {
    store.set(LS_STATE, JSON.stringify({
      grid: serialize().grid,
      score: score,
      won: won,
      over: over
    }));
  }

  function loadState() {
    var raw = store.get(LS_STATE);
    if (!raw) return false;
    var s;
    try { s = JSON.parse(raw); } catch (e) { return false; }
    if (!s || !s.grid || s.grid.length !== SIZE) return false;

    clearBoard();
    score = Number(s.score) || 0;
    won = !!s.won;
    over = !!s.over;
    scoreEl.textContent = score;

    var any = false;
    for (var r = 0; r < SIZE; r++) {
      for (var c = 0; c < SIZE; c++) {
        var v = Number(s.grid[r] && s.grid[r][c]) || 0;
        if (v > 0) { makeTile(v, r, c, false); any = true; }
      }
    }
    if (!any) return false;
    if (over) showOver();
    return true;
  }

  /* ---------------- 开局 ---------------- */

  function newGame() {
    history = [];
    clearBoard();
    score = 0;
    won = false;
    over = false;
    busy = false;
    scoreEl.textContent = '0';
    hideOverlay();
    updateUndoBtn();
    spawnRandom();
    spawnRandom();
    save();
    board.focus({ preventScroll: true });
  }

  /* ---------------- 输入 ---------------- */

  var KEYMAP = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    w: 'up', s: 'down', a: 'left', d: 'right',
    W: 'up', S: 'down', A: 'left', D: 'right',
    k: 'up', j: 'down', h: 'left', l: 'right'
  };

  document.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.key === 'Escape') { closeModal(); return; }
    if (e.key === 'z' || e.key === 'Z') { if (!modal.hidden) return; undo(); return; }

    var dir = KEYMAP[e.key];
    if (!dir) return;
    if (!modal.hidden) return;
    e.preventDefault();
    move(dir);
  }, { passive: false });

  // 触摸 / 鼠标拖拽
  var sx = 0, sy = 0, tracking = false, pid = null;

  board.addEventListener('pointerdown', function (e) {
    if (e.target.closest && e.target.closest('button')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    tracking = true;
    pid = e.pointerId;
    sx = e.clientX; sy = e.clientY;
    if (board.setPointerCapture) { try { board.setPointerCapture(pid); } catch (err) {} }
  });

  board.addEventListener('pointerup', function (e) {
    if (!tracking) return;
    tracking = false;
    var dx = e.clientX - sx, dy = e.clientY - sy;
    var ax = Math.abs(dx), ay = Math.abs(dy);
    if (Math.max(ax, ay) < 22) return;
    move(ax > ay ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
  });

  board.addEventListener('pointercancel', function () { tracking = false; });

  // 按钮
  newBtn.addEventListener('click', newGame);
  undoBtn.addEventListener('click', undo);
  helpBtn.addEventListener('click', openModal);
  modalClose.addEventListener('click', closeModal);
  modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });

  soundBtn.addEventListener('click', function () {
    var next = !Sound.isOn();
    Sound.setOn(next);
    soundBtn.setAttribute('aria-pressed', next ? 'true' : 'false');
    soundBtn.textContent = next ? '🔊' : '🔇';
    store.set(LS_SOUND, next ? '1' : '0');
    if (next) Sound.move();
  });

  window.addEventListener('resize', layout);
  window.addEventListener('orientationchange', function () { setTimeout(layout, 120); });
  window.addEventListener('beforeunload', save);
  document.addEventListener('visibilitychange', function () { if (document.hidden) save(); });

  /* ---------------- 启动 ---------------- */

  function init() {
    // 空格底
    var frag = document.createDocumentFragment();
    for (var i = 0; i < SIZE * SIZE; i++) frag.appendChild(document.createElement('i'));
    cellsLayer.appendChild(frag);

    // 最高分
    best = Number(store.get(LS_BEST)) || 0;
    if (!isFinite(best) || best < 0) best = 0;
    bestEl.textContent = best;

    // 音效开关
    var snd = store.get(LS_SOUND);
    var soundOn = snd === null ? true : snd === '1';
    Sound.setOn(soundOn);
    soundBtn.setAttribute('aria-pressed', soundOn ? 'true' : 'false');
    soundBtn.textContent = soundOn ? '🔊' : '🔇';

    if (!store.ok && storageNote) {
      storageNote.textContent = '当前环境不支持本地存档';
    }

    layout();

    if (!loadState()) {
      newGame();
    } else {
      updateUndoBtn();
      board.focus({ preventScroll: true });
    }

    // 预加载全部方块图案；个别加载失败时刷新一次，让它们退化成文字方块而不是留白
    preloadTiles(function () { refreshFaces(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
