// Mendil web panel. Plain JS, no build step. State arrives over server-sent events.
const STRINGS = {
  en: {
    passwordLabel: 'Panel password', signIn: 'Sign in', signOut: 'Sign out',
    passwordHint: "The password is in the bot's log on first start, or set it with PANEL_PASSWORD.",
    wrongPassword: "That password didn't work.", tooManyAttempts: 'Too many attempts. Try again in a few minutes.',
    nowPlaying: 'Now playing', nothingPlaying: 'Nothing is playing.',
    nothingPlayingHint: 'Request a song below, or type !play in TeamSpeak.',
    requestedBy: 'requested by {name}', live: 'live', paused: 'paused',
    skip: 'Skip', stop: 'Stop and clear the queue', pause: 'Pause', resume: 'Resume', volume: 'Volume',
    requestLabel: 'Request a song', requestPlaceholder: 'A YouTube link, a playlist, or what to search for',
    play: 'Add to queue', playNext: 'Play next', searchButton: 'Show results', add: 'Add',
    working: 'Looking it up…', searching: 'Searching…',
    added: 'Added "{title}" at position {position}.', addedNow: 'Playing "{title}".', addedMany: 'Added {count} tracks{from}.',
    from: ' from "{name}"', skippedLong: ' ({count} too long, skipped)',
    queue: 'Queue', queueEmpty: 'The queue is empty. Requests show up here as they come in.',
    queueSummary: '{count} tracks, {duration}', queueSummaryOne: '1 track, {duration}',
    loop: 'Loop', loopOff: 'Off', loopOne: 'Track', loopAll: 'Queue',
    shuffle: 'Shuffle', clear: 'Clear', clearConfirm: 'Remove all {count} tracks from the queue?',
    remove: 'Remove', log: 'Log',
    connected: 'In {channel}', connectedNoName: 'Connected', disconnected: 'Not connected', reconnecting: 'Reconnecting since {time}',
    engineClassic: 'Classic engine', engineNative: 'Native engine',
    errors: {
      empty: 'Type a link or what to search for.', queueFull: 'The queue is full.', busy: 'Mendil is busy with other requests. Try again in a moment.',
      blockedUrl: "That address is on a private network, so Mendil won't open it.",
      youtubeBlocked: 'YouTube is refusing requests from this server. See docs/youtube.md.',
      notFound: "Couldn't play that: {reason}", tooLong: 'That track is longer than the server allows.', noResults: 'Nothing found.',
      nothingPlaying: 'Nothing is playing.', notPaused: 'Nothing to resume.', queueChanged: 'The queue changed. Try again.',
      offline: "Can't reach Mendil. Is the bot running?", generic: 'That didn’t work ({error}).',
    },
  },
  tr: {
    passwordLabel: 'Panel şifresi', signIn: 'Giriş yap', signOut: 'Çıkış yap',
    passwordHint: "Şifre, ilk açılışta botun log'unda yazar; PANEL_PASSWORD ile kendin de belirleyebilirsin.",
    wrongPassword: 'Şifre yanlış.', tooManyAttempts: 'Çok fazla deneme oldu. Birkaç dakika sonra tekrar dene.',
    nowPlaying: 'Çalan', nothingPlaying: 'Şu an bir şey çalmıyor.',
    nothingPlayingHint: "Aşağıdan bir şarkı iste ya da TeamSpeak'te !çal yaz.",
    requestedBy: 'isteyen: {name}', live: 'canlı', paused: 'duraklatıldı',
    skip: 'Geç', stop: 'Durdur ve kuyruğu temizle', pause: 'Duraklat', resume: 'Devam et', volume: 'Ses',
    requestLabel: 'Şarkı iste', requestPlaceholder: 'YouTube linki, bir çalma listesi ya da aranacak şey',
    play: 'Kuyruğa ekle', playNext: 'Sıradaki yap', searchButton: 'Sonuçları göster', add: 'Ekle',
    working: 'Bakılıyor…', searching: 'Aranıyor…',
    added: '"{title}" {position}. sıraya eklendi.', addedNow: '"{title}" çalıyor.', addedMany: '{count} parça eklendi{from}.',
    from: ' ("{name}" listesinden)', skippedLong: ' ({count} tanesi çok uzun olduğu için atlandı)',
    queue: 'Kuyruk', queueEmpty: 'Kuyruk boş. İstekler geldikçe burada görünür.',
    queueSummary: '{count} parça, {duration}', queueSummaryOne: '1 parça, {duration}',
    loop: 'Tekrar', loopOff: 'Kapalı', loopOne: 'Parça', loopAll: 'Kuyruk',
    shuffle: 'Karıştır', clear: 'Temizle', clearConfirm: 'Kuyruktaki {count} parçanın hepsi silinsin mi?',
    remove: 'Kaldır', log: 'Log',
    connected: '{channel} kanalında', connectedNoName: 'Bağlı', disconnected: 'Bağlı değil', reconnecting: '{time} saatinden beri yeniden bağlanıyor',
    engineClassic: 'Classic motor', engineNative: 'Native motor',
    errors: {
      empty: 'Bir link ya da aranacak bir şey yaz.', queueFull: 'Kuyruk dolu.', busy: 'Mendil şu an başka isteklerle meşgul. Birazdan tekrar dene.',
      blockedUrl: 'Bu adres özel bir ağda, o yüzden Mendil açmıyor.',
      youtubeBlocked: "YouTube bu sunucudan gelen istekleri reddediyor. docs/youtube.md'ye bak.",
      notFound: 'Çalınamadı: {reason}', tooLong: 'Bu parça sunucunun izin verdiğinden uzun.', noResults: 'Bir şey bulunamadı.',
      nothingPlaying: 'Şu an bir şey çalmıyor.', notPaused: 'Devam ettirilecek bir şey yok.', queueChanged: 'Kuyruk değişti. Tekrar dene.',
      offline: "Mendil'e ulaşılamıyor. Bot çalışıyor mu?", generic: 'Olmadı ({error}).',
    },
  },
};

