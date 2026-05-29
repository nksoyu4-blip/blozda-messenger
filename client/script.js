let currentUser = null, activeChat = null, activeChatType = 'user', socket = null;
let localStream = null, peerConnection = null;
let mediaRecorder = null, audioChunks = [], isRecording = false, recordingStart = null, recordingTimer = null, currentAudio = null;
let incomingOffer = null, incomingCallFrom = null;
let friendRequests = { incoming: [], outgoing: [] };
let currentTheme = 'dark';
let callTimer = null;
let allContacts = [];
let allGroups = [];

// ====== SOUND ======
function playSound() {
  try {
    const a = new (window.AudioContext || window.webkitAudioContext)();
    const o = a.createOscillator(), g = a.createGain();
    o.connect(g); g.connect(a.destination);
    o.frequency.setValueAtTime(800, a.currentTime);
    o.frequency.setValueAtTime(1000, a.currentTime + 0.1);
    g.gain.setValueAtTime(0.2, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.01, a.currentTime + 0.3);
    o.start(a.currentTime); o.stop(a.currentTime + 0.3);
  } catch(e) {}
}

// ====== INIT ======
document.addEventListener('DOMContentLoaded', () => {
  const s = localStorage.getItem('blozda_auth');
  if (s) {
    try {
      const d = JSON.parse(s);
      if (Date.now() - d.timestamp < 7 * 86400000) {
        currentUser = { token: d.token };
        verifyAndEnter();
        return;
      }
    } catch {}
    localStorage.removeItem('blozda_auth');
  }
  
  // Enter key handlers
  document.getElementById('loginPassword')?.addEventListener('keypress', e => { if (e.key === 'Enter') login(); });
  document.getElementById('regConfirm')?.addEventListener('keypress', e => { if (e.key === 'Enter') register(); });
});

async function verifyAndEnter() {
  try {
    const r = await fetch('/api/verify', { headers: { 'Authorization': 'Bearer ' + currentUser.token } });
    if (r.ok) {
      const d = await r.json();
      currentUser.user = d.user;
      showMain();
      connectSocket();
    } else {
      localStorage.removeItem('blozda_auth');
    }
  } catch {}
}

// ====== UI ======
function switchTab(t) {
  document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
  document.getElementById('loginForm').style.display = t === 'login' ? 'flex' : 'none';
  document.getElementById('registerForm').style.display = t === 'register' ? 'flex' : 'none';
}

function toggleTheme() {
  currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', currentTheme);
  document.getElementById('themeIcon').className = currentTheme === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
  localStorage.setItem('blozda_theme', currentTheme);
}

function showMain() {
  document.getElementById('authScreen').style.display = 'none';
  document.getElementById('mainScreen').style.display = 'block';
  document.getElementById('currentUsername').textContent = currentUser.user.username;
  document.getElementById('userAvatar').src = currentUser.user.avatar || 
    'https://ui-avatars.com/api/?name=' + encodeURIComponent(currentUser.user.username) + '&background=7c5cfc&color=fff&size=100';
  currentTheme = localStorage.getItem('blozda_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', currentTheme);
  document.getElementById('themeIcon').className = currentTheme === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
}

// ====== AUTH ======
async function register() {
  const u = document.getElementById('regUsername').value.trim();
  const p = document.getElementById('regPassword').value;
  const c = document.getElementById('regConfirm').value;
  if (!u || !p) return alert('Заполните все поля');
  if (u.length < 3) return alert('Минимум 3 символа');
  if (p.length < 6) return alert('Пароль минимум 6 символов');
  if (p !== c) return alert('Пароли не совпадают');
  
  const r = await fetch('/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: p })
  });
  const d = await r.json();
  if (d.error) return alert(d.error);
  currentUser = d;
  showMain();
  connectSocket();
}

async function login() {
  const u = document.getElementById('loginUsername').value.trim();
  const p = document.getElementById('loginPassword').value;
  if (!u || !p) return alert('Заполните все поля');
  
  const r = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: p })
  });
  const d = await r.json();
  if (d.error) return alert(d.error);
  currentUser = d;
  if (document.getElementById('rememberMe').checked) {
    localStorage.setItem('blozda_auth', JSON.stringify({ token: d.token, timestamp: Date.now() }));
  }
  showMain();
  connectSocket();
}

