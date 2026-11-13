// Mendil web panel: the queue as a radio running order. Plain JS, no build step; state over SSE.
const STRINGS = {
  en: {
    passwordLabel: 'Panel password', signIn: 'Sign in', signOut: 'Sign out',
    passwordHint: "The password is in the bot's log on first start, or set it with PANEL_PASSWORD.",
    wrongPassword: "That password didn't work.", tooManyAttempts: 'Too many attempts. Try again in a few minutes.',
    nicknameLabel: 'Your TeamSpeak nickname', sendCode: 'Send me a code',
    sendCodeHint: 'Mendil sends the code to you in a private TeamSpeak message. You need to be on the server.',
    codeLabel: 'The code Mendil sent {name}', otherNickname: 'Use a different nickname',
    usePassword: 'Sign in with the panel password', useTeamspeak: 'Sign in with TeamSpeak',
    teamspeakOfflineHint: "Mendil isn't connected to TeamSpeak right now, so only the panel password works.",
    signedInAs: 'Signed in as {name}',
    lampOn: 'ON AIR', lampPaused: 'PAUSED', lampOff: 'OFF AIR', lampOffline: 'NO SIGNAL',
    nothingPlaying: 'Nothing on air', requestedBy: 'requested by {name}', live: 'live', left: '{time} left',
    pause: 'Pause', resume: 'Resume', start: 'Start', skip: 'Skip', stop: 'Stop', volume: 'Volume',
    runningOrder: 'Running order', colTime: 'Airs', colTrack: 'Track', colLength: 'Length', colBy: 'Requested by',
    tracks: '{count} tracks', track: '1 track', total: 'total {duration}', ends: 'ends {time}',
    shuffle: 'Shuffle', clear: 'Clear', clearConfirm: 'Remove all {count} tracks from the running order?', remove: 'Remove',
    queueEmpty: 'Nothing scheduled. Requests from the panel and from TeamSpeak chat land here.',
    requestLabel: 'Request a song', requestPlaceholder: 'YouTube or Spotify link, or song name',
    play: 'Add to queue', playNext: 'Play next', searchButton: 'Search', add: 'Add',
    working: 'Looking it up…', searching: 'Searching…',
    added: 'Added "{title}". It airs around {time}.', addedAt: 'Added "{title}" at position {position}.',
    addedNow: '"{title}" is going on air.', addedMany: 'Added {count} tracks{from}.',
    from: ' from "{name}"', skippedLong: ' ({count} too long, skipped)',
    loop: 'Repeat', loopOff: 'Off', loopOne: 'Track', loopAll: 'Queue',
    log: 'Log', logMore: 'Show more', logLess: 'Show less',
    connected: 'In {channel}', connectedNoName: 'Connected', disconnected: 'Not connected', reconnecting: 'Reconnecting since {time}',
    engineClassic: 'Classic engine', engineNative: 'Native engine', halted: 'Playback stopped after repeated errors. Resume to try again.',
    errors: {
      empty: 'Type a link or what to search for.', queueFull: 'The queue is full.', busy: 'Mendil is busy with other requests. Try again in a moment.',
      blockedUrl: "That address is on a private network, so Mendil won't open it.",
      youtubeBlocked: 'YouTube is refusing requests from this server. See docs/youtube.md.',
      notFound: "Couldn't play that: {reason}", tooLong: 'That track is longer than the server allows.', noResults: 'Nothing found.',
      nothingPlaying: 'Nothing is on air.', notPaused: 'Nothing to resume.', queueChanged: 'The running order changed. Try again.',
      offline: "Can't reach Mendil. Is the bot running?", generic: "That didn't work ({error}).",
      adminOnly: 'Only admins can do that.', notYours: 'You can only skip or remove songs you requested.',
      notOnline: "Nobody with that nickname is on the server. Check the spelling, or join first.",
      notAllowed: "You're not allowed to use this bot.", codeRecentlySent: 'A code was sent a moment ago. Check your TeamSpeak chat, or wait half a minute.',
      wrongCode: "That code didn't match.", codeExpired: 'That code has expired. Ask for a new one.',
      teamspeakOffline: "Mendil isn't connected to TeamSpeak right now. Use the panel password.",
    },
  },
  tr: {
    passwordLabel: 'Panel şifresi', signIn: 'Giriş yap', signOut: 'Çıkış yap',
    passwordHint: "Şifre, ilk açılışta botun log'unda yazar; PANEL_PASSWORD ile kendin de belirleyebilirsin.",
    wrongPassword: 'Şifre yanlış.', tooManyAttempts: 'Çok fazla deneme oldu. Birkaç dakika sonra tekrar dene.',
    nicknameLabel: 'TeamSpeak takma adın', sendCode: 'Bana kod gönder',
    sendCodeHint: 'Mendil kodu sana TeamSpeak üzerinden özel mesajla gönderir. Sunucuda olman gerekiyor.',
    codeLabel: "Mendil'in {name} için gönderdiği kod", otherNickname: 'Başka bir takma ad kullan',
    usePassword: 'Panel şifresiyle giriş yap', useTeamspeak: 'TeamSpeak ile giriş yap',
    teamspeakOfflineHint: "Mendil şu an TeamSpeak'e bağlı değil, o yüzden sadece panel şifresiyle girilebilir.",
    signedInAs: '{name} olarak giriş yapıldı',
    lampOn: 'YAYINDA', lampPaused: 'DURDU', lampOff: 'YAYIN DIŞI', lampOffline: 'SİNYAL YOK',
    nothingPlaying: 'Yayında bir şey yok', requestedBy: 'isteyen: {name}', live: 'canlı', left: 'kalan {time}',
    pause: 'Duraklat', resume: 'Devam et', start: 'Başlat', skip: 'Geç', stop: 'Durdur', volume: 'Ses',
    runningOrder: 'Yayın akışı', colTime: 'Saat', colTrack: 'Şarkı', colLength: 'Süre', colBy: 'İsteyen',
    tracks: '{count} parça', track: '1 parça', total: 'toplam {duration}', ends: 'bitiş {time}',
    shuffle: 'Karıştır', clear: 'Temizle', clearConfirm: 'Yayın akışındaki {count} parçanın hepsi silinsin mi?', remove: 'Kaldır',
    queueEmpty: 'Akışta bir şey yok. Panelden ve TeamSpeak sohbetinden gelen istekler buraya düşer.',
    requestLabel: 'Şarkı iste', requestPlaceholder: 'YouTube ya da Spotify linki, veya şarkı adı',
    play: 'Kuyruğa ekle', playNext: 'Sıradaki yap', searchButton: 'Ara', add: 'Ekle',
    working: 'Bakılıyor…', searching: 'Aranıyor…',
    added: '"{title}" eklendi, {time} civarı yayında.', addedAt: '"{title}" {position}. sıraya eklendi.',
    addedNow: '"{title}" yayına giriyor.', addedMany: '{count} parça eklendi{from}.',
    from: ' ("{name}" listesinden)', skippedLong: ' ({count} tanesi çok uzun olduğu için atlandı)',
    loop: 'Tekrar', loopOff: 'Kapalı', loopOne: 'Parça', loopAll: 'Kuyruk',
    log: 'Log', logMore: 'Daha fazla', logLess: 'Daha az',
    connected: '{channel} kanalında', connectedNoName: 'Bağlı', disconnected: 'Bağlı değil', reconnecting: '{time} saatinden beri yeniden bağlanıyor',
    engineClassic: 'Classic motor', engineNative: 'Native motor', halted: 'Art arda hata olduğu için çalma durdu. Tekrar denemek için Devam et.',
    errors: {
      empty: 'Bir link ya da aranacak bir şey yaz.', queueFull: 'Kuyruk dolu.', busy: 'Mendil şu an başka isteklerle meşgul. Birazdan tekrar dene.',
      blockedUrl: 'Bu adres özel bir ağda, o yüzden Mendil açmıyor.',
      youtubeBlocked: "YouTube bu sunucudan gelen istekleri reddediyor. docs/youtube.md'ye bak.",
      notFound: 'Çalınamadı: {reason}', tooLong: 'Bu parça sunucunun izin verdiğinden uzun.', noResults: 'Bir şey bulunamadı.',
      nothingPlaying: 'Yayında bir şey yok.', notPaused: 'Devam ettirilecek bir şey yok.', queueChanged: 'Yayın akışı değişti. Tekrar dene.',
      offline: "Mendil'e ulaşılamıyor. Bot çalışıyor mu?", generic: 'Olmadı ({error}).',
      adminOnly: 'Bunu sadece yöneticiler yapabilir.', notYours: 'Sadece kendi istediğin şarkıları geçebilir veya silebilirsin.',
      notOnline: 'Sunucuda bu takma adla kimse yok. Yazımı kontrol et ya da önce sunucuya gir.',
      notAllowed: 'Bu botu kullanma yetkin yok.', codeRecentlySent: 'Az önce bir kod gönderildi. TeamSpeak sohbetine bak ya da yarım dakika bekle.',
      wrongCode: 'Kod tutmadı.', codeExpired: 'Bu kodun süresi doldu. Yenisini iste.',
      teamspeakOffline: "Mendil şu an TeamSpeak'e bağlı değil. Panel şifresini kullan.",
    },
  },
};

