interface RenderLoginOptions {
  title: string;
  basePath: string;
  error?: string;
  redirect?: string;
  username?: string;
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderLoginPage(opts: RenderLoginOptions): string {
  const title = esc(opts.title);
  const action = `${esc(opts.basePath)}/auth/login`;
  const redirect = opts.redirect ? esc(opts.redirect) : "";
  const username = opts.username ? esc(opts.username) : "";
  const errorBlock = opts.error ? `<div class="error" role="alert">${esc(opts.error)}</div>` : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — sign in</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: #0b0d10;
    color: #e5e7eb;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    display: flex; align-items: center; justify-content: center;
    padding: 24px;
  }
  .card {
    width: 100%; max-width: 360px;
    background: #15181d;
    border: 1px solid #262a31;
    border-radius: 10px;
    padding: 28px;
    box-shadow: 0 10px 30px rgba(0,0,0,0.35);
  }
  h1 {
    margin: 0 0 20px;
    font-size: 16px; font-weight: 600;
    color: #e5e7eb;
    letter-spacing: 0.01em;
  }
  label {
    display: block;
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
    color: #8b95a7;
    margin-bottom: 6px;
  }
  input[type="text"], input[type="password"] {
    width: 100%;
    background: #0b0d10;
    border: 1px solid #262a31;
    border-radius: 6px;
    color: #e5e7eb;
    font: inherit; font-size: 14px;
    padding: 9px 11px;
    margin-bottom: 14px;
    outline: none;
    transition: border-color 120ms;
  }
  input[type="text"]:focus, input[type="password"]:focus {
    border-color: #60a5fa;
  }
  button {
    width: 100%;
    background: #60a5fa;
    color: #0b0d10;
    border: 0;
    border-radius: 6px;
    font: inherit; font-weight: 600; font-size: 14px;
    padding: 10px 14px;
    cursor: pointer;
    transition: background 120ms;
  }
  button:hover { background: #93c0fc; }
  .error {
    background: rgba(248, 113, 113, 0.08);
    border: 1px solid rgba(248, 113, 113, 0.35);
    color: #fca5a5;
    font-size: 13px;
    padding: 9px 11px;
    border-radius: 6px;
    margin-bottom: 14px;
  }
</style>
</head>
<body>
  <main class="card">
    <h1>${title}</h1>
    ${errorBlock}
    <form method="post" action="${action}">
      <input type="hidden" name="redirect" value="${redirect}">
      <label for="taskora-username">Username</label>
      <input id="taskora-username" name="username" type="text" autocomplete="username" autofocus value="${username}" required>
      <label for="taskora-password">Password</label>
      <input id="taskora-password" name="password" type="password" autocomplete="current-password" required>
      <button type="submit">Sign in</button>
    </form>
  </main>
</body>
</html>`;
}