function logout() {
  localStorage.removeItem('blozda_auth');
  if (socket) socket.disconnect();
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  endCall();
  currentUser = null;
  activeChat = null;
  document.getElementById('mainScreen').style.display = 'none';
  document.getElementById('authScreen').style.display = 'flex';
}

// ====== SOCKET ======
function connectSocket() {
  socket = io();
  
  socket.on('connect', () => {
    socket.emit('authenticate', { token: currentUser.token });
  });

  socket.on('newMessage', (msg) => {
    playSound();
    if ((activeChat === msg.from && activeChatType === 'user' && !msg.isGroup) || 
        (activeChat === msg.to && activeChatType === 'group' && msg.isGroup)) {
      displayMessage(msg);
      scrollBottom();
      if (!msg.isGroup) socket.emit('markAsRead', { from: msg.from });
    }
    loadAllChats();
  });

  socket.on('messageSent', (msg) => {
    if ((activeChat === msg.to && activeChatType === 'user' && !msg.isGroup) || 
        (activeChat === msg.to && activeChatType === 'group' && msg.isGroup)) {
      displayMessage(msg);
      scrollBottom();
    }
  });

  socket.on('messagesRead', () => {
    document.querySelectorAll('.message.sent .read-status').forEach(e => {
      e.textContent = '✓✓';
      e.style.color = '#00d2ff';
    });
  });

  socket.on('userStatus', (d) => {
    if (activeChat === d.username && activeChatType === 'user') {
      document.getElementById('chatPartnerStatus').textContent = d.status === 'online' ? 'В сети' : 'Не в сети';
    }
    loadAllChats();
  });

  socket.on('userTyping', (d) => {
    if (activeChat === d.from && activeChatType === 'user') {
      document.getElementById('chatPartnerStatus').textContent = 'печатает...';
      document.getElementById('chatPartnerStatus').style.color = 'var(--primary)';
    }
  });

  socket.on('userStoppedTyping', (d) => {
    if (activeChat === d.from && activeChatType === 'user') {
      document.getElementById('chatPartnerStatus').textContent = 'В сети';
      document.getElementById('chatPartnerStatus').style.color = '';
    }
  });

  socket.on('friendRequest', (r) => {
    playSound();
    loadFriendRequests();
  });

  socket.on('friendAccepted', () => {
    loadAllChats();
    loadFriendRequests();
  });

  socket.on('groupCreated', () => {
    loadAllChats();
  });

  // Calls
  socket.on('callOffer', (d) => {
    incomingOffer = d.offer;
    incomingCallFrom = d.from;
    document.getElementById('incomingCallName').textContent = d.from;
    document.getElementById('incomingCallAvatar').src = 'https://ui-avatars.com/api/?name=' + d.from + '&background=7c5cfc&color=fff&size=200';
    document.getElementById('incomingCallModal').style.display = 'flex';
    playSound();
  });

  socket.on('callAnswer', (d) => {
    if (peerConnection) {
      peerConnection.setRemoteDescription(new RTCSessionDescription(d.answer)).catch(() => {});
    }
  });

  socket.on('callCandidate', (d) => {
    if (peerConnection && d.candidate) {
      peerConnection.addIceCandidate(new RTCIceCandidate(d.candidate)).catch(() => {});
    }
  });

  socket.on('callEnd', () => endCall());

  loadAllChats();
  loadFriendRequests();
}

// ====== ЕДИНЫЙ СПИСОК ЧАТОВ (контакты + группы) ======
async function loadAllChats() {
  try {
    // Загружаем контакты
    const cr = await fetch('/api/contacts', {
      headers: { 'Authorization': 'Bearer ' + currentUser.token }
    });
    allContacts = await cr.json();
    
    // Загружаем группы
    const gr = await fetch('/api/groups', {
      headers: { 'Authorization': 'Bearer ' + currentUser.token }
    });
    allGroups = await gr.json();
    
    renderChatsList();
  } catch (e) {
    console.error('Error loading chats:', e);
  }
}

