(function () {
  "use strict";

  var STORAGE_KEY = "fangji_anki_v1";
  var SEED_VERSION = 2;
  var DAY = 24 * 60 * 60 * 1000;
  var PAGE = document.body.getAttribute("data-page") || "review";

  // 艾宾浩斯复习节点：5 分钟 → 30 分钟 → 12 小时 → 1 天 → 2 天 → 4 天 → 7 天 → 15 天 → 30 天 → 60 天
  var INTERVALS = [
    { ms: 5 * 60 * 1000, label: "5 分钟" },
    { ms: 30 * 60 * 1000, label: "30 分钟" },
    { ms: 12 * 60 * 60 * 1000, label: "12 小时" },
    { ms: 1 * DAY, label: "1 天" },
    { ms: 2 * DAY, label: "2 天" },
    { ms: 4 * DAY, label: "4 天" },
    { ms: 7 * DAY, label: "7 天" },
    { ms: 15 * DAY, label: "15 天" },
    { ms: 30 * DAY, label: "30 天" },
    { ms: 60 * DAY, label: "60 天" }
  ];

  var LEVELS = ["掌握", "熟悉", "了解"];

  // ---------- 工具 ----------
  function $(id) { return document.getElementById(id); }
  function on(id, evt, fn) { var el = $(id); if (el) el.addEventListener(evt, fn); }
  function onAll(sel, evt, fn) {
    document.querySelectorAll(sel).forEach(function (el) { el.addEventListener(evt, fn); });
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function toast(msg) {
    var el = $("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.classList.remove("show"); }, 2200);
  }
  function nextDue(stage) {
    var idx = Math.min(Math.max(stage - 1, 0), INTERVALS.length - 1);
    return Date.now() + INTERVALS[idx].ms;
  }
  function isDue(card) {
    return !card.dueAt || card.dueAt <= Date.now();
  }
  function stageLabel(stage) {
    if (!stage) return "未开始";
    if (stage >= INTERVALS.length) return "长期记忆";
    return INTERVALS[stage - 1].label;
  }
  function todayKey() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function ensureStats() {
    if (!state.daily) state.daily = {};
    var key = todayKey();
    if (!state.daily[key]) state.daily[key] = { reviewed: 0, forget: 0, remember: 0, easy: 0 };
    Object.keys(state.daily).forEach(function (k) {
      if (k < key && (Date.now() - new Date(k + "T00:00:00").getTime()) / DAY > 30) delete state.daily[k];
    });
    return state.daily[key];
  }

  // ---------- 状态 ----------
  var state = loadState();
  var session = null;
  var libLevel = "all";
  var libChapter = "all";
  var searchTerm = "";
  var editingId = null;
  var isNewCard = false;
  var openChapters = {};

  function seedCards() {
    return (window.SEED_CARDS || []).map(function (c, i) {
      return {
        id: "seed-" + i,
        name: c.name,
        level: c.level,
        chapter: c.chapter,
        song: c.song,
        note: "",
        stage: 0,
        dueAt: null,
        reviewCount: 0,
        lastReviewed: null
      };
    });
  }

  function loadState() {
    var raw = null;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { raw = null; }
    var saved = null;
    if (raw) {
      try { saved = JSON.parse(raw); } catch (e) { saved = null; }
    }
    if (!saved || !Array.isArray(saved.cards)) {
      return { cards: seedCards(), seedVersion: SEED_VERSION, daily: {}, updatedAt: Date.now() };
    }
    var seeds = seedCards();
    var seedByName = {};
    seeds.forEach(function (c) { seedByName[c.name] = c; });
    // 章节归位（第十七/十八章拆分、祛痰剂章号修正），保留用户进度与其它编辑
    if (saved.seedVersion !== SEED_VERSION) {
      saved.cards.forEach(function (c) {
        if (c.id && c.id.indexOf("seed-") === 0 && seedByName[c.name]) {
          c.chapter = seedByName[c.name].chapter;
        }
      });
      saved.seedVersion = SEED_VERSION;
    }
    // 若数据文件新增了方剂，补齐缺失卡片，保留用户已有进度与编辑
    var existing = {};
    saved.cards.forEach(function (c) { existing[c.name] = true; });
    seeds.forEach(function (c) {
      if (!existing[c.name]) saved.cards.push(c);
    });
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(saved)); } catch (e) {}
    return saved;
  }

  function saveState() {
    state.updatedAt = Date.now();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      toast("保存失败，浏览器存储可能已满");
    }
  }

  // ---------- 通用渲染 ----------
  function dueCount() {
    return state.cards.filter(isDue).length;
  }
  function refreshChrome() {
    var due = dueCount();
    var today = ensureStats();
    var mastered = state.cards.filter(function (c) { return c.stage >= 8; }).length;
    var pill = $("duePill");
    if (pill) pill.innerHTML = "今日待复习 <strong>" + due + "</strong>";
    var sd = $("statDue");
    if (sd) sd.textContent = due;
    var st = $("statToday");
    if (st) st.textContent = today.reviewed;
    if ($("reviewStats")) {
      $("reviewStats").innerHTML =
        "<span>今日已复习 <b>" + today.reviewed + "</b></span>" +
        "<span>待复习 <b>" + due + "</b></span>" +
        "<span>长期记忆 <b>" + mastered + "</b></span>";
    }
  }

  function openModal(id) { $(id).classList.remove("hidden"); }
  function closeModal(id) { $(id).classList.add("hidden"); }

  // ---------- 复习 ----------
  function populateScopeChapters() {
    var group = $("scopeChapters");
    if (!group) return;
    var chapters = [];
    state.cards.forEach(function (c) {
      if (chapters.indexOf(c.chapter) < 0) chapters.push(c.chapter);
    });
    group.innerHTML = chapters.map(function (ch) {
      return '<option value="chapter:' + esc(ch) + '">' + esc(ch) + "</option>";
    }).join("");
  }

  function buildQueue() {
    var scope = $("reviewScope").value;
    var limit = parseInt($("reviewLimit").value, 10);
    var pool = state.cards.filter(function (c) {
      if (scope === "due") return isDue(c);
      if (scope.indexOf("chapter:") === 0) return c.chapter === scope.slice(8);
      if (LEVELS.indexOf(scope) >= 0) return c.level === scope;
      return true;
    });
    pool.sort(function (a, b) { return (a.dueAt || 0) - (b.dueAt || 0); });
    return pool.slice(0, limit).map(function (c) { return c.id; });
  }

  function startReview() {
    var queue = buildQueue();
    if (!queue.length) {
      toast("当前范围内没有可复习的卡片");
      return;
    }
    session = { queue: queue, index: 0, flipped: false, counts: { forget: 0, remember: 0, easy: 0 } };
    $("reviewStart").classList.add("hidden");
    $("reviewDone").classList.add("hidden");
    $("reviewSession").classList.remove("hidden");
    showCurrent();
  }

  function showCurrent() {
    if (!session) return;
    if (session.index >= session.queue.length) { finishReview(); return; }
    var card = state.cards.find(function (c) { return c.id === session.queue[session.index]; });
    if (!card) { session.index++; showCurrent(); return; }
    session.flipped = false;
    $("flashcard").classList.remove("flipped");
    $("frontName").textContent = card.name;
    $("frontChapter").textContent = card.chapter;
    var lv = $("frontLevel");
    lv.textContent = card.level;
    lv.className = "level-badge level-" + card.level;
    $("backSong").textContent = card.song || "（暂无方歌，可在卡片库中编辑补充）";
    $("backChapter").textContent = card.name;
    $("backStage").textContent = "当前节点：" + stageLabel(card.stage);
    $("flipBtn").classList.remove("hidden");
    $("sessionCounter").textContent = (session.index + 1) + " / " + session.queue.length;
    $("sessionProgressBar").style.width = (session.index / session.queue.length * 100) + "%";
  }

  function flipCard() {
    if (!session) return;
    if (session.flipped) {
      session.flipped = false;
      $("flashcard").classList.remove("flipped");
      $("flipBtn").classList.remove("hidden");
      return;
    }
    session.flipped = true;
    $("flashcard").classList.add("flipped");
    $("flipBtn").classList.add("hidden");
  }

  function rateCurrent(rate) {
    if (!session || !session.flipped) return;
    var card = state.cards.find(function (c) { return c.id === session.queue[session.index]; });
    if (!card) return;
    if (rate === "forget") {
      card.stage = 0;
      card.dueAt = Date.now() + INTERVALS[0].ms;
      session.counts.forget++;
    } else if (rate === "remember") {
      card.stage = Math.min(card.stage + 1, INTERVALS.length);
      card.dueAt = nextDue(card.stage);
      session.counts.remember++;
    } else if (rate === "easy") {
      card.stage = Math.min(card.stage + 2, INTERVALS.length);
      card.dueAt = nextDue(card.stage);
      session.counts.easy++;
    }
    card.reviewCount = (card.reviewCount || 0) + 1;
    card.lastReviewed = Date.now();
    var day = ensureStats();
    day.reviewed++;
    day[rate]++;
    saveState();
    session.index++;
    showCurrent();
    refreshChrome();
  }

  function skipCurrent() {
    if (!session) return;
    session.index++;
    showCurrent();
  }

  function finishReview() {
    $("reviewSession").classList.add("hidden");
    $("reviewDone").classList.remove("hidden");
    var c = session.counts;
    $("doneSummary").textContent = "记得 " + c.remember + " 张 · 太简单 " + c.easy + " 张 · 忘记 " + c.forget + " 张。忘记的方剂将在 5 分钟后重新出现。";
    $("sessionProgressBar").style.width = "100%";
    session = null;
    refreshChrome();
  }

  function endReview() {
    session = null;
    $("reviewSession").classList.add("hidden");
    $("reviewDone").classList.add("hidden");
    $("reviewStart").classList.remove("hidden");
    refreshChrome();
  }

  // ---------- 卡片库 ----------
  function filteredCards() {
    var chapters = {};
    state.cards.forEach(function (c) { chapters[c.chapter] = true; });
    var select = $("chapterFilter");
    var keys = Object.keys(chapters).sort();
    if (select.options.length !== keys.length + 1) {
      select.innerHTML = '<option value="all">全部章节</option>' + keys.map(function (k) {
        return '<option value="' + esc(k) + '">' + esc(k) + "</option>";
      }).join("");
    }
    return state.cards.filter(function (c) {
      if (libLevel !== "all" && c.level !== libLevel) return false;
      if (libChapter !== "all" && c.chapter !== libChapter) return false;
      if (searchTerm) {
        var hay = (c.name + " " + c.song + " " + (c.note || "")).toLowerCase();
        if (hay.indexOf(searchTerm.toLowerCase()) < 0) return false;
      }
      return true;
    });
  }

  function renderLibrary() {
    if (!$("cardList")) return;
    var list = filteredCards();
    $("listMeta").textContent = "共 " + list.length + " 张卡片 · 点击卡片可查看详情或编辑";
    if (!list.length) {
      $("cardList").innerHTML = '<div class="empty-state">没有找到匹配的方剂</div>';
      return;
    }
    $("cardList").innerHTML = list.map(function (c) {
      return '<article class="mini-card" data-id="' + esc(c.id) + '">' +
        '<div class="mini-top"><span class="mini-name">' + esc(c.name) + "</span>" +
        '<span class="level-badge level-' + esc(c.level) + '">' + esc(c.level) + "</span></div>" +
        '<div class="mini-song">' + esc(c.song || "暂无方歌") + "</div>" +
        '<div class="mini-foot"><span>' + esc(c.chapter) + '</span><span class="stage-pill">' +
        esc(stageLabel(c.stage)) + "</span></div></article>";
    }).join("");
  }

  function openCardModal(id) {
    isNewCard = id === "new";
    editingId = isNewCard ? null : id;
    var card = isNewCard ? null : state.cards.find(function (c) { return c.id === id; });
    $("editTitle").textContent = isNewCard ? "新增卡片" : "编辑卡片";
    $("editName").value = card ? card.name : "";
    $("editLevel").value = card ? card.level : "掌握";
    $("editChapter").value = card ? card.chapter : "";
    $("editSong").value = card ? card.song : "";
    $("editNote").value = card ? (card.note || "") : "";
    $("deleteCardBtn").classList.toggle("hidden", isNewCard);
    openModal("editModal");
  }

  function saveCard() {
    var name = $("editName").value.trim();
    var song = $("editSong").value.trim();
    if (!name) { toast("请填写方名"); return; }
    if (!song) { toast("请填写方歌"); return; }
    var data = {
      name: name,
      level: $("editLevel").value,
      chapter: $("editChapter").value.trim() || "自定义",
      song: song,
      note: $("editNote").value.trim()
    };
    if (isNewCard) {
      data.id = "custom-" + Date.now();
      data.stage = 0;
      data.dueAt = null;
      data.reviewCount = 0;
      data.lastReviewed = null;
      state.cards.push(data);
    } else {
      var card = state.cards.find(function (c) { return c.id === editingId; });
      if (!card) return;
      Object.keys(data).forEach(function (k) { card[k] = data[k]; });
    }
    saveState();
    closeModal("editModal");
    renderLibrary();
    refreshChrome();
    toast(isNewCard ? "卡片已新增" : "卡片已更新");
  }

  function deleteCard() {
    if (isNewCard) return;
    var card = state.cards.find(function (c) { return c.id === editingId; });
    if (!card) return;
    if (!window.confirm("确定删除「" + card.name + "」这张卡片吗？此操作不可撤销。")) return;
    state.cards = state.cards.filter(function (c) { return c.id !== editingId; });
    saveState();
    closeModal("editModal");
    renderLibrary();
    refreshChrome();
    toast("卡片已删除");
  }

  // ---------- 统计 ----------
  function fmtTime(ts) {
    var d = new Date(ts);
    return String(d.getMonth() + 1).padStart(2, "0") + "/" + String(d.getDate()).padStart(2, "0") + " " +
      String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  function renderChapterStats() {
    var groups = [];
    var byName = {};
    state.cards.forEach(function (c) {
      var key = c.chapter || "自定义";
      if (!byName[key]) { byName[key] = { name: key, cards: [] }; groups.push(byName[key]); }
      byName[key].cards.push(c);
    });
    $("chapterStats").innerHTML = groups.map(function (g, i) {
      var total = g.cards.length;
      var fresh = g.cards.filter(function (c) { return !c.stage; }).length;
      var learning = g.cards.filter(function (c) { return c.stage > 0 && c.stage < 8; }).length;
      var mastered = total - fresh - learning;
      var due = g.cards.filter(isDue).length;
      var pct = function (n) { return total ? (n / total * 100).toFixed(1) + "%" : "0%"; };
      var rows = g.cards.slice().sort(function (a, b) {
        return (b.stage || 0) - (a.stage || 0);
      }).map(function (c) {
        var timing = !c.stage ? "未开始" : isDue(c) ? "待复习" : "下次 " + fmtTime(c.dueAt);
        return '<div class="formula-row"><span class="fname">' + esc(c.name) + "</span>" +
          '<span class="tag">' + esc(c.level) + "</span>" +
          '<span class="tag">' + esc(stageLabel(c.stage)) + "</span>" +
          '<span class="tag">' + (c.reviewCount || 0) + " 次 · " + timing + "</span></div>";
      }).join("");
      var open = openChapters[i] ? " open" : "";
      return '<div class="chapter-stat' + open + '" data-index="' + i + '">' +
        '<div class="chapter-stat-head"><span class="chev">›</span>' +
        '<div class="chapter-stat-main"><div class="chapter-stat-title">' + esc(g.name) + "</div>" +
        '<div class="chapter-stat-meta">未开始 ' + fresh + " · 学习中 " + learning + " · 长期记忆 " + mastered +
        " · 待复习 " + due + "</div>" +
        '<div class="chapter-stack"><span class="s-new" style="width:' + pct(fresh) + '"></span>' +
        '<span class="s-learning" style="width:' + pct(learning) + '"></span>' +
        '<span class="s-mastered" style="width:' + pct(mastered) + '"></span></div></div>' +
        '<span class="chapter-stat-count">' + total + " 首</span></div>" +
        '<div class="chapter-detail">' + rows + "</div></div>";
    }).join("");
    var allOpen = groups.length > 0 && groups.every(function (_, i) { return openChapters[i]; });
    $("toggleChapterStatsBtn").textContent = allOpen ? "全部收起" : "全部展开";
  }

  function renderStats() {
    if (!$("statTotal")) return;
    $("statTotal").textContent = state.cards.length;
    $("statDue").textContent = dueCount();
    $("statLearning").textContent = state.cards.filter(function (c) {
      return c.stage > 0 && c.stage < 8;
    }).length;
    $("statMastered").textContent = state.cards.filter(function (c) { return c.stage >= 8; }).length;

    $("levelBars").innerHTML = LEVELS.map(function (lv) {
      var n = state.cards.filter(function (c) { return c.level === lv; }).length;
      var pct = state.cards.length ? Math.round(n / state.cards.length * 100) : 0;
      return '<div class="bar-row"><span>' + lv + '</span><div class="bar-track"><div class="bar-fill ' + lv +
        '" style="width:' + pct + '%"></div></div><span>' + n + " 张</span></div>";
    }).join("");

    var days = [];
    for (var i = 6; i >= 0; i--) {
      var d = new Date();
      d.setDate(d.getDate() - i);
      var key = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
      days.push({ key: key, n: state.daily && state.daily[key] ? state.daily[key].reviewed : 0 });
    }
    var max = Math.max.apply(null, days.map(function (x) { return x.n; }).concat([1]));
    $("dailyBars").innerHTML = days.map(function (x, idx) {
      var h = Math.max(4, Math.round(x.n / max * 90));
      return '<div class="daily-col' + (idx === 6 ? " today" : "") + '">' +
        '<span class="daily-num">' + x.n + "</span>" +
        '<div class="daily-bar" style="height:' + h + 'px"></div>' +
        "<span>" + x.key.slice(5).replace("-", "/") + "</span></div>";
    }).join("");

    $("intervalList").innerHTML = INTERVALS.map(function (it, i) {
      return '<span class="interval-item"><b>第 ' + (i + 1) + ' 次</b>' + it.label + "</span>";
    }).join("") + '<span class="interval-item"><b>起点</b>新卡片 / 忘记后 5 分钟</span>';

    renderChapterStats();
  }

  // ---------- 数据管理 ----------
  function exportBackup() {
    var data = JSON.stringify(state, null, 2);
    var blob = new Blob([data], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "方剂记忆卡备份-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast("备份已导出");
  }

  function importBackup(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        if (!data || !Array.isArray(data.cards)) throw new Error("格式不正确");
        if (!window.confirm("导入将覆盖当前所有卡片与复习进度，确定继续？")) return;
        state = data;
        saveState();
        closeModal("settingsModal");
        populateScopeChapters();
        refreshChrome();
        renderLibrary();
        renderStats();
        toast("备份已导入");
      } catch (e) {
        toast("导入失败：文件格式不正确");
      }
    };
    reader.readAsText(file);
  }

  // ---------- 事件绑定 ----------
  function bind() {
    // 三个页面通用
    on("settingsTopBtn", "click", function () { openModal("settingsModal"); });
    onAll("[data-close]", "click", function () { closeModal(this.dataset.close); });
    on("exportBtn", "click", exportBackup);
    on("importInput", "change", function (e) {
      if (e.target.files && e.target.files[0]) importBackup(e.target.files[0]);
      e.target.value = "";
    });

    // 复习页
    if (PAGE === "review") {
      on("startReviewBtn", "click", startReview);
      on("flipBtn", "click", flipCard);
      on("flashcard", "click", flipCard);
      on("flashcard", "keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); flipCard(); }
      });
      onAll(".rate-btn", "click", function () { rateCurrent(this.dataset.rate); });
      on("skipBtn", "click", skipCurrent);
      on("endReviewBtn", "click", endReview);
      on("againBtn", "click", function () {
        $("reviewDone").classList.add("hidden");
        startReview();
      });
    }

    // 卡片库页
    if (PAGE === "library") {
      on("searchInput", "input", function (e) {
        searchTerm = e.target.value.trim();
        renderLibrary();
      });
      onAll("#levelChips .chip", "click", function () {
        document.querySelectorAll("#levelChips .chip").forEach(function (c) { c.classList.remove("active"); });
        this.classList.add("active");
        libLevel = this.dataset.level;
        renderLibrary();
      });
      on("chapterFilter", "change", function (e) {
        libChapter = e.target.value;
        renderLibrary();
      });
      on("cardList", "click", function (e) {
        var card = e.target.closest(".mini-card");
        if (card) openCardModal(card.dataset.id);
      });
      on("addCardBtn", "click", function () { openCardModal("new"); });
      on("saveCardBtn", "click", saveCard);
      on("deleteCardBtn", "click", deleteCard);
    }

    // 统计页
    if (PAGE === "stats") {
      on("chapterStats", "click", function (e) {
        var head = e.target.closest(".chapter-stat-head");
        if (!head) return;
        var box = head.parentNode;
        var open = !box.classList.contains("open");
        box.classList.toggle("open", open);
        openChapters[box.dataset.index] = open;
        var all = $("chapterStats").querySelectorAll(".chapter-stat");
        $("toggleChapterStatsBtn").textContent = $("chapterStats").querySelectorAll(".chapter-stat.open").length === all.length
          ? "全部收起" : "全部展开";
      });
      on("toggleChapterStatsBtn", "click", function () {
        var boxes = $("chapterStats").querySelectorAll(".chapter-stat");
        var expand = $("chapterStats").querySelectorAll(".chapter-stat.open").length !== boxes.length;
        boxes.forEach(function (b) {
          b.classList.toggle("open", expand);
          openChapters[b.dataset.index] = expand;
        });
        $("toggleChapterStatsBtn").textContent = expand ? "全部收起" : "全部展开";
      });
      on("openSettingsBtn", "click", function () { openModal("settingsModal"); });
      on("resetProgressBtn", "click", function () {
        if (!window.confirm("确定清空全部记忆进度吗？卡片内容会保留。")) return;
        state.cards.forEach(function (c) {
          c.stage = 0;
          c.dueAt = null;
          c.reviewCount = 0;
          c.lastReviewed = null;
        });
        saveState();
        refreshChrome();
        renderStats();
        renderLibrary();
        toast("记忆进度已清空");
      });
    }

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        ["editModal", "settingsModal"].forEach(closeModal);
        return;
      }
      if (PAGE !== "review" || !session || $("reviewSession").classList.contains("hidden")) return;
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;
      if (e.code === "Space") {
        e.preventDefault();
        flipCard();
      } else if (session.flipped && ["1", "2", "3"].indexOf(e.key) >= 0) {
        rateCurrent(["forget", "remember", "easy"][parseInt(e.key, 10) - 1]);
      }
    });
  }

  bind();
  populateScopeChapters();
  refreshChrome();
  if (PAGE === "library") renderLibrary();
  if (PAGE === "stats") {
    renderStats();
    var panel = $("chapterStatsPanel");
    if (panel && typeof panel.scrollIntoView === "function") {
      requestAnimationFrame(function () { panel.scrollIntoView({ behavior: "smooth", block: "start" }); });
    }
  }
})();
