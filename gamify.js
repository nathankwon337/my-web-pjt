/*!
 * gamify.js — 공통 동기부여(게이미피케이션) 모듈
 * 기본은 브라우저 localStorage만으로 동작하며, 원할 경우 Google 스프레드시트(Apps Script 웹앱)를
 * 얹어 기기 간 동기화 + 전체 사용자 리더보드까지 지원합니다(선택 사항, 미설정 시 완전히 기존과 동일하게 동작).
 * 문장 카드 맞추기 / 단어 짝맞추기 / 말하기 연습 / VOCA 트레이닝 4개 게임에서 공통으로 불러 씁니다.
 *
 * 사용법 (각 게임 HTML 맨 아래, </body> 직전에 한 줄만 추가):
 *   <script src="gamify.js"></script>
 *
 * 게임이 한 세트를 끝낼 때 아래처럼 결과만 보고하면 나머지는 이 모듈이 알아서 처리합니다:
 *   window.Gamify.reportResult({
 *     game: 'sentence' | 'word_match' | 'speaking' | 'voca',
 *     accuracy: 0.86,      // 0~1, 모르면 null
 *     comboMax: 7,         // 최다 콤보(없으면 0)
 *     correctCount: 12,    // 이번 세트 정답 개수(없으면 생략 가능)
 *     totalCount: 14       // 이번 세트 전체 문항 수(없으면 생략 가능)
 *   });
 *
 * 클라우드 동기화(선택): 아래 DEFAULT_CLOUD_ENDPOINT에 Apps Script 웹앱 URL을 한 번만
 * 넣어두면, 접속하는 모든 사람에게 자동으로 적용됩니다(각자 설정할 필요 없음).
 * 프로필 전환 메뉴의 "클라우드 동기화 설정"은 이 기본값을 개인적으로 덮어쓰거나
 * 끄고 싶을 때만 쓰는 선택 기능입니다.
 */
