'use strict';

const $ = (selector) => document.querySelector(selector);
const screens = ['home-screen', 'lobby-screen', 'game-screen', 'reveal-screen'];
const avatarSet = ['🦊', '🐸', '🐙', '🐻', '🐼', '🦄', '🐧', '🐯', '🐵', '🐨', '🐳', '🦖'];
const modeDescriptions = {
  classic: 'Una frase, un disegno, una nuova frase… il telefono senza fili più caotico che ci sia.',
  draw: 'Tutti disegnano: ogni artista riceve il disegno precedente e lo reinterpreta a modo suo.',
  phrase: 'Solo parole! La storia passa di mano in mano e diventa sempre più assurda.',
  sprint: 'La modalità classica, ma con soli 40 secondi a turno. Niente ripensamenti!',
  chaos: 'Telefono senza fili + imprevisti: a ogni turno una regola-jolly diversa da rispettare. Il caos è garantito!',
  emoji: 'Una storia fatta solo di emoji: ogni giocatore interpreta i simboli e aggiunge esattamente 5 emoji. Zero parole, fantasia al massimo!'
};
let socket = null;
let pendingAction = null;
let currentState = null;
let toastTimeout = null;
let activeTaskStamp = null;
let timerInterval = null;
let timerRemaining = 0;
let timerTotal = 0;
let undoStack = [];
let strokeLog = [];
let activeStroke = null;
let replayFrameHandle = null;
let resultView = 'album';
let resultBookIndex = 0;
let resultStepIndex = 0;
let resultFocus = false;
let resultState = null;
let presentationTimer = null;
let presentationPlaying = false;
let drawing = false;
let currentColor = '#25231f';
let currentBrush = 5;
let currentCanvas = null;
let currentContext = null;
let autoSubmitting = false;
let intentionalClose = false;

// Keeps connected multiplayer sessions active on hosts that idle-spin services down.
setInterval(() => {
  if (socket && socket.readyState === WebSocket.OPEN && currentState) {
    socket.send(JSON.stringify({ action: 'heartbeat' }));
  }
}, 25000);