let lang = 'en';
let state = null;
let me = null; // { via, uid, name, role } from /api/session
const isAdmin = () => me?.role === 'admin';
const isMine = (track) => Boolean(track?.requesterUid) && track.requesterUid === me?.uid;
let events = null;
let lastTitle = null;
const $ = (id) => document.getElementById(id);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function t(key, vars = {}) {
  const pick = (dict) => key.split('.').reduce((o, k) => o?.[k], dict);
  const raw = pick(STRINGS[lang] ?? STRINGS.en) ?? pick(STRINGS.en) ?? key;
  return raw.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}

function applyStrings() {
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll('[data-t]')) el.textContent = t(el.dataset.t);
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

const clock = (date) => date.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });

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

/** When each queued track should air: now + what's left of the current one + everything before it. */
function airTimes(s) {
  const times = [];
  let at = Date.now();
  if (s.current) {
    const left = s.current.isLive || !Number.isFinite(s.current.duration) ? NaN : s.current.duration - s.current.position;
    at += left * 1000;
  }
  for (const q of s.queue) {
    times.push(Number.isFinite(at) ? new Date(at) : null);
    at += (q.isLive || !Number.isFinite(q.duration) ? NaN : q.duration) * 1000;
  }
  return { times, end: Number.isFinite(at) ? new Date(at) : null };
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
  if (res.status === 401 && !path.startsWith('/api/login')) {
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

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

// --- login ----------------------------------------------------------------------------------

let loginMode = 'teamspeak'; // or 'password'
let pendingId = null;

function showLoginStep(step) {
  for (const id of ['ts-form', 'code-form', 'login-form']) $(id).hidden = id !== step;
  $('login-switch').textContent = t(step === 'login-form' ? 'useTeamspeak' : 'usePassword');
  $('login-switch').hidden = step === 'code-form';
  $({ 'ts-form': 'ts-nickname', 'code-form': 'ts-code', 'login-form': 'password' }[step]).focus();
}

function loginError(result) {
  const key = result.error === 'tooManyAttempts' ? 'tooManyAttempts' : result.error === 'wrongPassword' ? 'wrongPassword' : null;
  $('login-error').textContent = key ? t(key) : errorText(result);
}

async function showLogin() {
  events?.close();
  events = null;
  me = null;
  $('app').hidden = true;
  $('login').hidden = false;
  $('login-error').textContent = '';
  const session = await api('GET', '/api/session');
  // Without a TeamSpeak connection nobody can receive a code; offer the password straight away.
  const teamspeak = session.teamspeak !== false;
  $('login-offline').hidden = teamspeak;
  showLoginStep(loginMode === 'password' || !teamspeak ? 'login-form' : 'ts-form');
}

$('login-switch').addEventListener('click', () => {
  $('login-error').textContent = '';
  loginMode = $('login-form').hidden ? 'password' : 'teamspeak';
  showLoginStep(loginMode === 'password' ? 'login-form' : 'ts-form');
});

$('ts-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  const button = e.submitter ?? $('ts-form').querySelector('button');
  button.disabled = true;
  const result = await api('POST', '/api/login/code', { nickname: $('ts-nickname').value.trim() });
  button.disabled = false;
  if (!result.ok) return loginError(result);
  pendingId = result.id;
  $('code-label').textContent = t('codeLabel', { name: result.name });
  $('ts-code').value = '';
  showLoginStep('code-form');
  return undefined;
});

$('code-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  const result = await api('POST', '/api/login/verify', { id: pendingId, code: $('ts-code').value });
  if (result.ok) {
    pendingId = null;
    return startApp();
  }
  loginError(result);
  if (result.error === 'codeExpired') showLoginStep('ts-form');
  return undefined;
});