let lang = 'en';
let state = null;
let events = null;
const $ = (id) => document.getElementById(id);

function t(key, vars = {}) {
  const dict = STRINGS[lang] ?? STRINGS.en;
  const raw = key.split('.').reduce((o, k) => o?.[k], dict) ?? key.split('.').reduce((o, k) => o?.[k], STRINGS.en) ?? key;
  return raw.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}

function applyStrings() {
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll('[data-t]')) el.textContent = t(el.dataset.t);
  for (const el of document.querySelectorAll('[data-t-label]')) el.setAttribute('aria-label', t(el.dataset.tLabel));
  for (const el of document.querySelectorAll('[data-t-placeholder]')) el.placeholder = t(el.dataset.tPlaceholder);
}

function duration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '';
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function youtubeId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1, 12);
    if (/(^|\.)youtube\.com$/.test(u.hostname)) return u.searchParams.get('v');
  } catch {
    // not a URL
  }
  return null;
}

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: method === 'POST' ? { 'content-type': 'application/json', 'x-mendil': '1' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    return { ok: false, error: 'offline' };
  }
  if (res.status === 401 && path !== '/api/login') {
    showLogin();
    return { ok: false, error: 'loginRequired' };
  }
  try {
    return await res.json();
  } catch {
    return { ok: false, error: `http ${res.status}` };
  }
}

function errorText(result) {
  const key = `errors.${result.error}`;
  const text = t(key, { reason: result.reason ?? '' });
  return text === key ? t('errors.generic', { error: result.error }) : text;
}

// --- login --------------------------------------------------------------------------------

function showLogin() {
  events?.close();
  events = null;
  $('app').hidden = true;
  $('login').hidden = false;
  $('password').focus();
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  const result = await api('POST', '/api/login', { password: $('password').value });
  if (result.ok) {
    $('password').value = '';
    startApp();
  } else {
    $('login-error').textContent = t(result.error === 'tooManyAttempts' ? 'tooManyAttempts' : result.error === 'offline' ? 'errors.offline' : 'wrongPassword');
  }
});

$('logout').addEventListener('click', async () => {
  await api('POST', '/api/logout');
  showLogin();
});

// --- rendering ----------------------------------------------------------------------------

function renderStatus(s) {
  const status = $('status');
  status.classList.toggle('is-connected', s.connected);
  $('status-text').textContent = s.connected
    ? (s.channelName ? t('connected', { channel: s.channelName }) : t('connectedNoName'))
    : s.disconnectedSince ? t('reconnecting', { time: new Date(s.disconnectedSince).toLocaleTimeString(lang) }) : t('disconnected');
  $('engine').textContent = t(s.engine === 'native' ? 'engineNative' : 'engineClassic');
  $('nickname').textContent = s.nickname;
  document.title = s.current ? `${s.current.title} · ${s.nickname}` : s.nickname;
}

