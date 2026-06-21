// rackoona — login page.
//
// Posts credentials to /auth/login; on success the server sets an httpOnly session
// cookie and we navigate to the originally requested page (?next=) or the dashboard.

const form = document.getElementById("login-form");
const errorBox = document.getElementById("error");
const submitBtn = document.getElementById("submit");
const usernameEl = document.getElementById("username");
const passwordEl = document.getElementById("password");

/** Where to land after a successful sign-in (only same-origin paths are honored). */
function nextTarget() {
  const raw = new URLSearchParams(location.search).get("next");
  // Guard against open-redirects: accept only a root-relative path.
  return raw && /^\/[^/\\]/.test(raw) ? raw : "/";
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function clearError() {
  errorBox.hidden = true;
  errorBox.textContent = "";
}

async function submit(event) {
  event.preventDefault();
  clearError();

  const username = usernameEl.value.trim();
  const password = passwordEl.value;
  if (!username || !password) {
    showError("Enter your username and password.");
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = "Signing in…";

  try {
    const res = await fetch("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });

    if (res.ok) {
      location.replace(nextTarget());
      return;
    }

    const data = await res.json().catch(() => ({}));
    showError(data?.error?.message || `Sign-in failed (HTTP ${res.status}).`);
  } catch (err) {
    console.error("login failed:", err);
    showError("Could not reach the server. Check your connection and try again.");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Sign in";
  }
}

form.addEventListener("submit", submit);
