// 1688 Cookie helper popup logic: read all 1688 cookies (including HttpOnly
// login cookies) and POST them to the local DSH grabber endpoint.
const DSH_URL = 'http://127.0.0.1:3080/api/grab1688/browser-cookie'

const button = document.getElementById('send')
const status = document.getElementById('status')

function setStatus(text, ok) {
  status.textContent = text
  status.className = ok ? 'ok' : ok === false ? 'err' : ''
}

button.addEventListener('click', async () => {
  button.disabled = true
  setStatus('正在读取 1688 Cookie…', undefined)
  try {
    // GetAll matches cookies for 1688.com and its subdomains, including
    // HttpOnly login cookies (cookie2, _tb_token_, sg, etc.).
    const cookies = await chrome.cookies.getAll({ domain: '.1688.com' })
    if (cookies.length === 0) {
      setStatus('未找到 1688 的 Cookie。请先登录 1688.com，然后重试。', false)
      button.disabled = false
      return
    }
    const header = cookies.map(c => `${c.name}=${c.value}`).join('; ')
    const res = await fetch(DSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie: header }),
    })
    if (!res.ok) {
      setStatus(`发送失败：DSH 返回 HTTP ${res.status}。请确认 DeepSeek Harness 正在运行。`, false)
      button.disabled = false
      return
    }
    const data = await res.json()
    if (data.ok !== true) {
      setStatus(`发送失败：${data.error ?? '未知错误'}`, false)
      button.disabled = false
      return
    }
    setStatus(`✅ 已发送 ${cookies.length} 个 Cookie。现在可以回到 DSH 采图面板开始抓取。`, true)
  } catch (e) {
    setStatus(`发送失败：${e.message ?? String(e)}。请确认 DeepSeek Harness 正在运行（端口 3080）。`, false)
  } finally {
    button.disabled = false
  }
})