$('code-back').addEventListener('click', () => {
  $('login-error').textContent = '';
  showLoginStep('ts-form');
});

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  const result = await api('POST', '/api/login', { password: $('password').value });
  if (!result.ok) return loginError(result);
  $('password').value = '';
  return startApp();
});

$('logout').addEventListener('click', async () => {
  await api('POST', '/api/logout');
  showLogin();
});

// --- rendering ------------------------------------------------------------------------------

function renderBar(s) {
  $('status').classList.toggle('is-connected', s.connected);
  $('status-text').textContent = s.connected
    ? (s.channelName ? t('connected', { channel: s.channelName }) : t('connectedNoName'))
    : s.disconnectedSince ? t('reconnecting', { time: clock(new Date(s.disconnectedSince)) }) : t('disconnected');
  $('engine').textContent = t(s.engine === 'native' ? 'engineNative' : 'engineClassic');
  $('nickname').textContent = s.nickname;
  document.title = s.current ? `${s.current.title} · ${s.nickname}` : s.nickname;
}

function renderOnAir(s) {
  const c = s.current;
  const lamp = $('lamp');
  const lampState = !s.connected ? 'offline' : !c ? 'off' : s.paused ? 'paused' : 'on';
  lamp.dataset.state = lampState;
  const strip = lamp.closest('.onair');
  strip.dataset.state = lampState;
  strip.classList.toggle('has-track', Boolean(c));
  $('lamp-text').textContent = t({ on: 'lampOn', paused: 'lampPaused', off: 'lampOff', offline: 'lampOffline' }[lampState]);

  const link = $('now-link');
  $('now-empty').hidden = Boolean(c);
  link.hidden = !c;
  if (c && c.title !== lastTitle) {
    link.textContent = c.title;
    const title = $('now-title');
    if (lastTitle !== null && !reducedMotion.matches) {
      title.classList.remove('is-entering');
      void title.offsetWidth; // restart the animation
      title.classList.add('is-entering');
    }
  }
  lastTitle = c ? c.title : '';
  if (c) link.href = c.url;

  $('now-by').textContent = c?.requestedBy ? t('requestedBy', { name: c.requestedBy }) : '';
  $('now-time').textContent = c ? `${duration(c.position)} / ${c.isLive ? t('live') : duration(c.duration)}` : '';
  // Back-timing, as a studio reads it: how long until the next item airs.
  $('now-left').textContent = c && !c.isLive && Number.isFinite(c.duration) ? t('left', { time: duration(c.duration - c.position) }) : '';
  const pct = c?.duration ? Math.min(100, (c.position / c.duration) * 100) : 0;
  $('progress-bar').style.width = `${pct}%`;

  const id = c ? youtubeId(c.url) : null;
  const thumb = $('thumb');
  if (id) {
    const src = `https://i.ytimg.com/vi/${encodeURIComponent(id)}/mqdefault.jpg`;
    if (thumb.getAttribute('src') !== src) thumb.src = src;
  }
  thumb.hidden = !id;

  $('playpause-icon').setAttribute('href', !c || s.paused ? '#i-play' : '#i-pause');
  $('playpause-label').textContent = t(!c ? 'start' : s.paused ? 'resume' : 'pause');
  $('playpause').disabled = !c && s.queue.length === 0;
  $('skip').disabled = !c || !(isAdmin() || isMine(c));
  $('stop').disabled = !c && s.queue.length === 0;
  if (document.activeElement !== $('volume')) {
    $('volume').value = s.volume;
    $('volume-value').textContent = s.volume;
  }
}

