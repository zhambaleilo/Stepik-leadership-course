let step = 1;
let isDemoFinished = false;

function handleAction(actionType) {
  if (isDemoFinished) return;
  
  const messagesDiv = document.getElementById('messages');
  const hintsDiv = document.getElementById('hints');
  
  let userText = '';
  let aiText = '';
  
  if (step === 1) {
    if (actionType === 'empathy') {
      userText = 'Алексей, я вижу, что ты перегружен. Это нормально — чувствовать себя так перед дедлайном. Давай обсудим, что можно перенести.';
      aiText = 'Спасибо... Просто дедлайн по проекту Х завтра, а я не успеваю закончить тесты. Я чувствую, что подведу команду.';
      document.getElementById('placeholder').style.display = 'none';
      document.getElementById('dashboardCard').classList.add('visible');
      step = 2;
      hintsDiv.innerHTML = '<button class="hint-btn primary" onclick="handleAction(\'yes_and\')">💡 Принцип «Да, и...»</button>';
    } else {
      userText = 'Соберись, у всех бывает. Просто работай быстрее, клиент ждет.';
      aiText = 'Понял. Сделаю как скажете.';
      isDemoFinished = true;
      hintsDiv.innerHTML = '';
      showFinalScreen();
    }
  } else if (step === 2) {
    if (actionType === 'yes_and') {
      userText = 'Да, дедлайн горит. И давай подумаем: какую часть тестов я могу забрать на себя или перенести на понедельник?';
      aiText = 'Правда? Если ты сможешь взять на себя интеграционные тесты, я успею закончить основные до вечера. Это бы очень помогло.';
      isDemoFinished = true;
      hintsDiv.innerHTML = '';
      showFinalScreen();
    }
  }
  
  const userMsg = document.createElement('div');
  userMsg.className = 'message user';
  userMsg.innerHTML = '<div class="bubble">' + escapeHtml(userText) + '</div>';
  messagesDiv.appendChild(userMsg);
  
  setTimeout(() => {
    const aiMsg = document.createElement('div');
    aiMsg.className = 'message ai';
    aiMsg.innerHTML = '<div class="bubble">' + escapeHtml(aiText) + '</div>';
    messagesDiv.appendChild(aiMsg);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  }, 900);
  
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function showFinalScreen() {
  setTimeout(() => {
    document.getElementById('placeholder').style.display = 'none';
    document.getElementById('dashboardCard').style.display = 'none';
    const final = document.getElementById('finalScreen');
    final.style.display = 'block';
    requestAnimationFrame(() => final.classList.add('visible'));
  }, 1200);
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
