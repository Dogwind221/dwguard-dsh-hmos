// Client bundle wiring: slots, tab key and dictionaries must stay in sync.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: (initial) => ({ current: initial ?? null }),
  useCallback: (fn) => fn
};

let captured = null;
global.window = { __ModuleLoader__: { load: (entry) => { captured = entry; } } };
require('../lib/client.js');

const api = captured.factory((id) => {
  if (id === 'react') return fakeReact;
  throw new Error(`unexpected module: ${id}`);
});

test('client bundle registers the panellist row, main launcher and right-sidebar tab', () => {
  assert.equal(captured.id, 'dwguard-dsh-hmos');
  const slots = [];
  const dictionaries = [];
  const ctx = {
    slots: {
      inject: (_name, callback) => callback(),
      register: (meta, component) => {
        slots.push({ meta, component });
        return () => {};
      }
    },
    locale: {
      register: (namespace, dicts) => {
        dictionaries.push({ namespace, dicts });
        return () => {};
      }
    },
    get: () => undefined,
    effect: (body) => body()
  };

  api.apply(ctx);
  assert.equal(typeof api.apply, 'function');
  assert.equal(api.PANEL_ID, 'dsh-homs');
  assert.equal(api.TAB_KIND, 'dwguard-board');

  const byName = new Map(slots.map((slot) => [slot.meta.name, slot.meta]));
  assert.deepEqual([...byName.keys()].sort(), ['main', 'sidebar.panellist', 'sidebar.right.pane.tab']);
  assert.equal(byName.get('main')?.key, 'dsh-homs');
  assert.equal(byName.get('sidebar.right.pane.tab')?.key, 'dwguard-dsh-hmos/board');
  assert.equal(byName.get('sidebar.panellist')?.order, 5);

  assert.equal(dictionaries.length, 1);
  const { zh, en } = dictionaries[0].dicts;
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  assert.equal(zh.history, '历史');
  assert.equal(en.history, 'History');
  assert.equal(zh.phaseNames.confirmed, '用户已确认');
  assert.equal(en.phaseNames.confirmed, 'Confirmed');
});
