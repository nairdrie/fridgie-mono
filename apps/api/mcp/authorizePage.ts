// The one web page the connector has: where the user, sent here by Claude,
// proves who they are by typing the code their Fridgie app is showing.

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const STYLES = `
  :root { --bg:#F5F5EF; --card:#FFFFFF; --text:#173F35; --muted:#687A70; --tint:#23785E; --tint-text:#FFFFFF; --border:#DDE3DC; --error:#B3261E; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#14251E; --card:#1C3129; --text:#ECEDEE; --muted:#9BA1A6; --tint:#BFE4CC; --tint-text:#14251E; --border:#2C4439; --error:#F2B8B5; }
  }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:16px;
         background:var(--bg); color:var(--text); font:16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { width:100%; max-width:420px; background:var(--card); border:1px solid var(--border); border-radius:20px; padding:28px 24px; }
  h1 { font-size:22px; margin:0 0 4px; }
  .brand { font-weight:700; color:var(--tint); letter-spacing:.02em; margin-bottom:16px; }
  p { margin:0 0 12px; color:var(--muted); }
  ol { margin:0 0 20px; padding-left:20px; color:var(--muted); }
  ol b { color:var(--text); }
  label { display:block; font-weight:600; margin-bottom:6px; }
  input[type=text] { width:100%; font:600 24px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing:.18em; text-transform:uppercase;
                     text-align:center; padding:14px 12px; border-radius:12px; border:1px solid var(--border); background:var(--bg); color:var(--text); }
  input[type=text]:focus { outline:2px solid var(--tint); outline-offset:1px; }
  button { width:100%; margin-top:16px; padding:14px; border:0; border-radius:12px; background:var(--tint); color:var(--tint-text); font-weight:700; font-size:16px; cursor:pointer; }
  .error { color:var(--error); font-weight:600; margin:10px 0 0; }
  .fine { font-size:13px; margin-top:16px; }
`

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body><main>${body}</main></body>
</html>`
}

export function renderAuthorizePage(input: {
  clientName: string
  redirectHost: string
  /** Every authorization parameter, carried through the form untouched. */
  params: Record<string, string>
  error?: string
  linkCode?: string
}): string {
  const hidden = Object.entries(input.params)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join('')
  const error = input.error ? `<p class="error" role="alert">${escapeHtml(input.error)}</p>` : ''

  return shell('Connect to Fridgie', `
    <div class="brand">Fridgie</div>
    <h1>Connect ${escapeHtml(input.clientName)}</h1>
    <p>${escapeHtml(input.clientName)} is asking to add meals, recipes and groceries to your Fridgie account.</p>
    <ol>
      <li>Open the <b>Fridgie</b> app</li>
      <li>Go to <b>Profile → Connect Claude</b></li>
      <li>Tap <b>Get a code</b> and type it below</li>
    </ol>
    <form method="post" action="/oauth/authorize" autocomplete="off">
      ${hidden}
      <label for="link_code">Connection code</label>
      <input id="link_code" name="link_code" type="text" inputmode="text" autocapitalize="characters" spellcheck="false"
             maxlength="12" placeholder="ABCD-EFGH" required autofocus value="${escapeHtml(input.linkCode ?? '')}">
      ${error}
      <button type="submit">Connect</button>
    </form>
    <p class="fine">You'll be sent back to <b>${escapeHtml(input.redirectHost)}</b>. You can disconnect at any time from the same screen in the app.</p>
  `)
}

export function renderErrorPage(message: string): string {
  return shell('Fridgie — connection problem', `
    <div class="brand">Fridgie</div>
    <h1>Something's not right</h1>
    <p>${escapeHtml(message)}</p>
    <p>Try adding the connector again from Claude.</p>
  `)
}
