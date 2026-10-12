/* 奶龙 2048 端到端验证
   jsdom 跑真实 DOM + game.js，与独立参考实现逐步比对。
   随机方块不预测：改为「参考实现算出移动结果 + 从 DOM 反推那一只新冒出来的奶龙」。 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HTML = fs
  .readFileSync(path.join(ROOT, 'index.html'), 'utf8')
  .replace(
    /<script src="game\.js(\?[^"]*)?"><\/script>/,
    '<script>\n' + fs.readFileSync(path.join(ROOT, 'game.js'), 'utf8') + '\n</script>'
  );

const SIZE = 4;
// 防止 index.html 里 script 标签写法一变、注入静默失败（所有用例会一起失败）
if (!/nailong2048\.best/.test(HTML)) {
  console.error('注入 game.js 失败：index.html 中的 <script> 标签格式已变化，请同步本文件的正则');
  process.exit(1);
}
const STEP = 90 + 12; // jsdom 无布局，clientWidth=0，layout() 提前返回，沿用 CSS 默认 --cell/--gap
const VEC = { up: [-1, 0], down: [1, 0], left: [0, -1], right: [0, 1] };
const DIRNAME = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
const empty4 = () => [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeRng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const dirRng = makeRng(777); // 只用于挑方向，保证复现

/* ---------------- 参考实现 ---------------- */
function linesFor(dr, dc) {
  const lines = [];
  for (let k = 0; k < SIZE; k++) {
    const line = [];
    for (let i = 0; i < SIZE; i++) {
      line.push(dc === 0 ? [dr === -1 ? i : SIZE - 1 - i, k] : [k, dc === -1 ? i : SIZE - 1 - i]);
    }
    lines.push(line);
  }
  return lines;
}

function refMove(grid, dir) {
  const [dr, dc] = VEC[dir];
  const out = empty4();
  let gained = 0;
  for (const line of linesFor(dr, dc)) {
    const seq = line.map(([r, c]) => grid[r][c]).filter((v) => v > 0);
    const slots = [];
    for (const v of seq) {
      const last = slots[slots.length - 1];
      if (last && !last.merged && last.value === v) { last.merged = true; last.value *= 2; }
      else slots.push({ value: v, merged: false });
    }
    slots.forEach((s, k) => {
      out[line[k][0]][line[k][1]] = s.value;
      if (s.merged) gained += s.value;
    });
  }
  return { grid: out, moved: JSON.stringify(out) !== JSON.stringify(grid), gained };
}

function refOver(grid) {
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (!grid[r][c]) return false;
      if (c + 1 < SIZE && grid[r][c + 1] === grid[r][c]) return false;
      if (r + 1 < SIZE && grid[r + 1][c] === grid[r][c]) return false;
    }
  }
  return true;
}

/* ---------------- DOM ---------------- */
function readGrid(dom) {
  const els = Array.from(dom.window.document.querySelectorAll('#tiles .tile'));
  const grid = empty4();
  for (const el of els) {
    const m = /translate3d\(([-\d.]+)px,\s*([-\d.]+)px/.exec(el.style.transform || '');
    if (!m) throw new Error('方块缺少 transform：' + el.outerHTML.slice(0, 90));
    const c = Math.round(parseFloat(m[1]) / STEP);
    const r = Math.round(parseFloat(m[2]) / STEP);
    if (r < 0 || r > 3 || c < 0 || c > 3) throw new Error('方块在棋盘外：' + r + ',' + c);
    if (grid[r][c]) throw new Error('两个方块重叠在：' + r + ',' + c);
    grid[r][c] = Number(el.dataset.v);
  }
  return grid;
}

function key(dom, k) {
  dom.window.document.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })
  );
}

async function boot(seed, seedLS, failTiles, failOnceTiles) {
  const dom = new JSDOM(HTML, {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(w) {
      w.Math.random = makeRng(seed); // 固定随机源，保证可复现
      if (seedLS) Object.keys(seedLS).forEach((k) => w.localStorage.setItem(k, seedLS[k]));
      if (failTiles || failOnceTiles) {
        // 模拟「方块图加载失败」：failTiles 永远失败，failOnceTiles 只失败第一次（验证重试）
        const Base = w.Image;
        const seen = {};
        w.Image = function () {
          const img = new Base();
          let src = '';
          Object.defineProperty(img, 'src', {
            get() { return src; },
            set(v) {
              src = v;
              const base = String(v).split('?')[0];
              const n = /tile-(\d+)\.png$/.exec(base);
              const num = n ? Number(n[1]) : null;
              let bad = false;
              if (num !== null) {
                if (failTiles && failTiles.indexOf(num) >= 0) bad = true;
                if (failOnceTiles && failOnceTiles.indexOf(num) >= 0 && !seen[num]) { bad = true; seen[num] = 1; }
              }
              setTimeout(() => { if (bad) { img.onerror && img.onerror(); } else { img.onload && img.onload(); } }, 0);
            }
          });
          return img;
        };
      }
    }
  });
  await sleep(50); // 等 DOMContentLoaded + init()
  return dom;
}

