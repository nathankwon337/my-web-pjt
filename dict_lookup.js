/*
 * dict_lookup.js — shared "long-press a word to look it up" feature.
 *
 * Used by: sentence_card_game.html, word_match_game.html, voca_trainer.html,
 * speaking_practice_game.html. Keeping this logic in one file means dictionary
 * URL fixes (e.g. Naver's inconsistent per-language routing) only need to be
 * made once and every game picks them up.
 *
 * Usage from a game's own <script>:
 *
 *   DictLookup.attach(cardEl, function(){ return tok.text; }, function(){
 *     return { enabled: dictEnableCb.checked, provider: dictProviderSelect.value, langCode: getLangCode() };
 *   });
 *
 * attach() returns { consumeLongPress() } — call consumeLongPress() at the top
 * of the element's own click/tap handler and bail out early if it returns true,
 * so the long-press interaction doesn't also trigger the card's normal action.
 */
(function (global) {
  "use strict";

  var LONG_PRESS_MS = 550;
  var MOVE_TOLERANCE = 8;

  // English uses its own subdomain: en.dict.naver.com/#/search?query=
  var NAVER_SUBDOMAIN_LANGS = { en: "en" }; // confirmed working

  // Most other languages use a path under the main domain instead:
  // dict.naver.com/{code}kodict/#/search?query=
  // Confirmed for German ("dekodict") and Vietnamese ("vikodict"); the rest
  // follow the same naming convention but haven't been individually verified.
  var NAVER_KODICT_LANGS = ["de", "vi", "es", "fr", "it", "ru", "pt", "th", "id"];

  // Daum's dictionary (as opposed to its translator) has no German or
  // Spanish sub-dictionary, so those queries silently fall through to its
  // English dictionary and return a near-miss word.
  var DAUM_UNSUPPORTED_LANGS = { de: true, es: true };

  // Strips leading/trailing punctuation while keeping internal apostrophes/
  // hyphens and non-Latin characters (CJK, accented letters, etc.) intact.
  function cleanWord(word) {
    try {
      return word.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "");
    } catch (err) {
      // very old browsers without unicode property escape support
      return word.replace(/^[^\w']+|[^\w']+$/g, "");
    }
  }

  // Returns { url, note } — note is a short explanation shown in the popover
  // when we had to substitute a different dictionary than the one selected.
  function getDictionaryUrl(word, provider, langCode) {
    var q = encodeURIComponent(word);
    var note = "";

    if (provider === "daum" && DAUM_UNSUPPORTED_LANGS[langCode]) {
      note = "다음사전은 이 언어를 지원하지 않아 네이버 사전으로 연결했어요.";
      provider = "naver";
    }
    if (provider === "merriam" && langCode !== "en") {
      note = "Merriam-Webster는 영어 전용이라 Google 정의 검색으로 연결했어요.";
      provider = "google";
    }
    if (provider === "naver") {
      if (NAVER_SUBDOMAIN_LANGS[langCode]) {
        return { url: "https://" + NAVER_SUBDOMAIN_LANGS[langCode] + ".dict.naver.com/#/search?query=" + q, note: note };
      }
      if (NAVER_KODICT_LANGS.indexOf(langCode) !== -1) {
        return { url: "https://dict.naver.com/" + langCode + "kodict/#/search?query=" + q, note: note };
      }
      note = "이 언어는 네이버 사전 주소가 아직 확인되지 않아 Google 정의 검색으로 연결했어요.";
      provider = "google";
    }

    switch (provider) {
      case "daum":
        return { url: "https://dic.daum.net/search.do?q=" + q, note: note };
      case "merriam":
        return { url: "https://www.merriam-webster.com/dictionary/" + q, note: note };
      case "google":
      default:
        return { url: "https://www.google.com/search?q=" + encodeURIComponent("define " + word), note: note };
    }
  }

  var popoverEl = null;
  var popoverHideTimer = null;

  function injectStyles() {
    if (document.getElementById("dict-lookup-styles")) return;
    var style = document.createElement("style");
    style.id = "dict-lookup-styles";
    style.textContent =
      ".dict-lookup-target{ -webkit-user-select:none; user-select:none; -webkit-touch-callout:none; -webkit-tap-highlight-color:transparent; }\n" +
      ".dict-lookup-armed{ box-shadow:0 0 0 3px rgba(232,163,61,0.55) !important; }\n" +
      ".dict-lookup-popover{ position:fixed; z-index:10000; display:none; flex-direction:column; gap:6px;\n" +
      "  background:#1E2A44; color:#fff; padding:10px 14px; border-radius:10px;\n" +
      "  font-family:Inter, sans-serif; font-size:13.5px;\n" +
      "  box-shadow:0 10px 24px -8px rgba(30,42,68,0.45); max-width:min(320px, calc(100vw - 16px)); }\n" +
      ".dict-lookup-row{ display:flex; align-items:center; gap:12px; }\n" +
      ".dict-lookup-word{ font-family:'Space Grotesk', monospace; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }\n" +
      ".dict-lookup-popover a{ color:#E8A33D; font-weight:700; text-decoration:none; white-space:nowrap; }\n" +
      ".dict-lookup-popover a:hover{ text-decoration:underline; }\n" +
      ".dict-lookup-close{ margin-left:auto; cursor:pointer; opacity:0.65; padding:2px 4px; flex-shrink:0; }\n" +
      ".dict-lookup-close:hover{ opacity:1; }\n" +
      ".dict-lookup-note{ font-size:11.5px; color:#C7CCDE; line-height:1.4; }";
    document.head.appendChild(style);
  }

  function ensurePopover() {
    if (popoverEl) return popoverEl;
    injectStyles();
    popoverEl = document.createElement("div");
    popoverEl.className = "dict-lookup-popover";
    document.body.appendChild(popoverEl);
    document.addEventListener("pointerdown", function (e) {
      if (!popoverEl.style.display || popoverEl.style.display === "none") return;
      if (popoverEl.contains(e.target)) return;
      hidePopover();
    });
    window.addEventListener("scroll", hidePopover, true);
    return popoverEl;
  }

  function hidePopover() {
    if (!popoverEl) return;
    popoverEl.style.display = "none";
    if (popoverHideTimer) {
      clearTimeout(popoverHideTimer);
      popoverHideTimer = null;
    }
  }

  function showPopover(word, anchorEl, provider, langCode) {
    var cleaned = cleanWord(word);
    if (!cleaned) return;
    var result = getDictionaryUrl(cleaned, provider || "naver", langCode || "en");
    var el = ensurePopover();
    el.innerHTML = "";

    var row = document.createElement("div");
    row.className = "dict-lookup-row";
    var wordSpan = document.createElement("span");
    wordSpan.className = "dict-lookup-word";
    wordSpan.textContent = cleaned;
    var link = document.createElement("a");
    link.href = result.url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "사전에서 찾아보기 ↗";
    link.addEventListener("click", hidePopover);
    var closeX = document.createElement("span");
    closeX.className = "dict-lookup-close";
    closeX.setAttribute("role", "button");
    closeX.setAttribute("aria-label", "닫기");
    closeX.textContent = "✕";
    closeX.addEventListener("click", hidePopover);
    row.appendChild(wordSpan);
    row.appendChild(link);
    row.appendChild(closeX);
    el.appendChild(row);

    if (result.note) {
      var noteEl = document.createElement("div");
      noteEl.className = "dict-lookup-note";
      noteEl.textContent = result.note;
      el.appendChild(noteEl);
    }

    el.style.display = "flex";
    var rect = anchorEl.getBoundingClientRect();
    var elRect = el.getBoundingClientRect();
    var left = rect.left + rect.width / 2 - elRect.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - elRect.width - 8));
    var top = rect.top - elRect.height - 10;
    if (top < 8) top = rect.bottom + 10;
    el.style.left = left + "px";
    el.style.top = top + "px";

    if (popoverHideTimer) clearTimeout(popoverHideTimer);
    popoverHideTimer = setTimeout(hidePopover, 5000);
  }

  // Prevents the OS/browser's own long-press gestures (text-selection callout,
  // "copy" bubble, contextmenu) from firing alongside our custom long-press,
  // which otherwise swallows the interaction and forces a second tap.
  function markNonSelectable(el) {
    injectStyles();
    el.classList.add("dict-lookup-target");
    el.addEventListener("contextmenu", function (e) {
      e.preventDefault();
    });
  }

  // Attaches long-press detection to a word element (for cards/buttons where a
  // plain tap already does something else, e.g. select or add-to-answer).
  //   getWord()      -> string, the word/phrase to look up
  //   getSettings()  -> { enabled: bool, provider: string, langCode: string }
  //   onTap()        -> optional. Called on a plain tap (no long-press, no
  //                     drag). Prefer this over the old consumeLongPress()
  //                     pattern — some mobile browsers don't reliably fire a
  //                     synthetic "click" right after a long touch-and-hold,
  //                     which made a plain tap immediately following a
  //                     dictionary lookup silently do nothing. Handling the
  //                     tap directly off pointerup sidesteps that entirely.
  // Returns { consumeLongPress() } kept for backward compatibility with any
  // code still checking it from its own separate "click" handler.
  function attach(el, getWord, getSettings, onTap) {
    markNonSelectable(el);
    var timer = null;
    var startX = 0,
      startY = 0;
    var moved = false;
    var longPressFired = false;

    function cancelTimer() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      el.classList.remove("dict-lookup-armed");
    }

    el.addEventListener("pointerdown", function (e) {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      startX = e.clientX;
      startY = e.clientY;
      moved = false;
      longPressFired = false;
      cancelTimer();
      var settings = getSettings ? getSettings() : {};
      if (!settings.enabled) return;
      el.classList.add("dict-lookup-armed");
      timer = setTimeout(function () {
        timer = null;
        longPressFired = true;
        el.classList.remove("dict-lookup-armed");
        showPopover(getWord(), el, settings.provider, settings.langCode);
      }, LONG_PRESS_MS);
    });

    el.addEventListener("pointermove", function (e) {
      if (moved) return;
      if (Math.abs(e.clientX - startX) > MOVE_TOLERANCE || Math.abs(e.clientY - startY) > MOVE_TOLERANCE) {
        moved = true;
        cancelTimer();
      }
    });

    el.addEventListener("pointerup", function (e) {
      var wasLongPress = longPressFired;
      cancelTimer();
      if (!wasLongPress && !moved && onTap) onTap(e);
    });
    el.addEventListener("pointercancel", cancelTimer);

    return {
      consumeLongPress: function () {
        if (longPressFired) {
          longPressFired = false;
          return true;
        }
        return false;
      }
    };
  }

  // Attaches single-tap-to-look-up behavior. Use this instead of attach() for
  // plain text (a sentence, a headword display, ...) that has no other tap
  // action of its own — long-press there has nothing to disambiguate against,
  // and waiting for a hold only invites the OS's own text-selection/"Copy"
  // callout to pop up alongside our dictionary popover.
  function attachTap(el, getWord, getSettings) {
    markNonSelectable(el);
    var startX = 0,
      startY = 0;
    var moved = false;

    el.addEventListener("pointerdown", function (e) {
      if (e.pointerType === "mouse" && e.button !== 0) {
        moved = true; // ignore right-click/middle-click drags
        return;
      }
      startX = e.clientX;
      startY = e.clientY;
      moved = false;
    });
    el.addEventListener("pointermove", function (e) {
      if (moved) return;
      if (Math.abs(e.clientX - startX) > MOVE_TOLERANCE || Math.abs(e.clientY - startY) > MOVE_TOLERANCE) {
        moved = true;
      }
    });
    el.addEventListener("pointerup", function () {
      if (moved) return;
      var s = getSettings ? getSettings() : {};
      if (!s.enabled) return;
      showPopover(getWord(), el, s.provider, s.langCode);
    });
  }

  global.DictLookup = {
    attach: attach,
    attachTap: attachTap,
    hidePopover: hidePopover,
    cleanWord: cleanWord,
    getUrl: getDictionaryUrl
  };
})(window);