function renderOrder(s) {
  const { times, end } = airTimes(s);
  const body = $('order');
  const keys = `${me?.role}|${me?.uid}\n${s.queue.map((q, i) => `${i}|${q.url}`).join('\n')}`;
  if (body.dataset.keys !== keys) {
    const before = rowPositions(body);
    body.dataset.keys = keys;
    const seen = new Map();
    body.replaceChildren(...s.queue.map((q, i) => {
      const n = (seen.get(q.url) ?? 0) + 1;
      seen.set(q.url, n);
      return row(q, i + 1, `${q.url}#${n}`);
    }));
    animateRows(body, before);
  }
  // Air times move every second; update them in place.
  [...body.children].forEach((tr, i) => {
    const cell = tr.querySelector('.c-time');
    const time = times[i];
    cell.textContent = time ? clock(time) : '—';
    cell.classList.toggle('is-unknown', !time);
  });

  $('order-empty').hidden = s.queue.length > 0;
  const summary = $('schedule-summary');
  if (s.queue.length) {
    const total = s.queue.reduce((sum, q) => sum + (q.duration || 0), 0);
    const parts = [
      t(s.queue.length === 1 ? 'track' : 'tracks', { count: s.queue.length }),
      t('total', { duration: duration(total) }),
    ];
    if (end) parts.push(t('ends', { time: clock(end) }));
    summary.replaceChildren(...parts.map((p) => Object.assign(document.createElement('span'), { textContent: p })));
  } else {
    summary.replaceChildren();
  }
  $('shuffle').disabled = s.queue.length < 2;
  $('clear').disabled = s.queue.length === 0;
  for (const b of document.querySelectorAll('[data-loop]')) b.setAttribute('aria-checked', String(b.dataset.loop === s.loop));
}