function getPlayerId() {
  let id = sessionStorage.getItem('scarabocchioPlayerId');
  if (!id) {
    id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : `p-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem('scarabocchioPlayerId', id);
  }
  return id;
}
const playerId = getPlayerId();

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove('show'), 3200);
}
function showScreen(id) {
  screens.forEach((screen) => $(`#${screen}`).classList.toggle('hidden', screen !== id));
}
function send(payload) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  else showToast('Connessione non disponibile. Riprova tra un secondo.');
}
function connectAndSend(payload) {
  pendingAction = payload;
  intentionalClose = false;
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(pendingAction));
    pendingAction = null;
    return;
  }
  if (socket && socket.readyState === WebSocket.CONNECTING) return;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}`);
  socket.addEventListener('open', () => {
    if (pendingAction) {
      socket.send(JSON.stringify(pendingAction));
      pendingAction = null;
    }
  });
  socket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'error') {
      showToast(message.message || 'Si è verificato un errore.');
      return;
    }
    if (message.type === 'state') handleState(message);
  });
  socket.addEventListener('close', () => {
    if (!intentionalClose && currentState) showToast('Connessione interrotta. Ricarica la pagina per rientrare.');
  });
  socket.addEventListener('error', () => showToast('Non riesco a collegarmi al server della partita.'));
}

function handleState(state) {
  currentState = state;
  const code = state.room?.code;
  if (code) {
    const url = new URL(location.href);
    url.searchParams.set('room', code);
    history.replaceState({}, '', url);
  }
  if (state.status === 'lobby') {
    clearGameTimer();
    activeTaskStamp = null;
    renderLobby(state);
    showScreen('lobby-screen');
  } else if (state.game?.phase === 'reveal') {
    clearGameTimer();
    activeTaskStamp = null;
    renderReveal(state);
    showScreen('reveal-screen');
  } else {
    renderGame(state);
    showScreen('game-screen');
  }
}

function avatarFor(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  return avatarSet[Math.abs(hash) % avatarSet.length];
}

function renderLobby(state) {
  $('#room-code').textContent = state.room.code;
  $('#mode-select').value = state.room.settings.mode;
  $('#timer-select').value = String(state.room.settings.timer);
  $('#mode-description').textContent = modeDescriptions[state.room.settings.mode] || modeDescriptions.classic;
  $('#mode-select').disabled = !state.you.isHost;
  $('#timer-select').disabled = !state.you.isHost;
  $('#start-button').disabled = !state.you.isHost || state.players.filter(p => p.connected).length < 2;
  $('#start-button').innerHTML = state.you.isHost ? '<span>Inizia a giocare</span><span class="button-arrow">✦</span>' : '<span>Attendi il creatore</span><span class="button-arrow">…</span>';
  const connected = state.players.filter(p => p.connected).length;
  $('#player-count').textContent = `${connected} ${connected === 1 ? 'giocatore collegato' : 'giocatori collegati'}`;
  $('#player-counter').textContent = String(connected).padStart(2, '0');
  $('#players-list').innerHTML = state.players.map((player) => `
    <div class="player-item">
      <div class="avatar">${avatarFor(player.id)}</div>
      <div style="min-width:0"><div class="player-name">${escapeHtml(player.name)}</div><div class="player-status ${player.connected ? '' : 'offline'}">${player.connected ? '● Online' : '○ Offline'}</div></div>
      ${player.isHost ? '<span class="host-tag">HOST</span>' : ''}
    </div>`).join('');
  if (!state.you.isHost) $('#start-button').title = 'Solo il creatore della stanza può iniziare';
}

function copyText(text, successMessage) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => showToast(successMessage)).catch(() => fallbackCopy(text, successMessage));
  } else fallbackCopy(text, successMessage);
}
function fallbackCopy(text, successMessage) {
  const input = document.createElement('textarea');
  input.value = text; input.style.position = 'fixed'; input.style.opacity = '0';
  document.body.appendChild(input); input.select();
  try { document.execCommand('copy'); showToast(successMessage); } catch { showToast('Copia non riuscita: seleziona e copia il testo.'); }
  input.remove();
}

function clearGameTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
}
function startTaskTimer(stamp, seconds) {
  if (activeTaskStamp === stamp && timerInterval) return;
  clearGameTimer();
  activeTaskStamp = stamp;
  timerTotal = seconds;
  timerRemaining = seconds;
  autoSubmitting = false;
  if (seconds <= 0) {
    updateTimerDisplay();
    return;
  }
  timerInterval = setInterval(() => {
    timerRemaining = Math.max(0, timerRemaining - 1);
    updateTimerDisplay();
    if (timerRemaining <= 0) {
      clearGameTimer();
      if (currentState?.status === 'game' && !currentState.game.youSubmitted && !autoSubmitting) {
        autoSubmitting = true;
        showToast('Tempo scaduto! Invio del turno…');
        submitCurrentTask(true);
      }
    }
  }, 1000);
}
function updateTimerDisplay() {
  const pill = $('#timer-pill');
  if (!pill) return;
  const mins = Math.floor(timerRemaining / 60);
  const secs = timerRemaining % 60;
  pill.textContent = timerTotal === 0 ? '∞ TEMPO ILLIMITATO' : `${mins}:${String(secs).padStart(2, '0')}`;
  pill.classList.toggle('urgent', timerTotal > 0 && timerRemaining <= 10);
  const fill = $('#progress-fill');
  if (fill && timerTotal) {
    const timeProgress = Math.max(0, timerRemaining / timerTotal) * 100;
    fill.style.setProperty('--time-left', `${timeProgress}%`);
  }
}

function promptItemHtml(item) {
  if (!item) return '';
  const source = item.type === 'draw'
    ? `<img class="source-image" src="${escapeHtml(item.content)}" alt="Disegno ricevuto">`
    : `<div class="source-text">${escapeHtml(item.content)}</div>`;
  return `<div class="source-item"><div class="source-label">${item.type === 'draw' ? '🖍️ DISEGNO RICEVUTO' : '💬 FRASE RICEVUTA'} · DA ${escapeHtml(item.authorName || 'UN AMICO').toUpperCase()}</div>${source}</div>`;
}

function renderGame(state) {
  const game = state.game;
  const stamp = `${game.phase}-${game.round}-${game.youSubmitted ? 'sent' : 'task'}`;
  const isSameTask = activeTaskStamp === `${game.phase}-${game.round}-task` && !game.youSubmitted;
  $('#game-room-code').textContent = `STANZA ${state.room.code}`;
  const displayRound = game.phase === 'intro' ? 1 : game.round + 1;
  const totalTurns = game.maxRounds + 1;
  $('#game-nav-center').textContent = `TURNO ${displayRound} / ${totalTurns}`;

  if (game.youSubmitted) {
    if (activeTaskStamp !== stamp) {
      clearGameTimer(); activeTaskStamp = stamp;
      $('#game-content').innerHTML = `
        <div class="game-status-row"><span class="round-label">TURNO ${displayRound} DI ${totalTurns}</span><span class="timer-pill">INVIATO ✓</span></div>
        <div class="progress-track"><div class="progress-fill" style="width:${Math.round((displayRound / totalTurns) * 100)}%"></div></div>
        <div class="waiting-card"><div class="waiting-illustration">📮</div><h2>Il tuo turno è al sicuro!</h2><p>Adesso tocca agli altri. Preparati a scoprire dove finirà la tua idea…</p><div class="waiting-count" id="waiting-count">${game.submitted} / ${game.total} hanno consegnato</div><div class="waiting-dots"><span></span><span></span><span></span></div></div>`;
    } else {
      const count = $('#waiting-count');
      if (count) count.textContent = `${game.submitted} / ${game.total} hanno consegnato`;
    }
    return;
  }

  if (isSameTask) {
    const count = $('#turn-submitted-count');
    if (count) count.textContent = `${game.submitted} / ${game.total} consegnati`;
    return;
  }
  activeTaskStamp = `${game.phase}-${game.round}-task`;
  const task = game.task;
  if (!task) return;
  const typeLabel = task.type === 'draw' ? 'MOMENTO DI DISEGNARE' : 'MOMENTO DI SCRIVERE';
  const badge = task.type === 'draw' ? '🖍️ DISEGNA' : '💬 SCRIVI';
  const progressWidth = Math.round((displayRound / totalTurns) * 100);
  const taskHeading = game.phase === 'intro'
    ? (game.mode === 'draw' ? 'Apri le danze con un disegno!' : 'Comincia tu la catena!')
    : (task.type === 'draw' ? 'Trasforma le parole in un disegno.' : 'Che cosa sta succedendo qui?');
  const taskHelp = game.phase === 'intro'
    ? task.prompt
    : task.prompt;
  const answer = task.type === 'text'
    ? `<div class="answer-area"><textarea id="answer-text" class="answer-text" maxlength="320" placeholder="Scrivi qui la tua idea…" rows="4"></textarea><div class="char-count"><span id="char-count">0</span> / 320</div></div>`
    : drawingAreaHtml();

  $('#game-content').innerHTML = `
    <div class="game-status-row"><span class="round-label">TURNO ${displayRound} DI ${totalTurns} · <span id="turn-submitted-count">${game.submitted} / ${game.total} consegnati</span></span><span class="timer-pill" id="timer-pill">${game.timer === 0 ? '∞ TEMPO ILLIMITATO' : formatTime(game.timer)}</span></div>
    <div class="progress-track"><div class="progress-fill" id="progress-fill" style="width:${progressWidth}%"></div></div>
    <section class="task-card">
      <div class="task-card-top"><span class="task-kicker">${typeLabel}</span><span class="task-badge">${badge}</span></div>
      <h2>${taskHeading}</h2><p class="task-help">${escapeHtml(taskHelp)}</p>
      ${promptItemHtml(task.item)}
      ${answer}
      <div class="answer-actions"><button id="send-turn" class="button button-primary submit-button">Consegna il turno <span class="button-arrow">↗</span></button></div>
    </section>`;

  if (task.type === 'draw') setupCanvas();
  else {
    const text = $('#answer-text');
    text.addEventListener('input', () => { $('#char-count').textContent = text.value.length; });
    text.focus();
  }
  $('#send-turn').addEventListener('click', () => submitCurrentTask(false));
  startTaskTimer(`${game.phase}-${game.round}-task`, game.timer);
  updateTimerDisplay();
}

function formatTime(seconds) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function drawingAreaHtml() {
  return `<div class="answer-area"><div class="canvas-wrap"><div class="draw-toolbar">
    <button class="tool-button active" id="pen-tool" title="Pennello">✎</button>
    <button class="tool-button" id="eraser-tool" title="Gomma">◩</button>
    <span class="toolbar-divider"></span>
    <button class="color-dot selected" data-color="#25231f" style="background:#25231f" aria-label="Nero"></button>
    <button class="color-dot" data-color="#ed6c53" style="background:#ed6c53" aria-label="Corallo"></button>
    <button class="color-dot" data-color="#3d83c7" style="background:#3d83c7" aria-label="Blu"></button>
    <button class="color-dot" data-color="#65a56b" style="background:#65a56b" aria-label="Verde"></button>
    <button class="color-dot" data-color="#e4b72e" style="background:#e4b72e" aria-label="Giallo"></button>
    <input type="range" id="brush-size" class="brush-size" min="2" max="24" value="5" title="Spessore pennello">
    <button class="tool-button" id="undo-tool" title="Annulla">↶</button>
    <button class="tool-button" id="clear-tool" title="Pulisci">⌫</button>
  </div><div class="canvas-holder"><canvas id="draw-canvas" class="draw-canvas" width="900" height="550" aria-label="Area di disegno"></canvas></div><div class="canvas-bottom"><span>DISEGNA CON IL MOUSE O CON IL DITO</span><span>✦ L'ARTE È SOPRAVVALUTATA</span></div></div></div>`;
}

