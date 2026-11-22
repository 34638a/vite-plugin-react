import { describe, expect, test, vi } from 'vitest'
import {
  createScheduler,
  readConditions,
  splitOnProps,
  type Condition,
  type LoadCondition,
  type SchedulerEnv,
} from '../src/runtime/load'

/** Lets queued promise callbacks run. */
const settle = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

/** A controllable condition: the test decides when it is satisfied. */
function control() {
  let fire!: () => void
  const cancel = vi.fn()
  const condition: Condition = {
    promise: new Promise<void>((resolve) => (fire = resolve)),
    cancel,
  }
  return { condition, fire: () => fire(), cancel }
}

/** A fake environment: idle slices, the page load and every other signal are fired by the test. */
function fakeEnv() {
  const idle: Array<() => void> = []
  let loaded!: () => void
  const pageLoaded = new Promise<void>((r) => (loaded = r))
  const made: Record<string, ReturnType<typeof control>[]> = {
    visible: [],
    interaction: [],
    media: [],
    saveData: [],
  }
  const calls: Record<string, unknown[][]> = {
    visible: [],
    interaction: [],
    media: [],
    saveData: [],
  }
  const timers: Array<{ ms: number; cb: () => void; cleared: boolean }> = []
  const make =
    (kind: string) =>
    (...args: unknown[]): Condition => {
      const c = control()
      made[kind]!.push(c)
      calls[kind]!.push(args)
      return c.condition
    }
  const env: SchedulerEnv = {
    pageLoaded: () => pageLoaded,
    requestIdle: (cb) => void idle.push(cb),
    delay: (ms, cb) => {
      const t = { ms, cb, cleared: false }
      timers.push(t)
      return () => void (t.cleared = true)
    },
    visible: make('visible') as SchedulerEnv['visible'],
    interaction: make('interaction') as SchedulerEnv['interaction'],
    media: make('media') as SchedulerEnv['media'],
    saveData: make('saveData') as SchedulerEnv['saveData'],
  }
  return {
    env,
    made,
    calls,
    loadPage: async () => (loaded(), settle()),
    /** Runs one idle slice (the next requested idle callback). */
    slice: async () => (idle.shift()?.(), settle()),
    pendingSlices: () => idle.length,
    timers,
  }
}

const marker = {} as Element
const box = {} as Element // stands in for an element with a layout box
const ctx = { marker, targets: [box] }

