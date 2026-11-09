/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-require-imports */
const { existsSync, readFileSync } = require('node:fs')
const { mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { dirname, join, resolve } = require('node:path')
const { spawn } = require('node:child_process')
const { createFixture } = require('./performance-fixture.cjs')

function option(name, fallback) {
  const prefix = `--${name}=`
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback
}

async function executablePath() {
  const override = option('executable', '')
  if (override) {
    const executable = resolve(override)
    if (!existsSync(executable)) throw new Error(`Packaged app not found: ${executable}`)
    return executable
  }
  const candidates =
    process.platform === 'win32'
      ? ['dist/win-unpacked/kusu.exe']
      : process.platform === 'darwin'
        ? ['dist/mac/Kusu.app/Contents/MacOS/Kusu', 'dist/mac-arm64/Kusu.app/Contents/MacOS/Kusu']
        : ['dist/linux-unpacked/kusu']
  const match = candidates.map((candidate) => resolve(candidate)).find(existsSync)
  if (!match) throw new Error('Packaged app not found. Run pnpm build:unpack first.')
  return match
}

function runApp(executable, env, duration, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, args, { env: { ...process.env, ...env }, stdio: 'inherit' })
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error('Packaged performance run timed out.'))
    }, duration + 15_000)
    child.once('error', reject)
    child.once('exit', (code) => {
      clearTimeout(timeout)
      if (code === 0) resolveRun()
      else reject(new Error(`Packaged app exited with ${code}.`))
    })
  })
}

function percentile(values, ratio) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(ratio * sorted.length)))
  return sorted[index]
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)] ?? null
}

function p95(values) {
  return percentile(values, 0.95)
}