function renderNow(s) {
  const c = s.current;
  $('now-empty').hidden = Boolean(c);
  $('now-track').hidden = !c;
  const pp = $('playpause');
  pp.classList.toggle('is-paused', s.paused);
  pp.setAttribute('aria-label', t(s.paused ? 'resume' : 'pause'));
  pp.disabled = !c && s.queue.length === 0;
  $('skip').disabled = !c;
  $('stop').disabled = !c && s.queue.length === 0;
  if (document.activeElement !== $('volume')) {
    $('volume').value = s.volume;
    $('volume-value').textContent = s.volume;
  }
  if (!c) return;

  const title = $('now-title');
  if (title.textContent !== c.title) title.textContent = c.title;
  title.href = c.url;
  $('now-by').textContent = [c.requestedBy && t('requestedBy', { name: c.requestedBy }), s.paused && t('paused')].filter(Boolean).join(', ');
  const id = youtubeId(c.url);
  const thumb = $('thumb');
  if (id) {
    const src = `https://i.ytimg.com/vi/${encodeURIComponent(id)}/mqdefault.jpg`;
    if (thumb.getAttribute('src') !== src) thumb.src = src;
    thumb.hidden = false;
  } else {
    thumb.hidden = true;
  }
  $('elapsed').textContent = duration(c.position);
  $('length').textContent = c.isLive ? t('live') : duration(c.duration);
  const pct = c.duration ? Math.min(100, (c.position / c.duration) * 100) : 0;
  $('progress-bar').style.width = `${pct}%`;
}

function renderQueue(s) {
  const list = $('slips');
  const keys = s.queue.map((q, i) => `${i}|${q.url}`).join('\n');
  if (list.dataset.keys !== keys) {
    list.dataset.keys = keys;
    list.replaceChildren(...s.queue.map((q, i) => slip(q, i + 1)));
  }
  $('queue-empty').hidden = s.queue.length > 0;
  const total = s.queue.reduce((sum, q) => sum + (q.duration || 0), 0);
  $('queue-summary').textContent = s.queue.length
    ? t(s.queue.length === 1 ? 'queueSummaryOne' : 'queueSummary', { count: s.queue.length, duration: duration(total) })
    : '';
  $('shuffle').disabled = s.queue.length < 2;
  $('clear').disabled = s.queue.length === 0;
  for (const b of document.querySelectorAll('[data-loop]')) b.setAttribute('aria-checked', String(b.dataset.loop === s.loop));
}

function slip(q, position) {
  const li = document.createElement('li');
  li.className = 'napkin slip';
  const pos = document.createElement('span');
  pos.className = 'pos';
  pos.textContent = position;
  const title = document.createElement('a');
  title.className = 'title';
  title.href = q.url;
  title.target = '_blank';
  title.rel = 'noopener noreferrer';
  title.textContent = q.title;
  const meta = document.createElement('div');
  meta.className = 'meta';
  if (q.requestedBy) {
    const by = document.createElement('p');
    by.className = 'by';
    by.textContent = t('requestedBy', { name: q.requestedBy });
    meta.append(by);
  }
  const len = document.createElement('span');
  len.className = 'len';
  len.textContent = q.isLive ? t('live') : duration(q.duration);
  meta.append(len);
  const remove = document.createElement('button');
  remove.className = 'remove';
  remove.type = 'button';
  remove.textContent = '✕';
  remove.setAttribute('aria-label', `${t('remove')}: ${q.title}`);
  remove.addEventListener('click', async () => {
    remove.disabled = true;
    const result = await api('POST', '/api/remove', { index: position, url: q.url });
    if (!result.ok) showResult(errorText(result), true);
  });
  li.append(pos, title, remove, meta);
  return li;
}

function render(s) {
  state = s;
  if (s.lang && s.lang !== lang && STRINGS[s.lang]) {
    lang = s.lang;
    applyStrings();
  }
  renderStatus(s);
  renderNow(s);
  renderQueue(s);
}

// --- controls -----------------------------------------------------------------------------