function row(q, position, key) {
  const tr = document.createElement('tr');
  tr.dataset.key = key;
  const cell = (cls) => Object.assign(document.createElement('td'), { className: cls });
  const time = cell('c-time');
  const track = cell('c-track');
  const title = Object.assign(document.createElement('a'), { className: 'title', href: q.url, target: '_blank', rel: 'noopener noreferrer', textContent: q.title });
  track.append(title);
  const len = cell('c-len');
  len.textContent = q.isLive ? t('live') : duration(q.duration);
  const by = cell('c-by');
  by.textContent = q.requestedBy ?? '';
  const x = cell('c-x');
  const remove = Object.assign(document.createElement('button'), { className: 'remove', type: 'button' });
  remove.setAttribute('aria-label', `${t('remove')}: ${q.title}`);
  remove.append(icon('remove'));
  remove.hidden = !(isAdmin() || isMine(q));
  tr.classList.toggle('is-mine', isMine(q));
  remove.addEventListener('click', async () => {
    remove.disabled = true;
    const result = await api('POST', '/api/remove', { index: position, url: q.url });
    if (!result.ok) {
      remove.disabled = false;
      showResult(errorText(result), true);
    }
  });
  x.append(remove);
  tr.append(time, track, len, by, x);
  return tr;
}

// The one moving part: when the running order changes, rows slide to their new slot.
function rowPositions(body) {
  return new Map([...body.children].map((tr) => [tr.dataset.key, tr.getBoundingClientRect().top]));
}

function animateRows(body, before) {
  if (reducedMotion.matches || before.size === 0) return;
  for (const tr of body.children) {
    const old = before.get(tr.dataset.key);
    if (old === undefined) continue;
    const delta = old - tr.getBoundingClientRect().top;
    if (!delta) continue;
    tr.animate([{ transform: `translateY(${delta}px)` }, { transform: 'none' }], { duration: 420, easing: 'cubic-bezier(.16, 1, .3, 1)' });
  }
}

function render(s) {
  state = s;
  if (s.lang && s.lang !== lang && STRINGS[s.lang]) {
    lang = s.lang;
    applyStrings();
  }
  renderBar(s);
  renderOnAir(s);
  renderOrder(s);
  if (s.halted && !$('request-result').textContent) showResult(t('halted'), true);
}

// --- controls -------------------------------------------------------------------------------

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

function showResult(text, kind = false) {
  const el = $('request-result');
  el.textContent = text;
  el.classList.toggle('is-error', kind === true);
  el.classList.toggle('is-working', kind === 'working');
}

function busy(on) {
  for (const id of ['add', 'play-next', 'search']) $(id).disabled = on;
}

async function requestSong(query, next) {
  if (!query.trim()) return showResult(t('errors.empty'), true);
  showResult(t('working'), 'working');
  busy(true);
  const wasIdle = !state?.current;
  const result = await api('POST', '/api/play', { query, next });
  busy(false);
  if (!result.ok) return showResult(errorText(result), true);
  $('query').value = '';
  $('results').hidden = true;
  const skipped = result.tooLong ? t('skippedLong', { count: result.tooLong }) : '';
  if (result.added.length > 1) {
    const from = result.playlistTitle ? t('from', { name: result.playlistTitle }) : '';
    return showResult(t('addedMany', { count: result.added.length, from }) + skipped);
  }
  const title = result.added[0];
  if (wasIdle) return showResult(t('addedNow', { title }));
  // Tell people when it airs; the next state update has the new running order.
  setTimeout(() => {
    const idx = (result.position ?? 1) - 1;
    const time = state ? airTimes(state).times[idx] : null;
    showResult(time ? t('added', { title, time: clock(time) }) : t('addedAt', { title, position: result.position }));
  }, 400);
  return undefined;
}

