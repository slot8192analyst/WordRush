/* ===== 設定 ===== */
const NUM_QUESTIONS = 18;
const TIME_LIMIT = 30, HINT_AT = 10;
const PREFER_FAMILY = true;
const MIN_LEN = 4;
const DICT_URL = "words_alpha.txt";

const LENGTH_PLAN = [
  { len:4, count:4 }, { len:5, count:4 }, { len:6, count:4 },
  { len:7, count:3 }, { len:8, count:3 },
];

/* スコア配点 */
const PT_PER_LETTER = 100;   // 1文字あたりの基礎点
const PT_PER_SEC    = 20;    // 残り1秒あたりのスピードボーナス

/* モードごとの短縮コード（IDの接頭辞） */
const MODE_CODE = { junior:"JR", senior:"SR", common:"CT", toeic_s:"TS", toeic_g:"TG" };
const CODE_MODE = Object.fromEntries(Object.entries(MODE_CODE).map(([k,v])=>[v,k]));

/* データ */
let MODES = [];
let WORDS_BY_MODE = {};
let DICT_BY_KEY = null;
let WORD_POOL = [];
let currentMode = null;
let currentSeed = 0;

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
function pickQuestions(){
  const raw = WORD_POOL
    .filter(w => w.en.length >= MIN_LEN)
    .map(w=>{
      const en = w.en.toLowerCase(), key = letterKey(en);
      const fam = familyOf(key); fam.delete(en);
      return { main:{en:w.en,ja:w.ja}, letters:w.en.toUpperCase(),
               len:w.en.length, key, familyCount:fam.size };
    });

  const byKey = new Map();
  for(const c of raw){ if(!byKey.has(c.key)) byKey.set(c.key, []); byKey.get(c.key).push(c); }
  const uniq = [...byKey.values()].map(group => shuffle(group)[0]);

  const byLen = {};
  for(const c of uniq){ (byLen[c.len] = byLen[c.len] || []).push(c); }
  for(const len in byLen){
    shuffle(byLen[len]);
    if(PREFER_FAMILY) byLen[len].sort((a,b)=>b.familyCount-a.familyCount);
  }

  const chosen = [];
  for(const plan of LENGTH_PLAN){
    const bucket = byLen[plan.len] || [];
    for(let i=0; i<plan.count && bucket.length; i++){ chosen.push(bucket.shift()); }
  }
  if(chosen.length < NUM_QUESTIONS){
    const rest = Object.values(byLen).flat().filter(c => !chosen.includes(c));
    rest.sort((a,b)=>a.len-b.len);
    while(chosen.length < NUM_QUESTIONS && rest.length) chosen.push(rest.shift());
  }
  return chosen.slice(0, NUM_QUESTIONS);
}

let QUESTIONS=[];
function buildValidSet(q){ const set = familyOf(letterKey(q.letters)); set.add(q.main.en.toLowerCase()); return set; }

let qi=0, validSet, poolKey, poolLen, timeLeft, timer, paused, qStart;
let typed=[]; let results=[]; let totalScore=0;

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
    setTimeout(()=>{ clearInput(); $("msg").textContent=`第 ${qi+1} 問 / ${QUESTIONS.length}`; },350); }
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

  // スコア：基礎点(文字数×100) ＋ ボーナス(残り秒×20)。不正解・時間切れは0点
  const base  = ok ? shownEn.length * PT_PER_LETTER : 0;
  const bonus = ok ? remain * PT_PER_SEC : 0;
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

  // 合計スコアを大きく、正解数を副えて表示
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
  startGame(parsed.mode, parsed.seed);
};
$("codeInput").addEventListener("keydown",(e)=>{ if(e.key==="Enter") $("codeBtn").click(); });

$("homeBtn").onclick=()=>{ $("result").style.display="none"; $("home").style.display="flex"; };
$("restartBtn").onclick=()=>{ $("result").style.display="none"; startGame(currentMode, currentSeed); };

/* 1ゲーム開始（モードとシードを固定） */
function startGame(mode, seed){
  currentMode = mode; currentSeed = seed;
  WORD_POOL = WORDS_BY_MODE[mode] || [];
  seedRng(seed);
  QUESTIONS = pickQuestions();
  results = [];
  totalScore = 0;
  $("home").style.display="none"; $("result").style.display="none";
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
