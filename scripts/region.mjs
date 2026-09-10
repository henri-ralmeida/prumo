import { execFileSync } from 'node:child_process'

let cached

// Country/region preferences, not display language, browser language or IP location.
export function regionalLanguage({ platform = process.platform, env = process.env, run = execFileSync } = {}) {
  const cacheable = platform === process.platform && env === process.env && run === execFileSync
  if (cacheable && cached) return cached
  const read = (command, args) => String(run(command, args, { env, encoding: 'utf8', timeout: 3000, maxBuffer: 4096, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })).trim()
  let brazil = false
  try {
    if (platform === 'win32') {
      // Windows geographical-location identifier 32 is Brazil.
      brazil = read('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-WinHomeLocation).GeoId']) === '32'
    } else if (platform === 'darwin') {
      brazil = /[-_]BR(?:[.@-]|$)/i.test(read('/usr/bin/defaults', ['read', '-g', 'AppleLocale']))
    } else if (platform === 'linux') {
      brazil = /^country_ab2="?BR"?$/im.test(read('/usr/bin/locale', ['-k', 'LC_ADDRESS']))
    }
  } catch { /* Missing or unavailable regional settings fall back to English. */ }
  const lang = brazil ? 'pt-BR' : 'en'
  if (cacheable) cached = lang
  return lang
}