function renderChatsList() {
  const list = document.getElementById('chatsList');
  
  if (allContacts.length === 0 && allGroups.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-comments"></i>
        <p>Нет чатов</p>
        <p style="font-size:12px;margin-top:4px;color:var(--text3)">Добавьте контакты или создайте группу</p>
      </div>`;
    return;
  }
  
  let html = '';
  
  // Группы
  if (allGroups.length > 0) {
    html += '<div class="section-title">Группы</div>';
    html += allGroups.map(g => `
      <div class="contact-item ${activeChat === g.id && activeChatType === 'group' ? 'active' : ''}" 
           onclick="openGroupChat('${g.id}')">
        <div class="group-avatar">
          ${g.avatar ? '<img src="' + g.avatar + '" style="width:100%;height:100%;border-radius:50%;object-fit:cover">' : '<i class="fas fa-users"></i>'}
        </div>
        <div class="contact-info">
          <div class="name">${escapeHtml(g.name)}</div>
          <div class="status">${g.members.length} участников</div>
        </div>
      </div>
    `).join('');
  }
  
  // Контакты
  if (allContacts.length > 0) {
    html += '<div class="section-title">Контакты</div>';
    html += allContacts.map(c => `
      <div class="contact-item ${activeChat === c.username && activeChatType === 'user' ? 'active' : ''}" 
           onclick="openChat('${c.username}')">
        <img src="${c.avatar || 'https://ui-avatars.com/api/?name=' + encodeURIComponent(c.username) + '&background=7c5cfc&color=fff&size=100'}" alt="">
        <div class="contact-info">
          <div class="name">${c.username}</div>
          <div class="status ${c.status === 'online' ? 'online' : ''}">${c.status === 'online' ? 'В сети' : 'Не в сети'}</div>
        </div>
      </div>
    `).join('');
  }
  
  list.innerHTML = html;
}

// ====== SEARCH ======
async function searchUsers() {
  const q = document.getElementById('searchInput').value.trim();
  const results = document.getElementById('searchResults');
  
  if (!q) {
    results.style.display = 'none';
    return;
  }

  try {
    const res = await fetch('/api/users/search?q=' + encodeURIComponent(q), {
      headers: { 'Authorization': 'Bearer ' + currentUser.token }
    });
    const users = await res.json();
    
    const filtered = users.filter(u => u.username !== currentUser.user.username);
    
    if (filtered.length === 0) {
      results.innerHTML = '<div class="empty-state"><p>Ничего не найдено</p></div>';
    } else {
      results.innerHTML = filtered.map(u => `
        <div class="contact-item">
          <img src="${u.avatar || 'https://ui-avatars.com/api/?name=' + encodeURIComponent(u.username) + '&background=7c5cfc&color=fff&size=100'}" alt="">
          <div class="contact-info" style="flex:1">
            <div class="name">${u.username}</div>
            <div class="status ${u.status === 'online' ? 'online' : ''}">${u.status === 'online' ? 'В сети' : 'Не в сети'}</div>
          </div>
          <button class="btn btn-sm btn-primary" onclick="event.stopPropagation(); sendFriendRequest('${u.username}')">
            <i class="fas fa-user-plus"></i>
          </button>
        </div>
      `).join('');
    }
    
    results.style.display = 'block';
  } catch (e) {
    console.error('Search error:', e);
  }
}

// ====== FRIEND REQUESTS ======
async function loadFriendRequests() {
  try {
    const r = await fetch('/api/friends/requests', {
      headers: { 'Authorization': 'Bearer ' + currentUser.token }
    });
    friendRequests = await r.json();
    
    const badge = document.getElementById('reqBadge');
    const count = friendRequests.incoming.length;
    if (count > 0) {
      badge.style.display = 'flex';
      badge.textContent = count;
    } else {
      badge.style.display = 'none';
    }
  } catch (e) {}
}

async function sendFriendRequest(username) {
  try {
    await fetch('/api/friends/request', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + currentUser.token
      },
      body: JSON.stringify({ to: username })
    });
    document.getElementById('searchInput').value = '';
    document.getElementById('searchResults').style.display = 'none';
    loadFriendRequests();
  } catch (e) {}
}

function showFriendRequests() {
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <h3>Заявки в друзья</h3>
        <button class="modal-close" onclick="this.closest('.modal').remove()"><i class="fas fa-times"></i></button>
      </div>
      
      <h4 style="color:var(--text2);margin-bottom:8px">Входящие (${friendRequests.incoming.length})</h4>
      ${friendRequests.incoming.length === 0 ? 
        '<div class="empty-state"><p>Нет входящих заявок</p></div>' :
        friendRequests.incoming.map(r => `
          <div class="request-item">
            <img src="https://ui-avatars.com/api/?name=${encodeURIComponent(r.from)}&background=7c5cfc&color=fff&size=80" style="width:40px;height:40px;border-radius:50%">
            <div style="flex:1"><strong>${r.from}</strong></div>
            <button class="btn btn-sm btn-primary" onclick="acceptRequest('${r.id}')"><i class="fas fa-check"></i></button>
            <button class="btn btn-sm" style="background:var(--danger);color:#fff" onclick="rejectRequest('${r.id}')"><i class="fas fa-times"></i></button>
          </div>
        `).join('')
      }
      
      <h4 style="color:var(--text2);margin:20px 0 8px">Исходящие (${friendRequests.outgoing.length})</h4>
      ${friendRequests.outgoing.length === 0 ?
        '<div class="empty-state"><p>Нет исходящих заявок</p></div>' :
        friendRequests.outgoing.map(r => `
          <div class="request-item">
            <img src="https://ui-avatars.com/api/?name=${encodeURIComponent(r.to)}&background=7c5cfc&color=fff&size=80" style="width:40px;height:40px;border-radius:50%">
            <div style="flex:1"><strong>${r.to}</strong></div>
            <span style="color:var(--text3);font-size:13px">Ожидание</span>
          </div>
        `).join('')
      }
    </div>
  `;
  
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

async function acceptRequest(id) {
  await fetch('/api/friends/accept', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + currentUser.token
    },
    body: JSON.stringify({ requestId: id })
  });
  loadAllChats();
  loadFriendRequests();
  document.querySelector('.modal')?.remove();
}