describe('createScheduler', () => {
  test('no conditions: starts at once and returns the start result', async () => {
    const f = fakeEnv()
    const start = vi.fn(async () => {})
    const p = createScheduler(f.env)([], false, ctx, start)
    expect(start).toHaveBeenCalledOnce()
    await expect(p).resolves.toBeUndefined()
  })

  test('onLoad waits for the page load', async () => {
    const f = fakeEnv()
    const start = vi.fn()
    createScheduler(f.env)([{ on: 'load' }], false, ctx, start)
    await settle()
    expect(start).not.toHaveBeenCalled()
    await f.loadPage()
    expect(start).toHaveBeenCalledOnce()
  })

  test('onIdle starts gradually: one island per idle slice, in order, and only after the page load', async () => {
    const f = fakeEnv()
    const schedule = createScheduler(f.env)
    const [a, b, c] = [vi.fn(), vi.fn(), vi.fn()]
    for (const s of [a, b, c]) schedule([{ on: 'idle' }], false, ctx, s)
    await settle()
    expect(f.pendingSlices()).toBe(0) // idle time is not requested before the load
    await f.loadPage()
    const counts = () => [a, b, c].map((s) => s.mock.calls.length)
    await f.slice()
    expect(counts()).toEqual([1, 0, 0])
    await f.slice()
    expect(counts()).toEqual([1, 1, 0])
    await f.slice()
    expect(counts()).toEqual([1, 1, 1])
    expect(f.pendingSlices()).toBe(0)
  })

  test('onIdle with a number is a maximum wait for its turn', async () => {
    const f = fakeEnv()
    const start = vi.fn()
    createScheduler(f.env)([{ on: 'idle', timeout: 500 }], false, ctx, start)
    await f.loadPage()
    expect(f.timers.map((t) => t.ms)).toEqual([500])
    f.timers[0]!.cb() // no idle slice came in time
    await settle()
    expect(start).toHaveBeenCalledOnce()
  })

  test('onVisible watches the island content with its rootMargin', async () => {
    const f = fakeEnv()
    const start = vi.fn()
    createScheduler(f.env)(
      [{ on: 'visible', rootMargin: '200px 0px' }],
      false,
      ctx,
      start,
    )
    expect(f.calls.visible).toEqual([[[box], '200px 0px']])
    f.made.visible[0]!.fire()
    await settle()
    expect(start).toHaveBeenCalledOnce()
  })

  test('onInteraction listens on the marker for its events', async () => {
    const f = fakeEnv()
    const start = vi.fn()
    createScheduler(f.env)(
      [{ on: 'interaction', events: ['mouseenter', 'focusin'] }],
      false,
      ctx,
      start,
    )
    expect(f.calls.interaction).toEqual([[marker, ['mouseenter', 'focusin']]])
    f.made.interaction[0]!.fire()
    await settle()
    expect(start).toHaveBeenCalledOnce()
  })

  test('onInteraction defaults to touchstart and click', () => {
    const f = fakeEnv()
    createScheduler(f.env)([{ on: 'interaction' }], false, ctx, vi.fn())
    expect(f.calls.interaction[0]![1]).toEqual(['touchstart', 'click'])
  })

  test('onMedia and onSaveData pass their value through', async () => {
    const f = fakeEnv()
    createScheduler(f.env)(
      [
        { on: 'media', query: '(min-width: 64em)' },
        { on: 'saveData', expected: false },
      ],
      false,
      ctx,
      vi.fn(),
    )
    expect(f.calls.media).toEqual([['(min-width: 64em)']])
    expect(f.calls.saveData).toEqual([[false]])
  })

  describe('combining', () => {
    const both: LoadCondition[] = [
      { on: 'visible' },
      { on: 'media', query: 'q' },
    ]

    test('all conditions must be satisfied by default (is-land semantics)', async () => {
      const f = fakeEnv()
      const start = vi.fn()
      createScheduler(f.env)(both, false, ctx, start)
      f.made.visible[0]!.fire()
      await settle()
      expect(start).not.toHaveBeenCalled()
      f.made.media[0]!.fire()
      await settle()
      expect(start).toHaveBeenCalledOnce()
    })

    test('onAny: the first condition satisfied starts it, and the others stop watching', async () => {
      const f = fakeEnv()
      const start = vi.fn()
      createScheduler(f.env)(both, true, ctx, start)
      f.made.media[0]!.fire()
      await settle()
      expect(start).toHaveBeenCalledOnce()
      expect(f.made.visible[0]!.cancel).toHaveBeenCalled()
      f.made.visible[0]!.fire() // a late signal changes nothing
      await settle()
      expect(start).toHaveBeenCalledOnce()
    })

    test('onIdle + onVisible + onAny: visible before its idle turn loads it now, and its turn is skipped', async () => {
      const f = fakeEnv()
      const schedule = createScheduler(f.env)
      const hybrid: LoadCondition[] = [{ on: 'idle' }, { on: 'visible' }]
      const [first, second, third] = [vi.fn(), vi.fn(), vi.fn()]
      schedule(hybrid, true, ctx, first)
      schedule(hybrid, true, ctx, second)
      schedule(hybrid, true, ctx, third)
      await f.loadPage()
      f.made.visible[1]!.fire() // second scrolls into view before the gradual loader reaches it
      await settle()
      expect(second).toHaveBeenCalledOnce()
      await f.slice() // first's turn
      await f.slice() // second is already loaded: its turn is skipped, third gets the slice
      expect([first, second, third].map((s) => s.mock.calls.length)).toEqual([
        1, 1, 1,
      ])
    })

    test('onIdle + onVisible without onAny: visible waits for its idle turn too', async () => {
      const f = fakeEnv()
      const start = vi.fn()
      createScheduler(f.env)(
        [{ on: 'idle' }, { on: 'visible' }],
        false,
        ctx,
        start,
      )
      await f.loadPage()
      f.made.visible[0]!.fire()
      await settle()
      expect(start).not.toHaveBeenCalled()
      await f.slice()
      expect(start).toHaveBeenCalledOnce()
    })
  })

  test('visible or interaction with nothing to watch warns and waits for idle instead', async () => {
    const f = fakeEnv()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const start = vi.fn()
    createScheduler(f.env)(
      [{ on: 'visible' }],
      false,
      { marker, targets: [] },
      start,
    )
    createScheduler(f.env)(
      [{ on: 'interaction' }],
      false,
      { marker, targets: [] },
      start,
    )
    expect(warn).toHaveBeenCalledTimes(2)
    expect(f.calls.visible).toEqual([])
    await f.loadPage()
    await f.slice()
    await f.slice()
    expect(start).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})

describe('readConditions', () => {
  test('reads the marker data attributes, in a fixed order', () => {
    expect(
      readConditions({
        onSaveData: 'false',
        onMedia: '(min-width: 64em)',
        onInteraction: 'mouseenter, focusin',
        onLoad: '',
        onIdle: '2000',
        onVisible: '200px 0px',
        onAny: '',
      }),
    ).toEqual({
      any: true,
      conditions: [
        { on: 'visible', rootMargin: '200px 0px' },
        { on: 'idle', timeout: 2000 },
        { on: 'load' },
        { on: 'interaction', events: ['mouseenter', 'focusin'] },
        { on: 'media', query: '(min-width: 64em)' },
        { on: 'saveData', expected: false },
      ],
    })
  })

  test('bare attributes mean the defaults', () => {
    expect(
      readConditions({
        onVisible: '',
        onIdle: '',
        onInteraction: '',
        onSaveData: '',
      }),
    ).toEqual({
      any: false,
      conditions: [
        { on: 'visible' },
        { on: 'idle' },
        { on: 'interaction' },
        { on: 'saveData', expected: true },
      ],
    })
  })

  test('no attributes means no conditions (eager)', () => {
    expect(readConditions({ island: 'x', hydrate: 'ssr' })).toEqual({
      any: false,
      conditions: [],
    })
  })
})

describe('splitOnProps', () => {
  test('strips the on* props and returns the marker attributes', () => {
    const { rest, attrs } = splitOnProps(
      {
        n: 1,
        onVisible: '200px 0px',
        onIdle: 2000,
        onLoad: true,
        onInteraction: true,
        onMedia: '(min-width: 64em)',
        onSaveData: false,
        onAny: true,
      },
      'X',
    )
    expect(rest).toEqual({ n: 1 })
    expect(attrs).toEqual({
      'data-on-visible': '200px 0px',
      'data-on-idle': '2000',
      'data-on-load': '',
      'data-on-interaction': '',
      'data-on-media': '(min-width: 64em)',
      'data-on-save-data': 'false',
      'data-on-any': '',
    })
  })

  test('absent or false props add no attribute (false only means something for onSaveData)', () => {
    const { attrs } = splitOnProps(
      { onVisible: false, onIdle: undefined, onLoad: false, onAny: false },
      'X',
    )
    expect(attrs).toEqual({})
  })

  test.each([
    [{ onVisible: 3 }, /onVisible/],
    [{ onIdle: -1 }, /onIdle/],
    [{ onIdle: 'soon' }, /onIdle/],
    [{ onLoad: 'yes' }, /onLoad/],
    [{ onInteraction: 5 }, /onInteraction/],
    [{ onMedia: true }, /onMedia/],
    [{ onMedia: '' }, /onMedia/],
    [{ onSaveData: 'false' }, /onSaveData/],
    [{ onAny: 'all' }, /onAny/],
  ])('rejects %j, naming the component and the prop', (props, message) => {
    expect(() => splitOnProps(props, 'Widget')).toThrow(message)
    expect(() => splitOnProps(props, 'Widget')).toThrow(/<Widget>/)
  })
})