function setupCanvas() {
  const canvas = $('#draw-canvas');
  if (!canvas) return;
  currentCanvas = canvas;
  currentContext = canvas.getContext('2d');
  currentContext.fillStyle = '#ffffff';
  currentContext.fillRect(0, 0, canvas.width, canvas.height);
  undoStack = [];
  strokeLog = [];
  activeStroke = null;
  drawing = false;
  currentColor = '#25231f';
  currentBrush = 5;

  function pointFromEvent(event) {
    const rect = canvas.getBoundingClientRect();
    return [
      (event.clientX - rect.left) * (canvas.width / rect.width),
      (event.clientY - rect.top) * (canvas.height / rect.height)
    ];
  }
  function saveUndoPoint() {
    if (undoStack.length >= 20) undoStack.shift();
    undoStack.push({ data: canvas.toDataURL('image/png'), strokeCount: strokeLog.length });
  }
  canvas.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    saveUndoPoint();
    drawing = true;
    canvas.setPointerCapture(event.pointerId);
    const point = pointFromEvent(event);
    activeStroke = { color: currentColor, width: currentBrush, points: [point] };
    strokeLog.push(activeStroke);
    currentContext.beginPath(); currentContext.moveTo(point[0], point[1]);
    currentContext.lineCap = 'round'; currentContext.lineJoin = 'round';
    currentContext.strokeStyle = currentColor; currentContext.lineWidth = currentBrush;
    currentContext.lineTo(point[0] + .1, point[1] + .1); currentContext.stroke();
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!drawing || !activeStroke) return;
    event.preventDefault();
    const point = pointFromEvent(event);
    activeStroke.points.push(point);
    currentContext.lineTo(point[0], point[1]); currentContext.stroke();
  });
  const finish = () => { drawing = false; activeStroke = null; currentContext.closePath(); };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);
  canvas.addEventListener('lostpointercapture', finish);

  document.querySelectorAll('.color-dot').forEach((button) => button.addEventListener('click', () => {
    document.querySelectorAll('.color-dot').forEach((dot) => dot.classList.remove('selected'));
    button.classList.add('selected'); currentColor = button.dataset.color;
    $('#pen-tool').classList.add('active'); $('#eraser-tool').classList.remove('active');
  }));
  $('#pen-tool').addEventListener('click', () => { currentColor = document.querySelector('.color-dot.selected')?.dataset.color || '#25231f'; $('#pen-tool').classList.add('active'); $('#eraser-tool').classList.remove('active'); });
  $('#eraser-tool').addEventListener('click', () => { currentColor = '#ffffff'; $('#eraser-tool').classList.add('active'); $('#pen-tool').classList.remove('active'); });
  $('#brush-size').addEventListener('input', (event) => { currentBrush = Number(event.target.value); });
  $('#undo-tool').addEventListener('click', undoCanvas);
  $('#clear-tool').addEventListener('click', () => {
    saveUndoPoint();
    strokeLog.push({ clear: true });
    currentContext.fillStyle = '#ffffff'; currentContext.fillRect(0, 0, canvas.width, canvas.height);
  });
}

