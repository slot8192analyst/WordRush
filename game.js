/* ===== 設定 ===== */
const NUM_QUESTIONS = 12;
const TIME_LIMIT = 30, HINT_AT = 10;
const PREFER_FAMILY = false;   // 完全ランダム出題（アナグラム優先をオフ）
const MIN_LEN = 4;
const DICT_URL = "words_alpha.txt";

const LENGTH_PLAN = [
  { len:4, count:3 },   // 25%
  { len:5, count:4 },   // 33%
  { len:6, count:2 },
  { len:7, count:2 },
  { len:8, count:1 },   // 6文字以上で 5問（42%）
];

/* スコア配点 */
const PT_PER_LETTER = 30;   // 基礎点 = 文字数² × これ（全体スケール）
const PT_TIME_RATE  = 1.0;  // 時間ボーナス最大 = 基礎点 × これ（残り時間フル時）

/* モードごとの短縮コード（IDの接頭辞） */
const MODE_CODE = { junior:"JR", senior:"SR", common:"CT", toeic_s:"TS", toeic_g:"TG" };
const CODE_MODE = Object.fromEntries(Object.entries(MODE_CODE).map(([k,v])=>[v,k]));

/* ===== ランキングAPI ===== */
const RANKING_API = "https://wordrush-57z.pages.dev";

/* データ */
let MODES = [];
let WORDS_BY_MODE = {};
let DICT_BY_KEY = null;
let WORD_POOL = [];
let currentMode = null;
let currentSeed = 0;
let fromSharedCode = false;   // 共有コード由来かどうか

const $ = id => document.getElementById(id);
function letterKey(str){ return str.toLowerCase().split("").sort().join(""); }