$('request-form').addEventListener('submit', (e) => {
  e.preventDefault();
  requestSong($('query').value, false);
});
$('play-next').addEventListener('click', () => requestSong($('query').value, true));

$('search').addEventListener('click', async () => {
  const query = $('query').value.trim();
  if (!query) return showResult(t('errors.empty'), true);
  showResult(t('searching'), 'working');
  busy(true);
  const result = await api('POST', '/api/search', { query });
  busy(false);
  if (!result.ok) return showResult(errorText(result), true);
  showResult(result.results.length ? '' : t('errors.noResults'), !result.results.length);
  const list = $('results');
  list.replaceChildren(...result.results.map((r) => {
    const li = document.createElement('li');
    const title = Object.assign(document.createElement('span'), { className: 'title', textContent: r.title });
    const len = Object.assign(document.createElement('span'), { className: 'len', textContent: r.isLive ? t('live') : duration(r.duration) });
    const add = Object.assign(document.createElement('button'), { type: 'button', className: 'btn small' });
    add.append(icon('add'), Object.assign(document.createElement('span'), { textContent: t('add') }));
    add.setAttribute('aria-label', `${t('add')}: ${r.title}`);
    add.addEventListener('click', () => requestSong(r.url, false));
    li.append(title, len, add);
    return li;
  }));
  list.hidden = result.results.length === 0;
  return undefined;
});

// --- log ------------------------------------------------------------------------------------

function logLine(entry) {
  const li = document.createElement('li');
  li.className = entry.level;
  const time = document.createElement('time');
  time.dateTime = entry.at;
  time.textContent = new Date(entry.at).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  li.append(time, ` ${entry.text}`);
  return li;
}

function scrollLogToEnd() {
  const list = $('log-lines');
  list.scrollTop = list.scrollHeight;
}

function appendLog(entry) {
  const list = $('log-lines');
  const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 8;
  list.append(logLine(entry));
  while (list.children.length > 300) list.firstChild.remove();
  if (atBottom || !$('log-lines').closest('.log').classList.contains('is-open')) scrollLogToEnd();
}

$('log-toggle').addEventListener('click', () => {
  const panel = $('log-lines').closest('.log');
  const open = panel.classList.toggle('is-open');
  $('log-toggle').setAttribute('aria-expanded', String(open));
  $('log-toggle').textContent = t(open ? 'logLess' : 'logMore');
  scrollLogToEnd();
});

async function loadLog() {
  const lines = await api('GET', '/api/logs');
  if (!Array.isArray(lines)) return;
  $('log-lines').replaceChildren(...lines.slice(-300).map(logLine));
  scrollLogToEnd();
}

// --- start ----------------------------------------------------------------------------------

function connectEvents() {
  events?.close();
  events = new EventSource('/api/events');
  events.addEventListener('state', (e) => render(JSON.parse(e.data)));
  events.addEventListener('log', (e) => appendLog(JSON.parse(e.data)));
  events.onerror = async () => {
    // EventSource retries by itself; only step in when the session is gone.
    const session = await api('GET', '/api/session');
    if (session.loggedIn === false) showLogin();
  };
}

// The station clock: air times read against it.
const narrow = window.matchMedia('(max-width: 480px)');
function tickClock() {
  const now = new Date();
  $('clock').dateTime = now.toISOString();
  // Seconds add nothing at a glance on a phone, and the bar needs the room for the name.
  const opts = narrow.matches ? { hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit', second: '2-digit' };
  $('clock').textContent = now.toLocaleTimeString(lang, opts);
}
setInterval(tickClock, 1000);

/** Admin-only controls are hidden for listeners; the server enforces the same rules. */
function applyRole() {
  for (const el of document.querySelectorAll('[data-admin]')) el.hidden = !isAdmin();
  $('me').hidden = !me?.name;
  $('me').textContent = me?.name ?? '';
  $('logout').title = me?.name ? t('signedInAs', { name: me.name }) : '';
}

async function startApp(session) {
  session ??= await api('GET', '/api/session');
  if (!session.loggedIn) return showLogin();
  me = session.user;
  applyRole();
  tickClock();
  $('login').hidden = true;
  $('app').hidden = false;
  connectEvents();
  if (isAdmin()) loadLog();
  return undefined;
}

(async () => {
  const session = await api('GET', '/api/session');
  if (session.lang && STRINGS[session.lang]) lang = session.lang;
  applyStrings();
  if (session.loggedIn) startApp(session);
  else showLogin();
})();