$('playpause').addEventListener('click', () => api('POST', state?.paused || !state?.current ? '/api/resume' : '/api/pause'));
$('skip').addEventListener('click', () => api('POST', '/api/skip'));
$('stop').addEventListener('click', () => api('POST', '/api/stop'));
$('shuffle').addEventListener('click', () => api('POST', '/api/shuffle'));
$('clear').addEventListener('click', () => {
  if (state && window.confirm(t('clearConfirm', { count: state.queue.length }))) api('POST', '/api/clear');
});
for (const b of document.querySelectorAll('[data-loop]')) {
  b.addEventListener('click', () => api('POST', '/api/loop', { mode: b.dataset.loop }));
}

let volumeTimer = null;
$('volume').addEventListener('input', (e) => {
  $('volume-value').textContent = e.target.value;
  clearTimeout(volumeTimer);
  volumeTimer = setTimeout(() => api('POST', '/api/volume', { volume: Number(e.target.value) }), 250);
});

function showResult(text, isError = false) {
  const el = $('request-result');
  el.textContent = text;
  el.classList.toggle('is-error', isError);
}

async function requestSong(query, next) {
  if (!query.trim()) return showResult(t('errors.empty'), true);
  showResult(t('working'));
  const wasIdle = !state?.current;
  const result = await api('POST', '/api/play', { query, next });
  if (!result.ok) return showResult(errorText(result), true);
  $('query').value = '';
  $('results').hidden = true;
  const skipped = result.tooLong ? t('skippedLong', { count: result.tooLong }) : '';
  if (result.added.length > 1) {
    const from = result.playlistTitle ? t('from', { name: result.playlistTitle }) : '';
    return showResult(t('addedMany', { count: result.added.length, from }) + skipped);
  }
  return showResult(wasIdle ? t('addedNow', { title: result.added[0] }) : t('added', { title: result.added[0], position: result.position }));
}

$('request-form').addEventListener('submit', (e) => {
  e.preventDefault();
  requestSong($('query').value, false);
});
$('play-next').addEventListener('click', () => requestSong($('query').value, true));

$('search').addEventListener('click', async () => {
  const query = $('query').value.trim();
  if (!query) return showResult(t('errors.empty'), true);
  showResult(t('searching'));
  const result = await api('POST', '/api/search', { query });
  if (!result.ok) return showResult(errorText(result), true);
  showResult(result.results.length ? '' : t('errors.noResults'), !result.results.length);
  const list = $('results');
  list.replaceChildren(...result.results.map((r) => {
    const li = document.createElement('li');
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = r.title;
    const len = document.createElement('span');
    len.className = 'len';
    len.textContent = r.isLive ? t('live') : duration(r.duration);
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'btn small';
    add.textContent = t('add');
    add.addEventListener('click', () => requestSong(r.url, false));
    li.append(title, len, add);
    return li;
  }));
  list.hidden = result.results.length === 0;
});

// --- log ----------------------------------------------------------------------------------

function logLine(entry) {
  const li = document.createElement('li');
  li.className = entry.level;
  const time = document.createElement('time');
  time.dateTime = entry.at;
  time.textContent = new Date(entry.at).toLocaleTimeString(lang);
  li.append(time, ` ${entry.level.toUpperCase()} [${entry.scope}] ${entry.text}`);
  return li;
}

function appendLog(entry) {
  const list = $('log-lines');
  const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 8;
  list.append(logLine(entry));
  while (list.children.length > 500) list.firstChild.remove();
  if (atBottom) list.scrollTop = list.scrollHeight;
}

$('logs').addEventListener('toggle', async () => {
  if (!$('logs').open) return;
  const lines = await api('GET', '/api/logs');
  if (!Array.isArray(lines)) return;
  const list = $('log-lines');
  list.replaceChildren(...lines.map(logLine));
  list.scrollTop = list.scrollHeight;
});

// --- start --------------------------------------------------------------------------------

function connectEvents() {
  events?.close();
  events = new EventSource('/api/events');
  events.addEventListener('state', (e) => render(JSON.parse(e.data)));
  events.addEventListener('log', (e) => {
    if ($('logs').open) appendLog(JSON.parse(e.data));
  });
  events.onerror = async () => {
    // EventSource retries by itself; only step in when the session is gone.
    const session = await api('GET', '/api/session');
    if (session.loggedIn === false) showLogin();
  };
}

function startApp() {
  $('login').hidden = true;
  $('app').hidden = false;
  connectEvents();
}

(async () => {
  const session = await api('GET', '/api/session');
  if (session.lang && STRINGS[session.lang]) lang = session.lang;
  applyStrings();
  if (session.loggedIn) startApp();
  else showLogin();
})();