/* ===== シード付き乱数（mulberry32） ===== */
let rngState = 1;
function seedRng(seed){ rngState = seed >>> 0; }
function rng(){
  rngState |= 0; rngState = (rngState + 0x6D2B79F5) | 0;
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function shuffle(a){ for(let i=a.length-1;i>0;i--){const j=(rng()*(i+1))|0;[a[i],a[j]]=[a[j],a[i]];} return a; }

/* ===== ID <-> {mode, seed} ===== */
function makeCode(mode, seed){ return `${MODE_CODE[mode]}-${String(seed).padStart(4,"0")}`; }
function parseCode(str){
  const m = String(str).trim().toUpperCase().replace(/\s+/g,"").match(/^([A-Z]{2})-?(\d{1,6})$/);
  if(!m) return null;
  const mode = CODE_MODE[m[1]];
  if(!mode) return null;
  return { mode, seed: parseInt(m[2],10) };
}

/* ===== 時刻表示（当日は相対、前日以前は絶対） ===== */
function formatTime(ts){
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.getFullYear()===now.getFullYear()
               && d.getMonth()===now.getMonth()
               && d.getDate()===now.getDate();
  if(sameDay){
    const diffSec = Math.max(0, Math.floor((now - d)/1000));
    if(diffSec < 60) return "たった今";
    const diffMin = Math.floor(diffSec/60);
    if(diffMin < 60) return `${diffMin}分前`;
    const diffHour = Math.floor(diffMin/60);
    return `${diffHour}時間前`;
  }
  const y = d.getFullYear();
  const mo = String(d.getMonth()+1).padStart(2,"0");
  const da = String(d.getDate()).padStart(2,"0");
  const h = String(d.getHours()).padStart(2,"0");
  const mi = String(d.getMinutes()).padStart(2,"0");
  return `${y}/${mo}/${da} ${h}:${mi}`;
}

/* ===== 辞書 ===== */
function ingestDict(text){
  DICT_BY_KEY = new Map();
  for(const raw of text.split(/\r?\n/)){
    const w = raw.trim().toLowerCase();
    if(!w || w.length < MIN_LEN || !/^[a-z]+$/.test(w)) continue;
    const k = letterKey(w);
    if(!DICT_BY_KEY.has(k)) DICT_BY_KEY.set(k, []);
    DICT_BY_KEY.get(k).push(w);
  }
}
function familyOf(key){
  const set = new Set();
  if(DICT_BY_KEY && DICT_BY_KEY.has(key)) DICT_BY_KEY.get(key).forEach(w=>set.add(w));
  WORD_POOL.forEach(w=>{ if(letterKey(w.en)===key) set.add(w.en.toLowerCase()); });
  return set;
}
function jaFor(en, q){
  if(q && q.main.en.toLowerCase() === en) return q.main.ja;
  const hit = WORD_POOL.find(w => w.en.toLowerCase() === en);
  return hit ? hit.ja : "";
}

/* ===== 出題選択（seedRng 済み前提） ===== */
/* PREFER_FAMILY が true のときのみ familyCount による加重シャッフルを使う。
   false（既定）なら完全ランダム。                                      */
function weightedShuffle(arr){
  return arr
    .map(c => ({ c, key: -Math.log(rng() + 1e-9) / (c.familyCount + 1) }))
    .sort((a, b) => a.key - b.key)
    .map(x => x.c);
}

function pickQuestions(){
  const raw = WORD_POOL
    .filter(w => w.en.length >= MIN_LEN)
    .map(w=>{
      const en = w.en.toLowerCase(), key = letterKey(en);
      const fam = familyOf(key); fam.delete(en);
      return { main:{en:w.en,ja:w.ja}, letters:w.en.toUpperCase(),
               len:w.en.length, key, familyCount:fam.size };
    });

  // アナグラムグループから1語ずつランダムに選ぶ
  const byKey = new Map();
  for(const c of raw){ if(!byKey.has(c.key)) byKey.set(c.key, []); byKey.get(c.key).push(c); }
  const uniq = [...byKey.values()].map(group => shuffle(group)[0]);

  // 長さ別に分けて並べる
  const byLen = {};
  for(const c of uniq){ (byLen[c.len] = byLen[c.len] || []).push(c); }
  for(const len in byLen){
    byLen[len] = PREFER_FAMILY ? weightedShuffle(byLen[len]) : shuffle(byLen[len]);
  }

  const chosen = [];
  for(const plan of LENGTH_PLAN){
    const bucket = byLen[plan.len] || [];
    for(let i=0; i<plan.count && bucket.length; i++){ chosen.push(bucket.shift()); }
  }
  if(chosen.length < NUM_QUESTIONS){
    const rest = Object.values(byLen).flat().filter(c => !chosen.includes(c));
    rest.sort((a,b) => a.len !== b.len ? a.len - b.len : rng() - 0.5);
    while(chosen.length < NUM_QUESTIONS && rest.length) chosen.push(rest.shift());
  }
  return chosen.slice(0, NUM_QUESTIONS);
}

let QUESTIONS=[];
function buildValidSet(q){ const set = familyOf(letterKey(q.letters)); set.add(q.main.en.toLowerCase()); return set; }

let qi=0, validSet, poolKey, poolLen, timeLeft, timer, paused, qStart;
let typed=[]; let results=[]; let totalScore=0;
let usedPause=false;   // 一時停止を一度でも使ったか（ランキング対象外判定）

function startQuestion(i){
  qi=i; const q=QUESTIONS[i];
  poolKey=letterKey(q.letters); poolLen=q.letters.length;
  validSet=buildValidSet(q);
  typed=[]; timeLeft=TIME_LIMIT; paused=false; qStart=Date.now();
  renderLetters(shuffle(q.letters.split("")));
  markCurrentCell();
  $("answer").innerHTML="&nbsp;"; $("hint").innerHTML="&nbsp;";
  $("msg").textContent=`第 ${i+1} 問 / ${QUESTIONS.length}`;
  $("timer").classList.remove("warn");
  updateTyped(); updateTimer();
  clearInterval(timer); timer=setInterval(tick,1000);
}

function renderBoard(){ const b=$("board"); b.innerHTML="";
  QUESTIONS.forEach((_,idx)=>{const c=document.createElement("div");c.className="cell";c.dataset.idx=idx;b.appendChild(c);}); }
function markCurrentCell(){ document.querySelectorAll(".cell.current").forEach(c=>c.classList.remove("current"));
  const cur=document.querySelector(`.cell[data-idx="${qi}"]`); if(cur)cur.classList.add("current"); }

function renderLetters(arr){
  const box=$("letters"); box.innerHTML="";
  box.setAttribute("data-count", arr.length);
  const items = arr.map((ch, li) => ({ ch, li }));
  const topCount = Math.ceil(items.length / 2);
  const rows = [ items.slice(0, topCount), items.slice(topCount) ];
  let order = 0; const STEP = 0.06;
  rows.forEach((row)=>{
    const rowEl = document.createElement("div"); rowEl.className = "letter-row";
    row.forEach(({ch, li})=>{
      const el=document.createElement("div"); el.className="letter enter";
      el.textContent=ch; el.dataset.li=li;
      el.style.setProperty("--d", (order++ * STEP) + "s");
      el.onclick=(e)=>{e.stopPropagation(); onLetterClick(li,ch,el);};
      rowEl.appendChild(el);
    });
    box.appendChild(rowEl);
  });
}

function onLetterClick(li,ch,el){
  if(paused) return;
  const pos=typed.findIndex(t=>t.li===li);
  if(pos!==-1){ typed=typed.slice(0,pos); refreshUsed(); updateTyped(); return; }
  typed.push({ch,li}); el.classList.add("used"); updateTyped();
  if(typed.length===poolLen) autoSubmit();
}
function refreshUsed(){ document.querySelectorAll(".letter").forEach(el=>{
  el.classList.toggle("used", typed.some(t=>t.li===+el.dataset.li)); }); }
function updateTyped(){ $("typed").textContent=typed.map(t=>t.ch).join("");
  $("eraser").classList.toggle("show", typed.length>0); }
function clearInput(){ typed=[]; refreshUsed(); updateTyped(); }

function autoSubmit(){
  const guess=typed.map(t=>t.ch).join("").toLowerCase();
  if(validSet.has(guess)){ finishQuestion(true,guess); }
  else{ $("msg").textContent="不正解！"; flashWrong();
    setTimeout(()=>{ clearInput(); $("msg").textContent=` ${qi+1}  / ${QUESTIONS.length}`; },350); }
}
function flashWrong(){ $("typed").style.color="var(--bad)"; setTimeout(()=>{$("typed").style.color="";},350); }

function finishQuestion(ok, guess){
  clearInterval(timer);
  const q = QUESTIONS[qi];
  const sec = Math.min(TIME_LIMIT, Math.round((Date.now()-qStart)/1000));
  const remain = ok ? Math.max(0, TIME_LIMIT - sec) : 0;
  const cell=document.querySelector(`.cell[data-idx="${qi}"]`);
  cell.classList.remove("current"); cell.classList.add(ok?"correct":"missed");

  const intendedEn = q.main.en.toLowerCase();
  const shownEn = ok && guess ? guess : intendedEn;
  const shownJa = jaFor(shownEn, q);
  const showIntended = ok && guess && guess !== intendedEn;
  const intended = showIntended ? { en:q.main.en, ja:q.main.ja } : null;

  const base  = ok ? (shownEn.length * shownEn.length) * PT_PER_LETTER : 0;
  const bonus = ok ? Math.round(base * PT_TIME_RATE * (remain / TIME_LIMIT)) : 0;
  const score = base + bonus;
  totalScore += score;

  results.push({ en:shownEn, ja:shownJa, intended, ok, sec: ok?sec:TIME_LIMIT, base, bonus, score });

  let html = shownEn.toUpperCase();
  if(shownJa) html += ` <span class="ja">${shownJa}</span>`;
  if(intended) html += `<div class="intended">（${intended.en.toUpperCase()} <span class="ja">${intended.ja}</span>）</div>`;
  $("answer").innerHTML = html;

  $("msg").textContent = ok ? `正解！ +${score.toLocaleString()}点 (${sec}秒)` : "時間切れ…";
  setTimeout(()=>{ (qi+1<QUESTIONS.length)?startQuestion(qi+1):showResult(); }, ok?1100:1500);
}

function tick(){ if(paused)return; timeLeft--; updateTimer();
  if(timeLeft<=HINT_AT){ $("timer").classList.add("warn"); $("hint").textContent="ヒント: "+QUESTIONS[qi].main.ja; }
  if(timeLeft<=0) finishQuestion(false,null); }
function updateTimer(){ $("timer").innerHTML=timeLeft+"<small>s</small>"; }

function showResult(){
  clearInterval(timer);
  $("game").style.display="none";
  $("result").style.display="flex";
  const okCount=results.filter(r=>r.ok).length;

  const CELL_STEP = 0.05;
  const rb=$("resultBoard"); rb.innerHTML="";
  results.forEach((r,i)=>{
    const c=document.createElement("div");
    c.className="cell reveal "+(r.ok?"correct":"missed");
    c.style.setProperty("--d", (i*CELL_STEP)+"s");
    rb.appendChild(c);
  });
  const afterCells = results.length * CELL_STEP;

  const scoreEl = $("scoreLine");
  scoreEl.innerHTML = `${totalScore.toLocaleString()} <small style="font-size:16px;color:var(--sub);">pts</small>`
                    + `<div style="font-size:15px;color:var(--sub);font-weight:700;margin-top:4px;">${okCount} / ${results.length} words</div>`;
  scoreEl.classList.remove("floatUp"); void scoreEl.offsetWidth; scoreEl.classList.add("floatUp");
  scoreEl.style.setProperty("--d", (afterCells + 0.1) + "s");

  const modeLabel = (MODES.find(m=>m.id===currentMode)||{}).label || "";
  const codeEl = $("resultCode");
  codeEl.innerHTML = `${modeLabel}　ID <b>${makeCode(currentMode, currentSeed)}</b>`;
  codeEl.classList.remove("floatUp"); void codeEl.offsetWidth; codeEl.classList.add("floatUp");
  codeEl.style.setProperty("--d", (afterCells + 0.22) + "s");

  const list=$("resultList"); list.innerHTML="";
  const ROW_STEP = 0.06;
  results.forEach((r,i)=>{
    const intendedHtml = r.intended ? `<span class="intended">(${r.intended.en.toUpperCase()})</span>` : "";
    const jaHtml = r.ja ? `<span class="ja">${r.ja}</span>`
                        : (r.intended ? `<span class="ja">${r.intended.ja}</span>` : "");
    const secHtml = r.ok
      ? `<span class="sec">${r.score.toLocaleString()}<small style="font-size:11px;color:var(--sub);"> pts</small></span>`
      : `<span class="sec ng"><span class="emoji">&#128148;</span></span>`;
    const row=document.createElement("div"); row.className="res-row floatUp";
    row.style.setProperty("--d", (afterCells + 0.42 + i*ROW_STEP) + "s");
    row.innerHTML =
      `<div><span class="word">${r.en.toUpperCase()} ${intendedHtml}</span>${jaHtml}</div>`+
      `<div>${secHtml}</div>`;
    list.appendChild(row);
  });

  // ランキング登録欄（一時停止を使っていない場合のみ）
  renderScoreRegister(afterCells + 0.42 + results.length * ROW_STEP + 0.2);
}

/* ===== スコア登録欄（結果画面） ===== */
function renderScoreRegister(delay){
  const box = $("registerBox");
  box.innerHTML = "";
  box.style.setProperty("--d", delay + "s");
  box.classList.remove("floatUp"); void box.offsetWidth; box.classList.add("floatUp");

  if(usedPause){
    box.innerHTML = `<div class="reg-disabled">一時停止を使ったため、このプレイはランキング対象外です</div>`;
    return;
  }
  box.innerHTML = `
    <div class="reg-title">ランキングに登録</div>
    <div class="reg-row">
      <input id="nameInput" type="text" maxlength="12" autocomplete="off" placeholder="名前を入力">
      <button id="submitScore">登録</button>
    </div>
    <div id="regMsg">&nbsp;</div>`;

  $("submitScore").onclick = async () => {
    const name = ($("nameInput").value || "").trim().slice(0,12) || "名無し";
    $("submitScore").disabled = true;
    $("regMsg").textContent = "送信中…";
    const okCount = results.filter(r=>r.ok).length;
    try{
      await submitScore({ name, mode: currentMode, seed: currentSeed, score: totalScore, okCount });
      $("regMsg").style.color = "var(--brand)";
      $("regMsg").textContent = "登録しました！";
    }catch(err){
      $("regMsg").style.color = "var(--bad)";
      $("regMsg").textContent = "登録に失敗しました";
      $("submitScore").disabled = false;
    }
  };
}

/* ===== ランキングAPI（後で中身を差し替え） ===== */
/* スコア送信。API未接続時はローカルのダミーに保存する。 */
async function submitScore({ name, mode, seed, score, okCount }){
  const entry = { name, mode, seed, score, okCount, created_at: Date.now() };
  if(RANKING_API){
    const res = await fetch(RANKING_API + "/api/score", {
      method:"POST", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify(entry),
    });
    if(!res.ok) throw new Error("submit failed");
    return;
  }
  // --- ダミー（API未接続時） ---
  const key = "wr_dummy_scores";
  const arr = JSON.parse(localStorage.getItem(key) || "[]");
  arr.push(entry);
  localStorage.setItem(key, JSON.stringify(arr));
}

/* ランキング取得。API未接続時はダミーを返す。 */
async function fetchRanking({ mode, seed }){
  if(RANKING_API){
    const url = new URL(RANKING_API + "/api/ranking");
    url.searchParams.set("mode", mode);
    if(seed != null) url.searchParams.set("seed", seed);
    const res = await fetch(url);
    if(!res.ok) throw new Error("fetch failed");
    return await res.json();
  }
  // --- ダミー（API未接続時） ---
  const arr = JSON.parse(localStorage.getItem("wr_dummy_scores") || "[]");
  let rows = arr.filter(r => r.mode === mode);
  if(seed != null) rows = rows.filter(r => r.seed === seed);
  rows.sort((a,b) => b.score - a.score || a.created_at - b.created_at);
  return rows.slice(0, 50);
}

/* ===== 画面操作 ===== */
document.addEventListener("click",(e)=>{
  if($("game").style.display!=="flex") return;
  if(e.target.closest(".letter")||e.target.closest("#eraser")||e.target.closest(".icon-btn")||e.target.closest("#skipBtn")) return;
  clearInput();
});
$("eraser").onclick=(e)=>{e.stopPropagation(); clearInput();};
$("skipBtn").onclick=(e)=>{e.stopPropagation(); if(!paused) finishQuestion(false,null);};
$("shuffleBtn").onclick=(e)=>{e.stopPropagation(); if(paused)return;
  renderLetters(shuffle(QUESTIONS[qi].letters.split(""))); clearInput();};
$("pauseBtn").onclick=(e)=>{e.stopPropagation(); paused=!paused;
  if(paused) usedPause=true;   // 一度でも押したら記録（戻さない）
  $("pauseBtn").innerHTML=paused?"&#9654;":"&#10073;&#10073;";
  $("msg").textContent=paused?"一時停止中":`第 ${qi+1} 問 / ${QUESTIONS.length}`;};

document.addEventListener("keydown",(e)=>{
  if($("game").style.display!=="flex") return;
  if(paused) return;
  if(e.key==="Escape"){ clearInput(); return; }
  if(e.key==="Backspace"){ if(typed.length){ typed.pop(); refreshUsed(); updateTyped(); } return; }
  if(/^[a-zA-Z]$/.test(e.key)){ const ch=e.key.toUpperCase();
    const el=[...document.querySelectorAll(".letter")].find(x=>x.textContent===ch && !typed.some(t=>t.li===+x.dataset.li));
    if(el) onLetterClick(+el.dataset.li, el.textContent, el); }
});

/* ===== ホーム ===== */
let selectedMode = null;

function renderModes(){
  const box = $("modeList"); box.innerHTML="";
  MODES.forEach(m=>{
    const list = WORDS_BY_MODE[m.id] || [];
    const enough = list.length >= NUM_QUESTIONS;
    const btn = document.createElement("button");
    btn.className = "mode-btn" + (enough ? "" : " empty");
    btn.innerHTML = `<span>${m.label}</span><span class="count">${enough ? list.length+" 語" : "準備中"}</span>`;
    if(enough){ btn.onclick = ()=>{ selectMode(m.id); }; }
    box.appendChild(btn);
  });
  const first = MODES.find(m => (WORDS_BY_MODE[m.id]||[]).length >= NUM_QUESTIONS);
  if(first) selectMode(first.id);
}
function selectMode(id){
  selectedMode = id;
  [...$("modeList").children].forEach((b,i)=>{
    b.classList.toggle("selected", MODES[i].id === id && !b.classList.contains("empty"));
  });
  const btn=$("startBtn"); btn.disabled=false; btn.textContent="スタート";
}

$("startBtn").onclick=()=>{
  if($("startBtn").disabled || !selectedMode) return;
  const seed = (Math.random()*9000 + 1000) | 0;
  fromSharedCode = false;
  startGame(selectedMode, seed);
};

$("codeBtn").onclick=()=>{
  const parsed = parseCode($("codeInput").value);
  const msg=$("codeMsg");
  if(!parsed){ msg.textContent="IDの形式が正しくありません（例: JR-4821）"; return; }
  if((WORDS_BY_MODE[parsed.mode]||[]).length < NUM_QUESTIONS){
    msg.textContent="そのモードはまだ準備中です"; return;
  }
  msg.textContent="";
  fromSharedCode = true;
  startGame(parsed.mode, parsed.seed);
};
$("codeInput").addEventListener("keydown",(e)=>{ if(e.key==="Enter") $("codeBtn").click(); });

$("homeBtn").onclick=()=>{ $("result").style.display="none"; $("home").style.display="flex"; };
$("restartBtn").onclick=()=>{
  $("result").style.display="none";
  // 共有コード由来なら同じ問題、通常プレイなら新しい問題
  const seed = fromSharedCode ? currentSeed : (Math.random()*9000 + 1000) | 0;
  startGame(currentMode, seed);
};

/* ===== ランキング画面 ===== */
$("rankingBtn").onclick=()=>{ openRanking(selectedMode, null); };
$("rankBackBtn").onclick=()=>{ $("ranking").style.display="none"; $("home").style.display="flex"; };

let rankMode = null;   // 現在表示中のモード
let rankSeed = null;   // 現在の絞り込みシード（nullなら全体）

function openRanking(mode, seed){
  rankMode = mode || (MODES[0] && MODES[0].id);
  rankSeed = seed;
  $("home").style.display="none";
  $("result").style.display="none";
  $("game").style.display="none";
  $("ranking").style.display="flex";
  renderRankModeTabs();
  renderRankSeedFilter();
  loadAndRenderRanking();
}

function renderRankModeTabs(){
  const box = $("rankTabs"); box.innerHTML="";
  MODES.forEach(m=>{
    const enough = (WORDS_BY_MODE[m.id]||[]).length >= NUM_QUESTIONS;
    if(!enough) return;
    const tab = document.createElement("button");
    tab.className = "rank-tab" + (m.id===rankMode ? " active" : "");
    tab.textContent = m.label;
    tab.onclick = ()=>{ rankMode = m.id; rankSeed = null; renderRankModeTabs(); renderRankSeedFilter(); loadAndRenderRanking(); };
    box.appendChild(tab);
  });
}

function renderRankSeedFilter(){
  const box = $("rankSeedFilter");
  if(rankSeed != null){
    box.innerHTML = `
      <span class="seed-chip">ID <b>${makeCode(rankMode, rankSeed)}</b> で絞り込み中</span>
      <button id="clearSeedBtn" class="seed-clear">解除</button>`;
    $("clearSeedBtn").onclick = ()=>{ rankSeed = null; renderRankSeedFilter(); loadAndRenderRanking(); };
  }else{
    box.innerHTML = `<span class="seed-hint">モード全体のランキング（各行のIDをタップでそのシードだけ表示）</span>`;
  }
}

async function loadAndRenderRanking(){
  const list = $("rankList");
  list.innerHTML = `<div class="rank-loading">読み込み中…</div>`;
  let rows;
  try{
    rows = await fetchRanking({ mode: rankMode, seed: rankSeed });
  }catch(err){
    list.innerHTML = `<div class="rank-loading">読み込みに失敗しました</div>`;
    return;
  }
  if(!rows || rows.length===0){
    list.innerHTML = `<div class="rank-loading">まだ記録がありません</div>`;
    return;
  }
  list.innerHTML = "";
  rows.forEach((r,i)=>{
    const code = makeCode(r.mode, r.seed);
    const rankNo = i+1;
    const medal = rankNo<=3 ? `<span class="medal m${rankNo}">${rankNo}</span>` : `<span class="rankno">${rankNo}</span>`;
    const row = document.createElement("div");
    row.className = "rank-row";
    row.innerHTML = `
      <div class="rank-left">
        ${medal}
        <div class="rank-info">
          <div class="rank-name">${escapeHtml(r.name)}</div>
          <div class="rank-time">${formatTime(r.created_at)}</div>
        </div>
      </div>
      <div class="rank-right">
        <div class="rank-score">${Number(r.score).toLocaleString()}<small> pts</small></div>
        <button class="rank-seed" data-mode="${r.mode}" data-seed="${r.seed}" title="このシードで絞り込み">${code}</button>
      </div>`;
    list.appendChild(row);
  });

  // 各行のIDボタン：クリックでそのシードに絞り込み、長押し/右クリックでコピー
  list.querySelectorAll(".rank-seed").forEach(btn=>{
    btn.onclick = ()=>{
      rankSeed = parseInt(btn.dataset.seed,10);
      renderRankSeedFilter();
      loadAndRenderRanking();
    };
  });

  // コピーボタン（絞り込み中のときだけ、上部にまとめて出す）
  renderSeedCopy();
}

function renderSeedCopy(){
  const box = $("rankSeedFilter");
  if(rankSeed == null) return;
  const code = makeCode(rankMode, rankSeed);
  const btn = document.createElement("button");
  btn.className = "seed-copy";
  btn.textContent = "IDをコピー";
  btn.onclick = async ()=>{
    try{
      await navigator.clipboard.writeText(code);
      btn.textContent = "コピーしました！";
      setTimeout(()=>{ btn.textContent = "IDをコピー"; }, 1500);
    }catch{
      btn.textContent = "コピー失敗";
      setTimeout(()=>{ btn.textContent = "IDをコピー"; }, 1500);
    }
  };
  box.appendChild(btn);
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => (
    {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]
  ));
}