function undoCanvas() {
  if (!currentCanvas || !undoStack.length) return;
  const previous = undoStack.pop();
  strokeLog.length = previous.strokeCount;
  const image = new Image();
  image.onload = () => {
    currentContext.clearRect(0, 0, currentCanvas.width, currentCanvas.height);
    currentContext.drawImage(image, 0, 0);
  };
  image.src = previous.data;
}

function submitCurrentTask(isTimeout) {
  if (!currentState || currentState.game.youSubmitted) return;
  const taskType = currentState.game.task?.type;
  let content = '';
  if (taskType === 'draw') {
    if (!currentCanvas) return showToast('Non trovo la tela da disegno.');
    content = currentCanvas.toDataURL('image/jpeg', 0.76);
  } else {
    const input = $('#answer-text');
    content = input ? input.value.trim() : '';
    if (!content && isTimeout) content = 'Il tempo è scaduto: la mia fantasia è andata in pausa!';
  }
  if (!content) return showToast('Scrivi qualcosa prima di consegnare!');
  const button = $('#send-turn');
  if (button) { button.disabled = true; button.textContent = 'Invio…'; }
  send({ action: 'submit', content, strokes: taskType === 'draw' ? strokeLog : [] });
}

function resultEntryHtml(entry, entryIndex, bookIndex) {
  const icon = entry.type === 'draw' ? '🎨' : '💬';
  const label = entry.type === 'draw' ? 'DISEGNO' : 'FRASE';
  const content = entry.type === 'draw'
    ? `<div class="drawing-result"><img class="entry-image" src="${escapeHtml(entry.content)}" alt="Disegno di ${escapeHtml(entry.authorName)}"><canvas class="replay-canvas" width="900" height="550" aria-label="Riproduzione del disegno" hidden></canvas>${entry.strokes?.length ? `<button class="replay-button" data-story="${bookIndex}" data-entry="${entryIndex}">▶ Rivedi come è stato disegnato</button>` : ''}</div>`
    : `<div class="entry-text">${escapeHtml(entry.content)}</div>`;
  return `<div class="story-entry">
    <div class="entry-icon">${icon}</div>
    <div class="entry-body"><div class="entry-meta">${label} · ${escapeHtml(entry.authorName || 'AMICO').toUpperCase()} · PASSAGGIO ${entryIndex + 1}</div>${content}</div>
  </div>`;
}