/* ---------------- 断言 ---------------- */
let pass = 0;
const fails = [];
function check(name, cond, extra) {
  if (cond) pass++;
  else { fails.push(name + (extra ? ' → ' + extra : '')); console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')); }
}

/* ================= 用例 ================= */
(async function run() {
  /* --- 1. 开局 + 400 步随机对局逐步比对 --- */
  {
    const dom = await boot(20261012, null);
    const doc = dom.window.document;
    check('jsdom 无布局（读格算法前提）', doc.getElementById('board').clientWidth === 0);

    const t0 = doc.querySelectorAll('#tiles .tile').length;
    check('开局生成 2 个方块', t0 === 2, '实际 ' + t0);
    let grid = readGrid(dom);
    const flat0 = grid.flat().filter((v) => v);
    check('开局方块都是 1 或 2', flat0.every((v) => v === 1 || v === 2), JSON.stringify(flat0));
    check('分数初始为 0', doc.getElementById('score').textContent === '0');
    check('空格底渲染 16 个', doc.querySelectorAll('#cells i').length === 16);
    check('初始存档已写入', !!dom.window.localStorage.getItem('nailong2048.state'));

    let score = 0, mismatch = null, realMoves = 0, merges = 0, overSeen = false;
    const dirs = ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'];

    for (let step = 0; step < 400 && !mismatch; step++) {
      const dir = dirs[Math.floor(dirRng() * 4)];
      const expected = refMove(grid, DIRNAME[dir]);
      key(dom, dir);
      await sleep(185);
      const domGrid = readGrid(dom);

      if (!expected.moved) {
        if (JSON.stringify(domGrid) !== JSON.stringify(grid)) {
          mismatch = '第 ' + step + ' 步 ' + dir + ' 本该不动，却变成 ' + JSON.stringify(domGrid);
        }
      } else {
        realMoves++;
        if (expected.gained) merges++;
        let added = 0;
        for (let r = 0; r < SIZE && !mismatch; r++) {
          for (let c = 0; c < SIZE && !mismatch; c++) {
            const e = expected.grid[r][c], a = domGrid[r][c];
            if (e === 0) {
              if (a !== 0) {
                added++;
                if (a !== 1 && a !== 2) mismatch = '第 ' + step + ' 步新方块值非法：' + a;
              }
            } else if (a !== e) {
              mismatch = '第 ' + step + ' 步 (' + r + ',' + c + ') 期望 ' + e + ' 实际 ' + a +
                '｜页面 ' + JSON.stringify(domGrid);
            }
          }
        }
        if (!mismatch && added !== 1) mismatch = '第 ' + step + ' 步新增方块数 = ' + added;
        score += expected.gained;
        grid = domGrid;
      }

      const domScore = Number(doc.getElementById('score').textContent);
      if (domScore !== score) mismatch = '第 ' + step + ' 步分数不符：页面 ' + domScore + ' / 期望 ' + score;

      const isOver = refOver(grid);
      if (doc.getElementById('overlay').hidden !== !isOver) {
        mismatch = '第 ' + step + ' 步结束遮罩状态不符（棋盘已无解=' + isOver + '）';
      }
      if (isOver) { overSeen = true; break; }
    }
    check('400 步随机对局与参考实现完全一致', !mismatch, mismatch);
    check('确实发生了大量有效移动与合并', realMoves > 100 && merges > 30, '移动 ' + realMoves + ' / 合并 ' + merges);

    const vals = readGrid(dom).flat().filter((v) => v);
    check('所有方块都是 2 的幂', vals.every((v) => v > 0 && (v & (v - 1)) === 0), JSON.stringify(vals));
    check('结束局面确实无解（若已结束）', !overSeen || refOver(readGrid(dom)));

    const saved = JSON.parse(dom.window.localStorage.getItem('nailong2048.state') || 'null');
    check('存档棋盘与页面一致', !!saved && JSON.stringify(saved.grid) === JSON.stringify(readGrid(dom)));
    check('存档分数与页面一致', !!saved && Number(saved.score) === Number(doc.getElementById('score').textContent));

    if (!overSeen) {
      check('撤销按钮在有历史时可用', doc.getElementById('undo').disabled === false);
      const before = readGrid(dom);
      doc.getElementById('undo').click();
      await sleep(40);
      check('撤销后棋盘发生变化', JSON.stringify(readGrid(dom)) !== JSON.stringify(before), JSON.stringify(readGrid(dom)));

      const g1 = readGrid(dom);
      key(dom, 'a');
      await sleep(185);
      check('小写 wasd 也能操作', JSON.stringify(readGrid(dom)) !== JSON.stringify(g1));
    }
    dom.window.close();
  }

  /* --- 2. 合成 1024 触发通关 --- */
  {
    const dom = await boot(7, {
      'nailong2048.state': JSON.stringify({
        grid: [[512, 512, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
        score: 100, won: false, over: false
      })
    });
    const doc = dom.window.document;
    check('读档：还原 512+512', readGrid(dom)[0][0] === 512 && readGrid(dom)[0][1] === 512);

    key(dom, 'ArrowLeft');
    await sleep(200);
    const g = readGrid(dom);
    check('512+512 合并为 1024', g[0][0] === 1024, JSON.stringify(g[0]));
    check('得分累加 1024', Number(doc.getElementById('score').textContent) === 1124, doc.getElementById('score').textContent);
    const ov = doc.getElementById('overlay');
    check('弹出通关遮罩', !ov.hidden);
    check('通关文案提到 1024', /1024/.test(doc.getElementById('overlay-title').textContent + doc.getElementById('overlay-text').innerHTML));
    check('通关遮罩可继续挑战', /继续挑战/.test(doc.getElementById('overlay-actions').textContent));
    check('通关后最高分已更新', Number(doc.getElementById('best').textContent) === 1124, doc.getElementById('best').textContent);

    const cont = Array.from(doc.querySelectorAll('#overlay-actions .btn')).find((b) => /继续/.test(b.textContent));
    cont.click();
    await sleep(30);
    check('点「继续挑战」后遮罩关闭', ov.hidden === true);
    dom.window.close();
  }

  /* --- 3. 无路可走 -> 游戏结束 -> 撤销复活 --- */
  {
    const dom = await boot(11, {
      'nailong2048.state': JSON.stringify({
        grid: [[0, 4, 8, 16], [2, 8, 16, 32], [4, 16, 32, 64], [8, 32, 64, 128]],
        score: 200, won: false, over: false
      })
    });
    const doc = dom.window.document;
    check('读档：左上角为空', readGrid(dom)[0][0] === 0);
    check('读档棋盘与预期一致', JSON.stringify(readGrid(dom)[3]) === JSON.stringify([8, 32, 64, 128]));

    key(dom, 'ArrowUp');
    await sleep(220);
    check('这一步确实发生了移动', readGrid(dom)[0][0] === 2, JSON.stringify(readGrid(dom)[0]));
    const ov = doc.getElementById('overlay');
    check('无路可走时弹出结束遮罩', !ov.hidden);
    check('结束遮罩提示本局得分', /200/.test(doc.getElementById('overlay-text').innerHTML), doc.getElementById('overlay-text').innerHTML);

    const undoBtn = Array.from(doc.querySelectorAll('#overlay-actions .btn')).find((b) => /撤销/.test(b.textContent));
    check('结束遮罩带「撤销一步」', !!undoBtn);
    if (undoBtn) { undoBtn.click(); await sleep(40); }
    check('撤销后遮罩关闭', ov.hidden === true);
    check('撤销后回到移动前', readGrid(dom)[0][0] === 0, JSON.stringify(readGrid(dom)[0]));
    dom.window.close();
  }

  /* --- 4. 刷新续玩 / 新游戏 / 最高分 --- */
  {
    const dom1 = await boot(4242, null);
    const doc1 = dom1.window.document;
    for (const k of ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown']) {
      for (let i = 0; i < 12; i++) { key(dom1, k); await sleep(170); }
    }
    const grid1 = readGrid(dom1);
    const score1 = doc1.getElementById('score').textContent;
    const bestShown = doc1.getElementById('best').textContent;
    const bestSaved = dom1.window.localStorage.getItem('nailong2048.best');
    const snapshot = dom1.window.localStorage.getItem('nailong2048.state');
    check('最高分已写入 localStorage', bestSaved !== null, 'best=' + bestSaved);
    check('最高分不小于本局分数', Number(bestSaved || 0) >= Number(score1), bestSaved + ' vs ' + score1);
    check('最高分显示与存档一致', Number(bestShown) === Number(bestSaved || 0), bestShown + ' vs ' + bestSaved);
    dom1.window.close();

    const dom2 = await boot(99, {
      'nailong2048.state': snapshot,
      'nailong2048.best': bestSaved
    });
    const doc2 = dom2.window.document;
    check('刷新后棋盘还原', JSON.stringify(readGrid(dom2)) === JSON.stringify(grid1), JSON.stringify(readGrid(dom2)));
    check('刷新后分数还原', doc2.getElementById('score').textContent === score1);
    check('刷新后最高分还原', doc2.getElementById('best').textContent === bestShown);

    doc2.getElementById('new-game').click();
    await sleep(50);
    const g2 = readGrid(dom2);
    check('新游戏后只剩 2 个方块', g2.flat().filter((v) => v).length === 2, JSON.stringify(g2));
    check('新游戏后分数归零', doc2.getElementById('score').textContent === '0');
    check('新游戏保留最高分', doc2.getElementById('best').textContent === bestShown, doc2.getElementById('best').textContent);
    check('新游戏存档已同步', JSON.stringify(JSON.parse(dom2.window.localStorage.getItem('nailong2048.state')).grid) === JSON.stringify(g2));
    dom2.window.close();
  }

  /* --- 5. 素材与静态资源 --- */
  {
    const dir = path.join(ROOT, 'assets', 'tiles');
    const need = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024];
    const miss = need.filter((v) => !fs.existsSync(path.join(dir, 'tile-' + v + '.png')));
    check('11 张数字方块素材齐全', miss.length === 0, '缺少 ' + miss.join(','));
    check('背景图 assets/stars.jpg 存在', fs.existsSync(path.join(ROOT, 'assets', 'stars.jpg')));
    const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
    check('CSS 引用星空背景', /assets\/stars\.jpg/.test(css));
    check('CSS 用背景图渲染方块图案', /\.face\.img-face/.test(css) && /background-size:\s*contain/.test(css));
    const js = fs.readFileSync(path.join(ROOT, 'game.js'), 'utf8');
    check('game.js 使用 localStorage', /localStorage/.test(js));
    check('game.js 预加载方块图案', /preloadTiles/.test(js));
    check('不再用 <img> 渲染方块图案', !/faceHTML/.test(js));
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    check('页面引用本地样式与脚本', /styles\.css/.test(html) && /game\.js/.test(html));
  }

  /* --- 6. 方块图案渲染 + 加载失败兜底（本次 bug 的回归用例） --- */
  {
    const seedState = JSON.stringify({
      grid: [[1, 2, 4, 8], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
      score: 0, won: false, over: false
    });

    // 6a. 正常情况：全部用背景图渲染，DOM 里不应有 <img>
    const ok = await boot(31, { 'nailong2048.state': seedState });
    const okDoc = ok.window.document;
    await sleep(60); // 等预加载完成
    const faces = Array.from(okDoc.querySelectorAll('#tiles .tile'));
    check('正常时每个方块都用背景图', faces.every((el) => {
      const f = el.querySelector('.face');
      return f && f.classList.contains('img-face') && /url\(/.test(f.style.backgroundImage);
    }), faces.map((el) => el.dataset.v + ':' + (el.querySelector('.face').style.backgroundImage || 'none')).join(' '));
    check('正常时方块内不再有 <img> 元素', okDoc.querySelectorAll('#tiles img').length === 0);
    check('背景图指向 tile-N.png', /tile-1\.png/.test(faces[0].querySelector('.face').style.backgroundImage));
    ok.window.close();

    // 6b. 数值 1 的图案彻底加载失败 -> 必须退化成文字方块，绝不能留白
    const bad = await boot(31, { 'nailong2048.state': seedState }, [1]);
    const badDoc = bad.window.document;
    await sleep(120); // 等预加载 + 重试 + 刷新
    const tiles = Array.from(badDoc.querySelectorAll('#tiles .tile'));
    const t1 = tiles.find((el) => el.dataset.v === '1');
    const t2 = tiles.find((el) => el.dataset.v === '2');
    check('加载失败时仍保留方块', !!t1 && !!t2);
    if (t1) {
      const f1 = t1.querySelector('.face');
      check('彻底失败的方块改用文字兜底', !f1.classList.contains('img-face') && /(^|\D)1(\D|$)/.test(f1.textContent),
        'face=' + f1.outerHTML);
    }
    if (t2) {
      const f2 = t2.querySelector('.face');
      check('未失败的方块不受影响', f2.classList.contains('img-face') && /url\(/.test(f2.style.backgroundImage));
    }
    bad.window.close();

    // 6c. 只是第一次失败（重试成功）-> 仍应显示图案，不误判成兜底
    const once = await boot(31, { 'nailong2048.state': seedState }, null, [4]);
    const onceDoc = once.window.document;
    await sleep(120);
    const t4 = Array.from(onceDoc.querySelectorAll('#tiles .tile')).find((el) => el.dataset.v === '4');
    check('重试成功后仍用图案显示', !!t4 && t4.querySelector('.face').classList.contains('img-face'),
      t4 ? t4.querySelector('.face').outerHTML : 'no tile');
    once.window.close();
  }

  console.log('\n通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
  if (fails.length) {
    fails.forEach((f) => console.log('  ✗ ' + f));
    process.exit(1);
  }
  console.log('全部通过 ✓');
})();
