/**
 * 插件独立 HTTP 服务的鉴权与限流。
 *
 * 设计要点：
 * 1. 只有一个密钥（httpServer.token），不做用户体系。密钥用 crypto.randomBytes 生成，
 *    首次启用服务时落盘到 settings.json，之后只能脱敏查看或整体重置。
 * 2. 登录态不落盘：cookie 里放 `<过期秒>.<HMAC 签名>`，签名密钥直接从 token 派生
 *    （HMAC-SHA256）。这样重置密钥会让所有旧 cookie 立刻失效，无需额外的吊销表。
 * 3. 限流用进程内 Map：同一 IP 连续失败 5 次锁 60 秒。重启即清零，够用且零依赖。
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const COOKIE_NAME = 'qq_digest_session'
export const FAIL_LIMIT = 5
export const LOCK_MS = 60000

const SESSION_PREFIX = 'qq-digest-session:'

/** ip → { failures, lockedUntil } */
const buckets = new Map()
let sweeper = null

/** 定时清理过期项，避免长期运行把 Map 撑大。惰性创建且 unref，不拖住进程退出。 */
function ensureSweeper() {
  if (sweeper) return
  sweeper = setInterval(() => {
    const now = Date.now()
    for (const [ip, b] of buckets) {
      if (b.lockedUntil > now) continue
      if (b.failures === 0) buckets.delete(ip)
    }
  }, LOCK_MS)
  if (typeof sweeper.unref === 'function') sweeper.unref()
}

function bucketFor(ip) {
  const key = String(ip == null ? '' : ip) || 'unknown'
  let b = buckets.get(key)
  if (!b) {
    b = { failures: 0, lockedUntil: 0 }
    buckets.set(key, b)
  }
  return b
}

/**
 * 查询某 IP 是否被锁。返回 { blocked, retryAfterSec }。
 */
export function rateLimit(ip) {
  ensureSweeper()
  const b = bucketFor(ip)
  const now = Date.now()
  if (b.lockedUntil > now) {
    return { blocked: true, retryAfterSec: Math.max(1, Math.ceil((b.lockedUntil - now) / 1000)) }
  }
  if (b.lockedUntil !== 0) {
    // 锁已过期：重置计数，给一次干净的重试机会。
    b.lockedUntil = 0
    b.failures = 0
  }
  return { blocked: false, retryAfterSec: 0 }
}

/** 记一次失败；达到阈值就上锁。返回当前状态。 */
export function recordFailure(ip) {
  ensureSweeper()
  const b = bucketFor(ip)
  const now = Date.now()
  if (b.lockedUntil > now) {
    return { blocked: true, retryAfterSec: Math.max(1, Math.ceil((b.lockedUntil - now) / 1000)) }
  }
  b.failures += 1
  if (b.failures >= FAIL_LIMIT) {
    b.lockedUntil = now + LOCK_MS
    return { blocked: true, retryAfterSec: Math.ceil(LOCK_MS / 1000) }
  }
  return { blocked: false, retryAfterSec: 0, remaining: FAIL_LIMIT - b.failures }
}

/** 登录成功：清空该 IP 的失败计数。 */
export function recordSuccess(ip) {
  buckets.delete(String(ip == null ? '' : ip) || 'unknown')
}

/** 清空全部限流状态（测试用；生产上等价于「重启后清零」）。 */
export function resetRateLimit() {
  buckets.clear()
}

/** 定长安全比较：长度不同直接 false，避免 timingSafeEqual 抛错。 */
function safeEqual(a, b) {
  const left = Buffer.from(String(a == null ? '' : a), 'utf8')
  const right = Buffer.from(String(b == null ? '' : b), 'utf8')
  if (left.length !== right.length || left.length === 0) return false
  return timingSafeEqual(left, right)
}

/** 校验用户提交的密钥。长度不等先返回 false（不泄漏长度信息）。 */
export function verifyToken(input, expected) {
  const want = String(expected == null ? '' : expected)
  if (!want) return false
  return safeEqual(input, want)
}

/** 生成新的随机密钥（24 字节 → 32 字符 base64url）。 */
export function generateToken() {
  return randomBytes(24).toString('base64url')
}

/**
 * 取 httpServer 段：既接受完整配置，也接受 httpServer 子对象本身。
 */
function httpSection(cfg) {
  if (!cfg || typeof cfg !== 'object') return null
  if (cfg.httpServer && typeof cfg.httpServer === 'object') return cfg.httpServer
  return cfg
}

/**
 * token 为空时随机生成一个并落盘。返回最终生效的 token。
 *
 * writeSettings 是「保存一份覆盖」的回调：形如 (patch) => void，
 * patch 例如 { httpServer: { token } }。落盘失败不影响本次运行（内存里已生效）。
 */
export function ensureToken(cfg, writeSettings) {
  const section = httpSection(cfg)
  if (!section) return ''
  const current = String(section.token == null ? '' : section.token).trim()
  if (current) return current
  const token = generateToken()
  section.token = token
  if (typeof writeSettings === 'function') {
    try {
      writeSettings({ httpServer: { token } })
    } catch {
      /* 落盘失败仍然用内存里的新密钥，下次启动会重新生成 */
    }
  }
  return token
}

/** 签发登录态：`<过期秒>.<hmac>`。 */
export function signSession(token, hours) {
  const h = Math.max(1, Math.trunc(Number(hours) || 168))
  const exp = Math.trunc(Date.now() / 1000) + h * 3600
  const sig = createHmac('sha256', String(token == null ? '' : token))
    .update(SESSION_PREFIX + exp)
    .digest('base64url')
  return exp + '.' + sig
}

/** 校验登录态：格式、过期、签名三项都对才算通过。 */
export function verifySession(cookieValue, token) {
  const raw = String(cookieValue == null ? '' : cookieValue)
  const secret = String(token == null ? '' : token)
  if (!raw || !secret) return false
  const dot = raw.indexOf('.')
  if (dot <= 0) return false
  const expText = raw.slice(0, dot)
  const sig = raw.slice(dot + 1)
  const exp = Number(expText)
  if (!Number.isFinite(exp) || exp <= 0) return false
  if (exp * 1000 <= Date.now()) return false
  const expected = createHmac('sha256', secret).update(SESSION_PREFIX + exp).digest('base64url')
  return safeEqual(sig, expected)
}

/** 生成 Set-Cookie 头。HttpOnly 防 XSS 读取，SameSite=Lax 防 CSRF。 */
export function makeCookie(value, hours) {
  const h = Math.max(1, Math.trunc(Number(hours) || 168))
  const parts = [
    COOKIE_NAME + '=' + String(value == null ? '' : value),
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=' + h * 3600,
  ]
  return parts.join('; ')
}

/** 生成一个立即过期的 Set-Cookie 头（退出登录）。 */
export function clearCookie() {
  return COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'
}

/** 解析 Cookie 请求头为对象。畸形片段直接跳过。 */
export function parseCookies(header) {
  const out = {}
  const raw = String(header == null ? '' : header)
  if (!raw) return out
  for (const piece of raw.split(';')) {
    const eq = piece.indexOf('=')
    if (eq <= 0) continue
    const key = piece.slice(0, eq).trim()
    if (!key) continue
    const value = piece.slice(eq + 1).trim()
    try {
      out[key] = decodeURIComponent(value)
    } catch {
      out[key] = value
    }
  }
  return out
}