function storyCardHtml(book, index, compact = false) {
  return `<article class="story-card ${compact ? 'story-card-compact' : ''}">
    <div class="story-card-head"><h3>La catena di ${escapeHtml(book.ownerName)}</h3><span class="story-number">STORIA ${String(index + 1).padStart(2, '0')}</span></div>
    ${book.entries.map((entry, entryIndex) => resultEntryHtml(entry, entryIndex, index)).join('')}
  </article>`;
}

function resultItemPreview(entry, bookIndex, entryIndex) {
  if (!entry) return '<div class="empty-note">Nessun contenuto</div>';
  const content = entry.type === 'draw'
    ? `<img class="comparison-image" src="${escapeHtml(entry.content)}" alt="Disegno">`
    : `<p class="comparison-text">${escapeHtml(entry.content)}</p>`;
  return `<div class="comparison-item"><div class="entry-meta">${entry.type === 'draw' ? '🎨 DISEGNO' : '💬 FRASE'} · ${escapeHtml(entry.authorName || 'AMICO')}</div>${content}</div>`;
}

function stopPresentation() {
  if (presentationTimer) clearInterval(presentationTimer);
  presentationTimer = null;
  presentationPlaying = false;
}

function renderResultView() {
  const state = resultState;
  if (!state?.game?.books) return;
  const books = state.game.books;
  if (resultView !== 'presentation') stopPresentation();
  const hostControls = $('#result-content');
  if (!hostControls) return;
  document.querySelectorAll('[data-result-view]').forEach(button => {
    button.classList.toggle('active', button.dataset.resultView === resultView);
    button.setAttribute('aria-pressed', button.dataset.resultView === resultView ? 'true' : 'false');
  });
  $('#result-focus-button').textContent = resultFocus ? '↙ Vista normale' : '⛶ Ingrandisci album';
  $('#reveal-content').classList.toggle('result-focus', resultFocus);

  if (resultView === 'presentation') {
    resultBookIndex = Math.max(0, Math.min(resultBookIndex, books.length - 1));
    const book = books[resultBookIndex];
    hostControls.innerHTML = `<div class="presentation-top"><span class="round-label">ALBUM ${resultBookIndex + 1} DI ${books.length}</span><span class="presentation-progress">${Math.round(((resultBookIndex + 1) / books.length) * 100)}% COMPLETATO</span></div>
      ${storyCardHtml(book, resultBookIndex)}
      <div class="presentation-controls"><button class="button button-secondary" id="story-prev" ${resultBookIndex === 0 ? 'disabled' : ''}>← Precedente</button><button class="button button-outline" id="presentation-play">▶ Avvia presentazione</button><button class="button button-primary" id="story-next" ${resultBookIndex >= books.length - 1 ? 'disabled' : ''}>Successivo →</button></div>`;
    $('#story-prev')?.addEventListener('click', () => { stopPresentation(); resultBookIndex--; renderResultView(); });
    $('#story-next')?.addEventListener('click', () => { stopPresentation(); resultBookIndex++; renderResultView(); });
    $('#presentation-play')?.addEventListener('click', () => {
      if (presentationPlaying) {
        stopPresentation();
        $('#presentation-play').textContent = '▶ Riprendi presentazione';
        return;
      }
      if (resultBookIndex >= books.length - 1) resultBookIndex = 0;
      presentationPlaying = true;
      $('#presentation-play').textContent = 'Ⅱ Metti in pausa';
      presentationTimer = setInterval(() => {
        if (resultBookIndex >= books.length - 1) {
          stopPresentation();
          renderResultView();
          return;
        }
        resultBookIndex++;
        renderResultView();
        if (presentationPlaying) $('#presentation-play').textContent = 'Ⅱ Metti in pausa';
      }, 5000);
    });
  } else if (resultView === 'steps') {
    const book = books[resultBookIndex] || books[0];
    if (!book) { hostControls.innerHTML = '<div class="empty-note">Non ci sono catene da mostrare.</div>'; return; }
    resultStepIndex = Math.max(0, Math.min(resultStepIndex, book.entries.length - 1));
    const entry = book.entries[resultStepIndex];
    hostControls.innerHTML = `<div class="steps-toolbar"><label for="result-story-select">CATENA DA ESPLORARE</label><select id="result-story-select" class="text-input select-input">${books.map((item, index) => `<option value="${index}" ${index === resultBookIndex ? 'selected' : ''}>${escapeHtml(item.ownerName)} · Storia ${index + 1}</option>`).join('')}</select><span class="presentation-progress">PASSAGGIO ${resultStepIndex + 1} DI ${book.entries.length}</span></div>
      <article class="story-card step-card"><div class="story-card-head"><h3>La catena di ${escapeHtml(book.ownerName)}</h3><span class="story-number">PASSAGGIO ${String(resultStepIndex + 1).padStart(2, '0')}</span></div>${resultEntryHtml(entry, resultStepIndex, resultBookIndex)}</article>
      <div class="story-navigation"><button class="button button-secondary" id="step-prev" ${resultStepIndex === 0 ? 'disabled' : ''}>← Passaggio precedente</button><span>${resultStepIndex + 1} / ${book.entries.length}</span><button class="button button-primary" id="step-next" ${resultStepIndex >= book.entries.length - 1 ? 'disabled' : ''}>Passaggio successivo →</button></div>`;
    $('#result-story-select')?.addEventListener('change', event => { resultBookIndex = Number(event.target.value); resultStepIndex = 0; renderResultView(); });
    $('#step-prev')?.addEventListener('click', () => { resultStepIndex--; renderResultView(); });
    $('#step-next')?.addEventListener('click', () => { resultStepIndex++; renderResultView(); });
  } else if (resultView === 'timeline') {
    hostControls.innerHTML = `<div class="timeline-intro">Tutte le catene, dall'idea iniziale all'ultima trasformazione.</div><div class="timeline-list">${books.map((book, index) => storyCardHtml(book, index)).join('')}</div>`;
  } else if (resultView === 'compare') {
    hostControls.innerHTML = `<div class="comparison-grid">${books.map((book, index) => {
      const first = book.entries[0];
      const last = book.entries[book.entries.length - 1];
      return `<article class="comparison-card"><div class="story-card-head"><h3>${escapeHtml(book.ownerName)}</h3><span class="story-number">STORIA ${String(index + 1).padStart(2, '0')}</span></div><div class="comparison-columns"><section><h4>🌱 Come è iniziata</h4>${resultItemPreview(first, index, 0)}</section><section><h4>🎉 Come è finita</h4>${resultItemPreview(last, index, book.entries.length - 1)}</section></div></article>`;
    }).join('')}</div>`;
  } else {
    hostControls.innerHTML = `<div class="story-grid">${books.map((book, index) => storyCardHtml(book, index)).join('')}</div>`;
  }
  attachReplayButtons();
}

