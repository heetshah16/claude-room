import { spawnPortable } from './spawn.mjs'

/**
 * Recover a JSON object from model output that may be fenced or wrapped in
 * prose. Returns null rather than throwing — the caller keeps its previous
 * brief when parsing fails, and unparsed text is never injected anywhere.
 */
export function extractJSON(text) {
  if (typeof text !== 'string') return null
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

// The observer must not be able to touch anything. Even though it only ever
// summarises, it reads text written by room members, so it runs with the tool
// surface removed rather than merely unused.
const NO_TOOLS = 'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit'

function defaultSpawn(cmd, args, prompt) {
  return new Promise(resolve => {
    // spawnPortable rather than a bare spawn: on a machine where `claude` is
    // an npm .cmd shim, a bare spawn fails ENOENT and the observer silently
    // never produces a brief.
    const child = spawnPortable(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('error', err => resolve({ stdout: '', stderr: String(err.message), code: -1 }))
    child.on('close', code => resolve({ stdout, stderr, code }))
    child.stdin.end(prompt)
  })
}

/**
 * @returns {(prompt:string) => Promise<{text:string, tokens:{input:number,output:number}}>}
 */
export function makeRunner(config, { spawn = defaultSpawn } = {}) {
  const args = [
    '-p',
    '--model', config.observer.model,
    '--output-format', 'json',
    '--disallowed-tools', NO_TOOLS,
  ]

  return async function runModel(prompt) {
    const { stdout, stderr, code } = await spawn('claude', args, prompt)
    if (code !== 0) throw new Error(`observer exit ${code}: ${String(stderr).slice(0, 200)}`)

    let parsed
    try {
      parsed = JSON.parse(stdout)
    } catch {
      // Not the envelope we expected; hand the raw text on and let the brief
      // parser decide, rather than losing a usable result to a format change.
      return { text: stdout, tokens: { input: 0, output: 0 } }
    }

    const u = parsed.usage ?? {}
    return {
      text: typeof parsed.result === 'string' ? parsed.result : stdout,
      tokens: {
        input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        output: u.output_tokens ?? 0,
      },
    }
  }
}