async function main() {
  const runs = Math.max(1, Number(option('runs', '3')) || 3)
  const itemCount = Math.max(1, Number(option('items', '5000')) || 5000)
  const preview = process.argv.includes('--preview')
  const mixed = process.argv.includes('--mixed')
  const browsing = process.argv.includes('--browsing')
  const typing = process.argv.includes('--typing')
  const screenshots = process.argv.includes('--screenshots')
  if (browsing && typing) throw new Error('Run browsing and typing scenarios separately.')
  if (screenshots && typing) throw new Error('Run screenshots and typing scenarios separately.')
  const defaultDuration = typing || browsing ? '90000' : '30000'
  const duration = Math.max(
    1_000,
    Number(option('duration-ms', defaultDuration)) || Number(defaultDuration)
  )
  const output = resolve(option('output', '.performance/packaged.ndjson'))
  const root = await mkdtemp(join(tmpdir(), 'kusu-packaged-performance-'))
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, '')
  try {
    const executable = preview ? require('electron') : await executablePath()
    const userData = await createFixture(root, itemCount, mixed)
    for (let run = 1; run <= runs; run += 1) {
      await runApp(
        executable,
        {
          KUSU_PERFORMANCE_OUTPUT: output,
          KUSU_PERFORMANCE_USER_DATA: userData,
          KUSU_PERFORMANCE_RUN: String(run),
          KUSU_PERFORMANCE_SCREENSHOTS: screenshots ? '1' : '0',
          KUSU_PERFORMANCE_BROWSING: browsing ? '1' : '0',
          KUSU_PERFORMANCE_DURATION_MS: String(duration),
          ...(typing ? { KUSU_PERFORMANCE_TYPING: '1' } : {})
        },
        duration,
        preview ? [resolve(__dirname, '..')] : []
      )
    }
    const entries = readFileSync(output, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    if (screenshots) {
      const errors = entries.filter((entry) => entry.event.endsWith('-error'))
      if (errors.length) throw new Error(JSON.stringify(errors))
      for (let run = 1; run <= runs; run += 1) {
        const events = entries.filter((entry) => Number(entry.run) === run)
        for (const mode of ['light', 'dark']) {
          if (!events.some((entry) => entry.event === 'screenshot' && entry.data.mode === mode)) {
            throw new Error(`Missing ${mode} screenshot for run ${run}.`)
          }
        }
        if (!events.some((entry) => entry.event === 'reduced-motion' && entry.data.verified)) {
          throw new Error(`Missing reduced-motion verification for run ${run}.`)
        }
      }
    }
    const firstCards = entries
      .filter((entry) => entry.event === 'first-card')
      .map((entry) => ({ run: Number(entry.run), milliseconds: entry.data.milliseconds }))
    const cachedFirstCards = firstCards
      .filter((entry) => entry.run > 1 || runs === 1)
      .map((entry) => entry.milliseconds)
    const settledMemory = entries
      .filter((entry) => entry.event === 'settled-memory')
      .map((entry) => entry.data.totalWorkingSetKb / 1024)
    const settledCpu = entries
      .filter((entry) => entry.event === 'settled-memory')
      .map((entry) => entry.data.totalCpuPercent)
    const settledProcessCounts = entries
      .filter((entry) => entry.event === 'settled-memory')
      .map((entry) => entry.data.processes.length)

    const summary = {
      runs,
      itemCount,
      mixed,
      packaged: !preview,
      cachedFirstCardMedianMs: median(cachedFirstCards),
      settledWorkingSetMedianMb: median(settledMemory),
      settledCpuMedianPercent: median(settledCpu),
      settledProcessCountMedian: median(settledProcessCounts),
      output
    }

    if (browsing) {
      const scenarios = entries.filter((entry) => entry.event === 'browsing')
      const errors = entries.filter((entry) => entry.event === 'browsing-error')
      if (errors.length || scenarios.length !== runs)
        throw new Error(JSON.stringify(errors.length ? errors : 'Missing browsing results'))
      summary.browsing = {
        maximumMountedCards: Math.max(
          ...scenarios.flatMap((entry) => entry.data.samples.map((sample) => sample.mounted))
        ),
        selectionP95Ms: p95(scenarios.flatMap((entry) => entry.data.selectionLatencies)),
        scrollFrameP95Ms: p95(scenarios.flatMap((entry) => entry.data.scrollFrameIntervals)),
        scrollMaxLongTaskMs: Math.max(
          0,
          ...scenarios.flatMap((entry) => entry.data.scrollLongTasks)
        )
      }
      summary.browsing.focusMaximumMounted = Math.max(
        ...scenarios.map((entry) => entry.data.interactions.maxFocusMounted)
      )
      summary.browsing.interactions = [
        ...new Set(
          scenarios.flatMap((entry) => entry.data.interactions.timings.map((timing) => timing.name))
        )
      ].map((name) => ({
        name,
        p95Ms: p95(
          scenarios.flatMap((entry) =>
            entry.data.interactions.timings
              .filter((timing) => timing.name === name)
              .map((timing) => timing.milliseconds)
          )
        )
      }))
      summary.browsing.vaultScansDuringInteraction = Math.max(
        ...scenarios.map((entry) => entry.data.vaultScansDuringInteraction)
      )
      if (summary.browsing.vaultScansDuringInteraction !== 0)
        throw new Error('Ordinary interactions triggered a full vault scan.')
      if (summary.browsing.focusMaximumMounted > 150)
        throw new Error('Focus exceeded 150 mounted items.')
      if (mixed && scenarios.some((entry) => entry.data.interactions.mediaTypes.length !== 3))
        throw new Error('Mixed scenario did not open every media type.')
      if (summary.browsing.maximumMountedCards > 150)
        throw new Error('Browsing mounted more than 150 cards.')
      if (summary.browsing.selectionP95Ms > 100) throw new Error('Selection exceeded 100 ms p95.')
    }

    if (typing) {
      const typingEvents = entries.filter((entry) => entry.event === 'typing')
      if (typingEvents.length !== runs) {
        throw new Error('A packaged run did not complete the typing scenario.')
      }
      if (typingEvents.some((entry) => entry.data.completed === false)) {
        throw new Error(
          'A typing scenario never reached an interactive workspace (no search trigger found).'
        )
      }
      const searchKeyLatencies = typingEvents.flatMap((entry) => entry.data.search.keyLatencies)
      const noteKeyLatencies = typingEvents.flatMap((entry) => entry.data.note.keyLatencies)
      const longTasks = typingEvents.flatMap((entry) => [
        ...entry.data.search.longTasks,
        ...entry.data.note.longTasks
      ])
      const ipcCalls = entries.filter((entry) => entry.event === 'ipc-call')
      const queryItems = ipcCalls
        .filter((entry) => entry.data.channel === 'library:query-items')
        .map((entry) => entry.data.milliseconds)
      const updateNotes = ipcCalls
        .filter((entry) => entry.data.channel === 'library:update-note')
        .map((entry) => entry.data.milliseconds)
      const vaultScans = Math.max(...typingEvents.map((entry) => entry.data.vaultScans))
      const autosaveScans = Math.max(...typingEvents.map((entry) => entry.data.autosaveScans))
      if (!Number.isFinite(autosaveScans))
        throw new Error('Typing did not report autosave scan measurements.')
      summary.typing = {
        searchKeystrokeP95Ms: p95(searchKeyLatencies),
        noteKeystrokeP95Ms: p95(noteKeyLatencies),
        maxLongTaskMs: Math.max(0, ...longTasks),
        droppedFramesPerRun: typingEvents.map(
          (entry) => entry.data.search.droppedFrames + entry.data.note.droppedFrames
        ),
        queryItemsCount: queryItems.length,
        queryItemsP95Ms: p95(queryItems),
        updateNoteP95Ms: p95(updateNotes),
        vaultScans,
        autosaveScans
      }
      const budgetMs = 100
      const below = (value, label) => {
        if (value === null) throw new Error(`${label} produced no measurements.`)
        if (value > budgetMs) throw new Error(`${label} exceeded ${budgetMs} ms: ${value} ms.`)
      }
      below(p95(searchKeyLatencies), 'Search keystroke p95')
      below(p95(noteKeyLatencies), 'Note editor keystroke p95')
      below(p95(queryItems), 'queryItems p95')
      below(p95(updateNotes), 'updateNote p95')
      if (Math.max(0, ...longTasks) > budgetMs) {
        throw new Error(`Long task exceeded ${budgetMs} ms during typing.`)
      }
      if (autosaveScans !== 0) {
        throw new Error(`Note autosave triggered ${autosaveScans} full vault scans.`)
      }
    }

    console.log(JSON.stringify(summary))
    if (firstCards.length !== runs) throw new Error('A packaged run did not reach the first card.')
    if (runs > 1 && median(cachedFirstCards) > 1_200) {
      throw new Error(`Cached first card exceeded 1,200 ms: ${median(cachedFirstCards)} ms.`)
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