function attachReplayButtons() {
  document.querySelectorAll('.replay-button').forEach(button => {
    button.addEventListener('click', () => {
      const storyIndex = Number(button.dataset.story);
      const entryIndex = Number(button.dataset.entry);
      const entry = resultState.game.books[storyIndex]?.entries[entryIndex];
      const body = button.closest('.drawing-result');
      const image = body?.querySelector('.entry-image');
      const canvas = body?.querySelector('.replay-canvas');
      if (!entry?.strokes?.length || !canvas || !image) return;
      if (replayFrameHandle) cancelAnimationFrame(replayFrameHandle);
      image.hidden = true;
      canvas.hidden = false;
      button.disabled = true;
      button.textContent = '▶ Riproduzione in corso…';
      playStrokeReplay(canvas, entry.strokes, () => {
        button.disabled = false;
        button.textContent = '↻ Rivedi il disegno';
      });
    });
  });
}

function playStrokeReplay(canvas, strokes, onFinish) {
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  let strokeIndex = 0;
  let pointIndex = 0;
  let hasBegun = false;
  function tick() {
    let budget = 7;
    while (budget > 0 && strokeIndex < strokes.length) {
      const stroke = strokes[strokeIndex];
      if (stroke.clear) {
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        strokeIndex++; pointIndex = 0; hasBegun = false; budget--;
        continue;
      }
      const points = stroke.points || [];
      if (!points.length) { strokeIndex++; pointIndex = 0; hasBegun = false; continue; }
      ctx.strokeStyle = stroke.color || '#25231f';
      ctx.lineWidth = stroke.width || 5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      if (!hasBegun) {
        ctx.beginPath(); ctx.moveTo(points[0][0], points[0][1]);
        ctx.lineTo(points[0][0] + .1, points[0][1] + .1); ctx.stroke();
        pointIndex = 1; hasBegun = true; budget--;
        if (points.length === 1) { strokeIndex++; pointIndex = 0; hasBegun = false; }
        continue;
      }
      if (pointIndex < points.length) {
        ctx.beginPath(); ctx.moveTo(points[pointIndex - 1][0], points[pointIndex - 1][1]);
        const end = Math.min(points.length - 1, pointIndex + 6);
        for (let i = pointIndex; i <= end; i++) ctx.lineTo(points[i][0], points[i][1]);
        ctx.stroke();
        budget -= Math.max(1, end - pointIndex + 1);
        pointIndex = end + 1;
      } else {
        strokeIndex++; pointIndex = 0; hasBegun = false;
      }
    }
    if (strokeIndex < strokes.length) replayFrameHandle = requestAnimationFrame(tick);
    else { replayFrameHandle = null; onFinish?.(); }
  }
  replayFrameHandle = requestAnimationFrame(tick);
}