(function (global) {
  'use strict';

  // ▼▼▼ (레거시) 예전 방식 — 이제는 gamify_config.js에 넣는 것을 권장합니다 ▼▼▼
  // gamify_config.js의 window.GAMIFY_CLOUD_ENDPOINT가 설정되어 있으면 그쪽이 항상 우선합니다.
  // 이 값은 gamify.js가 업데이트될 때마다 초기화되므로 계속 채워두지 않아도 됩니다.
  var DEFAULT_CLOUD_ENDPOINT = 'https://script.google.com/macros/s/AKfycbzdD2odP3YSXtkehAEPC6R3pvaXVg_8uupBBlkBOGMumEWRzeMzly1iJuTYyyAYbQzK/exec';
  // ▲▲▲ (레거시) ▲▲▲

  var STORAGE_KEY = 'lingo_gamify_v1';
  var CLOUD_KEY = 'lingo_gamify_cloud_endpoint';
  var CREDIT_NAME = '캐럿';
  var CREDIT_ICON = '💎';

  var GAME_LABELS = {
    sentence:   '문장 카드 맞추기',
    word_match: '단어 짝맞추기',
    speaking:   '말하기 연습',
    voca:       'VOCA 트레이닝'
  };

  var BASE_CREDIT = {
    sentence: 10,
    word_match: 10,
    speaking: 15,
    voca: 10
  };

  var DAILY_CAP = 300;
  var REPEAT_COOLDOWN_MS = 15 * 60 * 1000; // 15분 이내 같은 게임 재플레이 시 기본 캐럿 절반

  var LEAGUES = [
    { id: 'bronze',    name: '브론즈',    emoji: '🥉', min: 0 },
    { id: 'silver',    name: '실버',      emoji: '🥈', min: 1000 },
    { id: 'gold',      name: '골드',      emoji: '🥇', min: 3000 },
    { id: 'sapphire',  name: '사파이어',  emoji: '💎', min: 7000 },
    { id: 'diamond',   name: '다이아몬드', emoji: '👑', min: 15000 }
  ];

  var BADGES = {
    first_play:      { label: '첫 걸음',            desc: '아무 게임이나 최초 1회 완료' },
    all_four_games:  { label: '팔방미인',            desc: '4개 게임을 모두 1회 이상 플레이' },
    streak3:         { label: '3일의 약속',          desc: '3일 연속 학습' },
    streak7:         { label: '7일의 기적',          desc: '7일 연속 학습' },
    streak30:        { label: '한 달의 꾸준함',      desc: '30일 연속 학습' },
    correct100:      { label: '백문백답',            desc: '누적 정답 100개 달성' },
    flawless:        { label: '완벽주의자',          desc: '한 세트를 실수 없이(100%) 클리어' },
    speaking_ace:    { label: '원어민 부럽지 않은',  desc: '말하기 연습 90% 이상 판정 10회 달성' }
  };

  // ---------------------------------------------------------------------
  // storage helpers
  // ---------------------------------------------------------------------
  function loadStore(){
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { activeNickname: null, profiles: {} };
      var parsed = JSON.parse(raw);
      if (!parsed.profiles) parsed.profiles = {};
      return parsed;
    } catch (err) {
      return { activeNickname: null, profiles: {} };
    }
  }

  function saveStore(store){
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); }
    catch (err) { /* storage full / disabled — fail silently */ }
  }

  function todayStr(){
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function pad(n){ return n < 10 ? '0' + n : '' + n; }

  function daysBetween(a, b){
    var da = new Date(a + 'T00:00:00');
    var db = new Date(b + 'T00:00:00');
    return Math.round((db - da) / 86400000);
  }

  function newProfile(nickname){
    return {
      nickname: nickname,
      totalCredits: 0,
      totalCorrect: 0,
      league: 'bronze',
      streak: { current: 0, longest: 0, lastPlayedDate: null },
      badges: [],
      gamesPlayed: {},          // { sentence: true, word_match: true, ... }
      dailyCredits: { date: todayStr(), amount: 0 },
      lastPlayAt: {},           // { sentence: timestamp, ... } — for repeat-cooldown
      speakingHighCount: 0,
      createdAt: Date.now()
    };
  }

  var store = loadStore();

  // ---------------------------------------------------------------------
  // cloud sync (optional) — Google Apps Script 웹앱 엔드포인트
  // ---------------------------------------------------------------------
  // 우선순위: 개인 브라우저 설정(localStorage) > gamify_config.js의 사이트 기본값 > (레거시) 내부 기본값
  function siteDefaultEndpoint(){
    return (typeof global.GAMIFY_CLOUD_ENDPOINT === 'string' && global.GAMIFY_CLOUD_ENDPOINT)
      ? global.GAMIFY_CLOUD_ENDPOINT
      : (DEFAULT_CLOUD_ENDPOINT || '');
  }
  function getCloudEndpoint(){
    var personal;
    try { personal = localStorage.getItem(CLOUD_KEY); } catch (err) { personal = null; }
    if (personal === '__off__') return '';
    if (personal) return personal;
    return siteDefaultEndpoint();
  }
  function setCloudEndpoint(url){
    try {
      if (url) localStorage.setItem(CLOUD_KEY, url);
      else localStorage.setItem(CLOUD_KEY, '__off__');
    } catch (err) { /* ignore */ }
  }
  function isUsingSiteDefault(){
    var personal;
    try { personal = localStorage.getItem(CLOUD_KEY); } catch (err) { personal = null; }
    return !personal && !!siteDefaultEndpoint();
  }
  function isCloudEnabled(){ return !!getCloudEndpoint(); }

  function cloudPush(profile){
    var url = getCloudEndpoint();
    if (!url) return;
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids CORS preflight on Apps Script
      body: JSON.stringify(profile)
    }).catch(function(err){
      console.error('[gamify] cloudPush failed:', err);
      /* offline/오류 시 조용히 무시 — 다음 저장 때 다시 시도됨 */
    });
  }

  function cloudPull(nickname, cb){
    var url = getCloudEndpoint();
    if (!url){ cb(null); return; }
    fetch(url + '?action=get&nickname=' + encodeURIComponent(nickname))
      .then(function(r){
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function(res){ cb(res && res.found ? res.data : null); })
      .catch(function(err){ console.error('[gamify] cloudPull failed:', err); cb(null); });
  }

  function cloudLeaderboard(cb){
    var url = getCloudEndpoint();
    if (!url){ cb(null); return; }
    fetch(url + '?action=list')
      .then(function(r){
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function(res){ cb(res && res.list ? res.list : []); })
      .catch(function(err){ console.error('[gamify] cloudLeaderboard failed:', err); cb(null); });
  }

  function activeProfile(){
    if (!store.activeNickname) return null;
    return store.profiles[store.activeNickname] || null;
  }

  function getLeague(totalCredits){
    var current = LEAGUES[0];
    for (var i = 0; i < LEAGUES.length; i++){
      if (totalCredits >= LEAGUES[i].min) current = LEAGUES[i];
    }
    return current;
  }

  // ---------------------------------------------------------------------
  // styles (namespaced, injected once)
  // ---------------------------------------------------------------------
  function injectStyles(){
    if (document.getElementById('gm-styles')) return;
    var css =
      '.gm-bar{position:fixed;top:0;left:0;right:0;z-index:9998;height:46px;display:flex;align-items:center;' +
      'gap:14px;padding:0 16px;background:linear-gradient(90deg,#1F3A5F,#2C4C78);color:#fff;' +
      'font-family:Inter,-apple-system,sans-serif;font-size:13px;box-shadow:0 2px 10px rgba(0,0,0,.15);}' +
      '.gm-bar .gm-nick{display:flex;align-items:center;gap:7px;font-weight:700;cursor:pointer;background:none;border:none;color:#fff;font-size:13px;padding:6px 8px;border-radius:8px;font-family:inherit;max-width:40vw;}' +
      '.gm-bar .gm-nick:hover{background:rgba(255,255,255,.12);}' +
      '.gm-nick-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
      '.gm-avatar{width:22px;height:22px;border-radius:50%;background:#E8A33D;color:#1F3A5F;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:11px;flex-shrink:0;}' +
      '.gm-bar .gm-spacer{flex:1;}' +
      '@media (max-width:480px){' +
        '.gm-bar{gap:8px;padding:0 10px;}' +
        '.gm-bar .gm-nick{gap:0;padding:6px;max-width:none;}' +
        '.gm-nick-label{display:none;}' +
        '.gm-pill{padding:5px 8px;gap:3px;}' +
      '}' +
      '.gm-pill{display:flex;align-items:center;gap:5px;background:rgba(255,255,255,.12);padding:5px 10px;border-radius:20px;white-space:nowrap;font-weight:600;}' +
      '.gm-pill.gm-league{cursor:pointer;}' +
      '.gm-credit-num{font-variant-numeric:tabular-nums;transition:color .2s ease;}' +
      '.gm-credit-pop{color:#7CF29C !important;}' +
      '.gm-overlay{position:fixed;inset:0;background:rgba(20,26,40,.55);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;font-family:Inter,-apple-system,sans-serif;}' +
      '.gm-modal{background:#fff;color:#1E2A44;border-radius:16px;padding:26px 24px;max-width:360px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.3);text-align:center;}' +
      '.gm-modal h3{margin:0 0 8px;font-size:19px;}' +
      '.gm-modal p{margin:0 0 16px;font-size:13.5px;color:#5B6580;line-height:1.55;}' +
      '.gm-modal input[type=text]{width:100%;padding:11px 12px;border:1.5px solid #CBD2E3;border-radius:10px;font-size:15px;margin-bottom:14px;box-sizing:border-box;text-align:center;font-family:inherit;}' +
      '.gm-btn{appearance:none;border:none;background:#3A4CA8;color:#fff;font-weight:700;font-size:14px;padding:11px 18px;border-radius:10px;cursor:pointer;width:100%;font-family:inherit;}' +
      '.gm-btn:hover{background:#2C3986;}' +
      '.gm-btn.gm-ghost{background:#F1F3F9;color:#1E2A44;margin-top:8px;}' +
      '.gm-btn.gm-ghost:hover{background:#E5E9F3;}' +
      '.gm-profile-row{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border:1px solid #E4E8F2;border-radius:10px;margin-bottom:8px;font-size:13.5px;cursor:pointer;text-align:left;}' +
      '.gm-profile-row:hover{border-color:#3A4CA8;background:#F5F7FE;}' +
      '.gm-profile-row.active{border-color:#3A4CA8;background:#EEF1FC;font-weight:700;}' +
      '.gm-toast-wrap{position:fixed;top:56px;right:16px;z-index:10000;display:flex;flex-direction:column;gap:8px;align-items:flex-end;}' +
      '.gm-toast{background:#1F3A5F;color:#fff;padding:10px 16px;border-radius:12px;font-size:13px;font-weight:600;box-shadow:0 8px 20px rgba(0,0,0,.22);opacity:0;transform:translateY(-6px);transition:opacity .25s ease,transform .25s ease;max-width:280px;}' +
      '.gm-toast.show{opacity:1;transform:translateY(0);}' +
      '.gm-celebrate{font-size:52px;margin-bottom:6px;}' +
      '.gm-link-row{margin-top:14px;font-size:12.5px;color:#8A93A8;}' +
      '.gm-link-row a{color:#3A4CA8;font-weight:600;cursor:pointer;text-decoration:underline;}' +
      '.gm-hidden{display:none !important;}' +
      '.gm-badge-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin:14px 0;text-align:left;}' +
      '.gm-badge-chip{border:1px solid #E4E8F2;border-radius:10px;padding:8px 10px;font-size:12px;}' +
      '.gm-badge-chip.locked{opacity:.35;}' +
      '.gm-badge-chip b{display:block;font-size:12.5px;margin-bottom:2px;}' +
      '.gm-code-box{background:#F5F7FB;border:1px dashed #B9C3E8;border-radius:10px;padding:12px;font-family:"Space Grotesk",monospace;font-size:12.5px;word-break:break-all;margin-bottom:14px;user-select:all;}' +
      '.gm-stats-modal{max-width:400px;}' +
      '.gm-rank-hero{background:linear-gradient(135deg,#1F3A5F,#2C4C78);color:#fff;border-radius:14px;padding:18px 16px;margin-bottom:16px;}' +
      '.gm-rank-hero .gm-rank-num{font-size:30px;font-weight:800;font-family:"Space Grotesk",monospace;}' +
      '.gm-rank-hero .gm-rank-sub{font-size:12.5px;opacity:.85;margin-top:2px;}' +
      '.gm-rank-hero .gm-rank-pct{display:inline-block;margin-top:8px;background:rgba(255,255,255,.16);padding:4px 10px;border-radius:20px;font-size:12px;font-weight:700;}' +
      '.gm-stat-block{margin-bottom:16px;text-align:left;}' +
      '.gm-stat-block-title{font-size:12px;font-weight:700;color:#8A93A8;text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px;}' +
      '.gm-bar-row{display:flex;align-items:center;gap:8px;margin-bottom:7px;font-size:12px;}' +
      '.gm-bar-row .gm-bar-label{width:52px;flex-shrink:0;color:#5B6580;font-weight:600;}' +
      '.gm-bar-track{flex:1;height:14px;background:#EEF1F6;border-radius:8px;overflow:hidden;}' +
      '.gm-bar-fill{height:100%;border-radius:8px;background:linear-gradient(90deg,#3A4CA8,#57C7E3);}' +
      '.gm-bar-fill.me{background:linear-gradient(90deg,#E8A33D,#C97A2B);}' +
      '.gm-bar-row .gm-bar-val{width:56px;flex-shrink:0;text-align:right;font-family:"Space Grotesk",monospace;font-weight:700;color:#1E2A44;}' +
      '.gm-league-dist-row{display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:12px;}' +
      '.gm-league-dist-row .gm-ld-label{width:78px;flex-shrink:0;}' +
      '.gm-league-dist-row.me .gm-ld-label{font-weight:800;color:#1F3A5F;}' +
      '.gm-league-dist-row .gm-ld-track{flex:1;height:10px;background:#EEF1F6;border-radius:6px;overflow:hidden;}' +
      '.gm-league-dist-row .gm-ld-fill{height:100%;background:#B9C3E8;border-radius:6px;}' +
      '.gm-league-dist-row.me .gm-ld-fill{background:#E8A33D;}' +
      '.gm-league-dist-row .gm-ld-count{width:26px;text-align:right;color:#8A93A8;font-size:11px;}';
    var style = document.createElement('style');
    style.id = 'gm-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------------
  // overlay / modal helpers
  // ---------------------------------------------------------------------
  function openOverlay(innerHtml, opts){
    opts = opts || {};
    var overlay = document.createElement('div');
    overlay.className = 'gm-overlay';
    overlay.innerHTML = '<div class="gm-modal">' + innerHtml + '</div>';
    if (!opts.persistent){
      overlay.addEventListener('click', function(e){
        if (e.target === overlay) closeOverlay(overlay);
      });
    }
    document.body.appendChild(overlay);
    return overlay;
  }
  function closeOverlay(overlay){
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }

  function toast(msg){
    var wrap = document.getElementById('gm-toast-wrap');
    if (!wrap){
      wrap = document.createElement('div');
      wrap.id = 'gm-toast-wrap';
      wrap.className = 'gm-toast-wrap';
      document.body.appendChild(wrap);
    }
    var el = document.createElement('div');
    el.className = 'gm-toast';
    el.textContent = msg;
    wrap.appendChild(el);
    requestAnimationFrame(function(){ el.classList.add('show'); });
    setTimeout(function(){
      el.classList.remove('show');
      setTimeout(function(){ if (el.parentNode) el.parentNode.removeChild(el); }, 300);
    }, 2600);
  }

  // ---------------------------------------------------------------------
  // nickname onboarding
  // ---------------------------------------------------------------------
  function promptNickname(){
    var html =
      '<div class="gm-celebrate">👋</div>' +
      '<h3>닉네임을 알려주세요</h3>' +
      '<p>게임을 플레이할 때마다 ' + CREDIT_NAME + '가 쌓이고, 리그가 올라가요.<br>비밀번호는 필요 없어요 — 이 브라우저에만 저장됩니다.</p>' +
      '<input type="text" id="gm-nick-input" maxlength="8" placeholder="예: 민준">' +
      '<button class="gm-btn" id="gm-nick-ok">시작하기</button>';
    var overlay = openOverlay(html, { persistent: true });
    var input = overlay.querySelector('#gm-nick-input');
    input.focus();
    function submit(){
      var name = input.value.trim();
      if (!name){ input.style.borderColor = '#D1495B'; return; }
      if (!store.profiles[name]) store.profiles[name] = newProfile(name);
      store.activeNickname = name;
      saveStore(store);
      closeOverlay(overlay);
      renderBar();
      toast(name + '님, 환영해요! 학습을 시작해볼까요? 🎉');
      syncFromCloudThenPush(name);
    }
    overlay.querySelector('#gm-nick-ok').addEventListener('click', submit);
    input.addEventListener('keydown', function(e){ if (e.key === 'Enter') submit(); });
  }

  function openProfileSwitcher(){
    var names = Object.keys(store.profiles);
    var rows = names.map(function(n){
      var pr = store.profiles[n];
      var lg = getLeague(pr.totalCredits);
      var activeCls = (n === store.activeNickname) ? ' active' : '';
      return '<div class="gm-profile-row' + activeCls + '" data-name="' + escapeHtml(n) + '">' +
        '<span>' + lg.emoji + ' ' + escapeHtml(n) + '</span>' +
        '<span>' + pr.totalCredits + ' ' + CREDIT_ICON + '</span></div>';
    }).join('');
    var html =
      '<h3>프로필 전환</h3>' +
      '<p>같은 기기를 함께 쓰는 경우, 자신의 이름을 골라주세요.</p>' +
      '<div>' + rows + '</div>' +
      '<button class="gm-btn gm-ghost" id="gm-new-profile">+ 새 사람으로 시작하기</button>' +
      '<div class="gm-link-row">' +
        '<a id="gm-export-link">내 기록 내보내기</a> · ' +
        '<a id="gm-import-link">기록 가져오기</a> · ' +
        '<a id="gm-badges-link">배지 보기</a><br>' +
        '<a id="gm-cloud-link">☁️ 클라우드 동기화 설정</a>' + (isCloudEnabled() ? ' · <a id="gm-board-link">🏆 전체 순위 보기</a> · <a id="gm-stats-link">📊 내 순위 통계</a>' : '') +
      '</div>' +
      '<input type="file" id="gm-import-file" accept="application/json" class="gm-hidden">';
    var overlay = openOverlay(html);
    overlay.querySelectorAll('.gm-profile-row').forEach(function(row){
      row.addEventListener('click', function(){
        store.activeNickname = row.getAttribute('data-name');
        saveStore(store);
        closeOverlay(overlay);
        renderBar();
        toast(row.getAttribute('data-name') + '님으로 전환했어요.');
        syncFromCloudThenPush(row.getAttribute('data-name'));
      });
    });
    overlay.querySelector('#gm-new-profile').addEventListener('click', function(){
      closeOverlay(overlay);
      promptNickname();
    });
    overlay.querySelector('#gm-export-link').addEventListener('click', function(){ exportData(); });
    overlay.querySelector('#gm-import-link').addEventListener('click', function(){
      overlay.querySelector('#gm-import-file').click();
    });
    overlay.querySelector('#gm-import-file').addEventListener('change', function(e){
      var file = e.target.files[0];
      if (file) importData(file, overlay);
    });
    overlay.querySelector('#gm-badges-link').addEventListener('click', function(){
      closeOverlay(overlay);
      openBadgeList();
    });
    overlay.querySelector('#gm-cloud-link').addEventListener('click', function(){
      closeOverlay(overlay);
      openCloudSettings();
    });
    var boardLink = overlay.querySelector('#gm-board-link');
    if (boardLink) boardLink.addEventListener('click', function(){
      closeOverlay(overlay);
      openLeaderboard();
    });
    var statsLink = overlay.querySelector('#gm-stats-link');
    if (statsLink) statsLink.addEventListener('click', function(){
      closeOverlay(overlay);
      openMyStats();
    });
  }

  function openBadgeList(){
    var pr = activeProfile();
    if (!pr) return;
    var chips = Object.keys(BADGES).map(function(key){
      var b = BADGES[key];
      var got = pr.badges.indexOf(key) !== -1;
      return '<div class="gm-badge-chip' + (got ? '' : ' locked') + '"><b>' + (got ? '🏅 ' : '🔒 ') + b.label + '</b>' + b.desc + '</div>';
    }).join('');
    var html =
      '<h3>나의 배지</h3>' +
      '<div class="gm-badge-grid">' + chips + '</div>' +
      '<button class="gm-btn gm-ghost" id="gm-badge-close">닫기</button>';
    var overlay = openOverlay(html);
    overlay.querySelector('#gm-badge-close').addEventListener('click', function(){ closeOverlay(overlay); });
  }

  function openCloudSettings(){
    var current = getCloudEndpoint();
    var usingDefault = isUsingSiteDefault();
    var statusLine = usingDefault
      ? '<p style="color:#3F9142;font-weight:600;">✅ 이 사이트는 기본적으로 클라우드 동기화가 켜져 있어요. 별도로 설정하지 않아도 자동으로 적용됩니다.</p>'
      : (current
          ? '<p style="color:#3F9142;font-weight:600;">✅ 개인 설정으로 클라우드 동기화가 켜져 있어요.</p>'
          : '<p style="color:#8A93A8;">현재 이 기기에만 저장되고 있어요.</p>');
    var html =
      '<h3>☁️ 클라우드 동기화 설정</h3>' +
      statusLine +
      '<p>다른 주소를 쓰고 싶거나, 이 기기에서만 동기화를 끄고 싶을 때 아래에서 바꿀 수 있어요.</p>' +
      '<input type="text" id="gm-cloud-input" placeholder="https://script.google.com/macros/s/.../exec" value="' + escapeHtml(current) + '">' +
      '<button class="gm-btn" id="gm-cloud-save">이 주소로 저장하고 동기화</button>' +
      '<button class="gm-btn gm-ghost" id="gm-cloud-clear">이 기기만 동기화 끄기</button>';
    var overlay = openOverlay(html);
    overlay.querySelector('#gm-cloud-save').addEventListener('click', function(){
      var url = overlay.querySelector('#gm-cloud-input').value.trim();
      if (!url){ toast('주소를 입력해주세요.'); return; }
      setCloudEndpoint(url);
      closeOverlay(overlay);
      toast('클라우드 동기화를 설정했어요. 동기화하는 중...');
      var pr = activeProfile();
      if (pr) syncFromCloudThenPush(pr.nickname);
    });
    overlay.querySelector('#gm-cloud-clear').addEventListener('click', function(){
      setCloudEndpoint('');
      closeOverlay(overlay);
      toast('이 기기에서는 동기화를 껐어요. 이제 이 브라우저에만 저장돼요.');
    });
  }

  // 닉네임으로 로그인/전환할 때: 클라우드에 더 앞선 기록이 있으면 그것을 쓰고,
  // 없으면 지금 가진(로컬) 기록을 클라우드에 올려 둔다. (last-write-wins 방식의 단순 병합)
  function syncFromCloudThenPush(nickname){
    if (!isCloudEnabled()) return;
    cloudPull(nickname, function(remote){
      var local = store.profiles[nickname];
      var winner = local;
      if (remote && (!local || remote.totalCredits >= local.totalCredits)){
        winner = remote;
      }
      store.profiles[nickname] = winner;
      saveStore(store);
      if (store.activeNickname === nickname) renderBar();
      cloudPush(winner);
    });
  }

  function openLeaderboard(){
    var html =
      '<h3>🏆 전체 순위</h3>' +
      '<p id="gm-board-loading">불러오는 중...</p>' +
      '<div id="gm-board-list"></div>' +
      '<button class="gm-btn gm-ghost" id="gm-board-close">닫기</button>' +
      '<div class="gm-link-row"><a id="gm-board-stats-link">📊 내 순위 통계 보기</a></div>';
    var overlay = openOverlay(html);
    overlay.querySelector('#gm-board-close').addEventListener('click', function(){ closeOverlay(overlay); });
    overlay.querySelector('#gm-board-stats-link').addEventListener('click', function(){
      closeOverlay(overlay);
      openMyStats();
    });
    cloudLeaderboard(function(list){
      var loadingEl = overlay.querySelector('#gm-board-loading');
      if (!list){ loadingEl.textContent = '순위를 불러오지 못했어요. 잠시 후 다시 시도해주세요.'; return; }
      loadingEl.remove();
      var pr = activeProfile();
      var rows = list.slice(0, 20).map(function(item, idx){
        var lg = getLeague(item.totalCredits);
        var mine = pr && item.nickname === pr.nickname;
        return '<div class="gm-profile-row' + (mine ? ' active' : '') + '">' +
          '<span>' + (idx + 1) + '. ' + lg.emoji + ' ' + escapeHtml(item.nickname) + '</span>' +
          '<span>' + item.totalCredits + ' ' + CREDIT_ICON + '</span></div>';
      }).join('');
      overlay.querySelector('#gm-board-list').innerHTML = rows || '<p>아직 기록이 없어요.</p>';
    });
  }

  function openMyStats(){
    if (!isCloudEnabled()){
      var offHtml =
        '<h3>📊 내 순위 통계</h3>' +
        '<p>전체 사용자와 비교하려면 클라우드 동기화가 필요해요. 아직 켜져 있지 않아요.</p>' +
        '<button class="gm-btn" id="gm-stats-enable">클라우드 동기화 설정하기</button>' +
        '<button class="gm-btn gm-ghost" id="gm-stats-close">닫기</button>';
      var offOverlay = openOverlay(offHtml);
      offOverlay.querySelector('#gm-stats-close').addEventListener('click', function(){ closeOverlay(offOverlay); });
      offOverlay.querySelector('#gm-stats-enable').addEventListener('click', function(){
        closeOverlay(offOverlay);
        openCloudSettings();
      });
      return;
    }

    var html =
      '<h3>📊 내 순위 통계</h3>' +
      '<p id="gm-stats-loading">불러오는 중...</p>' +
      '<div id="gm-stats-body" class="gm-hidden"></div>' +
      '<button class="gm-btn gm-ghost" id="gm-stats-close">닫기</button>' +
      '<div class="gm-link-row"><a id="gm-stats-board-link">🏆 전체 순위 목록 보기</a></div>';
    var overlay = openOverlay(html);
    overlay.querySelector('#gm-stats-close').addEventListener('click', function(){ closeOverlay(overlay); });
    overlay.querySelector('#gm-stats-board-link').addEventListener('click', function(){
      closeOverlay(overlay);
      openLeaderboard();
    });

    cloudLeaderboard(function(list){
      var loadingEl = overlay.querySelector('#gm-stats-loading');
      var bodyEl = overlay.querySelector('#gm-stats-body');
      try {
        if (!list || !list.length){
          loadingEl.textContent = list ? '아직 랭킹에 표시할 기록이 없어요.' : '통계를 불러오지 못했어요. 잠시 후 다시 시도하거나, 개발자도구(F12) Console 탭에 오류가 있는지 확인해주세요.';
          return;
        }
        var pr = activeProfile();
        var total = list.length;
        var myIndex = pr ? list.findIndex(function(item){ return item.nickname === pr.nickname; }) : -1;
        var myRank = myIndex === -1 ? total : myIndex + 1;
        var percentile = Math.max(1, Math.round(((total - myRank) / total) * 100));
        var myCredits = myIndex !== -1 ? list[myIndex].totalCredits : (pr ? pr.totalCredits : 0);
        var sum = list.reduce(function(a, b){ return a + (b.totalCredits || 0); }, 0);
        var avg = Math.round(sum / total);
        var top = list.reduce(function(m, item){ return Math.max(m, item.totalCredits || 0); }, 0);
        var maxBar = Math.max(top, myCredits, avg, 1);

        function barRow(label, value, isMe){
          var pct = Math.max(3, Math.round((value / maxBar) * 100));
          return '<div class="gm-bar-row"><span class="gm-bar-label">' + label + '</span>' +
            '<span class="gm-bar-track"><span class="gm-bar-fill' + (isMe ? ' me' : '') + '" style="width:' + pct + '%;"></span></span>' +
            '<span class="gm-bar-val">' + value + '</span></div>';
        }

        // league distribution
        var counts = {};
        LEAGUES.forEach(function(l){ counts[l.id] = 0; });
        list.forEach(function(item){ var lg = getLeague(item.totalCredits); counts[lg.id] = (counts[lg.id] || 0) + 1; });
        var maxCount = Math.max.apply(null, LEAGUES.map(function(l){ return counts[l.id]; }).concat([1]));
        var myLeagueId = getLeague(myCredits).id;
        var distRows = LEAGUES.slice().reverse().map(function(l){
          var c = counts[l.id] || 0;
          var pct = Math.max(c ? 4 : 0, Math.round((c / maxCount) * 100));
          var isMe = l.id === myLeagueId;
          return '<div class="gm-league-dist-row' + (isMe ? ' me' : '') + '">' +
            '<span class="gm-ld-label">' + l.emoji + ' ' + l.name + '</span>' +
            '<span class="gm-ld-track"><span class="gm-ld-fill" style="width:' + pct + '%;"></span></span>' +
            '<span class="gm-ld-count">' + c + '명</span></div>';
        }).join('');

        bodyEl.innerHTML =
          '<div class="gm-rank-hero">' +
            '<div class="gm-rank-num">전체 ' + total + '명 중 ' + myRank + '위</div>' +
            '<div class="gm-rank-sub">' + escapeHtml(pr ? pr.nickname : '') + '님의 현재 순위예요</div>' +
            '<span class="gm-rank-pct">상위 ' + percentile + '%</span>' +
          '</div>' +
          '<div class="gm-stat-block">' +
            '<div class="gm-stat-block-title">' + CREDIT_NAME + ' 비교</div>' +
            barRow('나', myCredits, true) +
            barRow('평균', avg, false) +
            barRow('1위', top, false) +
          '</div>' +
          '<div class="gm-stat-block">' +
            '<div class="gm-stat-block-title">리그별 인원 분포 (나: ' + getLeague(myCredits).emoji + ' ' + getLeague(myCredits).name + ')</div>' +
            distRows +
          '</div>';

        loadingEl.remove();
        bodyEl.classList.remove('gm-hidden');
      } catch (err){
        console.error('[gamify] openMyStats render failed:', err);
        loadingEl.textContent = '통계 화면을 그리는 중 오류가 났어요: ' + err.message;
      }
    });
  }

  function exportData(){
    var pr = activeProfile();
    if (!pr) return;
    var blob = new Blob([JSON.stringify(pr, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'lingo_' + pr.nickname + '_기록.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(url); }, 2000);
  }

  function importData(file, overlay){
    var reader = new FileReader();
    reader.onload = function(){
      try {
        var pr = JSON.parse(reader.result);
        if (!pr || !pr.nickname) throw new Error('invalid');
        store.profiles[pr.nickname] = pr;
        store.activeNickname = pr.nickname;
        saveStore(store);
        if (overlay) closeOverlay(overlay);
        renderBar();
        toast(pr.nickname + '님의 기록을 불러왔어요.');
      } catch (err) {
        toast('파일을 읽지 못했어요. 올바른 백업 파일인지 확인해주세요.');
      }
    };
    reader.readAsText(file);
  }

  function escapeHtml(str){
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // 버튼 클릭 핸들러를 감싸서, 예상치 못한 오류가 나도 '아무 반응 없음'이 아니라
  // 눈에 보이는 토스트 메시지로 알려준다 (개발자도구 없이도 원인 파악이 쉬워짐).
  function safeCall(fn){
    return function(){
      try { return fn.apply(this, arguments); }
      catch (err){
        console.error('[gamify]', err);
        toast('오류가 발생했어요: ' + (err && err.message ? err.message : String(err)));
      }
    };
  }

  // ---------------------------------------------------------------------
  // header bar
  // ---------------------------------------------------------------------
  function renderBar(){
    injectStyles();
    var pr = activeProfile();
    var bar = document.getElementById('gm-bar');
    if (!bar){
      bar = document.createElement('div');
      bar.className = 'gm-bar';
      bar.id = 'gm-bar';
      document.body.insertBefore(bar, document.body.firstChild);
      var currentPad = parseInt(getComputedStyle(document.body).paddingTop || '0', 10) || 0;
      document.body.setAttribute('data-gm-orig-pad', currentPad);
      document.body.style.paddingTop = (currentPad + 46) + 'px';
    }
    if (!pr){
      bar.innerHTML =
        '<button class="gm-nick" id="gm-bar-nick"><span class="gm-avatar">?</span>시작하기</button><span class="gm-spacer"></span>';
      bar.querySelector('#gm-bar-nick').addEventListener('click', promptNickname);
      return;
    }
    var league = getLeague(pr.totalCredits);
    var statsBtn = isCloudEnabled()
      ? '<span class="gm-pill gm-league" id="gm-bar-stats" title="전체 순위에서 내 위치 보기">📊 내 순위</span>'
      : '';
    bar.innerHTML =
      '<button class="gm-nick" id="gm-bar-nick" title="' + escapeHtml(pr.nickname) + '"><span class="gm-avatar">' + escapeHtml(pr.nickname.charAt(0)) + '</span><span class="gm-nick-label">' + escapeHtml(pr.nickname) + ' ▾</span></button>' +
      '<span class="gm-spacer"></span>' +
      statsBtn +
      '<span class="gm-pill gm-league" id="gm-bar-league" title="리그 · 클릭해서 배지 보기">' + league.emoji + ' ' + league.name + '</span>' +
      '<span class="gm-pill">' + CREDIT_ICON + ' <span class="gm-credit-num" id="gm-bar-credit">' + pr.totalCredits + '</span></span>' +
      '<span class="gm-pill">🔥 ' + pr.streak.current + '일</span>';
    bar.querySelector('#gm-bar-nick').addEventListener('click', safeCall(openProfileSwitcher));
    bar.querySelector('#gm-bar-league').addEventListener('click', safeCall(openBadgeList));
    var statsEl = bar.querySelector('#gm-bar-stats');
    if (statsEl) statsEl.addEventListener('click', safeCall(openMyStats));
  }

  function bumpCreditDisplay(newTotal){
    var el = document.getElementById('gm-bar-credit');
    if (!el) return;
    el.textContent = newTotal;
    el.classList.add('gm-credit-pop');
    setTimeout(function(){ el.classList.remove('gm-credit-pop'); }, 700);
  }

  // ---------------------------------------------------------------------
  // core: reportResult
  // ---------------------------------------------------------------------
  function reportResult(input){
    input = input || {};
    var pr = activeProfile();
    if (!pr){
      // no profile yet — silently skip; header will prompt nickname on next view.
      return null;
    }
    var game = input.game;
    var accuracy = (typeof input.accuracy === 'number') ? Math.max(0, Math.min(1, input.accuracy)) : null;
    var comboMax = input.comboMax || 0;
    var today = todayStr();

    // reset daily cap bucket if day changed
    if (pr.dailyCredits.date !== today){
      pr.dailyCredits = { date: today, amount: 0 };
    }

    // ---- streak update (first credit-earning action of the day) ----
    var isFirstToday = (pr.streak.lastPlayedDate !== today);
    var streakBonus = 0;
    if (isFirstToday){
      if (pr.streak.lastPlayedDate){
        var gap = daysBetween(pr.streak.lastPlayedDate, today);
        pr.streak.current = (gap === 1) ? pr.streak.current + 1 : 1;
      } else {
        pr.streak.current = 1;
      }
      pr.streak.lastPlayedDate = today;
      pr.streak.longest = Math.max(pr.streak.longest, pr.streak.current);
      streakBonus += 5; // 당일 첫 학습 보너스
      if (pr.streak.current === 3) streakBonus += 20;
      if (pr.streak.current === 7) streakBonus += 50;
      if (pr.streak.current === 30) streakBonus += 200;
    }

    // ---- base + performance bonus ----
    var base = BASE_CREDIT[game] || 10;
    var now = Date.now();
    var lastAt = pr.lastPlayAt[game];
    if (lastAt && (now - lastAt) < REPEAT_COOLDOWN_MS){
      base = Math.round(base * 0.5); // 짧은 시간 내 동일 게임 반복 → 완료 기본 캐럿 절반
    }
    pr.lastPlayAt[game] = now;

    var perfBonus = 0;
    if (accuracy !== null){
      if (accuracy >= 0.9) perfBonus += 10;
      else if (accuracy >= 0.7) perfBonus += 5;
    }
    if (comboMax >= 5) perfBonus += Math.floor(comboMax / 5) * 3;

    var earned = base + perfBonus + streakBonus;

    // ---- daily cap ----
    var capHit = false;
    var room = DAILY_CAP - pr.dailyCredits.amount;
    if (room <= 0){
      earned = 0;
      capHit = true;
    } else if (earned > room){
      earned = room;
      capHit = true;
    }
    pr.dailyCredits.amount += earned;

    var prevLeague = getLeague(pr.totalCredits);
    pr.totalCredits += earned;
    var newLeague = getLeague(pr.totalCredits);

    // ---- cumulative correct + games played ----
    if (typeof input.correctCount === 'number'){
      pr.totalCorrect += input.correctCount;
    } else if (accuracy !== null && typeof input.totalCount === 'number'){
      pr.totalCorrect += Math.round(accuracy * input.totalCount);
    }
    pr.gamesPlayed[game] = true;
    if (game === 'speaking' && accuracy !== null && accuracy >= 0.9){
      pr.speakingHighCount = (pr.speakingHighCount || 0) + 1;
    }

    // ---- badge checks ----
    var newlyUnlocked = [];
    function unlock(key){
      if (pr.badges.indexOf(key) === -1){
        pr.badges.push(key);
        newlyUnlocked.push(key);
      }
    }
    unlock('first_play');
    if (Object.keys(GAME_LABELS).every(function(g){ return pr.gamesPlayed[g]; })) unlock('all_four_games');
    if (pr.streak.current >= 3) unlock('streak3');
    if (pr.streak.current >= 7) unlock('streak7');
    if (pr.streak.current >= 30) unlock('streak30');
    if (pr.totalCorrect >= 100) unlock('correct100');
    if (accuracy === 1) unlock('flawless');
    if ((pr.speakingHighCount || 0) >= 10) unlock('speaking_ace');

    saveStore(store);
    cloudPush(pr);

    if (earned > 0) bumpCreditDisplay(pr.totalCredits);
    else renderBar();

    if (capHit && earned === 0){
      toast('오늘 목표 ' + CREDIT_NAME + '를 이미 달성했어요! 내일 또 만나요 🌙');
    } else if (earned > 0){
      toast('+' + earned + ' ' + CREDIT_NAME + ' 획득! (' + GAME_LABELS[game] + ')');
    }

    newlyUnlocked.forEach(function(key){
      setTimeout(function(){ toast('🏅 새 배지: ' + BADGES[key].label); }, 400);
    });

    if (newLeague.id !== prevLeague.id){
      setTimeout(function(){ showLeagueUpModal(newLeague, pr); }, 700);
    }

    return {
      earned: earned,
      totalCredits: pr.totalCredits,
      league: newLeague,
      leagueChanged: newLeague.id !== prevLeague.id,
      newBadges: newlyUnlocked
    };
  }

  function showLeagueUpModal(league, pr){
    var html =
      '<div class="gm-celebrate">' + league.emoji + '</div>' +
      '<h3>' + league.name + ' 승급!</h3>' +
      '<p>' + escapeHtml(pr.nickname) + '님, 누적 ' + pr.totalCredits + ' ' + CREDIT_NAME + '를 모아 ' + league.name + ' 리그로 올라섰어요!<br>' +
      '보호자에게 이 화면을 보여주면 리워드를 받을 수 있어요.</p>' +
      '<div class="gm-code-box" id="gm-reward-code"></div>' +
      '<button class="gm-btn" id="gm-league-ok">계속하기</button>';
    var overlay = openOverlay(html);
    var code = btoa(unescape(encodeURIComponent(
      pr.nickname + '|' + league.id + '|' + pr.totalCredits + '|' + todayStr()
    ))).replace(/=+$/, '');
    overlay.querySelector('#gm-reward-code').textContent = '리워드 신청 코드: ' + code;
    overlay.querySelector('#gm-league-ok').addEventListener('click', function(){ closeOverlay(overlay); });
  }

  // ---------------------------------------------------------------------
  // boot
  // ---------------------------------------------------------------------
  function boot(){
    injectStyles();
    renderBar();
    console.log('[gamify] cloud sync:', isCloudEnabled() ? ('ON (' + getCloudEndpoint() + ')') : 'OFF (기기별 저장만 사용)');
    if (!store.activeNickname){
      setTimeout(promptNickname, 300);
    } else if (isCloudEnabled()){
      syncFromCloudThenPush(store.activeNickname);
    }
  }

  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  global.Gamify = {
    reportResult: reportResult,
    getActiveProfile: activeProfile,
    openProfileSwitcher: openProfileSwitcher,
    openBadgeList: openBadgeList,
    openCloudSettings: openCloudSettings,
    openLeaderboard: openLeaderboard,
    openMyStats: openMyStats,
    isCloudEnabled: isCloudEnabled,
    toast: toast,
    CREDIT_NAME: CREDIT_NAME
  };

})(window);