/* 1ゲーム開始（モードとシードを固定） */
function startGame(mode, seed){
  currentMode = mode; currentSeed = seed;
  WORD_POOL = WORDS_BY_MODE[mode] || [];
  seedRng(seed);
  QUESTIONS = pickQuestions();
  results = [];
  totalScore = 0;
  usedPause = false;
  $("home").style.display="none"; $("result").style.display="none"; $("ranking").style.display="none";
  $("game").style.display="flex";
  renderBoard(); startQuestion(0);
}

/* ===== 起動 ===== */
async function boot(){
  try{
    const [wjRes, dictRes] = await Promise.all([ fetch("words.json"), fetch(DICT_URL) ]);
    if(!wjRes.ok) throw new Error("words.json: HTTP "+wjRes.status);
    const data = await wjRes.json();

    if(Array.isArray(data.words)){
      MODES = [{ id:"junior", label:"すべて" }];
      WORDS_BY_MODE = { junior: data.words };
    }else{
      MODES = data.modes || Object.keys(data.words||{}).map(id=>({id,label:id}));
      WORDS_BY_MODE = data.words || {};
    }

    const total = Object.values(WORDS_BY_MODE).reduce((n,a)=>n+(a?a.length:0),0);
    if(total < NUM_QUESTIONS)
      throw new Error(`単語数が足りません（合計${total}語 / 最低${NUM_QUESTIONS}語）`);

    if(dictRes.ok){ ingestDict(await dictRes.text()); }
    else{ console.warn("辞書ファイルが読めません。プール内のみで正解判定します。"); }

    $("loading").style.display="none";
    $("home").style.display="flex";
    renderModes();
  }catch(err){
    $("loading").innerHTML =
      "読み込みに失敗しました：" + err.message +
      "<br><br>index.html と同じフォルダに words.json と words_alpha.txt を置いて、Live Server で開いてください。";
  }
}
boot();
