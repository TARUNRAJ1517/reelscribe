function switchTab(tab) {
  const isLogin = tab === 'login';
  document.getElementById('loginView').style.display = isLogin ? 'block' : 'none';
  document.getElementById('signupView').style.display = isLogin ? 'none' : 'block';
  document.getElementById('tabLogin').classList.toggle('active', isLogin);
  document.getElementById('tabSignup').classList.toggle('active', !isLogin);
}

const nextParam = new URLSearchParams(window.location.search).get('next');
const nextPath = (nextParam && nextParam.startsWith('/')) ? nextParam : '/dashboard.html';

function googleLogin() { window.location.href = '/auth/google?next=' + encodeURIComponent(nextPath); }

function showStatus(id, msg, type) {
  const el = document.getElementById(id);
  el.innerText = msg; el.className = 'status-msg ' + type; el.style.display = 'block';
}

async function sendLoginOtp() {
  const email = document.getElementById('loginEmail').value.trim();
  if (!email || !email.includes('@')) { showStatus('loginStep1Status', 'Please enter a valid email address.', 'error'); return; }
  const btn = document.getElementById('loginSendOtp');
  btn.disabled = true; btn.innerText = 'Sending...';
  try {
    const res = await fetch('/send-otp', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ email }) });
    const data = await res.json();
    if (data.success) {
      document.getElementById('loginStep1').style.display = 'none';
      document.getElementById('loginStep2').style.display = 'block';
      document.getElementById('loginEmailShow').innerText = email;
      document.getElementById('loginResend').style.display = 'block';
      document.getElementById('loginOtp').focus();
    } else {
      showStatus('loginStep1Status', data.message || 'Could not send the code. Please try again.', 'error');
      btn.disabled = false; btn.innerText = 'Send Code';
    }
  } catch (e) { showStatus('loginStep1Status', 'Server error, please try again.', 'error'); btn.disabled = false; btn.innerText = 'Send Code'; }
}

async function verifyLoginOtp() {
  const email = document.getElementById('loginEmail').value.trim();
  const otp = document.getElementById('loginOtp').value.trim();
  if (otp.length < 6) { showStatus('loginStep2Status', 'Please enter the full 6-digit code.', 'error'); return; }
  try {
    const res = await fetch('/verify-otp', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ email, otp }) });
    const data = await res.json();
    if (data.success) {
      localStorage.setItem('userEmail', email); // display only — the server session (set on verify) is what actually authenticates you
      showStatus('loginStep2Status', 'Logged in successfully!', 'success');
      setTimeout(() => { window.location.href = nextPath; }, 800);
    } else {
      showStatus('loginStep2Status', data.message || 'Invalid code.', 'error');
    }
  } catch (e) { showStatus('loginStep2Status', 'Server error, please try again.', 'error'); }
}

async function sendSignupOtp() {
  const email = document.getElementById('signupEmail').value.trim();
  if (!email || !email.includes('@')) { showStatus('signupStep1Status', 'Please enter a valid email address.', 'error'); return; }
  const btn = document.getElementById('signupSendOtp');
  btn.disabled = true; btn.innerText = 'Sending...';
  try {
    const res = await fetch('/send-otp', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ email }) });
    const data = await res.json();
    if (data.success) {
      document.getElementById('signupStep1').style.display = 'none';
      document.getElementById('signupStep2').style.display = 'block';
      document.getElementById('signupEmailShow').innerText = email;
      document.getElementById('signupResend').style.display = 'block';
      document.getElementById('signupOtp').focus();
    } else {
      showStatus('signupStep1Status', data.message || 'Could not send the code. Please try again.', 'error');
      btn.disabled = false; btn.innerText = 'Send Code';
    }
  } catch (e) { showStatus('signupStep1Status', 'Server error, please try again.', 'error'); btn.disabled = false; btn.innerText = 'Send Code'; }
}

async function verifySignupOtp() {
  const email = document.getElementById('signupEmail').value.trim();
  const otp = document.getElementById('signupOtp').value.trim();
  if (otp.length < 6) { showStatus('signupStep2Status', 'Please enter the full 6-digit code.', 'error'); return; }
  try {
    const res = await fetch('/verify-otp', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ email, otp }) });
    const data = await res.json();
    if (data.success) {
      localStorage.setItem('userEmail', email);
      showStatus('signupStep2Status', 'Account created!', 'success');
      setTimeout(() => { window.location.href = nextPath; }, 800);
    } else {
      showStatus('signupStep2Status', data.message || 'Invalid code.', 'error');
    }
  } catch (e) { showStatus('signupStep2Status', 'Server error, please try again.', 'error'); }
}

const urlTab = new URLSearchParams(window.location.search).get('tab');
if (urlTab === 'signup') switchTab('signup');