function renderReveal(state) {
  stopPresentation();
  resultState = state;
  resultBookIndex = 0;
  resultStepIndex = 0;
  resultView = 'album';
  resultFocus = false;
  const game = state.game;
  const modeNames = { classic: 'Telefono classico', draw: 'Solo disegni', phrase: 'Solo frasi', sprint: 'Modalità sprint', chaos: 'Caos totale', emoji: 'Storia a emoji' };
  $('#reveal-content').innerHTML = `
    <header class="reveal-heading"><div class="eyebrow">✳ PARTITA COMPLETATA · ${escapeHtml(modeNames[game.mode] || 'Party game')}</div><h1>È uscito un <span>capolavoro?</span></h1><p>Rivivi ogni catena in cinque modi: album, presentazione automatica, passaggi, cronologia e confronto.</p></header>
    <div class="result-toolbar">
      <div class="result-view-buttons" role="group" aria-label="Visualizzazione risultati">
        <button class="result-view-button" data-result-view="album" aria-pressed="true">▦ Album</button>
        <button class="result-view-button" data-result-view="presentation" aria-pressed="false">▶ Presentazione</button>
        <button class="result-view-button" data-result-view="steps" aria-pressed="false">☷ Passaggio per passaggio</button>
        <button class="result-view-button" data-result-view="timeline" aria-pressed="false">▤ Cronologia</button>
        <button class="result-view-button" data-result-view="compare" aria-pressed="false">⇄ Prima / dopo</button>
      </div>
      <div class="result-tools"><button id="result-focus-button" class="button button-outline">⛶ Ingrandisci album</button><button id="print-album" class="button button-outline">⇩ Stampa / PDF</button><button id="download-album" class="button button-outline">↓ Esporta album</button></div>
    </div>
    <div id="result-content" class="result-content"></div>
    <div class="reveal-actions">${state.you.isHost ? '<button id="replay-button" class="button button-primary">Un\'altra partita ↗</button>' : '<button class="button button-secondary" disabled>Attendi il creatore della stanza</button>'}<button id="copy-final-link" class="button button-secondary">Condividi la stanza</button></div>
    <div class="reveal-footnote">NON GIUDICHIAMO I DISEGNI. (FORSE.)</div>`;
  document.querySelectorAll('[data-result-view]').forEach(button => button.addEventListener('click', () => {
    if (button.dataset.resultView !== resultView) stopPresentation();
    resultView = button.dataset.resultView;
    renderResultView();
  }));
  $('#result-focus-button').addEventListener('click', () => { resultFocus = !resultFocus; renderResultView(); });
  $('#print-album').addEventListener('click', () => window.print());
  $('#download-album').addEventListener('click', downloadAlbum);
  if ($('#replay-button')) $('#replay-button').addEventListener('click', () => send({ action: 'backToLobby' }));
  $('#copy-final-link').addEventListener('click', () => copyText(location.href, 'Link della stanza copiato!'));
  renderResultView();
}