async function rejectRequest(id) {
  await fetch('/api/friends/reject', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + currentUser.token
    },
    body: JSON.stringify({ requestId: id })
  });
  loadFriendRequests();
  document.querySelector('.modal')?.remove();
}

// ====== CREATE GROUP ======
function showCreateGroup() {
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <h3>Создать группу</h3>
        <button class="modal-close" onclick="this.closest('.modal').remove()"><i class="fas fa-times"></i></button>
      </div>
      <div class="input-group" style="margin-bottom:12px">
        <i class="fas fa-users"></i>
        <input type="text" id="groupName" placeholder="Название группы">
      </div>
      <label style="color:var(--text2);font-size:13px;margin-bottom:8px;display:block">Выберите участников:</label>
      <div id="groupMemberList" style="max-height:200px;overflow-y:auto;margin-bottom:12px"></div>
      <div id="selectedMembers" class="selected-members"></div>
      <button class="btn btn-primary" onclick="createGroup()" style="width:100%">
        <i class="fas fa-plus"></i> Создать группу
      </button>
    </div>
  `;
  
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  loadGroupMembers();
}

async function loadGroupMembers() {
  try {
    const r = await fetch('/api/contacts', {
      headers: { 'Authorization': 'Bearer ' + currentUser.token }
    });
    const contacts = await r.json();
    
    document.getElementById('groupMemberList').innerHTML = contacts.map(c => `
      <label class="contact-item" style="cursor:pointer">
        <input type="checkbox" value="${c.username}" onchange="toggleGroupMember(this)" style="margin-right:10px">
        <img src="${c.avatar || 'https://ui-avatars.com/api/?name=' + encodeURIComponent(c.username) + '&background=7c5cfc&color=fff&size=80'}" 
             style="width:36px;height:36px;border-radius:50%">
        <span>${c.username}</span>
      </label>
    `).join('');
  } catch (e) {}
}

function toggleGroupMember(cb) {
  const container = document.getElementById('selectedMembers');
  if (cb.checked) {
    const badge = document.createElement('span');
    badge.className = 'selected-member';
    badge.id = 'gm-' + cb.value;
    badge.innerHTML = cb.value + ' <button onclick="document.getElementById(\'gm-' + cb.value + '\').remove(); document.querySelector(\'#groupMemberList input[value=\\\'' + cb.value + '\\\']\').checked=false" style="background:none;border:none;color:var(--danger);cursor:pointer;font-size:14px">×</button>';
    container.appendChild(badge);
  } else {
    document.getElementById('gm-' + cb.value)?.remove();
  }
}

async function createGroup() {
  const name = document.getElementById('groupName').value.trim();
  const members = Array.from(document.querySelectorAll('#groupMemberList input:checked')).map(c => c.value);
  
  if (!name) return alert('Введите название группы');
  if (members.length === 0) return alert('Выберите участников');
  
  try {
    await fetch('/api/groups', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + currentUser.token
      },
      body: JSON.stringify({ name, members: JSON.stringify(members) })
    });
    
    document.querySelector('.modal')?.remove();
    loadAllChats();
  } catch (e) {
    alert('Ошибка создания группы');
  }
}

// ====== OPEN CHATS ======
async function openChat(username) {
  activeChat = username;
  activeChatType = 'user';
  
  document.getElementById('chatPlaceholder').style.display = 'none';
  document.getElementById('chatActive').style.display = 'flex';
  document.getElementById('messagesContainer').innerHTML = '';
  
  // Показываем кнопки звонков
  document.getElementById('chatActions').style.display = 'flex';
  
  const contact = allContacts.find(c => c.username === username);
  document.getElementById('chatPartnerName').textContent = username;
  document.getElementById('chatPartnerStatus').textContent = contact?.status === 'online' ? 'В сети' : 'Не в сети';
  document.getElementById('chatPartnerAvatar').src = contact?.avatar || 
    'https://ui-avatars.com/api/?name=' + encodeURIComponent(username) + '&background=7c5cfc&color=fff&size=100';
  
  // Load messages
  try {
    const r = await fetch('/api/messages/' + username, {
      headers: { 'Authorization': 'Bearer ' + currentUser.token }
    });
    const msgs = await r.json();
    msgs.forEach(displayMessage);
    scrollBottom();
    socket.emit('markAsRead', { from: username });
  } catch (e) {}
  
  loadAllChats();
  document.getElementById('messageInput')?.focus();
}

async function openGroupChat(groupId) {
  activeChat = groupId;
  activeChatType = 'group';
  
  document.getElementById('chatPlaceholder').style.display = 'none';
  document.getElementById('chatActive').style.display = 'flex';
  document.getElementById('messagesContainer').innerHTML = '';
  
  // Скрываем кнопки звонков для групп
  document.getElementById('chatActions').style.display = 'none';
  
  const group = allGroups.find(g => g.id === groupId);
  if (group) {
    document.getElementById('chatPartnerName').textContent = group.name;
    document.getElementById('chatPartnerStatus').textContent = group.members.length + ' участников';
    document.getElementById('chatPartnerAvatar').src = group.avatar || 
      'https://ui-avatars.com/api/?name=' + encodeURIComponent(group.name) + '&background=7c5cfc&color=fff&size=100';
  }
  
  // Load messages
  try {
    const r = await fetch('/api/groups/' + groupId + '/messages', {
      headers: { 'Authorization': 'Bearer ' + currentUser.token }
    });
    const msgs = await r.json();
    msgs.forEach(displayMessage);
    scrollBottom();
  } catch (e) {}
  
  loadAllChats();
  document.getElementById('messageInput')?.focus();
}

// ====== SEND MESSAGE ======
function sendMessage() {
  const input = document.getElementById('messageInput');
  const text = input.value.trim();
  
  if (!text || !activeChat) return;
  
  socket.emit('sendMessage', {
    to: activeChat,
    message: text,
    type: 'text',
    isGroup: activeChatType === 'group'
  });
  
  input.value = '';
  input.focus();
}

// ====== DISPLAY MESSAGE ======
function displayMessage(msg) {
  const container = document.getElementById('messagesContainer');
  if (document.querySelector('[data-id="' + msg.id + '"]')) return;
  
  const isSent = msg.from === currentUser.user.username;
  const time = new Date(msg.timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  
  let content = '';
  switch (msg.type) {
    case 'text':
      content = escapeHtml(msg.message);
      break;
    case 'image':
      content = '<img src="' + msg.fileData.url + '" style="max-width:240px;border-radius:8px;cursor:pointer" onclick="window.open(\'' + msg.fileData.url + '\')">';
      break;
    case 'voice':
      content = '<div class="voice-msg"><button class="voice-btn" onclick="playVoice(\'' + msg.fileData.url + '\',this)"><i class="fas fa-play"></i></button><span style="font-size:12px">' + (msg.fileData.duration || '0:00') + '</span></div>';
      break;
    case 'file':
      content = '<div style="display:flex;align-items:center;gap:8px"><i class="fas fa-file"></i><a href="' + msg.fileData.url + '" target="_blank" style="color:inherit;font-size:13px">' + msg.fileData.name + '</a></div>';
      break;
  }
  
  container.insertAdjacentHTML('beforeend', 
    '<div class="message ' + (isSent ? 'sent' : 'received') + '" data-id="' + msg.id + '">' +
    '<div class="message-bubble">' +
    (activeChatType === 'group' && !isSent ? '<div style="font-size:11px;color:var(--primary);font-weight:600;margin-bottom:4px">' + msg.from + '</div>' : '') +
    content +
    '<div class="message-meta"><span>' + time + '</span>' + 
    (isSent ? '<span class="read-status">' + (msg.read ? '✓✓' : '✓') + '</span>' : '') +
    '</div></div></div>'
  );
  
  scrollBottom();
}

function scrollBottom() {
  const c = document.getElementById('messagesContainer');
  setTimeout(() => c.scrollTop = c.scrollHeight, 100);
}

// ====== FILES & VOICE ======
async function handleFile(input) {
  for (let file of input.files) {
    const fd = new FormData();
    fd.append('file', file);
    const r = await fetch('/api/upload', { method: 'POST', body: fd });
    const d = await r.json();
    socket.emit('sendMessage', {
      to: activeChat,
      message: d.name,
      type: file.type.startsWith('image/') ? 'image' : 'file',
      fileData: d,
      isGroup: activeChatType === 'group'
    });
  }
  input.value = '';
}

async function toggleRecording() {
  isRecording ? stopRecording() : startRecording();
}

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    audioChunks = [];
    
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
    
    mediaRecorder.onstop = async () => {
      const blob = new Blob(audioChunks, { type: 'audio/webm' });
      const dur = Math.round((Date.now() - recordingStart) / 1000);
      const fd = new FormData();
      fd.append('voice', blob, 'voice.webm');
      fd.append('duration', formatDur(dur));
      
      const r = await fetch('/api/voice', { method: 'POST', body: fd });
      const d = await r.json();
      socket.emit('sendMessage', {
        to: activeChat,
        message: 'Голосовое',
        type: 'voice',
        fileData: d,
        isGroup: activeChatType === 'group'
      });
      
      stream.getTracks().forEach(t => t.stop());
      stopUI();
    };
    
    mediaRecorder.start();
    isRecording = true;
    recordingStart = Date.now();
    
    document.getElementById('recordingBar').style.display = 'flex';
    document.getElementById('recordBtn').innerHTML = '<i class="fas fa-stop" style="color:var(--danger)"></i>';
    recordingTimer = setInterval(() => {
      document.getElementById('recordingTime').textContent = formatDur(Math.round((Date.now() - recordingStart) / 1000));
    }, 1000);
  } catch (e) {
    alert('Нет доступа к микрофону');
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
}

function stopUI() {
  document.getElementById('recordingBar').style.display = 'none';
  document.getElementById('recordBtn').innerHTML = '<i class="fas fa-microphone"></i>';
  clearInterval(recordingTimer);
  isRecording = false;
}

function playVoice(url, btn) {
  if (currentAudio) {
    if (currentAudio.src === url) {
      currentAudio.paused ? currentAudio.play() : currentAudio.pause();
      btn.innerHTML = currentAudio.paused ? '<i class="fas fa-play"></i>' : '<i class="fas fa-pause"></i>';
      return;
    }
    currentAudio.pause();
  }
  currentAudio = new Audio(url);
  currentAudio.play();
  btn.innerHTML = '<i class="fas fa-pause"></i>';
  currentAudio.onended = () => { btn.innerHTML = '<i class="fas fa-play"></i>'; currentAudio = null; };
}

// ====== CALLS ======
async function startVoiceCall() {
  if (!activeChat || activeChatType !== 'user') return;
  await initCall(false);
}

async function startVideoCall() {
  if (!activeChat || activeChatType !== 'user') return;
  await initCall(true);
}

async function initCall(video) {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: video });
    
    if (peerConnection) { peerConnection.close(); peerConnection = null; }
    
    peerConnection = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });
    
    localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));
    
    peerConnection.onicecandidate = e => {
      if (e.candidate) socket.emit('callCandidate', { to: activeChat, candidate: e.candidate });
    };
    
    peerConnection.ontrack = e => {
      document.getElementById('remoteVideo').srcObject = e.streams[0];
    };
    
    peerConnection.onconnectionstatechange = () => {
      if (peerConnection && (peerConnection.connectionState === 'disconnected' || peerConnection.connectionState === 'failed')) {
        endCall();
      }
    };
    
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('callOffer', { to: activeChat, offer });
    
    showCallUI();
  } catch (e) {
    alert('Ошибка звонка. Проверьте камеру и микрофон.');
  }
}

async function acceptCall() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    
    if (peerConnection) { peerConnection.close(); peerConnection = null; }
    
    peerConnection = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });
    
    localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));
    
    peerConnection.onicecandidate = e => {
      if (e.candidate && incomingCallFrom) {
        socket.emit('callCandidate', { to: incomingCallFrom, candidate: e.candidate });
      }
    };
    
    peerConnection.ontrack = e => {
      document.getElementById('remoteVideo').srcObject = e.streams[0];
    };
    
    await peerConnection.setRemoteDescription(new RTCSessionDescription(incomingOffer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socket.emit('callAnswer', { to: incomingCallFrom, answer });
    
    document.getElementById('incomingCallModal').style.display = 'none';
    activeChat = incomingCallFrom;
    activeChatType = 'user';
    showCallUI();
  } catch (e) {
    rejectCall();
  }
}

function rejectCall() {
  if (incomingCallFrom) socket.emit('callEnd', { to: incomingCallFrom });
  document.getElementById('incomingCallModal').style.display = 'none';
  incomingOffer = null;
  incomingCallFrom = null;
}

function showCallUI() {
  document.getElementById('callModal').style.display = 'flex';
  document.getElementById('localVideo').srcObject = localStream;
  document.getElementById('callPartnerName2').textContent = activeChat;
  
  let seconds = 0;
  clearInterval(callTimer);
  callTimer = setInterval(() => {
    seconds++;
    document.getElementById('callDuration').textContent = formatDur(seconds);
  }, 1000);
}

function endCall() {
  clearInterval(callTimer);
  if (peerConnection) { peerConnection.close(); peerConnection = null; }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (activeChat) socket.emit('callEnd', { to: activeChat });
  document.getElementById('callModal').style.display = 'none';
  document.getElementById('remoteVideo').srcObject = null;
  document.getElementById('localVideo').srcObject = null;
}

function toggleMute() {
  if (localStream) {
    const t = localStream.getAudioTracks()[0];
    if (t) {
      t.enabled = !t.enabled;
      document.getElementById('muteBtn').style.background = t.enabled ? '' : 'var(--danger)';
    }
  }
}

function toggleVideo() {
  if (localStream) {
    const t = localStream.getVideoTracks()[0];
    if (t) {
      t.enabled = !t.enabled;
      document.getElementById('videoToggleBtn').style.background = t.enabled ? '' : 'var(--danger)';
    }
  }
}

// ====== AVATAR ======
async function changeAvatar() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('avatar', file);
    const r = await fetch('/api/avatar', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + currentUser.token },
      body: fd
    });
    const d = await r.json();
    if (d.avatar) {
      currentUser.user.avatar = d.avatar;
      document.getElementById('userAvatar').src = d.avatar;
    }
  };
  input.click();
}

// ====== UTILS ======
function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

function formatDur(s) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m + ':' + sec.toString().padStart(2, '0');
}

// Event listeners
document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-box') && !e.target.closest('#searchResults')) {
    const sr = document.getElementById('searchResults');
    if (sr) sr.style.display = 'none';
  }
});

// Typing indicator
let typingTO;
document.addEventListener('DOMContentLoaded', () => {
  const msgInput = document.getElementById('messageInput');
  if (msgInput) {
    msgInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') sendMessage();
    });
    
    msgInput.addEventListener('input', () => {
      if (!activeChat || !socket || activeChatType !== 'user') return;
      socket.emit('typing', { to: activeChat });
      clearTimeout(typingTO);
      typingTO = setTimeout(() => socket.emit('stopTyping', { to: activeChat }), 2000);
    });
  }
});