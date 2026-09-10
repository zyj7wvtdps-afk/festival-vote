(() => {
  'use strict';

  const STORAGE_KEY = 'festival-race-state-v1';
  const VOTER_KEY = 'festival-race-voter-id-v1';
  const AUTH_KEY = 'festival-race-admin-auth-v1';
  const THEME_KEY = 'festival-race-theme-v1';
  const REMOTE_RACE_ID = 'current';
  const LEGACY_ADMIN_EMAIL = 'staff@festival-race.local';
  const LEGACY_ADMIN_PASSWORD = 'greenrace2026';

  const initialState = () => ({
    title: '文化祭記念・芝の祭典',
    status: 'open', // open | closed | revealed
    revealed: false,
    winnerId: null,
    horses: [
      { id: 'horse-1', name: 'グリーンリーフ' },
      { id: 'horse-2', name: 'サクラフェス' },
      { id: 'horse-3', name: 'ハッピーギャロップ' },
      { id: 'horse-4', name: 'ミライスター' },
      { id: 'horse-5', name: 'ホワイトキャンバス' },
      { id: 'horse-6', name: 'キラキラダッシュ' },
    ],
    votes: {},
    updatedAt: Date.now(),
  });

  const remote = {
    configured: Boolean(window.firebase && window.FIREBASE_CONFIG?.projectId),
    fallback: false,
    authReady: false,
    user: null,
    admin: false,
    auth: null,
    db: null,
    raceRef: null,
    votesRef: null,
    stopRace: null,
    stopVotes: null,
    error: '',
    signingIn: false,
  };

  let state = loadState();
  let toastTimer;
  let adminToastTimer;
  let broadcast;

  const $ = (selector, parent = document) => parent.querySelector(selector);
  const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];

  function safeStorageGet(key) {
    try { return window.localStorage.getItem(key); } catch (_) { return null; }
  }

  function safeStorageSet(key, value) {
    try { window.localStorage.setItem(key, value); return true; } catch (_) { return false; }
  }

  function makeId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `voter-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function getVoterId() {
    let id = safeStorageGet(VOTER_KEY);
    if (!id) {
      id = makeId();
      safeStorageSet(VOTER_KEY, id);
    }
    return id;
  }

  const voterId = getVoterId();

  function toMillis(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (value && typeof value.toMillis === 'function') return value.toMillis();
    if (value && Number.isFinite(value.seconds)) return value.seconds * 1000;
    return Date.now();
  }

  function normalizeState(raw) {
    const fallback = initialState();
    if (!raw || typeof raw !== 'object') return fallback;
    const horses = Array.isArray(raw.horses) && raw.horses.length >= 1
      ? raw.horses.map((horse, index) => ({
          id: String(horse.id || `horse-${index + 1}`),
          name: String(horse.name || `出走馬 ${index + 1}`).slice(0, 40),
        }))
      : fallback.horses;
    const votes = raw.votes && typeof raw.votes === 'object' ? raw.votes : {};
    const status = ['open', 'closed', 'revealed'].includes(raw.status) ? raw.status : 'open';
    return {
      title: String(raw.title || fallback.title).slice(0, 40),
      status,
      revealed: status === 'revealed' || raw.revealed === true,
      winnerId: raw.winnerId ? String(raw.winnerId) : null,
      horses,
      votes,
      updatedAt: toMillis(raw.updatedAt),
    };
  }

  function loadState() {
    const saved = safeStorageGet(STORAGE_KEY);
    if (!saved) return initialState();
    try { return normalizeState(JSON.parse(saved)); } catch (_) { return initialState(); }
  }

  function currentVoterKey() {
    return remote.user?.uid || voterId;
  }

  function remoteActive() {
    return remote.configured && !remote.fallback && remote.authReady && Boolean(remote.user);
  }

  function syncLocalSnapshot(nextState, notifyOtherTabs = false) {
    state = normalizeState(nextState);
    safeStorageSet(STORAGE_KEY, JSON.stringify(state));
    if (notifyOtherTabs) {
      try { broadcast?.postMessage({ type: 'state-updated', state }); } catch (_) { /* optional */ }
    }
    renderAll();
  }

  function saveLocalState(nextState, message = '') {
    syncLocalSnapshot({ ...nextState, updatedAt: Date.now() }, true);
    if (message) showToast(message);
  }

  function escapeHTML(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function getCounts() {
    const counts = Object.fromEntries(state.horses.map((horse) => [horse.id, 0]));
    Object.values(state.votes).forEach((horseId) => {
      if (Object.prototype.hasOwnProperty.call(counts, horseId)) counts[horseId] += 1;
    });
    return counts;
  }

  function getRanking() {
    const counts = getCounts();
    return state.horses
      .map((horse, index) => ({ ...horse, originalIndex: index, count: counts[horse.id] || 0 }))
      .sort((a, b) => b.count - a.count || a.originalIndex - b.originalIndex);
  }

  function getHorse(horseId) {
    return state.horses.find((horse) => horse.id === horseId);
  }

  function totalVotes() {
    return Object.values(getCounts()).reduce((sum, count) => sum + count, 0);
  }

  function statusLabel() {
    if (state.status === 'revealed') return ['結果発表済み', 'status-revealed'];
    if (state.status === 'closed') return ['投票受付終了', 'status-closed'];
    return ['投票受付中', 'status-open'];
  }

  function formatUpdated() {
    if (!state.updatedAt) return 'たった今更新';
    const time = new Date(state.updatedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    return `${time}に更新`;
  }

  function renderRaceMeta() {
    const [label, className] = statusLabel();
    const status = $('#race-status');
    status.className = `status-pill ${className}`;
    status.innerHTML = `<span class="status-dot"></span>${label}`;
    $('#race-title').textContent = state.title;
    $('#race-subtitle').textContent = state.status === 'open'
      ? '単勝1頭勝負　/　発走までみんなの予想を受付中'
      : state.status === 'revealed'
        ? '単勝1頭勝負　/　レース結果が発表されました'
        : '単勝1頭勝負　/　投票の受付は終了しました';
  }

  function renderNotice() {
    const notices = [];
    if (state.status === 'revealed') {
      notices.push('<div class="notice success"><span aria-hidden="true">🏆</span><span>レース結果が発表されました。「みんなの予想」から勝ち馬と的中状況を確認できます。</span></div>');
    } else if (state.status === 'closed') {
      notices.push('<div class="notice warning"><span aria-hidden="true">⏸</span><span>ただいま投票受付を終了しています。結果発表をお楽しみに！</span></div>');
    }
    if (remote.error) {
      notices.push(`<div class="notice warning"><span aria-hidden="true">!</span><span>${escapeHTML(remote.error)}</span></div>`);
    }
    $('#notice-area').innerHTML = notices.join('');
  }

  function renderHorseList() {
    const list = $('#horse-list');
    $('#horse-count').textContent = state.horses.length;
    const myVote = state.votes[currentVoterKey()];
    const waitingForFirebase = remote.configured && !remote.fallback && !remote.authReady;
    const disabled = state.status !== 'open' || Boolean(myVote) || waitingForFirebase;
    list.innerHTML = state.horses.map((horse, index) => `
      <div class="horse-option">
        <input id="pick-${escapeHTML(horse.id)}" name="horse" value="${escapeHTML(horse.id)}" type="radio" ${myVote === horse.id ? 'checked' : ''} ${disabled ? 'disabled' : ''} />
        <label class="horse-label" for="pick-${escapeHTML(horse.id)}">
          <span class="horse-number">${String(index + 1).padStart(2, '0')}</span>
          <span><span class="horse-name">${escapeHTML(horse.name)}</span><small class="horse-sub">単勝予想</small></span>
          <span class="checkmark" aria-hidden="true"></span>
        </label>
      </div>`).join('');
    const voteButton = $('#vote-button');
    voteButton.disabled = disabled;
    voteButton.innerHTML = waitingForFirebase
      ? '<span>接続中…</span>'
      : state.status === 'open' && !myVote
        ? '<span>投票する</span><span class="button-arrow" aria-hidden="true">→</span>'
        : '<span>投票受付終了</span>';
    voteButton.style.opacity = disabled ? '.55' : '1';
  }

  function renderVotedPanel() {
    const myVote = state.votes[currentVoterKey()];
    const votedPanel = $('#voted-panel');
    const votePanel = $('#vote-panel');
    if (!myVote) {
      votedPanel.classList.add('hidden');
      votePanel.classList.remove('hidden');
      return;
    }
    const horse = getHorse(myVote);
    $('#my-vote-name').textContent = horse?.name || '選択した馬';
    const message = $('#voted-result-message');
    if (state.status === 'revealed' && state.winnerId) {
      const winner = getHorse(state.winnerId);
      message.innerHTML = myVote === state.winnerId
        ? `<div class="result-message hit">🎉 的中！あなたの予想 ${escapeHTML(horse?.name || '')} が1着です。</div>`
        : `<div class="result-message waiting">結果発表：1着は「${escapeHTML(winner?.name || '')}」でした。</div>`;
    } else {
      message.innerHTML = '<div class="result-message waiting">結果発表まで、みんなの予想を見ながらお待ちください。</div>';
    }
    votePanel.classList.add('hidden');
    votedPanel.classList.remove('hidden');
  }

  function renderRanking() {
    const ranking = getRanking();
    const total = totalVotes();
    const max = Math.max(1, ...ranking.map((horse) => horse.count));
    $('#total-votes').textContent = total;
    $('#top-horse').textContent = total ? ranking[0]?.name || '—' : '—';
    $('#updated-label').textContent = formatUpdated();
    $('#ranking-list').innerHTML = ranking.map((horse, index) => `
      <div class="ranking-row">
        <span class="rank-number">${index + 1}</span>
        <span class="ranking-name">${escapeHTML(horse.name)}<small>${index === 0 && total ? '現在の1番人気' : '単勝予想'}</small></span>
        <span class="bar-track"><span class="bar-fill" style="width: ${horse.count ? Math.max(7, (horse.count / max) * 100) : 0}%"></span></span>
        <span class="vote-count">${horse.count}<small>票</small></span>
      </div>`).join('');
  }

  function renderResultBox() {
    const box = $('#result-box');
    if (state.status === 'revealed' && state.winnerId) {
      const winner = getHorse(state.winnerId);
      const myVote = state.votes[currentVoterKey()];
      const hit = myVote === state.winnerId;
      box.innerHTML = `
        <p class="section-kicker">RACE RESULT</p>
        <h2>レース結果発表！</h2>
        <p>みんなが選んだ勝ち馬はこちらです。</p>
        <div class="result-winner"><span class="result-winner-icon" aria-hidden="true">🏆</span><span><strong>${escapeHTML(winner?.name || '—')}</strong><small>1着 / WINNER</small></span></div>
        ${myVote ? `<div class="hit-callout">${hit ? '🎉 あなたの予想は的中！' : '次回は的中を目指そう！'}</div>` : ''}`;
    } else {
      box.innerHTML = `
        <p class="section-kicker">RACE RESULT</p>
        <h2>結果発表を待とう</h2>
        <p>管理者が「レース結果を発表」するまで、勝ち馬は秘密です。投票は人気順で確認できます。</p>
        <div class="result-winner"><span class="result-winner-icon" aria-hidden="true">🎫</span><span><strong>Coming soon…</strong><small>RESULT NOT ANNOUNCED</small></span></div>`;
    }
  }

  function renderAdmin() {
    const loggedIn = remote.configured && !remote.fallback
      ? remote.admin
      : sessionStorage.getItem(AUTH_KEY) === 'true';
    $('#admin-login').classList.toggle('hidden', loggedIn);
    $('#admin-dashboard').classList.toggle('hidden', !loggedIn);
    if (!loggedIn) return;

    $('#setting-title').value = state.title;
    $('#admin-horse-count').textContent = state.horses.length;
    $('#admin-total-votes').textContent = totalVotes();
    const ranking = getRanking();
    $('#admin-top-horse').textContent = totalVotes() ? ranking[0]?.name || '—' : '—';
    $('#admin-status-text').textContent = state.status === 'open' ? '受付中' : state.status === 'closed' ? '受付終了' : '結果発表済み';

    const isOpen = state.status === 'open';
    const toggle = $('#toggle-open-button');
    toggle.setAttribute('aria-checked', String(isOpen));
    toggle.querySelector('b').textContent = isOpen ? '受付中' : '受付終了';

    $('#admin-horse-list').innerHTML = state.horses.map((horse, index) => `
      <div class="admin-horse-row">
        <span>${index + 1}</span>
        <input type="text" maxlength="40" value="${escapeHTML(horse.name)}" data-horse-name="${escapeHTML(horse.id)}" aria-label="${escapeHTML(horse.name)}の馬名" />
        <div class="order-actions">
          <button type="button" data-move="up" data-horse-id="${escapeHTML(horse.id)}" ${index === 0 ? 'disabled' : ''} aria-label="上へ">↑</button>
          <button type="button" data-move="down" data-horse-id="${escapeHTML(horse.id)}" ${index === state.horses.length - 1 ? 'disabled' : ''} aria-label="下へ">↓</button>
        </div>
      </div>`).join('');

    const winnerSelect = $('#winner-select');
    winnerSelect.innerHTML = state.horses.map((horse) => `<option value="${escapeHTML(horse.id)}" ${horse.id === state.winnerId ? 'selected' : ''}>${escapeHTML(horse.name)}</option>`).join('');
    $('#current-winner').textContent = state.winnerId && getHorse(state.winnerId) ? `設定中：${getHorse(state.winnerId).name}` : 'まだ結果は発表されていません';
  }

  function renderAll() {
    renderRaceMeta();
    renderNotice();
    renderHorseList();
    renderVotedPanel();
    renderRanking();
    renderResultBox();
    renderAdmin();
  }

  function navigate(viewName, updateHash = true) {
    const view = ['vote', 'results', 'admin'].includes(viewName) ? viewName : 'vote';
    $$('.view').forEach((section) => section.classList.toggle('active-view', section.id === `view-${view}`));
    $$('.nav-link').forEach((button) => button.classList.toggle('active', button.dataset.nav === view));
    if (updateHash && window.location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function showToast(message) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
  }

  function showAdminToast(message, kind = 'success') {
    const area = $('#admin-toast');
    area.innerHTML = `<div class="notice ${kind}"><span aria-hidden="true">${kind === 'success' ? '✓' : '!'}</span><span>${escapeHTML(message)}</span></div>`;
    clearTimeout(adminToastTimer);
    adminToastTimer = setTimeout(() => { area.innerHTML = ''; }, 3200);
  }

  function firebaseErrorText(error) {
    const code = error?.code || '';
    if (code.includes('auth/invalid-credential') || code.includes('auth/wrong-password') || code.includes('auth/user-not-found')) return 'メールアドレスまたはパスワードが正しくありません。';
    if (code.includes('permission-denied')) return 'Firebaseの権限設定を確認してください。Firestoreルールを公開する必要があります。';
    if (code.includes('already-exists')) return 'このブラウザではすでに投票済みです。';
    if (code.includes('unavailable') || code.includes('network')) return 'Firebaseに接続できません。通信環境を確認してください。';
    return error?.message || 'Firebaseとの通信に失敗しました。';
  }

  function racePayload(nextState) {
    const normalized = normalizeState(nextState);
    return {
      title: normalized.title,
      status: normalized.status,
      revealed: normalized.revealed,
      winnerId: normalized.winnerId,
      horses: normalized.horses,
      updatedAt: window.firebase.firestore.FieldValue.serverTimestamp(),
    };
  }

  async function saveRaceSettings(nextState, message = '') {
    const normalized = normalizeState({ ...nextState, updatedAt: Date.now() });
    if (remoteActive() && remote.admin) {
      state = normalized;
      syncLocalSnapshot(state);
      try {
        await remote.raceRef.set(racePayload(normalized), { merge: true });
        if (message) showToast(message);
      } catch (error) {
        remote.error = firebaseErrorText(error);
        renderAll();
        showAdminToast(remote.error, 'warning');
      }
      return;
    }
    if (remote.configured && !remote.fallback) {
      showAdminToast('Firebase管理者としてログインしてください', 'warning');
      return;
    }
    saveLocalState(normalized, message);
  }

  async function handleVote(event) {
    event.preventDefault();
    if (state.status !== 'open') {
      showToast('現在は投票を受け付けていません');
      return;
    }
    const key = currentVoterKey();
    if (state.votes[key]) {
      showToast('このブラウザでは投票済みです');
      return;
    }
    const selected = $('input[name="horse"]:checked');
    if (!selected) {
      showToast('1着になると思う馬を選んでください');
      $('.selection-card').animate?.([{ transform: 'translateX(-4px)' }, { transform: 'translateX(4px)' }, { transform: 'none' }], { duration: 220 });
      return;
    }
    if (remote.configured && !remote.fallback) {
      if (!remoteActive()) {
        showToast('Firebaseに接続中です。少し待ってから再度お試しください');
        return;
      }
      try {
        await remote.votesRef.doc(remote.user.uid).create({
          horseId: selected.value,
          createdAt: window.firebase.firestore.FieldValue.serverTimestamp(),
        });
        syncLocalSnapshot({ ...state, votes: { ...state.votes, [remote.user.uid]: selected.value }, updatedAt: Date.now() });
        showToast('投票を受け付けました！');
      } catch (error) {
        showToast(firebaseErrorText(error));
      }
      return;
    }
    saveLocalState({ ...state, votes: { ...state.votes, [key]: selected.value } }, '投票を受け付けました！');
  }

  async function checkAdminAccess(user) {
    if (!user || user.isAnonymous || !remote.db) return false;
    try {
      const adminDoc = await remote.db.collection('admins').doc(user.uid).get();
      return adminDoc.exists && adminDoc.data()?.enabled !== false;
    } catch (_) {
      return false;
    }
  }

  async function handleLogin(event) {
    event.preventDefault();
    const email = $('#admin-email').value.trim();
    const password = $('#admin-password').value;
    const error = $('#login-error');
    error.textContent = '';

    if (remote.configured && !remote.fallback) {
      if (!remote.auth) {
        error.textContent = 'Firebaseを初期化できていません。設定を確認してください。';
        return;
      }
      try {
        const credential = await remote.auth.signInWithEmailAndPassword(email, password);
        const allowed = await checkAdminAccess(credential.user);
        if (!allowed) {
          await remote.auth.signOut();
          throw new Error('管理者UIDが未登録です。READMEの手順でadminsを登録してください。');
        }
        remote.admin = true;
        remote.error = '';
        $('#login-form').reset();
        await ensureRemoteRace();
        renderAll();
        showAdminToast('Firebase管理者としてログインしました');
      } catch (authError) {
        error.textContent = authError.message?.startsWith('管理者UID') ? authError.message : firebaseErrorText(authError);
        remote.admin = false;
        renderAll();
      }
      return;
    }

    if (email === LEGACY_ADMIN_EMAIL && password === LEGACY_ADMIN_PASSWORD) {
      sessionStorage.setItem(AUTH_KEY, 'true');
      error.textContent = '';
      $('#login-form').reset();
      renderAdmin();
      showAdminToast('ローカルデモとしてログインしました');
    } else {
      error.textContent = 'メールアドレスまたはパスワードが正しくありません。';
    }
  }

  async function moveHorse(horseId, direction) {
    const index = state.horses.findIndex((horse) => horse.id === horseId);
    const target = direction === 'up' ? index - 1 : index + 1;
    if (index < 0 || target < 0 || target >= state.horses.length) return;
    const horses = [...state.horses];
    [horses[index], horses[target]] = [horses[target], horses[index]];
    await saveRaceSettings({ ...state, horses }, '表示順を保存しました');
    showAdminToast('表示順を保存しました');
  }

  async function resetRemoteVotes() {
    const snapshot = await remote.votesRef.get();
    let batch = remote.db.batch();
    let operationCount = 0;
    const commits = [];
    snapshot.forEach((voteDoc) => {
      batch.delete(voteDoc.ref);
      operationCount += 1;
      if (operationCount === 450) {
        commits.push(batch.commit());
        batch = remote.db.batch();
        operationCount = 0;
      }
    });
    if (operationCount > 0) commits.push(batch.commit());
    await Promise.all(commits);
  }

  async function ensureRemoteRace() {
    if (!remoteActive() || !remote.admin) return;
    const snapshot = await remote.raceRef.get();
    if (!snapshot.exists) await remote.raceRef.set(racePayload(state));
  }

  async function logout() {
    if (remote.configured && !remote.fallback && remote.auth) {
      remote.admin = false;
      await remote.auth.signOut();
      showToast('ログアウトしました');
      return;
    }
    sessionStorage.removeItem(AUTH_KEY);
    renderAdmin();
    showToast('ログアウトしました');
  }

  async function subscribeRemote() {
    if (!remoteActive()) return;
    remote.stopRace?.();
    remote.stopVotes?.();
    remote.stopRace = remote.raceRef.onSnapshot((snapshot) => {
      if (!snapshot.exists) {
        if (remote.admin) void ensureRemoteRace();
        return;
      }
      remote.error = '';
      syncLocalSnapshot({ ...state, ...snapshot.data(), votes: state.votes });
    }, (error) => {
      remote.error = firebaseErrorText(error);
      renderAll();
    });
    remote.stopVotes = remote.votesRef.onSnapshot((snapshot) => {
      const votes = {};
      snapshot.forEach((voteDoc) => {
        const horseId = voteDoc.data()?.horseId;
        if (horseId) votes[voteDoc.id] = horseId;
      });
      syncLocalSnapshot({ ...state, votes });
    }, (error) => {
      remote.error = firebaseErrorText(error);
      renderAll();
    });
  }

  async function initializeFirebase() {
    if (!remote.configured) return;
    try {
      if (!window.firebase.apps.length) window.firebase.initializeApp(window.FIREBASE_CONFIG);
      remote.auth = window.firebase.auth();
      remote.db = window.firebase.firestore();
      remote.raceRef = remote.db.collection('races').doc(REMOTE_RACE_ID);
      remote.votesRef = remote.raceRef.collection('votes');
      remote.auth.onAuthStateChanged(async (user) => {
        remote.user = user;
        remote.authReady = true;
        remote.admin = user ? await checkAdminAccess(user) : false;
        await subscribeRemote();
        renderAll();
        if (!user && !remote.signingIn) {
          remote.signingIn = true;
          try { await remote.auth.signInAnonymously(); }
          catch (error) {
            remote.fallback = true;
            remote.error = `Firebase匿名ログインに失敗しました。localStorage版で動作しています（${firebaseErrorText(error)}）`;
            renderAll();
          } finally { remote.signingIn = false; }
        }
      });
    } catch (error) {
      remote.fallback = true;
      remote.error = `Firebaseの初期化に失敗しました。localStorage版で動作しています（${firebaseErrorText(error)}）`;
      renderAll();
    }
  }

  function bindEvents() {
    document.addEventListener('click', (event) => {
      const nav = event.target.closest('[data-nav]');
      if (nav) {
        event.preventDefault();
        navigate(nav.dataset.nav);
        return;
      }
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (action === 'logout') {
        void logout();
        return;
      }
      if (action === 'toggle-theme') {
        const dark = !document.body.classList.contains('dark-mode');
        document.body.classList.toggle('dark-mode', dark);
        safeStorageSet(THEME_KEY, dark ? 'dark' : 'light');
        return;
      }
      const moveButton = event.target.closest('[data-move]');
      if (moveButton) void moveHorse(moveButton.dataset.horseId, moveButton.dataset.move);
    });

    $('#vote-form').addEventListener('submit', (event) => { void handleVote(event); });
    $('#login-form').addEventListener('submit', (event) => { void handleLogin(event); });

    $('#setting-title').addEventListener('change', (event) => {
      const title = event.target.value.trim() || '文化祭記念・芝の祭典';
      void saveRaceSettings({ ...state, title }, 'レース名を保存しました');
      showAdminToast('レース名を保存しました');
    });

    $('#toggle-open-button').addEventListener('click', () => {
      if (state.status === 'revealed') {
        showAdminToast('結果発表後は、いったん結果発表を取り消してください', 'warning');
        return;
      }
      const nextStatus = state.status === 'open' ? 'closed' : 'open';
      void saveRaceSettings({ ...state, status: nextStatus }, nextStatus === 'open' ? '投票受付を開始しました' : '投票受付を終了しました');
      showAdminToast(nextStatus === 'open' ? '投票受付を開始しました' : '投票受付を終了しました');
    });

    $('#admin-horse-list').addEventListener('change', (event) => {
      const input = event.target.closest('[data-horse-name]');
      if (!input) return;
      const horses = state.horses.map((horse) => horse.id === input.dataset.horseName
        ? { ...horse, name: input.value.trim() || horse.name }
        : horse);
      void saveRaceSettings({ ...state, horses }, '馬名を保存しました');
      showAdminToast('馬名を保存しました');
    });

    $('#winner-select').addEventListener('change', (event) => {
      void saveRaceSettings({ ...state, winnerId: event.target.value }, '勝ち馬を選択しました');
      showAdminToast('勝ち馬を選択しました');
    });

    $('#announce-button').addEventListener('click', () => {
      const winnerId = $('#winner-select').value;
      if (!winnerId) {
        showAdminToast('1着の馬を選んでください', 'warning');
        return;
      }
      if (!window.confirm('この馬を1着として結果発表しますか？')) return;
      void saveRaceSettings({ ...state, winnerId, revealed: true, status: 'revealed' }, 'レース結果を発表しました');
      showAdminToast('レース結果を発表しました');
    });

    $('#clear-result-button').addEventListener('click', () => {
      if (!state.revealed && !state.winnerId) return;
      if (!window.confirm('結果発表を取り消して、投票受付中に戻しますか？')) return;
      void saveRaceSettings({ ...state, winnerId: null, revealed: false, status: 'open' }, '結果発表を取り消しました');
      showAdminToast('結果発表を取り消しました');
    });

    $('#reset-votes-button').addEventListener('click', () => {
      if (!window.confirm('現在の投票をすべて消去します。次のレースを始めますか？')) return;
      if (remoteActive() && remote.admin) {
        void (async () => {
          try {
            await resetRemoteVotes();
            await saveRaceSettings({ ...state, votes: {}, winnerId: null, revealed: false, status: 'open' }, '投票データをリセットしました');
            showAdminToast('次のレースの受付を開始しました');
          } catch (error) {
            showAdminToast(firebaseErrorText(error), 'warning');
          }
        })();
      } else {
        saveLocalState({ ...state, votes: {}, winnerId: null, revealed: false, status: 'open' }, '投票データをリセットしました');
        showAdminToast('次のレースの受付を開始しました');
      }
    });

    window.addEventListener('storage', (event) => {
      if (event.key === STORAGE_KEY && event.newValue) {
        try {
          state = normalizeState(JSON.parse(event.newValue));
          renderAll();
          showToast('最新の投票状況に更新しました');
        } catch (_) { /* ignore malformed external state */ }
      }
    });

    if ('BroadcastChannel' in window) {
      try {
        broadcast = new BroadcastChannel(STORAGE_KEY);
        broadcast.addEventListener('message', (event) => {
          if (event.data?.type !== 'state-updated') return;
          state = normalizeState(event.data.state);
          renderAll();
        });
      } catch (_) { /* optional */ }
    }

    window.addEventListener('hashchange', () => navigate(window.location.hash.slice(1), false));
  }

  function init() {
    if (safeStorageGet(THEME_KEY) === 'dark') document.body.classList.add('dark-mode');
    bindEvents();
    renderAll();
    navigate(window.location.hash.slice(1) || 'vote', false);
    void initializeFirebase();
  }

  init();
})();