function downloadAlbum() {
  if (!resultState?.game?.books) return;
  const data = {
    title: 'Scarabocchio Party — Album della partita',
    exportedAt: new Date().toISOString(),
    room: resultState.room.code,
    mode: resultState.game.mode,
    albums: resultState.game.books.map(book => ({
      owner: book.ownerName,
      entries: book.entries.map(entry => ({ type: entry.type, author: entry.authorName, content: entry.content, strokes: entry.strokes || [] }))
    }))
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = `scarabocchio-album-${resultState.room.code}.json`;
  document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
  showToast('Album esportato!');
}

function leaveRoom() {
  intentionalClose = true;
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ action: 'leave' }));
    setTimeout(() => { try { socket.close(); } catch { /* ignore */ } }, 80);
  } else if (socket) {
    try { socket.close(); } catch { /* ignore */ }
  }
  socket = null; currentState = null; pendingAction = null;
  clearGameTimer(); activeTaskStamp = null;
  const url = new URL(location.href); url.searchParams.delete('room'); history.replaceState({}, '', url);
  showScreen('home-screen');
}

$('#create-button').addEventListener('click', () => {
  const name = $('#create-name').value.trim() || 'Capogioco';
  connectAndSend({ action: 'create', playerId, name });
});
$('#join-button').addEventListener('click', () => {
  const code = $('#join-code').value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  if (code.length !== 5) return showToast('Inserisci un codice stanza di 5 caratteri.');
  const name = $('#join-name').value.trim() || 'Amico';
  connectAndSend({ action: 'join', code, playerId, name });
});
$('#join-code').addEventListener('input', (event) => { event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5); });
$('#join-code').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('#join-button').click(); });
$('#create-name').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('#create-button').click(); });
$('#join-name').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('#join-code').focus(); });
$('#copy-code').addEventListener('click', () => { if (currentState) copyText(currentState.room.code, 'Codice stanza copiato!'); });
$('#copy-link').addEventListener('click', () => copyText(location.href, 'Link d’invito copiato!'));
$('#leave-lobby').addEventListener('click', leaveRoom);
$('#brand-home').addEventListener('click', (event) => { event.preventDefault(); leaveRoom(); });
$('#mode-select').addEventListener('change', () => send({ action: 'settings', mode: $('#mode-select').value, timer: Number($('#timer-select').value) }));
$('#timer-select').addEventListener('change', () => send({ action: 'settings', mode: $('#mode-select').value, timer: Number($('#timer-select').value) }));
$('#start-button').addEventListener('click', () => send({ action: 'start' }));
$('#game-room-code').addEventListener('click', () => { if (currentState) copyText(currentState.room.code, 'Codice stanza copiato!'); });

const roomFromUrl = new URL(location.href).searchParams.get('room');
if (roomFromUrl) {
  $('#join-code').value = roomFromUrl.toUpperCase().slice(0, 5);
  $('#join-name').focus();
}
